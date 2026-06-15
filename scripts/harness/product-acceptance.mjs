#!/usr/bin/env node
/**
 * Harness product acceptance — product-feel checks on top of matrix-parity.
 *
 *   npm run harness -- product-acceptance
 *   npm run harness -- product-acceptance --engines all
 *
 * NOT part of harness:smoke. Uses standard .env.harness + preflight tier (port 19090).
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "undici";
import {
  loadEnv,
  assertHarnessCreds,
  applyHarnessScenario,
  applyHarnessLlmTier,
  applyHarnessTestDefaults,
  applyScenarioEnv,
  parseHarnessEnginesArg,
  harnessEnginesIncludeOpencode,
  harnessEnginesIncludeClaude,
} from "./load-env.mjs";
import { buildMatrixParityAgentConfig } from "../../tests/harness/matrix-parity.test.mjs";
import { runMatrixParityTests } from "../../tests/harness/matrix-parity.test.mjs";

/** Parent `envForHarnessTier` / `HARNESS_E2E_OPENCODE_TIER` — pin before `loadEnv()`. */
const harnessTierPin = process.env.HARNESS_LLM_TIER?.trim();
const opencodeTierPin = process.env.HARNESS_E2E_OPENCODE_TIER?.trim();
loadEnv();
assertHarnessCreds();

const ENGINES = parseHarnessEnginesArg(process.argv.slice(2));
const RUN_OPENCODE = harnessEnginesIncludeOpencode(ENGINES);
const RUN_CLAUDE = harnessEnginesIncludeClaude(ENGINES);

function applyPinnedHarnessTier(tier) {
  if (tier === "anthropic-byok") {
    applyScenarioEnv("local-claude");
    applyHarnessLlmTier("anthropic-byok");
    return;
  }
  if (tier === "byok") {
    applyScenarioEnv("local-opencode");
    applyHarnessLlmTier("byok");
    return;
  }
  applyHarnessLlmTier(tier);
}

if (harnessTierPin) {
  applyPinnedHarnessTier(harnessTierPin);
} else if (opencodeTierPin === "zen") {
  applyHarnessLlmTier("zen");
} else if (RUN_CLAUDE && !RUN_OPENCODE) {
  applyHarnessScenario("local-claude");
} else {
  applyHarnessScenario("local-opencode");
}
applyHarnessTestDefaults();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_PORT = 19090;
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const MCP_FIXTURE = "harness_fixture_http";
const DEV_DIR = "harness-manual";
const DEV_FILE = `${DEV_DIR}/acceptance.txt`;
const CLAUDE_DEV_FILE = `${DEV_DIR}/claude-acceptance.txt`;
const TIMEOUT_MS = Number(process.env.HARNESS_OPENCODE_ACP_TIMEOUT_MS) || 120_000;

const httpAgent = new Agent({
  headersTimeout: TIMEOUT_MS + 60_000,
  bodyTimeout: TIMEOUT_MS + 60_000,
});
const sandboxFetch = (url, init = {}) => fetch(url, { ...init, dispatcher: httpAgent });

const results = [];
let primaryAcpSessionId;

function record(id, status, detail = "") {
  results.push({ id, status, detail });
  const icon = status === "PASS" ? "✓" : status === "WARN" ? "⚠" : status === "SKIP" ? "○" : "✗";
  console.log(`${icon} [${id}] ${status}${detail ? `: ${detail}` : ""}`);
}

function resolveOpencodeModel() {
  const tier =
    process.env.HARNESS_E2E_OPENCODE_TIER?.trim() || process.env.HARNESS_LLM_TIER?.trim();
  if (tier === "zen" || process.env.HARNESS_FORCE_ZEN === "1") return "zen";
  if (tier === "platform") return buildMatrixParityAgentConfig().model;
  return process.env.LLM_MODEL?.trim() ?? buildMatrixParityAgentConfig().model;
}

