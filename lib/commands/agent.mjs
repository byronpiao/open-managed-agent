// ── Agent commands ────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { execSync, spawnSync } from "child_process";
import { stringify as yamlStringify } from "yaml";

import {
  normalizeAgentRuntime,
  applyHarnessRuntimeEnv,
} from "../harness-deploy.mjs";
import { hydrateCloudEnvFromCli, requireEnvId } from "../env.mjs";
import { runTcb, getNodeExecutable, getTcbScript } from "../tcb.mjs";
import { callTcbCloudApi } from "../api.mjs";
import { acpCall, getAcpUrl, buildPlaygroundUrl } from "../acp.mjs";
import { toAlias } from "../alias.mjs";
import { resolveCodePath } from "../config.mjs";
import {
  buildCloudRunEnvParam,
  waitForCloudRunDeploy,
  waitForConfigLive,
  lookupAgent,
  buildImageViaCloudRun,
} from "../cloudrun.mjs";
import {
  downloadDeployedCode,
  redeployCloudRunWithEnv,
  applySkillsToDeployDir,
  skillsChanged,
  skillsNeedSync,
  stampDeployMetadata,
  loadLocalSkillConfig,
  confirmManagedSkillDeploy,
} from "../skills-sync.mjs";
import { runWithSkillSyncLog, managedLog, withSkillSyncContext, skillSyncPhase, skillSyncMilestone } from "../managed-logging.mjs";
import { installScfLinuxDeps, scfAgentFullUpdateArgs, SCF_DEPLOY_IGNORE } from "../scf-bundle.mjs";
import { dim, green, yellow, red, bold, cyan } from "../ui.mjs";
import { pollAndReportAgentReady } from "../agent-ready.mjs";
import { pinnedHarnessToolId } from "../harness-env-file.mjs";
import { assertHarnessDeployPreflight } from "../harness-preflight.mjs";

/** Resolve agent ID from options, supporting both -a/--agent and -i/--id. */
function resolveAgentId(options) {
  return options.agent ?? options.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
}

/** SCF deploy env — must stay in sync for agent:create and agent:update (full replace). */
async function buildScfDeployEnvMap(envId, config, configB64, opts = {}) {
  hydrateCloudEnvFromCli({ envId });
  if (config.runtime === "harness" && !process.env.TCB_REGION?.trim()) {
    console.warn(
      dim(
        "Warning: TCB_REGION unset — FlexDB persistence may be disabled in cloud. " +
        "Set TCB_REGION or ensure `tcb env detail` works (see docs/harness-env.md#advanced-settings).",
      ),
    );
  }
  const scfEnvMap = {
    CLOUDBASE_ENV_ID: envId,
    AGENT_CONFIG_B64: configB64,
    // OAK_SESSION_LOCAL_DIR: "/tmp/.claude",
  };
  // SCF forbids TENCENTCLOUD_* in user env; execution role injects them at runtime.
  // Do NOT fall back to tcb-login STS (~2h) — it expires and causes SIGN_PARAM.
  // Resolution: local CLOUDBASE_APIKEY → local TCB_SECRET_ID/KEY → interactive ensureTcbApiKey.
  const hasApiKey = !!process.env.CLOUDBASE_APIKEY?.trim();
  const hasSecretPair =
    !!process.env.TCB_SECRET_ID?.trim() && !!process.env.TCB_SECRET_KEY?.trim();

  if (hasApiKey) {
    scfEnvMap.CLOUDBASE_APIKEY = process.env.CLOUDBASE_APIKEY.trim();
  }
  if (hasSecretPair) {
    scfEnvMap.TCB_SECRET_ID = process.env.TCB_SECRET_ID.trim();
    scfEnvMap.TCB_SECRET_KEY = process.env.TCB_SECRET_KEY.trim();
    if (process.env.TCB_TOKEN?.trim()) scfEnvMap.TCB_TOKEN = process.env.TCB_TOKEN.trim();
  }
  if (!hasApiKey && !hasSecretPair) {
    const { ensureTcbApiKey } = await import("../ensure-tcb-api-key.mjs");
    await ensureTcbApiKey(envId);
    if (process.env.CLOUDBASE_APIKEY) {
      scfEnvMap.CLOUDBASE_APIKEY = process.env.CLOUDBASE_APIKEY;
    }
  }
  if (config.runtime === "harness") {
    applyHarnessRuntimeEnv(scfEnvMap, config, {
      envId,
      harnessToolId: pinnedHarnessToolId() || undefined,
      agentId: opts.agentId,
    });
  }
  return scfEnvMap;
}

function scfEnvMapToCliArg(envMap) {
  return Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join(",");
}

function scfMemorySizeMb(runtime) {
  return runtime === "harness" ? "512" : "256";
}

/** Bundle linux SCF deploy dir (shared by agent:create and harness SCF agent:update). */
async function bundleScfDeployDir(sourceCode, deployLabel, config, { strict = false, configFile = null } = {}) {
  const deployDir = resolve("/tmp", `magent-scf-${deployLabel}-${Date.now()}`);
  let actualCode = sourceCode;
  let deployConfig = config;
  try {
    execSync(`rm -rf "${deployDir}" && mkdir -p "${deployDir}"`, { encoding: "utf-8" });

    const filesToCopy = ["dist", "package.json", "package-lock.json", "scf_bootstrap", "vendor"];
    const uidShim = resolve(sourceCode, "src", "uid-shim.mjs");
    if (existsSync(uidShim)) {
      execSync(`cp "${uidShim}" "${deployDir}/uid-shim.mjs"`, { encoding: "utf-8" });
    }

    for (const f of filesToCopy) {
      const src = resolve(sourceCode, f);
      if (existsSync(src)) execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
    }

    if (config?.skills?.length && config.runtime !== "harness") {
      const r = await applySkillsToDeployDir(deployDir, config.skills, { configFile });
      if (r.added.length || r.updated.length || r.removed.length) {
        console.log(
          dim(`  ✓ Skills synced: +${r.added.length} ~${r.updated.length} -${r.removed.length}`),
        );
        managedLog({ lane: "skill-sync", operation: "deploy-bundle" }).milestone("install_complete", {
          added: r.added,
          updated: r.updated,
          removed: r.removed,
        });
      }
    }

    if (config) {
      deployConfig = await stampDeployMetadata(config, { configFile });
      writeFileSync(resolve(deployDir, "agent.yaml"), yamlStringify(deployConfig), "utf-8");
      console.log(dim(`  ✓ Wrote agent.yaml to deploy dir`));
    }

    process.stdout.write(dim("  Installing dependencies... "));
    installScfLinuxDeps(deployDir);
    console.log(green("OK"));
    actualCode = deployDir;
  } catch (err) {
    if (strict) {
      throw new Error(`SCF deploy bundle failed: ${err.message?.split("\n")[0]}`);
    }
    console.log(yellow(`  Warning: dep bundling failed: ${err.message?.split("\n")[0]}`));
    console.log(yellow("  Falling back to --install-dep (cloud-side install, slower cold start)"));
  }
  return { deployDir, actualCode, sourceCode, deployConfig };
}

