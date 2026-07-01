/**
 * Cloud harness: deploy + gateway ACP smoke.
 *
 *   npm run harness -- run --infra tcbr --engine opencode
 *   npm run harness -- run --infra scf --engine claude
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAccessTokenViaSign, readTcbLoginCredential } from "../../lib/credentials.mjs";
import { pinnedHarnessToolId } from "../../lib/harness-env-file.mjs";
import { resolveHarnessByokModel } from "../../lib/harness-llm-env.mjs";
import {
  applyHarnessScenario,
  cloudHarnessAgentPinVar,
  cloudHarnessScenario,
  logHarnessScenario,
  parseCloudCosMount,
  parseHarnessEnginesArg,
  pinnedCloudHarnessAgentId,
  resolveHarnessAgentYaml,
} from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const runtimeRoot = resolve(repoRoot, "packages/agent-runtime");
const magent = resolve(repoRoot, "magent.mjs");

const DEFAULT_GATEWAY_READY_MS = 5 * 60_000;
const SCF_CREATE_COOLDOWN_MS = Number(process.env.HARNESS_SCF_CREATE_COOLDOWN_MS) || 90_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function harnessDeployEnv(backend = "tcbr", engine = "opencode", argv = []) {
  const env = { ...process.env };
  if (!pinnedHarnessToolId()) delete env.HARNESS_TOOL_ID;
  const cloudCosMount = parseCloudCosMount(argv);
  const meta = applyHarnessScenario(cloudHarnessScenario(backend, engine), env, {
    cloudCosMount,
  });
  logHarnessScenario(meta);
  return env;
}

function gatewayAcpUrl(envId, agentId) {
  return `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}/acp`;
}

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, { stdio: "inherit", cwd: repoRoot, ...opts });
}

function execOutputBlob(err) {
  return `${err?.message ?? ""}${err?.stdout ?? ""}${err?.stderr ?? ""}`;
}

async function agentUpdateWithRetry(agentId, yamlPath, envId, opts = {}) {
  const engine = opts.engine ?? "opencode";
  const cmd = `node "${magent}" agent:update -a "${agentId}" -f "${yamlPath}" --agent-runtime harness --engine ${engine} -e "${envId}"`;
  const maxAttempts = Number(process.env.HARNESS_CLOUD_UPDATE_RETRIES) || 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`\n=== magent agent:update ${agentId} engine=${engine} (attempt ${attempt}/${maxAttempts}) ===\n`);
      execSync(cmd, {
        cwd: repoRoot,
        env: opts.env ?? harnessDeployEnv(opts.backend ?? "tcbr", engine, opts.argv ?? []),
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
      });
      return;
    } catch (err) {
      if (err.stdout) process.stdout.write(err.stdout);
      if (err.stderr) process.stderr.write(err.stderr);
      const blob = execOutputBlob(err);
      const locked = /ResourceInUse|部署发布任务运行中/i.test(blob);
      const retryable = locked || (opts.afterRedeploy && attempt < maxAttempts);
      if (retryable) {
        console.warn(
          locked
            ? "agent:update: deploy still in flight — retry in 15s…"
            : `agent:update failed after redeploy — retry ${attempt}/${maxAttempts} in 15s…`,
        );
        await sleep(15_000);
        continue;
      }
      throw err;
    }
  }
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

export function resolveCloudHarnessEngine(argv = []) {
  return parseHarnessEnginesArg(argv);
}

async function buildAgentYaml(backend = "tcbr", engine = "opencode") {
  const scenario = cloudHarnessScenario(backend, engine);
  const templatePath = resolveHarnessAgentYaml(scenario);
  const { parse, stringify } = await import("yaml");
  const doc = parse(readFileSync(templatePath, "utf8"));
  doc.engine = engine;

  const apiKey = process.env.LLM_API_KEY?.trim();
  const modelId = resolveHarnessByokModel();

  if (engine === "claude") {
    const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim();
    if (!apiKey || !modelId || !anthropicBase) {
      throw new Error(
        `cloud-${backend}-claude 需要 .env.harness ③ 段：LLM_API_KEY + LLM_MODEL + ANTHROPIC_BASE_URL`,
      );
    }
    doc.model = { id: modelId, apiKey };
    console.log(
      `agent: engine=claude model=${modelId} (${backend}, ANTHROPIC_BASE_URL=${anthropicBase})`,
    );
  } else if (backend === "scf") {
    const openaiBase = process.env.OPENAI_BASE_URL?.trim();
    if (!apiKey || !openaiBase) {
      throw new Error(
        "cloud-scf-opencode 需要 .env.harness ③ 段：LLM_API_KEY + LLM_MODEL + OPENAI_BASE_URL",
      );
    }
    doc.model = { id: modelId, apiKey };
    console.log(`agent: engine=opencode model=${modelId} (cloud-scf, OPENAI_BASE_URL=${openaiBase})`);
  } else {
    doc.model = "zen";
    console.log("agent: engine=opencode model=zen (cloud-tcbr — 箱内 OpenCode 内置)");
  }

  const out = resolve(runtimeRoot, "agent.harness.yaml");
  writeFileSync(out, stringify(doc));
  return out;
}

function resolveCloudBackend(argv, explicitBackend) {
  const fromFlag = flagValue(argv, "--backend")?.toLowerCase();
  if (fromFlag === "scf" || fromFlag === "tcbr") return fromFlag;
  if (explicitBackend === "scf" || explicitBackend === "tcbr") return explicitBackend;
  return "tcbr";
}

function pinnedAgentId(backend, engine = "opencode") {
  const fromArgv = flagValue([], "--agent-id");
  if (fromArgv) return fromArgv;
  return pinnedCloudHarnessAgentId(backend, engine);
}

function createAgentName(backend, engine) {
  if (engine === "claude") {
    return backend === "scf" ? "OMA-Hrn-Cld-SCF" : "OMA-Hrn-Cld-TCBR";
  }
  return backend === "scf" ? "OMA-Harness-SCF" : "OMA-Harness";
}

async function deployCloudHarness(argv, backend = "tcbr", engine = "opencode") {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");

  const agentIdArg = flagValue(argv, "--agent-id") || pinnedCloudHarnessAgentId(backend, engine);

  console.log(`=== build agent-runtime (backend=${backend} engine=${engine}) ===`);
  sh("npm run build --workspace=packages/agent-runtime");

  const yamlPath = await buildAgentYaml(backend, engine);
  console.log(`Wrote ${yamlPath}`);

  let agentId = agentIdArg;

  if (agentId) {
    const updateLabel = `magent agent:update (${backend} harness ${engine} ${agentId})`;
    console.log(`=== ${updateLabel} ===`);
    await agentUpdateWithRetry(agentId, yamlPath, envId, {
      afterRedeploy: true,
      backend,
      engine,
      argv,
    });
  } else if (backend === "tcbr") {
    console.log(`=== magent agent:create (tcbr harness ${engine}, ~3–5 min) ===`);
    const createOut = execSync(
      `node "${magent}" agent:create -n "${createAgentName(backend, engine)}" --type tcbr --agent-runtime harness --engine ${engine} -f "${yamlPath}" -e "${envId}"`,
      {
        encoding: "utf-8",
        cwd: repoRoot,
        env: harnessDeployEnv(backend, engine, argv),
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    console.log(createOut);
    agentId = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i)?.[1];
  } else {
    const pinVar = cloudHarnessAgentPinVar(backend, engine);
    const pinned = pinnedCloudHarnessAgentId(backend, engine);
    if (pinned) {
      console.log(`Tip: pin ${pinVar}=${pinned} in .env.harness to reuse on update+verify.`);
    }
    console.log(
      `=== magent agent:create (SCF harness ${engine}, ~60–90s; cooldown ${Math.round(SCF_CREATE_COOLDOWN_MS / 1000)}s) ===`,
    );
    console.log("(avoid SCF Deleting-state 435 — waiting before create…)");
    await sleep(SCF_CREATE_COOLDOWN_MS);
    const createOut = execSync(
      `node "${magent}" agent:create -n "${createAgentName(backend, engine)}" --type scf --agent-runtime harness --engine ${engine} -f "${yamlPath}" -e "${envId}"`,
      {
        encoding: "utf-8",
        cwd: repoRoot,
        env: harnessDeployEnv(backend, engine, argv),
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    console.log(createOut);
    agentId = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i)?.[1];
  }

  if (!agentId) {
    throw new Error(
      `Could not resolve agent id — pass --agent-id or set ${cloudHarnessAgentPinVar(backend, engine)} in .env.harness`,
    );
  }
  console.log(`\nAgent ID: ${agentId}`);

  // Pinned agent path already ran agent:update above.
  if (agentIdArg) {
    return agentId;
  }

  // Post-create: deploy harness env (CLOUDBASE_AGENT_ID; TCBR may override callback URL).
  if (backend === "tcbr") {
    let base = process.env.CLOUDBASE_SERVER_URL?.trim();
    if (!base || base.includes("127.0.0.1") || base.includes("localhost")) {
      try {
        const detail = execSync(`node "${magent}" agent:get -a "${agentId}" -e "${envId}"`, {
          encoding: "utf-8",
        });
        const urlMatch = detail.match(/https:\/\/[^\s]+\.tcloudbase\.com[^\s]*/i);
        if (urlMatch) base = urlMatch[0].replace(/[)\],]+$/, "");
      } catch {
        /* optional */
      }
    }

    if (base && !base.includes("127.0.0.1")) {
      console.log(`\n=== healthz ${base}/healthz ===`);
      sh(`curl -sf "${base}/healthz" | head -c 800`);
      console.log("\n");
      await agentUpdateWithRetry(agentId, yamlPath, envId, {
        env: { ...harnessDeployEnv(backend, engine, argv), CLOUDBASE_SERVER_URL: base },
        backend,
        engine,
        argv,
      });
    } else {
      console.warn("WARN: could not resolve TCBR service URL for client-tool callback");
      await agentUpdateWithRetry(agentId, yamlPath, envId, { backend, engine, argv });
    }
  } else {
    await agentUpdateWithRetry(agentId, yamlPath, envId, { backend, engine, argv });
  }

  return agentId;
}