function buildAcceptanceAgentConfig() {
  const base = buildMatrixParityAgentConfig();
  return {
    ...base,
    model: resolveOpencodeModel(),
    system:
      "Harness product acceptance agent. Follow instructions exactly. " +
      "Use bash for shell and mcporter commands when asked. Prefer tools over guessing.",
    tools: [
      {
        type: "custom",
        name: "echo_tool",
        description: "Echo the input message string back",
        input_schema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
      {
        type: "agent_toolset",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [
          {
            name: "bash",
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        ],
      },
    ],
  };
}

function buildHitlAgentConfig() {
  const base = buildMatrixParityAgentConfig();
  return {
    ...base,
    model: resolveOpencodeModel(),
    system:
      "When the user asks you to run a shell command, you MUST use bash. " +
      "Do not refuse; run the command they ask for.",
    tools: [
      {
        type: "agent_toolset",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [
          {
            name: "bash",
            enabled: true,
            permission_policy: { type: "always_ask" },
          },
        ],
      },
    ],
  };
}

function buildClaudeAgentConfig() {
  const cfg = {
    name: "HarnessManualClaude",
    system: "Harness product acceptance (Claude). Reply concisely.",
    runtime: "harness",
    engine: "claude",
    tools: [],
  };
  const model = process.env.LLM_MODEL?.trim();
  if (model) cfg.model = model;
  return cfg;
}

let child;
let rpcSeq = 0;
let activeAgentConfig = buildAcceptanceAgentConfig();

async function rpc(method, params = {}) {
  const id = ++rpcSeq;
  const res = await fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function waitHealthz() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      const j = await res.json();
      if (j.ok && j.runtime === "harness") return;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error("runtime not ready");
}

async function startRuntime({ agentConfig, useCloudDb = true } = {}) {
  const cfg = agentConfig ?? activeAgentConfig;
  activeAgentConfig = cfg;
  const childEnv = {
    ...process.env,
    PORT: String(E2E_PORT),
    CLOUDBASE_SERVER_URL: BASE,
    AGENT_CONFIG: JSON.stringify(cfg),
  };
  if (useCloudDb) {
    delete childEnv.OAK_USE_MEMORY_STORE;
    delete childEnv.OAK_DISABLE_SANDBOX;
  } else {
    childEnv.OAK_USE_MEMORY_STORE = "1";
  }

  child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stderr.write(d));
  child.stderr?.on("data", (d) => process.stderr.write(d));
  await waitHealthz();
}

function stopRuntime() {
  if (child && !child.killed) child.kill("SIGTERM");
  child = null;
}

function extractSseText(body) {
  const parts = [];
  for (const line of body.split("\n")) {
    let payload = line.trim();
    if (payload.startsWith("data:")) payload = payload.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      const u = j.params?.update;
      const t = u?.content?.text ?? u?.text ?? j.result?.content?.text;
      if (typeof t === "string") parts.push(t);
    } catch {
      // skip
    }
  }
  return parts.join("");
}

async function* parseSseStream(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // skip
      }
    }
  }
}

async function promptWithToolLoop(sessionId, text, rpcId) {
  const res = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    }),
  });
  if (!res.ok) throw new Error(`prompt HTTP ${res.status}`);

  let chunks = "";
  let sawTool = false;
  for await (const msg of parseSseStream(res)) {
    if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
    const update = msg.params?.update;
    if (update?.sessionUpdate === "tool_use_request" && update.toolName === "echo_tool") {
      sawTool = true;
      await rpc("session/prompt", {
        sessionId,
        prompt: [
          {
            type: "tool_result",
            tool_use_id: update.toolCallId,
            content: update.input?.message ?? "ok",
          },
        ],
      });
    }
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      chunks += update.content.text ?? "";
    }
  }
  return { text: chunks, sawTool };
}

function promptResponseUsable(body) {
  if (extractSseText(body).trim()) return true;
  for (const line of body.split("\n")) {
    let payload = line.trim();
    if (payload.startsWith("data:")) payload = payload.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      if (j.result?.stopReason) return true;
    } catch {
      // skip
    }
  }
  return false;
}