function cleanupScfDeployDir(deployDir) {
  if (!deployDir) return;
  try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch { }
}

function scfCodeDeployTcbArgs(actualCode, sourceCode) {
  return [
    "--code", actualCode,
    "--ignore", SCF_DEPLOY_IGNORE,
    ...(actualCode === sourceCode ? ["--install-dep"] : []),
  ];
}

function parseTcbAgentJson(raw) {
  return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
}

function reportScfUpdateElapsed(data) {
  if (data.data?.elapsedTime) {
    console.log(dim(`  Elapsed: ${Math.round(data.data.elapsedTime / 1000)}s`));
  }
}

async function assertHarnessDeployPreflightOrExit(envId) {
  try {
    await assertHarnessDeployPreflight({ envId });
  } catch (err) {
    console.error(red(err.message ?? String(err)));
    process.exit(1);
  }
}

function applyScfAgentUpdateViaTcb(tcbArgs, { timeoutMs = 120000 } = {}) {
  process.stdout.write("Applying via tcb agent update... ");
  const raw = runTcb(tcbArgs, { timeout: timeoutMs });
  const data = parseTcbAgentJson(raw);
  console.log(green("OK"));
  reportScfUpdateElapsed(data);
}

/** Managed SCF agents: env-only update (unchanged upstream behavior). */
async function updateScfManagedAgentEnvOnly(agentId, envId, config) {
  const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");
  const scfUpdateEnv = await buildScfDeployEnvMap(envId, config, configBase64);
  const envStr = scfEnvMapToCliArg(scfUpdateEnv);
  try {
    applyScfAgentUpdateViaTcb(
      ["agent", "update", agentId, "--env", envStr, "-e", envId, "--json"],
      { timeoutMs: 120000 },
    );
  } catch (err) {
    throw new Error(`tcb agent update failed: ${err.message}`);
  }
  console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
}

/** Harness SCF agents: bundle runtime code + full env replace (mirrors agent:create). */
async function updateScfHarnessAgent(agentId, envId, config, codeOpt) {
  await assertHarnessDeployPreflightOrExit(envId);
  const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");
  const scfUpdateEnv = await buildScfDeployEnvMap(envId, config, configBase64, { agentId });
  const envStr = scfEnvMapToCliArg(scfUpdateEnv);
  const sourceCode = resolveCodePath(codeOpt);
  const { deployDir, actualCode } = await bundleScfDeployDir(sourceCode, agentId, config, { strict: true });
  try {
    applyScfAgentUpdateViaTcb(
      [
        "agent", "update", agentId,
        "--env", envStr,
        "-e", envId,
        ...scfCodeDeployTcbArgs(actualCode, sourceCode),
        "--timeout", "7200",
        "--memory-size", scfMemorySizeMb("harness"),
        "--json",
      ],
      { timeoutMs: 300000 },
    );
  } catch (err) {
    throw new Error(`tcb agent update failed: ${err.message}`);
  } finally {
    cleanupScfDeployDir(deployDir);
  }
  console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
}

/**
 * Build a compat args object for normalizeAgentRuntime / agentLoopRuntimeFromArgs,
 * which reads kebab-case keys like args["agent-runtime"].
 */
function compatArgs(options) {
  return {
    ...options,
    "agent-runtime": options.agentRuntime,
  };
}

// ── Handler functions (exported for cross-command delegation) ────────────────