async function waitForCloudAgentGateway(agentId, envId, expectedEngine = "opencode") {
  const acpUrl = gatewayAcpUrl(envId, agentId);
  const maxWaitMs = Number(process.env.HARNESS_CLOUD_READY_MS) || DEFAULT_GATEWAY_READY_MS;
  const started = Date.now();
  console.log("\n=== cloud: wait for gateway ACP ===");

  while (Date.now() - started < maxWaitMs) {
    const elapsed = Date.now() - started;
    try {
      const headers = await getAuthHeaders(envId);
      const res = await fetch(acpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "harness-cloud-ready", version: "0" },
          },
        }),
      });
      const text = await res.text();
      if (res.status === 404 || /default backend\s*-\s*404/i.test(text)) {
        process.stdout.write(`  ... gateway 404 (${Math.round(elapsed / 1000)}s)\r`);
        await sleep(5000);
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`initialize not JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
      if (isGatewayAuthFailure(res, json, text)) {
        process.stdout.write(`  ... gateway auth (${Math.round(elapsed / 1000)}s)\r`);
        await sleep(3000);
        continue;
      }
      if (json.error) throw new Error(`initialize: ${json.error.message}`);
      const runtime = json.result?.agentConfig?.runtime;
      const engine = json.result?.agentConfig?.engine;
      if (runtime !== "harness") {
        throw new Error(`initialize runtime=${runtime ?? "missing"} (expected harness)`);
      }
      if (engine !== expectedEngine) {
        throw new Error(`initialize engine=${engine ?? "missing"} (expected ${expectedEngine})`);
      }
      console.log(`✓ gateway ACP ready ${elapsed}ms runtime=${runtime} engine=${engine}`);
      return json.result;
    } catch (err) {
      if (/expected (harness|engine)/.test(err.message)) throw err;
      process.stdout.write(`  ... ${err.message?.slice(0, 60) || "retry"} (${Math.round(elapsed / 1000)}s)\r`);
      await sleep(5000);
    }
  }
  throw new Error(`gateway ACP not ready for ${agentId} after ${maxWaitMs}ms`);
}

async function magentRunPong(agentId, envId, expectedEngine = "opencode") {
  const cmd = `node "${magent}" run -a "${agentId}" -e "${envId}" -m "Reply with exactly: pong"`;
  const maxAttempts = Number(process.env.HARNESS_CLOUD_MAGENT_RETRIES) || 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`\n=== magent run pong (attempt ${attempt}/${maxAttempts}) ===`);
      sh(cmd);
      return;
    } catch {
      if (attempt >= maxAttempts) {
        throw new Error(`magent run failed after ${maxAttempts} attempts`);
      }
      console.warn(`magent run failed — retry in 10s…`);
      await sleep(10_000);
      await waitForCloudAgentGateway(agentId, envId, expectedEngine);
    }
  }
}

async function getAuthHeaders(envId) {
  const sessionToken =
    process.env.TCB_SESSION_TOKEN?.trim() ||
    process.env.TENCENTCLOUD_TOKEN?.trim() ||
    "";
  const secretId = process.env.TCB_SECRET_ID?.trim();
  const secretKey = process.env.TCB_SECRET_KEY?.trim();
  let accessKey = "";

  if (secretId && secretKey) {
    accessKey = await fetchAccessTokenViaSign({
      envId,
      secretId,
      secretKey,
      token: sessionToken,
    });
  } else {
    const cred = readTcbLoginCredential();
    if (cred) {
      accessKey = await fetchAccessTokenViaSign({ envId, ...cred });
    }
  }

  if (!accessKey) {
    accessKey = process.env.CLOUDBASE_APIKEY?.trim() ?? "";
  }
  if (!accessKey) {
    throw new Error(
      "No gateway access token — set TCB_SECRET_ID/TCB_SECRET_KEY in .env.harness or run magent login",
    );
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessKey}`,
    "X-CloudBase-Env-Id": envId,
  };
}