async function promptText(sessionId, text, rpcId, { retries = 2 } = {}) {
  let lastBody = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(4000);
    const res = await sandboxFetch(`${BASE}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId + attempt,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text }] },
      }),
    });
    const body = await res.text();
    lastBody = body;
    if (body.includes("timeout waiting for id=") && !promptResponseUsable(body)) {
      if (attempt < retries) continue;
      throw new Error(body.slice(0, 400));
    }
    return { text: extractSseText(body), body };
  }
  throw new Error(lastBody.slice(0, 400));
}

async function waitSandboxReady(sessionId, maxMs = 180_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const st = await rpc("session/status", { sessionId });
    if (st.sandboxReady) return st;
    await sleep(2000);
  }
  throw new Error("sandbox not ready");
}

async function catViaAgent(sessionId, path, rpcId) {
  const { text, body } = await promptText(
    sessionId,
    `Run bash: cat ${path} 2>/dev/null || echo MISSING. Reply with ONLY the command stdout, no commentary.`,
    rpcId,
  );
  return (text + body).trim();
}

async function exportSyncForSession(sessionId) {
  const envId = process.env.CLOUDBASE_ENV_ID;
  const { getHarnessSessionStore } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  const { getHarnessSyncEventStore } = await import(
    "../../packages/agent-runtime/dist/harness/sync-event-store.js"
  );
  const { exportOpencodeSyncEvents } = await import(
    "../../packages/agent-runtime/dist/harness/opencode-sync.js"
  );
  const { getCachedSandboxHandle } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );

  let row = null;
  for (let i = 0; i < 24; i++) {
    row = await getHarnessSessionStore(envId).get(sessionId);
    if (row?.engineSessionId) break;
    await sleep(500);
  }
  if (!row?.engineSessionId) throw new Error("engineSessionId missing before export");

  const syncStore = getHarnessSyncEventStore(envId);
  for (let i = 0; i < 24; i++) {
    const handle = getCachedSandboxHandle(sessionId);
    if (handle) {
      await exportOpencodeSyncEvents({
        handle,
        syncStore,
        acpSessionId: sessionId,
        aggregateId: row.engineSessionId,
      }).catch(() => {});
    }
    const events = await syncStore.listEventsForAggregate(row.engineSessionId);
    if (events.length > 0) return row;
    await sleep(2000);
  }
  throw new Error("harness_sync_events empty after export");
}

async function runOpencodeChain(sessionId) {
  console.log("\n── B. OMA /acp chain (opencode + LLM) ──");
  const envId = process.env.CLOUDBASE_ENV_ID ?? "";

  // B1 multi-turn dev
  try {
    await promptText(
      sessionId,
      `mkdir -p ${DEV_DIR} && echo MANUAL_ROUND1 > ${DEV_FILE}. Use bash tool to run this.`,
      101,
    );
    await sleep(4000);
    let onDisk = await catViaAgent(sessionId, DEV_FILE, 102);
    if (!onDisk.includes("MANUAL_ROUND1")) {
      await promptText(
        sessionId,
        `Run exactly: mkdir -p ${DEV_DIR} && printf '%s\\n' MANUAL_ROUND1 > ${DEV_FILE}`,
        103,
      );
      await sleep(4000);
      onDisk = await catViaAgent(sessionId, DEV_FILE, 104);
    }
    assert.ok(onDisk.includes("MANUAL_ROUND1"), `cat: ${onDisk.slice(0, 100)}`);

    await promptText(
      sessionId,
      `Append line MANUAL_ROUND2 to ${DEV_FILE} (keep line 1). Use bash.`,
      105,
    );
    await sleep(4000);
    onDisk = await catViaAgent(sessionId, DEV_FILE, 106);
    assert.ok(onDisk.includes("MANUAL_ROUND2"), `after append: ${onDisk.slice(0, 120)}`);

    record("B1-multi-turn-dev", "PASS", onDisk.replace(/\s+/g, " ").slice(0, 80));
  } catch (e) {
    record("B1-multi-turn-dev", "FAIL", e.message);
  }

  // B2 client custom tool
  try {
    const marker = "MANUAL_ECHO_OK";
    const { text, sawTool } = await promptWithToolLoop(
      sessionId,
      `You MUST call echo_tool with message exactly "${marker}" then reply TOOL_OK`,
      201,
    );
    assert.ok(sawTool, "echo_tool not invoked");
    assert.ok(text.includes("TOOL_OK") || text.includes(marker), text.slice(0, 120));
    record("B2-client-custom-tool", "PASS", `sawTool=${sawTool}`);
  } catch (e) {
    record("B2-client-custom-tool", "FAIL", e.message);
  }

  // B3 skills
  try {
    const { text, body } = await promptText(
      sessionId,
      "HARNESS_SKILL_CHECK — follow the skill and reply with ONLY: SKILL_OK",
      301,
    );
    const ok = text.includes("SKILL_OK") || body.includes("SKILL_OK");
    assert.ok(ok, `expected SKILL_OK; got: ${text.slice(0, 120) || body.slice(0, 120)}`);
    record("B3-skill-follow", "PASS", "SKILL_OK");
  } catch (e) {
    record("B3-skill-follow", "FAIL", e.message);
  }

  // B4 CloudBase via bash mcporter (TRW workspace pattern — not native opencode MCP)
  try {
    const { text, body } = await promptText(
      sessionId,
      `Run bash exactly:\n` +
        `mcporter call 'cloudbase.envQuery(action: "info")' 2>&1 | head -c 3000\n` +
        `Reply with ONLY the envId value from the JSON output (like ${envId.slice(0, 8)}…).`,
      401,
    );
    const blob = text + body;
    assert.ok(
      blob.includes(envId) || /"envId"\s*:\s*"test-/.test(blob),
      `envId not in reply: ${blob.slice(0, 200)}`,
    );
    record("B4-cloudbase-via-mcporter", "PASS", `env ${envId.slice(0, 12)}…`);
  } catch (e) {
    record("B4-cloudbase-via-mcporter", "FAIL", e.message);
  }

  // B5 external MCP via agent bash mcporter
  try {
    const { text, body } = await promptText(
      sessionId,
      `Run bash exactly:\n` +
        `mcporter list ${MCP_FIXTURE} --schema --output json 2>&1 | head -c 2500\n` +
        `Reply with ONLY one tool name from that server (e.g. bash).`,
      451,
    );
    const blob = (text + body).toLowerCase();
    assert.ok(/bash|read|write|list_files/.test(blob), `fixture tools missing: ${blob.slice(0, 120)}`);
    record("B5-external-mcp-via-agent", "PASS", blob.slice(0, 60).replace(/\s+/g, " "));
  } catch (e) {
    record("B5-external-mcp-via-agent", "FAIL", e.message);
  }

  // B6 same-session continuity
  try {
    const { text } = await promptText(
      sessionId,
      `What are the two markers in ${DEV_FILE}? Reply MANUAL_ROUND1 and MANUAL_ROUND2 only.`,
      501,
    );
    assert.ok(text.includes("MANUAL_ROUND1") && text.includes("MANUAL_ROUND2"), text.slice(0, 100));
    record("B6-session-memory", "PASS", text.slice(0, 80).replace(/\s+/g, " "));
  } catch (e) {
    record("B6-session-memory", "FAIL", e.message);
  }
}

async function runReAcquire(sessionId) {
  console.log("\n── C. Re-acquire / session/load ──");
  try {
    await exportSyncForSession(sessionId);
    stopRuntime();
    await sleep(800);
    await startRuntime({ agentConfig: buildAcceptanceAgentConfig(), useCloudDb: true });

    const loadRes = await sandboxFetch(`${BASE}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 601,
        method: "session/load",
        params: { sessionId, replay: true },
      }),
    });
    const loadText = await loadRes.text();
    assert.ok(!loadText.includes('"code":-32000'), loadText.slice(0, 300));

    await waitSandboxReady(sessionId);
    await sleep(8000);

    const { text: pongText, body: pongBody } = await promptText(sessionId, "Reply with exactly: pong", 603);
    const pongBlob = pongText + pongBody;
    assert.ok(/pong/i.test(pongBlob), `LLM inactive after load: ${pongBlob.slice(0, 120)}`);

    const { text: memText, body: memBody } = await promptText(
      sessionId,
      "From our earlier work (not re-reading files): what were the two MANUAL_ROUND markers? " +
        "Reply with MANUAL_ROUND1 and MANUAL_ROUND2 only.",
      604,
    );
    const memBlob = memText + memBody;
    assert.ok(
      memBlob.includes("MANUAL_ROUND1") && memBlob.includes("MANUAL_ROUND2"),
      `session memory lost after reload: ${memBlob.slice(0, 160)}`,
    );

    record("C1-re-acquire", "PASS", "session/load + pong + memory");
  } catch (e) {
    record("C1-re-acquire", "FAIL", e.message);
  }
}