export async function handleAgentCreate(options) {
  const { name, model, system } = options;
  if (!name) throw new Error("-n / --name is required");
  const type = (options.type ?? "scf").toLowerCase();
  if (type !== "scf" && type !== "scf-image" && type !== "tcbr") {
    throw new Error(`--type must be 'scf', 'scf-image', or 'tcbr' (got '${type}')`);
  }

  // Container-mode (TCBR cloudrun) — delegate to the cloudrun:create flow
  if (type === "tcbr") {
    const { handleCloudrunCreate } = await import("./cloudrun.mjs");
    return handleCloudrunCreate(options);
  }

  // SCF image-mode
  if (type === "scf-image") {
    return handleScfImageCreate(options);
  }

  // SCF cloud function path (default).
  const envId = requireEnvId(options);
  const code = resolveCodePath(options.code);
  const scfRuntime =
    options.scfRuntime ??
    (options.runtime && !["managed", "harness"].includes(String(options.runtime))
      ? options.runtime
      : "Nodejs20.19");

  // Build initial config
  const config = {
    name,
    model: model ?? "hy3-preview",
    system: system ?? "You are a helpful assistant.",
  };

  // If --file provided, load full config from YAML/JSON
  if (options.file) {
    try {
      const content = readFileSync(options.file, "utf-8");
      let fileConfig;
      if (content.trim().startsWith("{")) {
        fileConfig = JSON.parse(content);
      } else {
        const { parse } = await import("yaml");
        fileConfig = parse(content);
      }
      Object.assign(config, fileConfig);
    } catch (err) {
      throw new Error(`Failed to load config file: ${err.message}`);
    }
  }

  // Explicit CLI args override file config
  if (name) config.name = name;
  if (model) config.model = model;
  if (system) config.system = system;
  normalizeAgentRuntime(config, compatArgs(options));

  if (config.runtime === "harness") {
    await assertHarnessDeployPreflightOrExit(envId);
  }

  console.log(bold("Creating agent..."));
  console.log(dim(`  name:    ${config.name}`));
  console.log(dim(`  model:   ${typeof config.model === "string" ? config.model : `${config.model?.id ?? "?"}${config.model?.apiBaseUrl ? ` @ ${config.model.apiBaseUrl}` : ""}`}`));
  console.log(dim(`  code:    ${code}`));
  console.log(dim(`  loop: ${config.runtime ?? "managed"} · scf: ${scfRuntime}`));
  console.log();

  const { deployDir, actualCode, sourceCode, deployConfig } = await bundleScfDeployDir(code, name, config, {
    strict: config.runtime === "harness",
    configFile: options.file,
  });
  const configB64 = Buffer.from(JSON.stringify(deployConfig)).toString("base64");
  const scfEnvMap = await buildScfDeployEnvMap(envId, deployConfig, configB64);
  const envVars = scfEnvMapToCliArg(scfEnvMap);
  const memorySize = scfMemorySizeMb(config.runtime);

  try {
    const alias = toAlias(name);
    const tcbArgs = [
      "agent", "create",
      "--name", alias,
      "--runtime", scfRuntime,
      ...scfCodeDeployTcbArgs(actualCode, sourceCode),
      "--timeout", "7200",
      "--memory-size", memorySize,
      "--env", envVars,
      "-e", envId,
      "--json",
    ];
    const raw = runTcb(tcbArgs, { timeout: 300000 });
    const data = parseTcbAgentJson(raw);

    if (data.data?.agentId) {
      console.log(green(`✅ Agent created: ${data.data.agentId}`));
      console.log(dim(`  name:    ${name}`));
      console.log(dim(`  loop: ${config.runtime ?? "managed"} · scf: ${scfRuntime}`));
      const acpUrl = getAcpUrl({ env: envId, agent: data.data.agentId });
      const playgroundUrl = buildPlaygroundUrl(acpUrl, process.env.CLOUDBASE_APIKEY);
      console.log(cyan(`  🔗 Playground: ${playgroundUrl}`));
      console.log();
      console.log("Next steps:");
      await pollAndReportAgentReady({
        envId,
        agentId: data.data.agentId,
        wait: options.wait !== false,
        timeoutMs: 5 * 60 * 1000,
      });
      if (deployConfig.skills?.length && deployConfig.runtime !== "harness") {
        await withSkillSyncContext(
          {
            operation: "agent:create-verify",
            envId,
            agentId: data.data.agentId,
            agentType: "scf",
            skillCount: deployConfig.skills.length,
          },
          async () =>
            confirmManagedSkillDeploy({
              envId,
              agentId: data.data.agentId,
              agentType: "scf",
              codeDir: actualCode,
              skills: deployConfig.skills,
              stamped: deployConfig,
              agentUrl: acpUrl,
            }),
        );
      }
      console.log(dim(`  1. Update config:  magent agent:update -a ${data.data.agentId} -f agent.yaml -e ${envId}`));
      console.log(dim(`  2. Start chatting: magent run -a ${data.data.agentId} -m "Hello"`));
      console.log(dim(`  3. Open playground: magent open -a ${data.data.agentId} -e ${envId}`));
    } else {
      console.log(yellow("Agent creation submitted. Check status with: magent agent:list"));
    }
    cleanupScfDeployDir(deployDir);
  } catch (err) {
    cleanupScfDeployDir(deployDir);
    throw new Error(`Failed to create agent: ${err.message}`);
  }
}

function logSkillSyncResult(syncResult) {
  if (syncResult.added.length) console.log(green(`       Added: ${syncResult.added.join(", ")}`));
  if (syncResult.updated.length) console.log(green(`       Updated: ${syncResult.updated.join(", ")}`));
  if (syncResult.removed.length) console.log(yellow(`       Removed: ${syncResult.removed.join(", ")}`));
}

async function redeployManagedScfCode(envId, agentId, codeDir, config) {
  skillSyncPhase("redeploy_start", { agentType: "scf", agentId });
  console.log(dim("  Installing dependencies..."));
  try {
    installScfLinuxDeps(codeDir);
    console.log(green("  OK"));
  } catch (err) {
    console.log(yellow(`  Warning: dep bundling failed: ${err.message?.split("\n")[0]}`));
    console.log(yellow("  Falling back to cloud-side install (slower cold start)"));
  }

  const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");
  const scfEnvMap = await buildScfDeployEnvMap(envId, config, configBase64);
  const envStr = scfEnvMapToCliArg(scfEnvMap);

  console.log(dim("  Deploying function code + env (atomic)..."));
  applyScfAgentUpdateViaTcb(
    scfAgentFullUpdateArgs(envId, agentId, codeDir, envStr),
    { timeoutMs: 300000 },
  );
  console.log(green("  ✓ Function deployed."));
  skillSyncMilestone("redeploy_ok", { agentType: "scf", agentId });
}

