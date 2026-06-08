/**
 * Cloud harness: deploy + gateway ACP smoke.
 *   npm run harness -- cloud       # 云托管 tcbr（默认）
 *   npm run harness -- cloud-scf   # SCF 云函数
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const runtimeRoot = resolve(repoRoot, "packages/agent-runtime");
const magent = resolve(repoRoot, "magent.mjs");

const DEFAULT_GATEWAY_READY_MS = 5 * 60_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/** tcbr redeploy may still hold the service lock when agent:update runs. */
async function agentUpdateWithRetry(agentId, yamlPath, envId, opts = {}) {
  const cmd = `node "${magent}" agent:update -i "${agentId}" -f "${yamlPath}" --runtime harness --engine opencode -e "${envId}"`;
  const maxAttempts = Number(process.env.HARNESS_CLOUD_UPDATE_RETRIES) || 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`\n=== magent agent:update ${agentId} (attempt ${attempt}/${maxAttempts}) ===\n`);
      execSync(cmd, {
        cwd: repoRoot,
        env: opts.env ?? process.env,
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

async function buildAgentYaml() {
  const templatePath = resolve(runtimeRoot, "agent.harness.cloud.yaml");
  const { parse, stringify } = await import("yaml");
  const doc = parse(readFileSync(templatePath, "utf8"));
  const apiKey = process.env.LLM_API_KEY?.trim();
  const openaiBase = process.env.OPENAI_BASE_URL?.trim();
  const modelId = process.env.LLM_MODEL?.trim() || "mimo-v2.5-pro";

  if (apiKey && openaiBase) {
    doc.model = { id: modelId, apiKey };
    console.log(`agent model: custom LLM ${modelId} (OPENAI_BASE_URL=${openaiBase})`);
  } else {
    doc.model = "zen";
    console.log("agent model: zen (no LLM_API_KEY + OPENAI_BASE_URL → built-in zen)");
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

function pinnedAgentId(backend) {
  const fromEnv =
    backend === "scf"
      ? process.env.HARNESS_CLOUD_SCF_AGENT_ID?.trim()
      : process.env.HARNESS_CLOUD_AGENT_ID?.trim();
  return fromEnv;
}

async function deployCloudHarness(argv, backend = "tcbr") {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");

  const agentIdArg =
    flagValue(argv, "--agent-id") || pinnedAgentId(backend);

  console.log(`=== build agent-runtime (backend=${backend}) ===`);
  sh("npm run build --workspace=packages/agent-runtime");

  const yamlPath = await buildAgentYaml();
  console.log(`Wrote ${yamlPath}`);

  let agentId = agentIdArg;

  if (agentId) {
    if (backend === "tcbr") {
      console.log(`=== magent cloudrun:redeploy ${agentId} ===`);
      sh(`node "${magent}" cloudrun:redeploy -i "${agentId}" -e "${envId}" --code "${runtimeRoot}"`);
      await agentUpdateWithRetry(agentId, yamlPath, envId, { afterRedeploy: true });
    } else {
      console.log(`=== magent agent:update (SCF harness ${agentId}) ===`);
      await agentUpdateWithRetry(agentId, yamlPath, envId);
    }
  } else if (backend === "tcbr") {
    console.log("=== magent agent:create (tcbr harness, ~3–5 min) ===");
    const createOut = execSync(
      `node "${magent}" agent:create -n "OMA-Harness" --type tcbr --runtime harness --engine opencode -f "${yamlPath}" -e "${envId}"`,
      { encoding: "utf-8", cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    console.log(createOut);
    agentId = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i)?.[1];
  } else {
    console.log("=== magent agent:create (SCF harness, ~60–90s) ===");
    const createOut = execSync(
      `node "${magent}" agent:create -n "OMA-Harness-SCF" --runtime harness --engine opencode -f "${yamlPath}" --code "${runtimeRoot}" -e "${envId}"`,
      { encoding: "utf-8", cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    console.log(createOut);
    agentId = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i)?.[1];
  }

  if (!agentId) {
    throw new Error("Could not resolve agent id — pass --agent-id or set HARNESS_CLOUD_AGENT_ID (harness pin only)");
  }
  console.log(`\nAgent ID: ${agentId}`);

  let base = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (!base || base.includes("127.0.0.1") || base.includes("localhost")) {
    try {
      const detail = execSync(`node "${magent}" agent:get -i "${agentId}" -e "${envId}"`, {
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
    process.env.CLOUDBASE_SERVER_URL = base;
    sh(`curl -sf "${base}/healthz" | head -c 800`);
    console.log("\n");
    await agentUpdateWithRetry(agentId, yamlPath, envId, {
      env: { ...process.env, CLOUDBASE_SERVER_URL: base },
    });
  } else {
    console.warn("WARN: set CLOUDBASE_SERVER_URL to public gateway for client-tool callback");
  }

  return agentId;
}

/** Post-create: tcbr build may be "ready" while gateway bot route still 404. */
async function waitForCloudAgentGateway(agentId, envId) {
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
      if (json.error) throw new Error(`initialize: ${json.error.message}`);
      const runtime = json.result?.agentConfig?.runtime;
      if (runtime !== "harness") {
        throw new Error(`initialize runtime=${runtime ?? "missing"} (expected harness)`);
      }
      console.log(
        `✓ gateway ACP ready ${elapsed}ms runtime=${runtime} engine=${json.result?.agentConfig?.engine ?? "n/a"}`,
      );
      return json.result;
    } catch (err) {
      if (/expected harness/.test(err.message)) throw err;
      process.stdout.write(`  ... ${err.message?.slice(0, 60) || "retry"} (${Math.round(elapsed / 1000)}s)\r`);
      await sleep(5000);
    }
  }
  throw new Error(`gateway ACP not ready for ${agentId} after ${maxWaitMs}ms`);
}

async function magentRunPong(agentId, envId) {
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
      await waitForCloudAgentGateway(agentId, envId);
    }
  }
}

async function getAuthHeaders(envId) {
  const _require = createRequire(import.meta.url);
  const { sign } = _require("@cloudbase/signature-nodejs");
  let accessKey = process.env.CLOUDBASE_ACCESS_KEY?.trim() ?? "";
  if (!accessKey) {
    const home = process.env.HOME ?? "";
    const raw = readFileSync(resolve(home, ".config/.cloudbase/auth.json"), "utf8");
    const c = JSON.parse(raw).credential;
    const host = `${envId}.api.tcloudbasegateway.com`;
    const url = `https://${host}/auth/v1/token/clientCredential`;
    const headers = { "Content-Type": "application/json", Host: host };
    const data = { grant_type: "client_credentials" };
    const ts = Math.floor(Date.now() / 1000) - 1;
    const { authorization } = sign({
      secretId: c.tmpSecretId,
      secretKey: c.tmpSecretKey,
      method: "POST",
      url,
      headers,
      params: data,
      timestamp: ts,
      withSignedParams: false,
      isCloudApi: false,
      service: "tcb",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, Authorization: authorization, "X-TC-Timestamp": String(ts) },
      body: JSON.stringify(data),
    });
    const j = await res.json();
    accessKey = j.access_token ?? j.accessToken ?? "";
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessKey}`,
    "X-CloudBase-Env-Id": envId,
  };
}

async function verifyCloudHarness(agentId) {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");
  if (!agentId) throw new Error("Missing agent id for verify");

  const acpUrl = gatewayAcpUrl(envId, agentId);

  async function acpCall(method, params) {
    const headers = await getAuthHeaders(envId);
    const res = await fetch(acpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }

  const ms = (t0) => `${Date.now() - t0}ms`;

  console.log(`\n=== cloud verify ===`);
  console.log(`agent: ${agentId}`);
  console.log(`env:   ${envId}\n`);

  // Gateway does not expose GET …/healthz — use ACP initialize (same path as magent run).
  const tInit = Date.now();
  const init = await acpCall("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "harness-cloud", version: "0" },
  });
  console.log(
    `initialize: ${ms(tInit)} runtime=${init.agentConfig?.runtime} engine=${init.agentConfig?.engine}`,
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
      hasTimeout: /timeout/i.test(text),
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

  if (warmTimeout || p1.has504 || p2.has504 || !p1.ok || !p2.ok) {
    throw new Error("cloud verify failed (prewarm timeout, non-200, or 504)");
  }

  console.log("\n✓ cloud verify ok");
}

/** Fail fast when .env.harness has custom LLM (Mimo tp/sk, etc.) before deploy. */
async function maybeProbeCustomLlm() {
  const { hasHarnessCustomLlmEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
  );
  if (!hasHarnessCustomLlmEnv()) {
    console.log("=== cloud: LLM probe skipped（无 LLM_* → deploy 用 zen）===");
    return;
  }
  console.log("=== cloud: LLM probe（自定义 provider，deploy 前验 key）===");
  const { assertHarnessOpenAiLlmReachable } = await import(
    "../../packages/agent-runtime/dist/harness/llm-probe.js"
  );
  const probe = await assertHarnessOpenAiLlmReachable();
  console.log(
    `✓ LLM probe ${probe.latencyMs}ms model=${probe.model} reply=${probe.replySnippet ?? "(empty)"}`,
  );
}

/** @param {string[]} argv process.argv slice from harness.mjs */
/** @param {{ backend?: "tcbr" | "scf" }} [opts] */
export async function runCloudHarness(argv = [], opts = {}) {
  const verifyOnly = hasFlag(argv, "--verify-only");
  const deployOnly = hasFlag(argv, "--no-verify");
  const backend = resolveCloudBackend(argv, opts.backend);

  await maybeProbeCustomLlm();

  let agentId =
    flagValue(argv, "--agent-id") || pinnedAgentId(backend);

  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");

  console.log(`\n=== cloud harness backend: ${backend} ===\n`);

  if (!verifyOnly) {
    agentId = await deployCloudHarness(argv, backend);
    await waitForCloudAgentGateway(agentId, envId);
    await magentRunPong(agentId, envId);
  }

  if (!deployOnly) {
    if (verifyOnly) await waitForCloudAgentGateway(agentId, envId);
    await verifyCloudHarness(agentId);
  }

  const pinVar = backend === "scf" ? "HARNESS_CLOUD_SCF_AGENT_ID" : "HARNESS_CLOUD_AGENT_ID";
  console.log(`\n✓ Cloud harness (${backend}) done. Agent: ${agentId}`);
  console.log(`  pin: ${pinVar}=${agentId}`);
  return agentId;
}
