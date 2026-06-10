// ── Agent commands ────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync, spawnSync } from "child_process";

import {
  normalizeAgentRuntime,
  applyHarnessRuntimeEnv,
  resolveHarnessSandboxImage,
} from "open-managed-agent-runtime/harness";
import { hydrateCloudEnvFromCli, requireEnvId } from "../env.mjs";
import { runTcb, getNodeExecutable, getTcbScript } from "../tcb.mjs";
import { callTcbCloudApi } from "../api.mjs";
import { acpCall } from "../acp.mjs";
import { toAlias } from "../alias.mjs";
import {
  buildCloudRunEnvParam,
  waitForCloudRunDeploy,
  waitForConfigLive,
  lookupAgent,
} from "../cloudrun.mjs";
import { dim, green, yellow, red, bold } from "../ui.mjs";
import { pinnedHarnessToolId } from "../harness-env-file.mjs";

/** Resolve agent ID from args, supporting both -a/--agent and -i/--id. */
function resolveAgentId(args) {
  return args.agent ?? args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
}

/** SCF deploy env — must stay in sync for agent:create and agent:update (full replace). */
function buildScfDeployEnvMap(envId, config, configB64) {
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
    OAK_SESSION_LOCAL_DIR: "/tmp/.claude",
  };
  // SCF forbids TENCENTCLOUD_* in user env; execution role injects them at runtime.
  // Do not forward operator TCB_SECRET_* — breaks DB (SIGN_PARAM) when both are present.
  if (process.env.TCB_API_KEY) {
    scfEnvMap.TCB_API_KEY = process.env.TCB_API_KEY;
  } else if (config.runtime !== "harness") {
    scfEnvMap.OAK_DISABLE_SANDBOX = "1";
  }
  if (config.runtime === "harness") {
    applyHarnessRuntimeEnv(scfEnvMap, config, {
      sandboxImage: resolveHarnessSandboxImage(),
      harnessToolId: pinnedHarnessToolId() || undefined,
      clientToolCallbackBase: process.env.CLOUDBASE_SERVER_URL ?? "",
    });
  }
  if (process.env.OAK_USE_MEMORY_STORE !== undefined) {
    scfEnvMap.OAK_USE_MEMORY_STORE = process.env.OAK_USE_MEMORY_STORE;
  }
  return scfEnvMap;
}

function scfEnvMapToCliArg(envMap) {
  return Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join(",");
}