async function syncManagedAgentSkills({
  envId,
  agentId,
  agentType,
  serviceId,
  skills,
  configFile,
  fullConfig,
  agentUrl,
  tempPrefix,
  operation = "sync-skills",
}) {
  return runWithSkillSyncLog(
    {
      envId,
      agentId,
      agentType,
      serviceId,
      operation,
      skillCount: skills?.length ?? 0,
    },
    async () => {
      const tempDir = resolve("/tmp", `${tempPrefix}-${agentId}-${Date.now()}`);
      try {
        console.log(dim("  1/3 Pulling deployed code..."));
        await downloadDeployedCode(envId, agentType, tempDir, { agentId, serviceId });

        console.log(dim("  2/3 Installing skills..."));
        const syncResult = await applySkillsToDeployDir(tempDir, skills, { configFile });
        logSkillSyncResult(syncResult);

        const stamped = await stampDeployMetadata(fullConfig, { configFile });
        writeFileSync(resolve(tempDir, "agent.yaml"), yamlStringify(stamped), "utf-8");

        console.log(dim("  3/3 Redeploying..."));
        if (agentType === "tcbr") {
          await redeployCloudRunWithEnv(envId, serviceId, tempDir, stamped, agentUrl, {
            configFile,
            skipLiveVerify: true,
          });
          await confirmManagedSkillDeploy({
            envId,
            agentId,
            agentType,
            serviceId,
            skills,
            stamped,
            agentUrl,
          });
          return { tcbr: true, syncResult, stampedConfig: stamped };
        }
        await redeployManagedScfCode(envId, agentId, tempDir, stamped);
        await confirmManagedSkillDeploy({
          envId,
          agentId,
          agentType,
          serviceId,
          codeDir: tempDir,
          skills,
          stamped,
          agentUrl,
        });
        return { tcbr: false, syncResult, stampedConfig: stamped };
      } finally {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  );
}

async function handleAgentSyncSkills(options) {
  const agentId = resolveAgentId(options);
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  const envId = requireEnvId(options);

  const { skills, configPath, fullConfig } = await loadLocalSkillConfig(options.file);
  if (fullConfig.runtime === "harness") {
    throw new Error("agent:sync-skills supports managed agents only (runtime: managed).");
  }

  const { agentType, serviceId } = await lookupAgent(envId, agentId);
  if (!agentType) throw new Error(`Agent ${agentId} not found in env ${envId}`);

  const { getAcpUrl } = await import("../acp.mjs");
  const agentUrl = options.url ?? getAcpUrl({ ...options, agent: agentId });

  console.log(bold(`Syncing skills for agent ${agentId}...`));
  try {
    await syncManagedAgentSkills({
      envId,
      agentId,
      agentType,
      serviceId,
      skills,
      configFile: configPath,
      fullConfig,
      agentUrl,
      tempPrefix: "magent-sync-skills",
      operation: "agent:sync-skills",
    });
    console.log(green(`\n✅ Skills synced for agent ${agentId}.`));
  } catch (err) {
    console.error(red(`Skill sync failed: ${err.message}`));
    process.exitCode = 1;
  }
}

async function handleAgentList(options) {
  const envId = requireEnvId(options);
  const result = runTcb(["agent", "list", "-e", envId], { timeout: 30000 });
  console.log(result);
}

async function handleAgentGet(options) {
  const agentId = resolveAgentId(options);
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  const envId = requireEnvId(options);
  const result = runTcb(["agent", "detail", agentId, "-e", envId], { timeout: 30000 });
  console.log(result);
}

async function handleAgentExport(options) {
  const agentId = resolveAgentId(options);
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  requireEnvId(options);
  const { getAcpUrl } = await import("../acp.mjs");
  const agentUrl = options.url ?? getAcpUrl({ ...options, agent: agentId });

  process.stdout.write(dim("Fetching config from agent... "));
  let cfg;
  try {
    const result = await acpCall(agentUrl, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "magent", version: "0.1.0" },
    });
    if (!result?.agentConfig) throw new Error("initialize returned no agentConfig");
    cfg = { ...result.agentConfig };
    if (result.agentInfo?.name) cfg.name = result.agentInfo.name;
    if (result.agentInfo?.title) cfg.description = result.agentInfo.title;
  } catch (err) {
    console.log(red("FAILED"));
    throw err;
  }
  console.log(green("OK"));

  // Strip internal deployment stamps
  if (cfg.metadata) {
    cfg = { ...cfg, metadata: { ...cfg.metadata } };
    delete cfg.metadata.__deployedAt;
    delete cfg.metadata.__skillHashes;
    if (Object.keys(cfg.metadata).length === 0) delete cfg.metadata;
  }

  const { stringify } = await import("yaml");
  const yamlText = stringify(cfg, { lineWidth: 0 });

  const outPath = options.output;
  if (outPath) {
    writeFileSync(outPath, yamlText, "utf-8");
    console.log(green(`✅ Config written to ${outPath}`));
  } else {
    process.stdout.write(yamlText);
  }
}

async function handleOpen(options) {
  const agentId = options.agent ?? options.id ?? process.env.CLOUDBASE_AGENT_ID;
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  const envId = requireEnvId(options);
  const acpUrl = getAcpUrl({ env: envId, agent: agentId });
  const url = buildPlaygroundUrl(acpUrl, process.env.CLOUDBASE_APIKEY);
  console.log(cyan(`Opening: ${url}`));
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    console.log(dim(`  (could not auto-open; copy URL manually)`));
  }
}