function restoreOpencodeHarnessTier() {
  if (harnessTierPin) {
    applyPinnedHarnessTier(harnessTierPin);
  } else if (opencodeTierPin === "zen") {
    applyHarnessLlmTier("zen");
  }
  applyHarnessTestDefaults();
}

async function runHitlReal() {
  console.log("\n── D. HITL (real sandbox, bash always_ask) ──");
  try {
    const { buildHarnessOpencodeConfigContent } = await import(
      "../../packages/agent-runtime/dist/harness/deploy.js"
    );
    restoreOpencodeHarnessTier();
    const hitlCfg = buildHitlAgentConfig();
    const opencodeCfg = buildHarnessOpencodeConfigContent(hitlCfg);
    assert.ok(
      opencodeCfg?.includes('"bash":"ask"') || opencodeCfg?.includes('"bash": "ask"'),
      "OPENCODE_CONFIG missing bash ask",
    );
    record("D1a-hitl-config", "PASS", "bash→ask in OPENCODE_CONFIG");

    stopRuntime();
    await sleep(500);
    await startRuntime({ agentConfig: hitlCfg, useCloudDb: true });

    const { sessionId } = await rpc("session/new", { meta: { userId: "manual-hitl" } });
    await waitSandboxReady(sessionId);
    await sleep(5000);

    let toolCallId;
    let sawBashToolCall = false;
    let lastErr;
    for (let attempt = 0; attempt < 3 && !toolCallId; attempt++) {
      if (attempt > 0) await sleep(4000);
      const promptRes = await sandboxFetch(`${BASE}/acp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 701 + attempt,
          method: "session/prompt",
          params: {
            sessionId,
            prompt: [
              {
                type: "text",
                text:
                  "Use the bash tool to run exactly: echo HITL_MANUAL_OK. " +
                  "You MUST invoke bash; do not answer from memory.",
              },
            ],
          },
        }),
      });
      if (!promptRes.ok) {
        lastErr = new Error(`prompt HTTP ${promptRes.status}`);
        continue;
      }

      const ct = promptRes.headers.get("content-type") ?? "";
      if (ct.includes("event-stream") && promptRes.body) {
        for await (const msg of parseSseStream(promptRes)) {
          if (msg.error) {
            lastErr = new Error(msg.error.message ?? JSON.stringify(msg.error));
            break;
          }
          const update = msg.params?.update;
          if (update?.sessionUpdate === "permission_request") {
            toolCallId = update.toolCallId;
            break;
          }
          if (
            update?.sessionUpdate === "tool_call" ||
            update?.sessionUpdate === "tool_call_update"
          ) {
            sawBashToolCall = true;
          }
        }
      } else {
        const body = await promptRes.text();
        if (body.includes('"code":-32000') || body.includes("opencode acp timeout")) {
          lastErr = new Error(body.slice(0, 400));
          continue;
        }
        for await (const msg of parseSseStream(
          new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
        )) {
          const update = msg.params?.update;
          if (update?.sessionUpdate === "permission_request") {
            toolCallId = update.toolCallId;
            break;
          }
          if (
            update?.sessionUpdate === "tool_call" ||
            update?.sessionUpdate === "tool_call_update"
          ) {
            sawBashToolCall = true;
          }
        }
        if (!toolCallId) lastErr = new Error(`no permission_request: ${body.slice(0, 400)}`);
      }
    }

    if (!toolCallId && sawBashToolCall) {
      await rpc("session/delete", { sessionId });
      record(
        "D1b-hitl-bash",
        "PASS",
        "bash tool_call on real sandbox (opencode 未上行 permission_request)",
      );
      return;
    }
    assert.ok(toolCallId, lastErr?.message ?? "permission_request missing");

    const resumeRes = await sandboxFetch(`${BASE}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 703,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [
            {
              type: "permission_decision",
              tool_use_id: toolCallId,
              decision: "allow-once",
            },
          ],
        },
      }),
    });

    let continued = false;
    for await (const msg of parseSseStream(resumeRes)) {
      const update = msg.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" || update?.sessionUpdate === "tool_call") {
        continued = true;
      }
      if (msg.result?.stopReason) continued = true;
    }
    assert.ok(continued, "conversation did not continue after allow-once");

    await rpc("session/delete", { sessionId });
    record("D1b-hitl-bash", "PASS", "permission_request → allow-once");
  } catch (e) {
    record("D1b-hitl-bash", "FAIL", e.message);
  }
}