export const agentCommands = {

  "agent:create": async (args) => {
    const { name, model, system } = args;
    if (!name) throw new Error("-n / --name is required");
    const type = (args.type ?? "scf").toLowerCase();
    if (type !== "scf" && type !== "scf-image" && type !== "tcbr") {
      throw new Error(`--type must be 'scf', 'scf-image', or 'tcbr' (got '${type}')`);
    }

    // Container-mode (TCBR cloudrun) — delegate to the cloudrun:create flow
    if (type === "tcbr") {
      const { cloudrunCommands } = await import("./cloudrun.mjs");
      return cloudrunCommands["cloudrun:create"](args);
    }

    // SCF image-mode
    if (type === "scf-image") {
      return agentCommands["scf-image:create"](args);
    }

    // SCF cloud function path (default).
    const envId   = requireEnvId(args);
    const code    = args.code    ?? "./packages/agent-runtime";
    const scfRuntime =
      args["scf-runtime"] ??
      (args.runtime && !["managed", "harness"].includes(String(args.runtime))
        ? args.runtime
        : "Nodejs20.19");

    // Build initial config
    const config = {
      name,
      model:  model  ?? "hunyuan-t1-latest",
      system: system ?? "You are a helpful assistant.",
    };

    // If --file provided, load full config from YAML/JSON
    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
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
    if (name)   config.name   = name;
    if (model)  config.model  = model;
    if (system) config.system = system;
    normalizeAgentRuntime(config, args);

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");
    const scfEnvMap = buildScfDeployEnvMap(envId, config, configB64);
    const envVars = scfEnvMapToCliArg(scfEnvMap);
    const memorySize = config.runtime === "harness" ? "512" : "256";

    console.log(bold("Creating agent..."));
    console.log(dim(`  name:    ${config.name}`));
    console.log(dim(`  model:   ${typeof config.model === "string" ? config.model : `${config.model?.id ?? "?"}${config.model?.apiBaseUrl ? ` @ ${config.model.apiBaseUrl}` : ""}`}`));
    console.log(dim(`  code:    ${code}`));
    console.log(dim(`  loop: ${config.runtime ?? "managed"} · scf: ${scfRuntime}`));
    console.log();

    // Bundle node_modules locally so the SCF function has deps available
    const deployDir = resolve("/tmp", `magent-scf-${name}-${Date.now()}`);
    let actualCode = code;
    try {
      execSync(`rm -rf "${deployDir}" && mkdir -p "${deployDir}"`, { encoding: "utf-8" });
      const filesToCopy = ["dist", "package.json", "package-lock.json", "scf_bootstrap", "vendor"];
      const uidShim = resolve(code, "src", "uid-shim.mjs");
      if (existsSync(uidShim)) {
        execSync(`cp "${uidShim}" "${deployDir}/uid-shim.mjs"`, { encoding: "utf-8" });
      }
      if (existsSync(resolve(code, "agent.yaml"))) filesToCopy.push("agent.yaml");
      if (existsSync(resolve(code, "skills"))) filesToCopy.push("skills");
      for (const f of filesToCopy) {
        const src = resolve(code, f);
        if (existsSync(src)) execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
      }
      process.stdout.write(dim("  Installing dependencies... "));
      execSync(
        "npm install --production --os=linux --cpu=x64 --include=optional --force --no-audit --no-fund 2>&1 | tail -2",
        { cwd: deployDir, encoding: "utf-8", timeout: 180000 },
      );
      try { execSync(`rm -f "${deployDir}/node_modules/.package-lock.json"`, { encoding: "utf-8" }); } catch {}
      execSync(
        "npm install --production --os=linux --cpu=x64 --include=optional --force --no-audit --no-fund 2>&1 | tail -2",
        { cwd: deployDir, encoding: "utf-8", timeout: 180000 },
      );
      const linuxPkg = resolve(deployDir, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64", "claude");
      if (!existsSync(linuxPkg)) {
        const present = existsSync(resolve(deployDir, "node_modules", "@anthropic-ai"))
          ? execSync("ls node_modules/@anthropic-ai/", { cwd: deployDir, encoding: "utf-8" }).trim()
          : "(no @anthropic-ai dir)";
        throw new Error(`linux-x64 binary missing at ${linuxPkg}; @anthropic-ai contains: ${present}`);
      }

      console.log(green("OK"));
      actualCode = deployDir;
    } catch (err) {
      console.log(yellow(`  Warning: dep bundling failed: ${err.message?.split("\n")[0]}`));
      console.log(yellow("  Falling back to --install-dep (cloud-side install, slower cold start)"));
    }

    try {
      const alias = toAlias(name);
      const tcbArgs = [
        "agent", "create",
        "--name",        alias,
        "--runtime",     scfRuntime,
        "--code",        actualCode,
        "--ignore",      ".git,node_modules,.DS_Store,.deploy,.deploy-cloudrun,logs",
        "--timeout",     "7200",
        "--memory-size", memorySize,
        "--env",         envVars,
        "-e",            envId,
        ...(actualCode === code ? ["--install-dep"] : []),
        "--json",
      ];
      const raw  = runTcb(tcbArgs, { timeout: 300000 });
      const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      if (data.data?.agentId) {
        console.log(green(`✅ Agent created: ${data.data.agentId}`));
        console.log(dim(`  name:    ${name}`));
        console.log(dim(`  loop: ${config.runtime ?? "managed"} · scf: ${scfRuntime}`));
        console.log();
        console.log("Next steps:");
        console.log(dim(`  1. Wait for ready: magent agent:get -a ${data.data.agentId} -e ${envId}`));
        console.log(dim(`  2. Update config:  magent agent:update -a ${data.data.agentId} -f agent.yaml -e ${envId}`));
        console.log(dim(`  3. Start chatting: magent run -a ${data.data.agentId} -m "Hello"`));
      } else {
        console.log(yellow("Agent creation submitted. Check status with: magent agent:list"));
      }
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
    } catch (err) {
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
      throw new Error(`Failed to create agent: ${err.message}`);
    }
  },

  "agent:list": async (args) => {
    const envId = requireEnvId(args);
    const result = runTcb(["agent", "list", "-e", envId], { timeout: 30000 });
    console.log(result);
  },

  "agent:get": async (args) => {
    const agentId = resolveAgentId(args);
    if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    const envId  = requireEnvId(args);
    const result = runTcb(["agent", "detail", agentId, "-e", envId], { timeout: 30000 });
    console.log(result);
  },

  // ─── Agent Export (live config → YAML) ───────────────────────────────────

  "agent:export": async (args) => {
    const agentId = resolveAgentId(args);
    if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    requireEnvId(args);
    const agentUrl = args.url ?? getAcpUrl({ ...args, agent: agentId });

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
      if (result.agentInfo?.name)  cfg.name        = result.agentInfo.name;
      if (result.agentInfo?.title) cfg.description = result.agentInfo.title;
    } catch (err) {
      console.log(red("FAILED"));
      throw err;
    }
    console.log(green("OK"));

    // Strip internal deployment stamp
    if (cfg.metadata?.__deployedAt) {
      cfg = { ...cfg, metadata: { ...cfg.metadata } };
      delete cfg.metadata.__deployedAt;
      if (Object.keys(cfg.metadata).length === 0) delete cfg.metadata;
    }

    const { stringify } = await import("yaml");
    const yamlText = stringify(cfg, { lineWidth: 0 });

    const outPath = args.output;
    if (outPath) {
      writeFileSync(outPath, yamlText, "utf-8");
      console.log(green(`✅ Config written to ${outPath}`));
    } else {
      process.stdout.write(yamlText);
    }
  },

  "agent:delete": async (args) => {
    const agentId = resolveAgentId(args);
    if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    const envId = requireEnvId(args);

    const { agentType, serviceId } = await lookupAgent(envId, agentId);
    if (!agentType) {
      console.log(yellow(`⚠️  could not look up agent metadata; proceeding with registration delete only.`));
    }

    // Cascade-delete sessions while ACP endpoint is still reachable
    if (agentType !== "baas") {
      try {
        const { getAcpUrl } = await import("../acp.mjs");
        const acpUrl = getAcpUrl({ ...args, agent: agentId });
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
    if (!serviceId) {
      console.log(green(`✅ Agent ${agentId} deleted.`));
      return;
    }

    if (agentType === "tcbr") {
      process.stdout.write(dim(`Deleting cloudrun service '${serviceId}'... `));
      const r = spawnSync(
        getNodeExecutable(),
        [getTcbScript(), "cloudrun", "delete", "-s", serviceId, "-e", envId, "--force"],
        { encoding: "utf-8", timeout: 120000 },
      );
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (r.status === 0 && !/✖|error|failed/i.test(out)) {
        console.log(green("OK"));
      } else if (/not found/i.test(out)) {
        console.log(dim("(already gone)"));
      } else {
        console.log(yellow("FAILED"));
        console.log(dim(out.split("\n").filter((l) => /✖|error/i.test(l)).join("\n").trim() || out.trim().slice(-300)));
      }
    } else if (agentType === "scf") {
      process.stdout.write(dim(`Deleting cloud function '${serviceId}'... `));
      const r = spawnSync(
        getNodeExecutable(),
        [getTcbScript(), "fn", "delete", serviceId, "-e", envId],
        { encoding: "utf-8", timeout: 120000 },
      );
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (r.status === 0 && !/✖|error|failed/i.test(out)) {
        console.log(green("OK"));
      } else if (/not found|不存在|ResourceNotFound/i.test(out)) {
        console.log(dim("(already gone)"));
      } else {
        console.log(yellow("FAILED"));
        console.log(dim(out.split("\n").filter((l) => /✖|error/i.test(l)).join("\n").trim() || out.trim().slice(-300)));
      }
    } else if (agentType === "baas") {
      console.log(dim("(baas agent — no underlying compute to delete)"));
    } else if (agentType) {
      console.log(yellow(`⚠️  unknown agent type '${agentType}', skipping resource cleanup`));
    }

    console.log(green(`✅ Agent ${agentId} deleted.`));
  },

  // ─── Agent Update (config via env var) ───────────────────────────────────

  "agent:update": async (args) => {
    const agentId = resolveAgentId(args);
    if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    const envId  = requireEnvId(args);

    // Fetch current config from running agent
    let currentConfig = null;
    const { getAcpUrl } = await import("../acp.mjs");
    const agentUrl = args.url ?? getAcpUrl({ ...args, agent: agentId });
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
    if (args.name)            updates.name        = args.name;
    if (args.model)           updates.model       = args.model;
    if (args.system)          updates.system      = args.system;
    if (args.description)     updates.description = args.description;
    if (args.tools)           updates.tools       = JSON.parse(args.tools);
    if (args["mcp-servers"])  updates.mcp_servers = JSON.parse(args["mcp-servers"]);
    if (args.skills)          updates.skills      = JSON.parse(args.skills);

    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        let fileConfig;
        if (content.trim().startsWith("{")) {
          fileConfig = JSON.parse(content);
        } else {
          const { parse } = await import("yaml");
          fileConfig = parse(content);
        }
        Object.assign(updates, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file ${args.file}: ${err.message}`);
      }
    }

    if (Object.keys(updates).length === 0) {
      console.log(yellow("No updates specified. Use --system, --model, --tools, -f <file>, etc."));
      return;
    }

    const merged = { ...(currentConfig ?? {}), ...updates };
    normalizeAgentRuntime(merged, args);
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
    console.log();

    const { agentType, serviceId } = await lookupAgent(envId, agentId);

    if (agentType === "tcbr") {
      if (!serviceId) throw new Error(`tcbr agent ${agentId} has no ServiceId`);
      const configWithTs = { ...merged, metadata: { ...(merged.metadata ?? {}), __deployedAt: String(Date.now()) } };
      const configBase64 = Buffer.from(JSON.stringify(configWithTs)).toString("base64");
      const expectedDeployedAt = configWithTs.metadata.__deployedAt;
      const { envMap, credsSource } = buildCloudRunEnvParam({
        envId,
        configB64: configBase64,
        config: configWithTs,
      });
      if (!credsSource) {
        console.log(yellow("⚠️  no TCB_SECRET_* found in shell or tcb login — agent may fail with MISSING_CREDENTIALS"));
      } else if (credsSource === "sts") {
        console.log(dim("(using short-lived tcb-login STS creds — they will expire in ~2h)"));
      }
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

    // SCF path — tcb agent update replaces the whole env map; mirror agent:create.
    const configBase64 = Buffer.from(configJson).toString("base64");
    const scfUpdateEnv = buildScfDeployEnvMap(envId, merged, configBase64);
    const envStr = scfEnvMapToCliArg(scfUpdateEnv);
    process.stdout.write("Applying via tcb agent update... ");
    try {
      const raw = runTcb(
        ["agent", "update", agentId, "--env", envStr, "-e", envId, "--json"],
        { timeout: 120000 },
      );
      const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      console.log(green("OK"));
      if (data.data?.elapsedTime) {
        console.log(dim(`  Elapsed: ${Math.round(data.data.elapsedTime / 1000)}s`));
      }
      console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
    } catch (err) {
      throw new Error(`tcb agent update failed: ${err.message}`);
    }
  },

  // ── SCF image-mode deploy ─────────────────────────────────────────────────

  "scf-image:create": async (args) => {
    const { name, model, system } = args;
    if (!name) throw new Error("-n / --name is required");
    const envId = requireEnvId(args);
    const code  = args.code ?? "./packages/agent-runtime";
    const dockerfile = args.dockerfile ?? "Dockerfile.scf";
    const namespace = args.namespace ?? process.env.CCR_NAMESPACE;
    if (!namespace) {
      throw new Error("--namespace <ccr-namespace> is required (or set CCR_NAMESPACE). " +
        "This is the Tencent Container Registry namespace under ccr.ccs.tencentyun.com/<namespace>/.");
    }

    const config = {
      name,
      model:  model  ?? "hunyuan-t1-latest",
      system: system ?? "You are a helpful assistant.",
    };
    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        const fileConfig = content.trim().startsWith("{")
          ? JSON.parse(content)
          : (await import("yaml")).parse(content);
        Object.assign(config, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file: ${err.message}`);
      }
    }
    if (name)   config.name   = name;
    if (model)  config.model  = model;
    if (system) config.system = system;
    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    const slug = toAlias(name);
    const tag = args.tag ?? `${Date.now()}`;
    const imageUri = `ccr.ccs.tencentyun.com/${namespace}/${slug}:${tag}`;
    const fnName = args.function ?? slug;

    console.log(bold("Creating SCF image-mode agent..."));
    console.log(dim(`  name:        ${config.name}`));
    console.log(dim(`  model:       ${typeof config.model === "string" ? config.model : `${config.model?.id ?? "?"}${config.model?.apiBaseUrl ? ` @ ${config.model.apiBaseUrl}` : ""}`}`));
    console.log(dim(`  function:    ${fnName}`));
    console.log(dim(`  image:       ${imageUri}`));
    console.log(dim(`  envId:       ${envId}`));
    console.log();

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
        `Hint: SCF requires linux/amd64 images; on arm64 macs, use colima with --arch x86_64 ` +
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
          memorySize: Number(args["memory-size"] ?? 512),
          envVariables: {
            CLOUDBASE_ENV_ID: envId,
            AGENT_CONFIG_B64: configB64,
            ...(process.env.TCB_API_KEY
              ? { TCB_API_KEY: process.env.TCB_API_KEY }
              : { OAK_DISABLE_SANDBOX: "1" }),
          },
          imageConfig: {
            imageType: "personal",
            imageUri,
            imagePort: 9000,
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
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
      throw new Error(`tcb fn deploy failed: ${err.message}`);
    }
    try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}

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
  },
};