async function deleteCloudRunService(serviceName, envId, { optional = false } = {}) {
  process.stdout.write(dim(`Deleting cloudrun service '${serviceName}'... `));
  const r = spawnSync(
    getNodeExecutable(),
    [getTcbScript(), "cloudrun", "delete", "-s", serviceName, "-e", envId, "--force"],
    { encoding: "utf-8", timeout: 120000 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0 && !/✖|error|failed/i.test(out)) {
    console.log(green("OK"));
    return;
  }
  if (/not found|不存在|未找到|ResourceNotFound|Deleting状态|处于Deleting|正在删除/i.test(out)) {
    console.log(dim("(already deleting / gone)"));
    return;
  }
  if (optional) {
    console.log(dim("(skip)"));
    return;
  }
  console.log(yellow("FAILED"));
  console.log(dim(out.split("\n").filter((l) => /✖|error/i.test(l)).join("\n").trim() || out.trim().slice(-300)));
  throw new Error(`cloudrun delete failed for ${serviceName}`);
}

async function handleAgentDelete(options) {
  const agentId = resolveAgentId(options);
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  const envId = requireEnvId(options);

  const { agentType, serviceId } = await lookupAgent(envId, agentId);
  if (!agentType) {
    console.log(yellow(`⚠️  could not look up agent metadata; proceeding with registration delete only.`));
  }

  // Cascade-delete sessions while ACP endpoint is still reachable
  if (agentType !== "baas") {
    try {
      const { getAcpUrl } = await import("../acp.mjs");
      const acpUrl = getAcpUrl({ ...options, agent: agentId });
      const { sessions = [] } = await acpCall(acpUrl, "session/list", {});
      if (sessions.length === 0) {
        console.log(dim("(no sessions to clean up)"));
      } else {
        process.stdout.write(dim(`Deleting ${sessions.length} session(s)... `));
        let ok = 0, failed = 0;
        for (const s of sessions) {
          try {
            await acpCall(acpUrl, "session/delete", { sessionId: s.sessionId });
            ok++;
          } catch {
            failed++;
          }
        }
        if (failed === 0) console.log(green(`OK (${ok})`));
        else console.log(yellow(`OK ${ok}, FAILED ${failed}`));
      }
    } catch (e) {
      console.log(yellow(`⚠️  could not cascade-delete sessions: ${e.message}`));
      console.log(dim(`    (sessions may remain orphaned in env ${envId} oak_* collections)`));
    }
  }

  // Remove agent registration
  process.stdout.write(dim(`Deleting agent registration... `));
  runTcb(["agent", "delete", agentId, "-e", envId], { input: "Y\n", timeout: 60000 });
  console.log(green("OK"));

  // Cascade-delete the underlying compute
  if (agentType === "tcbr") {
    if (!serviceId) {
      console.log(yellow(`⚠️  tcbr agent ${agentId} has no ServiceId; skipped cloudrun cleanup.`));
    } else {
      await deleteCloudRunService(serviceId, envId);
      await deleteCloudRunService(`${serviceId}-imgbuild`, envId, { optional: true });
    }
  } else if (agentType === "scf") {
    const fnName = serviceId || agentId;
    process.stdout.write(dim(`Deleting cloud function '${fnName}'... `));
    const r = spawnSync(
      getNodeExecutable(),
      [getTcbScript(), "fn", "delete", fnName, "-e", envId],
      { encoding: "utf-8", timeout: 120000 },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status === 0 && !/✖|error|failed/i.test(out)) {
      console.log(green("OK"));
    } else if (/not found|不存在|未找到|ResourceNotFound|Deleting状态|处于Deleting|正在删除/i.test(out)) {
      console.log(dim("(already deleting / gone)"));
    } else {
      console.log(yellow("FAILED"));
      console.log(dim(out.split("\n").filter((l) => /✖|error/i.test(l)).join("\n").trim() || out.trim().slice(-300)));
      throw new Error(`fn delete failed for ${fnName}`);
    }
  } else if (agentType === "baas") {
    console.log(dim("(baas agent — no underlying compute to delete)"));
  } else if (agentType) {
    console.log(yellow(`⚠️  unknown agent type '${agentType}', skipping resource cleanup`));
  }

  console.log(green(`✅ Agent ${agentId} deleted.`));
}

async function handleAgentUpdate(options) {
  const agentId = resolveAgentId(options);
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  const envId = requireEnvId(options);

  // Fetch current config from running agent
  let currentConfig = null;
  const { getAcpUrl } = await import("../acp.mjs");
  const agentUrl = options.url ?? getAcpUrl({ ...options, agent: agentId });
  const fetchCurrent = async () => {
    const result = await acpCall(agentUrl, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "magent", version: "0.1.0" },
    });
    if (!result?.agentConfig) return null;
    const cfg = { ...result.agentConfig };
    if (result.agentInfo?.name) cfg.name = result.agentInfo.name;
    if (result.agentInfo?.title) cfg.description = result.agentInfo.title;
    return cfg;
  };

  process.stdout.write(dim("Fetching current config... "));
  try {
    currentConfig = await fetchCurrent();
  } catch {
    await new Promise((r) => setTimeout(r, 5000));
    try { currentConfig = await fetchCurrent(); } catch { /* fall through */ }
  }
  if (currentConfig) {
    console.log(green("OK"));
  } else {
    console.log(yellow("not available"));
  }

  // Collect updates
  const updates = {};
  if (options.name) updates.name = options.name;
  if (options.model) updates.model = options.model;
  if (options.system) updates.system = options.system;
  if (options.description) updates.description = options.description;
  if (options.tools) updates.tools = JSON.parse(options.tools);
  if (options.mcpServers) updates.mcp_servers = JSON.parse(options.mcpServers);
  if (options.skills) updates.skills = JSON.parse(options.skills);

  if (options.file) {
    try {
      const content = readFileSync(options.file, "utf-8");
      let fileConfig;
      if (content.trim().startsWith("{")) {
        fileConfig = JSON.parse(content);
      } else {
        const { parse } = await import("yaml");
        fileConfig = parse(content);
      }
      Object.assign(updates, fileConfig);
    } catch (err) {
      throw new Error(`Failed to load config file ${options.file}: ${err.message}`);
    }
  }

  if (Object.keys(updates).length === 0) {
    console.log(yellow("No updates specified. Use --system, --model, --tools, -f <file>, etc."));
    return;
  }

  const merged = { ...(currentConfig ?? {}), ...updates };
  normalizeAgentRuntime(merged, compatArgs(options));
  const requireFullConfig = !currentConfig;
  if (requireFullConfig) {
    const missing = [];
    if (!merged.name) missing.push("name");
    if (!merged.model) missing.push("model");
    if (!merged.system) missing.push("system");
    if (missing.length > 0) {
      throw new Error(
        `Could not read the agent's current config (initialize failed). ` +
        `Cannot fall back to defaults — that would silently overwrite the ` +
        `agent's identity. Provide a full config via --file (must include ${missing.join(", ")}) ` +
        `or wait for the agent to come back online and retry.`,
      );
    }
  }

  const modelDisplay = typeof merged.model === "string"
    ? merged.model
    : `${merged.model?.id ?? "?"}${merged.model?.apiBaseUrl ? ` @ ${merged.model.apiBaseUrl}` : ""}`;
  const configJson = JSON.stringify(merged);

  console.log(dim(`\nUpdated config (${configJson.length} bytes):`));
  console.log(dim(`  name:        ${merged.name}`));
  console.log(dim(`  model:       ${modelDisplay}`));
  console.log(dim(`  system:      ${merged.system?.slice(0, 60)}${merged.system?.length > 60 ? "..." : ""}`));
  console.log(dim(`  tools:       ${merged.tools?.length ?? 0} items`));
  console.log(dim(`  mcp_servers: ${merged.mcp_servers?.length ?? 0} items`));
  console.log(dim(`  skills:      ${merged.skills?.length ?? 0} items`));

  // Detect skill changes (managed agents only)
  let skillSyncNeeded = false;
  if (merged.runtime !== "harness" && merged.skills) {
    skillSyncNeeded = await withSkillSyncContext(
      {
        operation: "agent:update-detect",
        agentId,
        envId,
        skillCount: merged.skills.length,
      },
      async () =>
        skillsNeedSync({
          currentSkills: currentConfig?.skills,
          newSkills: merged.skills,
          currentConfig,
          configFile: options.file,
        }),
    );
  }
  console.log();

  const { agentType, serviceId } = await lookupAgent(envId, agentId);

  // Auto-sync skills if changed: pull deployed code, update skills, redeploy
  let skipNormalUpdate = false;
  if (skillSyncNeeded && agentType && merged.runtime !== "harness") {
    console.log(bold("Skills changed — syncing deployed code..."));
    try {
      const { tcbr, stampedConfig } = await syncManagedAgentSkills({
        envId,
        agentId,
        agentType,
        serviceId,
        skills: merged.skills || [],
        configFile: options.file,
        fullConfig: merged,
        agentUrl,
        tempPrefix: "magent-sync",
        operation: "agent:update",
      });
      if (stampedConfig) {
        merged.metadata = stampedConfig.metadata;
      }
      if (tcbr || agentType === "scf") skipNormalUpdate = true;
      console.log(green("  ✓ Skills synced.\n"));
    } catch (err) {
      console.log(red(`  ✗ Auto skill sync failed: ${err.message}`));
      console.log(dim("  Env update aborted to avoid config/code mismatch."));
      console.log(dim(`  Retry: magent agent:sync-skills -a ${agentId} -e ${envId} -f <agent.yaml>`));
      throw new Error(`Skill sync failed; agent update aborted: ${err.message}`);
    }
  }

  if (skipNormalUpdate) {
    console.log(green(`✅ Agent ${agentId} updated successfully (code + env).`));
    return;
  }

  if (agentType === "tcbr") {
    if (!serviceId) throw new Error(`tcbr agent ${agentId} has no ServiceId`);
    const configWithTs = await stampDeployMetadata(merged, { configFile: options.file });
    const configBase64 = Buffer.from(JSON.stringify(configWithTs)).toString("base64");
    const expectedDeployedAt = configWithTs.metadata.__deployedAt;
    const { envMap } = await buildCloudRunEnvParam({
      envId,
      configB64: configBase64,
      config: configWithTs,
      agentId,
    });
    process.stdout.write(dim("Applying via SubmitServerConfigChangeDiff (tcbr)... "));
    let taskId;
    try {
      const submitResp = await callTcbCloudApi({
        action: "SubmitServerConfigChangeDiff",
        payload: {
          EnvId: envId,
          ServerName: serviceId,
          Items: [{ Key: "EnvParam", Value: JSON.stringify(envMap) }],
        },
        service: "tcbr",
        version: "2022-02-17",
      });
      taskId = submitResp.TaskId;
      console.log(green(`submitted (TaskId=${taskId})`));
    } catch (err) {
      throw new Error(`SubmitServerConfigChangeDiff failed: ${err.message}`);
    }

    process.stdout.write(dim("Waiting for new version to deploy... "));
    const finalStatus = await waitForCloudRunDeploy(envId, serviceId);
    if (finalStatus === "normal") {
      console.log(green("ready"));
    } else {
      console.log(yellow(`status=${finalStatus || "timeout"}, agent may still be coming up`));
    }

    process.stdout.write(dim("Waiting for traffic switchover... "));
    const matched = await waitForConfigLive({
      agentUrl, expectedDeployedAt, maxWaitMs: 5 * 60 * 1000,
    });
    if (matched) {
      console.log(green("done"));
    } else {
      console.log(yellow("timeout — new config may still be rolling out"));
    }
    console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
    return;
  }

  if (merged.runtime === "harness") {
    await updateScfHarnessAgent(agentId, envId, merged, options.code);
  } else {
    await updateScfManagedAgentEnvOnly(agentId, envId, merged);
  }
}