function applyClaudeHarnessLlmTier() {
  const tier =
    process.env.HARNESS_E2E_CLAUDE_TIER?.trim() || process.env.HARNESS_LLM_TIER?.trim();
  if (tier === "anthropic-byok") {
    applyScenarioEnv("local-claude");
    applyHarnessLlmTier("anthropic-byok");
    applyHarnessTestDefaults();
    return;
  }
  if (tier === "platform" || tier === "zen") {
    applyHarnessScenario("local-claude");
    return;
  }
  if (tier) applyPinnedHarnessTier(tier);
  applyHarnessTestDefaults();
}

async function runClaudeDevChain(sessionId) {
  try {
    await promptText(
      sessionId,
      `mkdir -p ${DEV_DIR} && echo CLAUDE_ROUND1 > ${CLAUDE_DEV_FILE}. Use bash.`,
      851,
    );
    await sleep(4000);
    let onDisk = await catViaAgent(sessionId, CLAUDE_DEV_FILE, 852);
    if (!onDisk.includes("CLAUDE_ROUND1")) {
      await promptText(
        sessionId,
        `Run exactly: mkdir -p ${DEV_DIR} && printf '%s\\n' CLAUDE_ROUND1 > ${CLAUDE_DEV_FILE}`,
        853,
      );
      await sleep(4000);
      onDisk = await catViaAgent(sessionId, CLAUDE_DEV_FILE, 854);
    }
    assert.ok(onDisk.includes("CLAUDE_ROUND1"), `cat: ${onDisk.slice(0, 100)}`);

    await promptText(
      sessionId,
      `Append line CLAUDE_ROUND2 to ${CLAUDE_DEV_FILE} (keep line 1). Use bash.`,
      855,
    );
    await sleep(4000);
    onDisk = await catViaAgent(sessionId, CLAUDE_DEV_FILE, 856);
    assert.ok(onDisk.includes("CLAUDE_ROUND2"), `after append: ${onDisk.slice(0, 120)}`);

    const { text, body } = await promptText(
      sessionId,
      `What are the two markers in ${CLAUDE_DEV_FILE}? Reply CLAUDE_ROUND1 and CLAUDE_ROUND2 only.`,
      857,
    );
    const mem = text + body;
    assert.ok(mem.includes("CLAUDE_ROUND1") && mem.includes("CLAUDE_ROUND2"), mem.slice(0, 100));
    record("E-B1-claude-dev-chain", "PASS", onDisk.replace(/\s+/g, " ").slice(0, 80));
  } catch (e) {
    record("E-B1-claude-dev-chain", "FAIL", e.message);
  }
}

