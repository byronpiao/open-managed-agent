/**
 * Cloud harness: deploy (tcbr) + prompt smoke. Internal — use `npm run harness -- cloud`.
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

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, { stdio: "inherit", cwd: repoRoot, ...opts });
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

async function deployCloudHarness(argv) {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");

  const agentIdArg = flagValue(argv, "--agent-id") || process.env.HARNESS_CLOUD_AGENT_ID?.trim();

  console.log("=== build agent-runtime ===");
  sh("npm run build --workspace=packages/agent-runtime");

  const yamlPath = await buildAgentYaml();
  console.log(`Wrote ${yamlPath}`);

  let agentId = agentIdArg;

  if (agentId) {
    console.log(`=== magent cloudrun:redeploy ${agentId} ===`);
    sh(`node "${magent}" cloudrun:redeploy -i "${agentId}" -e "${envId}" --code "${runtimeRoot}"`);
    console.log(`=== magent agent:update ${agentId} ===`);
    sh(
      `node "${magent}" agent:update -i "${agentId}" -f "${yamlPath}" --runtime harness --engine opencode -e "${envId}"`,
    );
  } else {
    console.log("=== magent agent:create (tcbr harness, ~3–5 min) ===");
    const createOut = execSync(
      `node "${magent}" agent:create -n "OMA-Harness" --type tcbr --runtime harness --engine opencode -f "${yamlPath}" -e "${envId}"`,
      { encoding: "utf-8", cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    console.log(createOut);
    agentId = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i)?.[1];
  }

  if (!agentId) {
    throw new Error("Could not resolve agent id — set HARNESS_CLOUD_AGENT_ID or --agent-id");
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
    sh(
      `node "${magent}" agent:update -i "${agentId}" -f "${yamlPath}" --runtime harness --engine opencode -e "${envId}"`,
      { env: { ...process.env, CLOUDBASE_SERVER_URL: base } },
    );
  } else {
    console.warn("WARN: set CLOUDBASE_SERVER_URL to public gateway for client-tool callback");
  }

  return agentId;
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

  const acpUrl = `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}/acp`;

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

/** @param {string[]} argv process.argv slice from harness.mjs */
export async function runCloudHarness(argv = []) {
  const verifyOnly = hasFlag(argv, "--verify-only");
  const deployOnly = hasFlag(argv, "--no-verify");

  let agentId = flagValue(argv, "--agent-id") || process.env.HARNESS_CLOUD_AGENT_ID?.trim();

  if (!verifyOnly) {
    agentId = await deployCloudHarness(argv);
    console.log("\n=== magent run pong ===");
    sh(`node "${magent}" run -a "${agentId}" -e "${process.env.CLOUDBASE_ENV_ID}" -m "Reply with exactly: pong"`);
  }

  if (!deployOnly) {
    await verifyCloudHarness(agentId);
  }

  console.log(`\n✓ Cloud harness done. Agent: ${agentId}`);
  console.log(`  Tip: set HARNESS_CLOUD_AGENT_ID=${agentId} in .env.harness for update (not create)`);
  return agentId;
}