async function handleScfImageCreate(options) {
  const { name, model, system } = options;
  if (!name) throw new Error("-n / --name is required");
  const envId = requireEnvId(options);
  const code = resolveCodePath(options.code);
  const dockerfile = options.dockerfile ?? "Dockerfile.scf";
  const namespace = options.namespace ?? process.env.CCR_NAMESPACE ?? 'open-managed-agent';
  if (!namespace) {
    throw new Error("--namespace <ccr-namespace> is required (or set CCR_NAMESPACE). " +
      "This is the Tencent Container Registry namespace under ccr.ccs.tencentyun.com/<namespace>/.");
  }

  const config = {
    name,
    model: model ?? "hy3-preview",
    system: system ?? "You are a helpful assistant.",
  };
  if (options.file) {
    try {
      const content = readFileSync(options.file, "utf-8");
      const fileConfig = content.trim().startsWith("{")
        ? JSON.parse(content)
        : (await import("yaml")).parse(content);
      Object.assign(config, fileConfig);
    } catch (err) {
      throw new Error(`Failed to load config file: ${err.message}`);
    }
  }
  if (name) config.name = name;
  if (model) config.model = model;
  if (system) config.system = system;
  const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

  const remoteBuild = !!options.remoteBuild;
  const slug = toAlias(name);
  const tag = options.tag ?? `${Date.now()}`;
  const fnName = options.function ?? slug;

  // imageUri / imagePort / imageType are finalized after the build phase:
  //   - local docker build  → ccr.ccs.tencentyun.com/<ns>/<slug>:<tag>, port 9000 (Dockerfile.scf)
  //   - remote CloudRun CD  → image URI read back from the build, port 8080 (Dockerfile)
  let imageUri = remoteBuild ? "" : `ccr.ccs.tencentyun.com/${namespace}/${slug}:${tag}`;
  let imagePort = remoteBuild ? 8080 : 9000;
  let imageType = "personal";

  console.log(bold("Creating SCF image-mode agent..."));
  console.log(dim(`  name:        ${config.name}`));
  console.log(dim(`  model:       ${typeof config.model === "string" ? config.model : `${config.model?.id ?? "?"}${config.model?.apiBaseUrl ? ` @ ${config.model.apiBaseUrl}` : ""}`}`));
  console.log(dim(`  function:    ${fnName}`));
  console.log(dim(`  build:       ${remoteBuild ? "remote (CloudRun CD)" : "local docker"}`));
  if (!remoteBuild) console.log(dim(`  image:       ${imageUri}`));
  console.log(dim(`  envId:       ${envId}`));
  console.log();

  if (remoteBuild) {
    // Phase 1+2: build linux/amd64 image in the cloud (no local docker).
    console.log(dim("Phase 1/4: building image via CloudRun CD..."));
    const buildSvc = `${slug}-imgbuild`;
    const { imageUri: builtUri } = await buildImageViaCloudRun({
      envId, code, serviceName: buildSvc,
    });
    imageUri = builtUri;
    imageType = imageUri.split("/")[0].endsWith(".tencentcloudcr.com") ? "enterprise" : "personal";
    console.log(green(`  image: ${imageUri}`));
  } else {
    // Phase 1: docker build
    process.stdout.write(dim("Phase 1/4: docker build linux/amd64... "));
    try {
      const dfPath = resolve(code, dockerfile);
      if (!existsSync(dfPath)) {
        throw new Error(`Dockerfile not found at ${dfPath}`);
      }
      execSync(
        `docker build --platform linux/amd64 -f "${dfPath}" -t "${imageUri}" .`,
        { cwd: code, encoding: "utf-8", stdio: "pipe", timeout: 600000 },
      );
      console.log(green("OK"));
    } catch (err) {
      throw new Error(`docker build failed: ${err.message?.split("\n").slice(-3).join(" | ")}\n` +
        `Hint: SCF requires linux/amd64 images; on arm64 macs, use --remote-build to build ` +
        `in the cloud, or colima with --arch x86_64 ` +
        `(brew install qemu lima-additional-guestagents; colima delete --force; colima start --arch x86_64).`);
    }

    // Phase 2: docker push
    process.stdout.write(dim("Phase 2/4: docker push to CCR... "));
    try {
      execSync(`docker push "${imageUri}"`, {
        encoding: "utf-8", stdio: "pipe", timeout: 600000,
      });
      console.log(green("OK"));
    } catch (err) {
      throw new Error(`docker push failed: ${err.message?.split("\n").slice(-3).join(" | ")}\n` +
        `Hint: ensure you have docker login to ccr.ccs.tencentyun.com and push permission ` +
        `for namespace '${namespace}'.`);
    }
  }

  // Phase 3: tcb fn deploy --deployMode image
  process.stdout.write(dim("Phase 3/4: tcb fn deploy (image mode)... "));
  const deployDir = resolve("/tmp", `magent-scf-image-${slug}-${Date.now()}`);
  try {
    execSync(`mkdir -p "${deployDir}/functions/${fnName}"`, { encoding: "utf-8" });
    const cloudbaserc = {
      $schema: "https://static.cloudbase.net/cli/cloudbaserc.schema.json",
      envId,
      version: "2.0",
      functionRoot: "./functions",
      functions: [{
        name: fnName,
        type: "HTTP",
        runtime: "CustomRuntime",
        timeout: 900,
        memorySize: Number(options.memorySize ?? 512),
        envVariables: {
          CLOUDBASE_ENV_ID: envId,
          AGENT_CONFIG_B64: configB64,
          ...(process.env.CLOUDBASE_APIKEY?.trim()
            ? {
              CLOUDBASE_APIKEY: process.env.CLOUDBASE_APIKEY.trim(),
            }
            : {}),
          ...(process.env.TCB_SECRET_ID?.trim() && process.env.TCB_SECRET_KEY?.trim()
            ? {
              TCB_SECRET_ID: process.env.TCB_SECRET_ID.trim(),
              TCB_SECRET_KEY: process.env.TCB_SECRET_KEY.trim(),
              ...(process.env.TCB_TOKEN?.trim()
                ? { TCB_TOKEN: process.env.TCB_TOKEN.trim() }
                : {}),
            }
            : {}),
        },
        imageConfig: {
          imageType,
          imageUri,
          imagePort,
        },
      }],
    };
    writeFileSync(resolve(deployDir, "cloudbaserc.json"), JSON.stringify(cloudbaserc, null, 2));
    const out = spawnSync(getNodeExecutable(), [
      getTcbScript(), "fn", "deploy", fnName,
      "--httpFn", "--deployMode", "image",
      "-e", envId, "--force",
    ], { cwd: deployDir, encoding: "utf-8", env: process.env });
    if (out.status !== 0) {
      const errText = (out.stdout ?? "") + (out.stderr ?? "");
      throw new Error(errText.split("\n").filter(Boolean).slice(-5).join(" | "));
    }
    console.log(green("OK"));
  } catch (err) {
    try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch { }
    throw new Error(`tcb fn deploy failed: ${err.message}`);
  }
  try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch { }

  // Phase 4: HTTP access service
  process.stdout.write(dim("Phase 4/4: creating HTTP access path... "));
  let httpUrl = "";
  try {
    const out = spawnSync(getNodeExecutable(), [
      getTcbScript(), "service", "create",
      "-p", `/${fnName}`, "-f", fnName, "-e", envId,
    ], { encoding: "utf-8", env: process.env });
    const text = (out.stdout ?? "") + (out.stderr ?? "");
    const m = text.match(/(https:\/\/[^\s]+)/);
    if (m) httpUrl = m[1];
    if (out.status !== 0 && !text.includes("HTTP access service created")) {
      if (!httpUrl) httpUrl = `https://${envId}.app.tcloudbase.com/${fnName}`;
      console.log(yellow(`(path may already exist, using ${httpUrl})`));
    } else {
      console.log(green("OK"));
    }
  } catch (err) {
    console.log(yellow(`Warning: ${err.message}`));
  }

  console.log();
  console.log(green(`✅ SCF image agent deployed: ${fnName}`));
  if (httpUrl) {
    console.log(dim(`  HTTP endpoint: ${httpUrl}`));
    console.log(dim(`  ACP endpoint:  ${httpUrl}/acp`));
  }
  console.log();
  console.log("Test with:");
  if (httpUrl) {
    console.log(dim(`  curl -X POST ${httpUrl}/healthz`));
    console.log(dim(`  curl -X POST -H 'Content-Type: application/json' \\`));
    console.log(dim(`    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \\`));
    console.log(dim(`    ${httpUrl}/acp`));
  }
  console.log();
  console.log("Logs:");
  console.log(dim(`  tcb fn log ${fnName} -e ${envId}`));
}