function isGatewayAuthFailure(res, json, text) {
  if (res.status === 401 || res.status === 403) return true;
  const code = json?.code ?? json?.error?.code ?? "";
  return (
    /ACCESS_TOKEN_EXPIRED|INVALID_ACCESS_TOKEN|UNAUTHORIZED/i.test(String(code)) ||
    /ACCESS_TOKEN_EXPIRED|invalid.*token/i.test(text)
  );
}

/** @param {{ warmTimeout: boolean, p1: { ok: boolean, has504: boolean }, p2: { ok: boolean, has504: boolean } }} result */
export function cloudVerifyPromptsPassed({ warmTimeout, p1, p2 }) {
  if (warmTimeout) return false;
  if (!p2.ok || p2.has504) return false;
  if (p1.ok) return true;
  // Cold gateway: first prompt may 504 after prewarm; second must succeed.
  if (p1.has504) return true;
  return false;
}

async function verifyCloudHarness(agentId, expectedEngine = "opencode") {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");
  if (!agentId) throw new Error("Missing agent id for verify");

  const acpUrl = gatewayAcpUrl(envId, agentId);

  async function acpCall(method, params, { retries = 8 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const headers = await getAuthHeaders(envId);
      const res = await fetch(acpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        const retryable =
          attempt < retries &&
          (res.status >= 500 || res.status === 404 || text.trimStart().startsWith("<"));
        if (retryable) {
          await sleep(2000);
          continue;
        }
        throw new Error(`${method} not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    }
    throw new Error(`${method} failed after ${retries} attempts`);
  }

  const ms = (t0) => `${Date.now() - t0}ms`;

  console.log(`\n=== cloud verify (engine=${expectedEngine}) ===`);
  console.log(`agent: ${agentId}`);
  console.log(`env:   ${envId}\n`);

  const tInit = Date.now();
  const init = await acpCall("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "harness-cloud", version: "0" },
  });
  const engine = init.agentConfig?.engine;
  if (engine !== expectedEngine) {
    throw new Error(`verify engine=${engine ?? "missing"} (expected ${expectedEngine})`);
  }
  console.log(
    `initialize: ${ms(tInit)} runtime=${init.agentConfig?.runtime} engine=${engine}`,
  );

  const tNew = Date.now();
  const { sessionId } = await acpCall("session/new", { meta: { userId: "harness-cloud" } });
  console.log(`session/new: ${ms(tNew)} id=${sessionId}`);

  const warmT0 = Date.now();
  let polls = 0;
  let instanceId;
  let warmTimeout = false;
  while (Date.now() - warmT0 < 5 * 60_000) {
    polls++;
    const st = await acpCall("session/status", { sessionId });
    if (st.sandboxReady) {
      instanceId = st.instanceId;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!instanceId) warmTimeout = true;
  const warmMs = Date.now() - warmT0;
  console.log(
    `prewarm: ${warmMs}ms polls=${polls} instance=${instanceId ?? "n/a"}${warmTimeout ? " TIMEOUT" : ""}`,
  );

  async function promptOnce() {
    const headers = await getAuthHeaders(envId);
    const t0 = Date.now();
    const res = await fetch(acpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 203,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "Reply with exactly: pong" }],
        },
      }),
    });
    const text = await res.text();
    return {
      httpStatus: res.status,
      totalMs: Date.now() - t0,
      has504: res.status === 504 || text.includes("504"),
      ok: res.status === 200 && !text.includes("504"),
    };
  }

  const p1 = await promptOnce();
  console.log(`prompt#1: status=${p1.httpStatus} total=${p1.totalMs}ms ok=${p1.ok} 504=${p1.has504}`);

  await new Promise((r) => setTimeout(r, 3000));
  const p2 = await promptOnce();
  console.log(`prompt#2: status=${p2.httpStatus} total=${p2.totalMs}ms ok=${p2.ok} 504=${p2.has504}`);

  try {
    await acpCall("session/delete", { sessionId });
  } catch {
    /* ignore */
  }

  if (!cloudVerifyPromptsPassed({ warmTimeout, p1, p2 })) {
    throw new Error("cloud verify failed (prewarm timeout, non-200, or 504)");
  }
  if (p1.has504 && p2.ok) {
    console.log("(prompt#1 cold-start 504 ignored — prompt#2 ok)");
  }

  console.log("\n✓ cloud verify ok");
}

async function maybeProbeLlm(backend = "tcbr", engine = "opencode") {
  const { runHarnessLlmPreflight } = await import("./llm-preflight.mjs");
  const scenario = engine === "claude" ? `cloud-${backend}-claude` : `cloud-${backend}-opencode`;
  console.log(`=== ${scenario}: LLM preflight（deploy 前）===`);
  const result = await runHarnessLlmPreflight(scenario, { allowTestFallback: false });
  if (result.probe?.ok) {
    console.log(
      `✓ ${result.protocol} llm=${result.mode} ${result.probe.latencyMs}ms ` +
        `model=${result.probe.model} reply=${result.probe.replySnippet ?? "(empty)"}`,
    );
  } else if (result.mode === "zen") {
    console.log("✓ tier=zen (no host probe)");
  }
}

/** @param {string[]} argv process.argv slice from harness.mjs */
/** @param {{ backend?: "tcbr" | "scf"; engine?: "opencode" | "claude" }} [opts] */
export async function runCloudHarness(argv = [], opts = {}) {
  const verifyOnly = hasFlag(argv, "--verify-only");
  const deployOnly = hasFlag(argv, "--no-verify");
  const backend = resolveCloudBackend(argv, opts.backend);
  const engine = opts.engine ?? resolveCloudHarnessEngine(argv);

  await maybeProbeLlm(backend, engine);

  let agentId = flagValue(argv, "--agent-id") || pinnedCloudHarnessAgentId(backend, engine);

  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");

  console.log(`\n=== cloud harness backend=${backend} engine=${engine} ===\n`);

  if (!verifyOnly) {
    agentId = await deployCloudHarness(argv, backend, engine);
    await waitForCloudAgentGateway(agentId, envId, engine);
    await magentRunPong(agentId, envId, engine);
  }

  if (!deployOnly) {
    if (verifyOnly) await waitForCloudAgentGateway(agentId, envId, engine);
    await verifyCloudHarness(agentId, engine);
    const {
      verifyCloudOpencodeSync,
      verifyCloudClaudeSessionStore,
    } = await import("./cloud-session-verify.mjs");
    if (engine === "claude") {
      await verifyCloudClaudeSessionStore(agentId, envId);
    } else {
      await verifyCloudOpencodeSync(agentId, envId);
    }
    const { maybeRunCloudDbPressure } = await import("./db-pressure.mjs");
    await maybeRunCloudDbPressure(agentId, envId, engine, argv);
  }

  const pinVar = cloudHarnessAgentPinVar(backend, engine);
  console.log(`\n✓ Cloud harness (${backend}/${engine}) done. Agent: ${agentId}`);
  console.log(`  pin: ${pinVar}=${agentId}`);
  return agentId;
}