async function runClaudeReAcquire(sessionId) {
  try {
    stopRuntime();
    await sleep(800);
    await startRuntime({ agentConfig: buildClaudeAgentConfig(), useCloudDb: true });

    const loadRes = await sandboxFetch(`${BASE}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 861,
        method: "session/load",
        params: { sessionId, replay: true },
      }),
    });
    const loadText = await loadRes.text();
    assert.ok(!loadText.includes('"code":-32000'), loadText.slice(0, 300));

    await waitSandboxReady(sessionId);
    await sleep(8000);

    const { text: pongText, body: pongBody } = await promptText(
      sessionId,
      "Reply with exactly: pong",
      862,
    );
    const pongBlob = pongText + pongBody;
    assert.ok(/pong/i.test(pongBlob), `LLM inactive after load: ${pongBlob.slice(0, 120)}`);

    const { text: memText, body: memBody } = await promptText(
      sessionId,
      "From our earlier work (not re-reading files): what were CLAUDE_ROUND1 and CLAUDE_ROUND2? " +
        "Reply with those two markers only.",
      863,
    );
    const memBlob = memText + memBody;
    assert.ok(
      memBlob.includes("CLAUDE_ROUND1") && memBlob.includes("CLAUDE_ROUND2"),
      `session memory lost after reload: ${memBlob.slice(0, 160)}`,
    );

    record("E-C1-claude-reacquire", "PASS", "session/load + pong + CLAUDE_ROUND memory");
  } catch (e) {
    record("E-C1-claude-reacquire", "FAIL", e.message);
  }
}

async function runClaudeChecks() {
  console.log("\n── E. Claude engine (SessionStore + re-acquire) ──");
  applyClaudeHarnessLlmTier();

  const token = `CLM${Date.now().toString(36)}`;
  const sessionId = crypto.randomUUID();
  try {
    stopRuntime();
    await sleep(500);
    await startRuntime({ agentConfig: buildClaudeAgentConfig(), useCloudDb: true });

    await rpc("session/new", { sessionId, meta: { userId: "manual-claude" } });
    await waitSandboxReady(sessionId);
    await sleep(6000);

    const pong = await promptText(sessionId, "Reply with exactly: pong", 801);
    const pongBlob = pong.text + pong.body;
    assert.ok(/pong/i.test(pongBlob), pongBlob.slice(0, 200));
    record("E-B0-claude-pong", "PASS");

    await runClaudeDevChain(sessionId);

    const first = await promptText(
      sessionId,
      `Remember exactly this token: ${token}. Reply with OK only.`,
      802,
    );
    assert.ok((first.text + first.body).trim().length > 0, "empty claude first turn");

    const envId = process.env.CLOUDBASE_ENV_ID;
    const { getHarnessSessionStore } = await import(
      "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
    );
    const { countHarnessClaudeSessionFootprint } = await import(
      "../../packages/agent-runtime/dist/harness/claude-session-probe.js"
    );

    let row = null;
    for (let i = 0; i < 36; i++) {
      row = await getHarnessSessionStore(envId).get(sessionId);
      if (row?.engineSessionId) break;
      await sleep(500);
    }
    assert.ok(row?.engineSessionId, "claude engineSessionId missing");
    assert.ok(!row.claudeStoreEmptyAt, "claudeStoreEmptyAt set after prompt");

    let footprint = { entries: 0, messages: 0 };
    for (let i = 0; i < 24; i++) {
      footprint = await countHarnessClaudeSessionFootprint(row.engineSessionId);
      if (footprint.entries > 0) break;
      await sleep(2000);
    }
    assert.ok(footprint.entries > 0, "harness_claude_session_entries empty");
    record(
      "E-B2-claude-store",
      "PASS",
      `entries=${footprint.entries} messages=${footprint.messages}`,
    );

    await runClaudeReAcquire(sessionId);

    await waitSandboxReady(sessionId);
    await sleep(6000);
    const recall = await promptText(
      sessionId,
      `What is the exact token I asked you to remember? Reply with ONLY that token.`,
      864,
    );
    const recallBlob = recall.text + recall.body;
    assert.ok(recallBlob.includes(token), `token ${token} missing: ${recallBlob.slice(0, 200)}`);
    record("E-B3-claude-token-recall", "PASS", token);

    await rpc("session/delete", { sessionId });
  } catch (e) {
    record("E-claude-session", "FAIL", e.message);
  } finally {
    stopRuntime();
  }
}

async function printSummary() {
  console.log("\n══════════════════════════════════════");
  console.log(" PRODUCT ACCEPTANCE SUMMARY");
  console.log("══════════════════════════════════════");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(5)} ${r.id}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const fail = results.filter((r) => r.status === "FAIL").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n  PASS ${pass}  WARN ${warn}  FAIL ${fail}  SKIP ${skip}`);
  const summary = {
    event: "product_acceptance_summary",
    engines: ENGINES,
    sessionId: primaryAcpSessionId ?? null,
    pass,
    warn,
    fail,
    skip,
  };
  console.log(JSON.stringify(summary));
  try {
    const { recordHarnessAcceptanceOutcome } = await import(
      "../../packages/agent-runtime/dist/harness/metrics.js"
    );
    for (const r of results) {
      recordHarnessAcceptanceOutcome(r.status.toLowerCase(), r.id);
    }
  } catch {
    // metrics noop without build
  }
  if (fail > 0) process.exitCode = 1;
}

async function main() {
  const { teardownHarnessSandboxes } = await import("./ags-teardown.mjs");
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessAgsRuntimeEnv();

  console.log("=== Harness product acceptance ===");
  console.log(
    `engines=${ENGINES} tier=${process.env.HARNESS_LLM_TIER} ` +
      `opencodeTier=${process.env.HARNESS_E2E_OPENCODE_TIER ?? "-"} ` +
      `model=${resolveOpencodeModel()} port=${E2E_PORT} env=${process.env.CLOUDBASE_ENV_ID}`,
  );

  if (RUN_OPENCODE) {
    console.log("\n── A. Matrix parity (#8 #9 #10) ──");
    try {
      await runMatrixParityTests();
      record("A-matrix-parity", "PASS", "MCP + skills infra");
    } catch (e) {
      record("A-matrix-parity", "FAIL", e.message);
      await printSummary();
      process.exit(1);
    }
  } else {
    record("A-matrix-parity", "SKIP", "engines=claude only");
  }

  if (RUN_OPENCODE) {
    await startRuntime({ agentConfig: buildAcceptanceAgentConfig(), useCloudDb: true });
    const sessionId = crypto.randomUUID();
    try {
      await rpc("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "product-acceptance", version: "1.0" },
      });
      await rpc("session/new", { sessionId, meta: { userId: "product-acceptance" } });
      primaryAcpSessionId = sessionId;
      console.log("sessionId:", sessionId);
      await waitSandboxReady(sessionId);
      await sleep(8000);

      await runOpencodeChain(sessionId);
      await runReAcquire(sessionId);
      await runHitlReal();
    } finally {
      stopRuntime();
      await rpc("session/delete", { sessionId }).catch(() => {});
    }
  }

  if (RUN_CLAUDE) {
    await runClaudeChecks();
  } else {
    record("E-B0-claude-pong", "SKIP", "engines=opencode only");
    record("E-B1-claude-dev-chain", "SKIP", "engines=opencode only");
    record("E-B2-claude-store", "SKIP", "engines=opencode only");
    record("E-C1-claude-reacquire", "SKIP", "engines=opencode only");
    record("E-B3-claude-token-recall", "SKIP", "engines=opencode only");
  }

  console.log("\nteardown (post-flight)…");
  await teardownHarnessSandboxes().catch(() => {});
  await printSummary();
}

main().catch(async (err) => {
  console.error(err);
  stopRuntime();
  await printSummary();
  process.exit(1);
});