// ── Command registration ────────────────────────────────────────────────────

export function registerAgentCommands(program) {
  program.command("agent:create")
    .description("Create and deploy a new agent")
    .option("-n, --name <name>", "Agent name (required)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--type <type>", "Compute backend (scf|tcbr)", "scf")
    .option("--model <model>", "Model", "hy3-preview")
    .option("--system <prompt>", "System prompt")
    .option("-f, --file <path>", "Load config from YAML/JSON file")
    .option("--code <path>", "Code directory (default: auto-resolve from ~/.magent or magent install location)")
    .option("--runtime <rt>", "[scf only] Runtime")
    .option("--agent-runtime <rt>", "Agent loop runtime (harness|managed)")
    .option("--engine <engine>", "Harness engine (claude|codebuddy|hermes|opencode)")
    .option("--service <name>", "[tcbr only] Override cloudrun service name")
    .option("--scf-runtime <rt>", "[scf only] SCF runtime", "Nodejs20.19")
    .option("--dockerfile <path>", "[scf-image only] Dockerfile path", "Dockerfile.scf")
    .option("--namespace <ns>", "[scf-image only] CCR namespace (or set CCR_NAMESPACE)", "open-managed-agent")
    .option("--remote-build", "[scf-image only] Build image in the cloud (CloudRun CD) instead of local docker")
    .option("--no-wait", "Skip waiting for agent ready after create")
    .action(handleAgentCreate);

  program.command("agent:sync-skills")
    .description("Sync skills from agent.yaml into a deployed managed agent")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-i, --id <id>", "Alias for --agent")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("-f, --file <path>", "agent.yaml with skills (required)")
    .option("--url <url>", "Override agent ACP URL (TCBR traffic wait)")
    .action(handleAgentSyncSkills);

  program.command("agent:list")
    .description("List all agents")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleAgentList);

  program.command("agent:get")
    .description("Get agent details")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-i, --id <id>", "Alias for --agent")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleAgentGet);

  program.command("agent:export")
    .description("Export live agent config to YAML")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-i, --id <id>", "Alias for --agent")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("-o, --output <path>", "Output file path (omit to print to stdout)")
    .action(handleAgentExport);

  program.command("agent:delete")
    .description("Delete an agent (also cleans up underlying compute)")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-i, --id <id>", "Alias for --agent")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleAgentDelete);

  program.command("agent:update")
    .description("Update agent config")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-i, --id <id>", "Alias for --agent")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--system <prompt>", "Update system prompt")
    .option("--model <model>", "Update model")
    .option("--name <name>", "Update agent name")
    .option("--tools <json>", "Replace tools array (JSON)")
    .option("--mcp-servers <json>", "Replace mcp_servers array (JSON)")
    .option("--skills <json>", "Replace skills array (JSON)")
    .option("-f, --file <path>", "Load full config from YAML/JSON file")
    .option("--description <desc>", "Update agent description")
    .option("--url <url>", "Override ACP URL")
    .option("--agent-runtime <rt>", "Agent loop runtime (harness|managed)")
    .option("--engine <engine>", "Harness engine")
    .option("--code <path>", "[harness SCF] Runtime source directory (default: auto-resolve)")
    .action(handleAgentUpdate);

  program.command("open")
    .description("Open ACP playground in browser")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-i, --id <id>", "Alias for --agent")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleOpen);

  program.command("scf-image:create")
    .description("Deploy agent as SCF image-mode function (internal)")
    .option("-n, --name <name>", "Agent name (required)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--model <model>", "Model", "hy3-preview")
    .option("--system <prompt>", "System prompt")
    .option("-f, --file <path>", "Load config from YAML/JSON file")
    .option("--code <path>", "Code directory (default: auto-resolve from ~/.magent or magent install location)")
    .option("--dockerfile <path>", "Dockerfile path", "Dockerfile.scf")
    .option("--namespace <ns>", "CCR namespace (or set CCR_NAMESPACE)", 'open-managed-agent')
    .option("--tag <tag>", "Image tag")
    .option("--function <name>", "SCF function name")
    .option("--memory-size <mb>", "Memory size", "512")
    .option("--remote-build", "Build image in the cloud (CloudRun CD) instead of local docker")
    .action(handleScfImageCreate);
}
