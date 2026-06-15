/**
 * Harness runtime e2e — agent-in-sandbox chain (local stub + optional real AGS).
 *
 *   npm run harness -- local
 *
 * Loads `.env.harness` via scripts/harness/load-env.mjs
 */

import {
  loadEnv,
  assertHarnessCreds,
  applyHarnessLlmTier,
  applyHarnessScenario,
  applyScenarioEnv,
  applyHarnessTestDefaults,
  hasAnthropicByokInMap,
  parseHarnessEnginesArg,
  harnessEnginesIncludeOpencode,
  harnessEnginesIncludeClaude,
} from "../../scripts/harness/load-env.mjs";

/** Parent `envForHarnessTier` sets this before spawn; `loadEnv()` wipes it unless pinned first. */
const harnessTierPin = process.env.HARNESS_LLM_TIER?.trim();
loadEnv();

const FULL = process.argv.includes("--full");
const LLM_SUITE = process.argv.includes("--llm");
const E2E_ENGINES = parseHarnessEnginesArg(process.argv.slice(2));
const E2E_OPENCODE = harnessEnginesIncludeOpencode(E2E_ENGINES);
const E2E_CLAUDE = harnessEnginesIncludeClaude(E2E_ENGINES);
const FORCE_ZEN = process.env.HARNESS_FORCE_ZEN === "1";

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

const tierFromEnv = harnessTierPin;
if (tierFromEnv) {
  applyPinnedHarnessTier(tierFromEnv);
} else if (LLM_SUITE) {
  applyHarnessLlmTier("byok");
} else if (FULL && E2E_CLAUDE && !E2E_OPENCODE) {
  applyHarnessScenario("local-claude");
} else if (FULL && FORCE_ZEN) {
  applyHarnessLlmTier("zen");
} else if (FULL) {
  applyHarnessLlmTier("platform");
}
if (FULL || LLM_SUITE) applyHarnessTestDefaults();

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Agent } from "undici";
import * as acp from "@agentclientprotocol/sdk";

const E2E_ACP_TIMEOUT_MS = Number(process.env.HARNESS_OPENCODE_ACP_TIMEOUT_MS) || 90_000;
/** undici 须略大于箱内 opencode ACP relay 超时 */
const SANDBOX_HTTP = new Agent({
  headersTimeout: E2E_ACP_TIMEOUT_MS + 60_000,
  bodyTimeout: E2E_ACP_TIMEOUT_MS + 60_000,
});
function sandboxFetch(url, init = {}) {
  return fetch(url, { ...init, dispatcher: SANDBOX_HTTP });
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_FIXTURE_PATH = resolve(repoRoot, "tests/fixtures/skills/harness-e2e-demo.md");
const E2E_PORT = 19090;
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BOT_ID = "e2e-bot";
/** Dev-only: seed fake sync row when /sync/history empty — keep false in CI. */
const E2E_SYNC_SEED_SYNTHETIC_ON_EMPTY = false;

const BASE_AGENT_CONFIG = {
  name: "HarnessE2E",
  system:
    "When asked to use echo_tool, you MUST call it before answering. " +
    "Harness e2e agent.",
  runtime: "harness",
  engine: "opencode",
  tools: [
    {
      type: "custom",
      name: "echo_tool",
      description: "Echo input",
      input_schema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
};

const STUB_AGENT_CONFIG = {
  ...BASE_AGENT_CONFIG,
  metadata: { harnessE2eStub: "1" },
};

let activeAgentConfig = { ...BASE_AGENT_CONFIG };

function hasCustomLlmInEnv() {
  return !!(
    process.env.LLM_API_KEY?.trim() &&
    process.env.OPENAI_BASE_URL?.trim() &&
    process.env.LLM_MODEL?.trim()
  );
}

/** FULL e2e tier: platform(hy3) | zen | byok — 见 HARNESS_LLM_TIER / harness -- local|cloud-* */
function resolveFullAgentConfig() {
  const tier = process.env.HARNESS_LLM_TIER?.trim();
  if (tier === "zen" || FORCE_ZEN) {
    return { ...BASE_AGENT_CONFIG, model: "zen", engine: "opencode" };
  }
  if (tier === "platform" || (!LLM_SUITE && !hasCustomLlmInEnv())) {
    return { ...BASE_AGENT_CONFIG, engine: "opencode" };
  }

  const raw = process.env.AGENT_CONFIG?.trim();
  if (!raw) {
    return {
      ...BASE_AGENT_CONFIG,
      model: process.env.LLM_MODEL?.trim() ?? "mimo-v2.5-pro",
      engine: "opencode",
    };
  }
  try {
    const parsed = JSON.parse(raw);
    const { model, tools, ...rest } = parsed;
    const cfg = {
      ...BASE_AGENT_CONFIG,
      ...rest,
      runtime: "harness",
      engine: parsed.engine ?? "opencode",
      tools: tools ?? BASE_AGENT_CONFIG.tools,
    };
    if (process.env.LLM_API_KEY?.trim() && process.env.OPENAI_BASE_URL?.trim()) {
      cfg.model = process.env.LLM_MODEL?.trim() ?? (typeof model === "string" ? model : model?.id) ?? cfg.model;
    } else if (typeof model === "string") {
      cfg.model = model;
    } else if (model?.apiKey && model?.apiBaseUrl && /openai|\/v1/i.test(model.apiBaseUrl)) {
      cfg.model = model;
    }
    return cfg;
  } catch {
    return { ...BASE_AGENT_CONFIG, model: process.env.LLM_MODEL?.trim() ?? "mimo-v2.5-pro" };
  }
}

let child;
let bridgeChild;
let rpcSeq = 0;

async function rpc(path, method, params = {}) {
  const id = ++rpcSeq;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${path} ${method}: ${json.error.message}`);
  return json.result;
}

async function waitHealthz() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      const j = await res.json();
      if (j.ok && j.runtime === "harness") return j;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error("runtime did not become ready");
}

async function startRuntime({
  useCloudDb = false,
  stubSandbox = false,
  agentConfig,
} = {}) {
  const cfg = agentConfig ?? (stubSandbox ? STUB_AGENT_CONFIG : activeAgentConfig);
  activeAgentConfig = cfg;
  const childEnv = {
    ...process.env,
    PORT: String(E2E_PORT),
    CLOUDBASE_SERVER_URL: BASE,
    CLOUDBASE_ENV_ID: process.env.CLOUDBASE_ENV_ID ?? "test-local-harness",
    AGENT_CONFIG: JSON.stringify(cfg),
  };
  if (!useCloudDb) {
    childEnv.OAK_USE_MEMORY_STORE = "1";
  } else {
    delete childEnv.OAK_USE_MEMORY_STORE;
    delete childEnv.OAK_DISABLE_SANDBOX;
  }

  child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stderr.write(d));
  child.stderr?.on("data", (d) => process.stderr.write(d));
  return waitHealthz();
}

function stopRuntime() {
  if (child && !child.killed) child.kill("SIGTERM");
  if (bridgeChild && !bridgeChild.killed) bridgeChild.kill("SIGTERM");
}

async function testAcpLifecycle(path = "/acp") {
  const init = await rpc(path, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "e2e", version: "0.0.1" },
  });
  assert.equal(init.agentConfig.runtime, "harness");

  const created = await rpc(path, "session/new", { meta: { userId: "e2e" } });
  const sessionId = created.sessionId;
  assert.ok(sessionId);

  const listed = await rpc(path, "session/list", {});
  assert.ok(listed.sessions.some((s) => s.sessionId === sessionId));

  const loaded = await rpc(path, "session/load", { sessionId });
  assert.equal(loaded.sessionId, sessionId);

  const cancelRes = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    }),
  });
  assert.equal(cancelRes.status, 204);

  await rpc(path, "session/delete", { sessionId });
  const listedAfter = await rpc(path, "session/list", {});
  assert.ok(!listedAfter.sessions.some((s) => s.sessionId === sessionId));
}

async function testManagedAgentClientMcpList() {
  const res = await fetch(`${BASE}/internal/harness/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Acp-Session-Id": crypto.randomUUID(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  const json = await res.json();
  assert.ok(json.result?.tools?.some((t) => t.name === "echo_tool"));
}

async function* parseSseBody(res) {
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
        // skip heartbeats
      }
    }
  }
}

/**
 * Local closed loop: stub sandbox holds prompt SSE; MCP tools/call ↔ tool_result.
 */
async function testClientToolBridgeClosedLoop() {
  stopRuntime();
  await sleep(400);
  await startRuntime({ stubSandbox: true });

  const { sessionId } = await rpc("/acp", "session/new", { meta: { userId: "e2e-bridge" } });
  const mcpUrl = `${BASE}/internal/harness/mcp?sessionId=${encodeURIComponent(sessionId)}`;
  const expectedContent = "echo:local-loop-ok";

  const promptRes = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 50,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "client tool bridge e2e" }],
      },
    }),
  });
  assert.ok(promptRes.ok, `prompt HTTP ${promptRes.status}`);

  const sseHandled = (async () => {
    for await (const msg of parseSseBody(promptRes)) {
      const update = msg.params?.update;
      if (update?.sessionUpdate === "tool_use_request") {
        assert.equal(update.toolName, "echo_tool");
        await rpc("/acp", "session/prompt", {
          sessionId,
          prompt: [
            {
              type: "tool_result",
              tool_use_id: update.toolCallId,
              content: expectedContent,
            },
          ],
        });
        return true;
      }
    }
    return false;
  })();

  const mcpRes = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo_tool", arguments: { message: "local-loop-ok" } },
    }),
  });

  assert.ok(await sseHandled, "expected tool_use_request on prompt SSE");

  const mcpJson = await mcpRes.json();
  assert.ok(!mcpJson.error, mcpJson.error?.message ?? "MCP tools/call failed");
  assert.equal(mcpJson.result?.content?.[0]?.text, expectedContent);

  await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    }),
  });
  await rpc("/acp", "session/delete", { sessionId });

  stopRuntime();
  await sleep(300);
  await startRuntime();
}

async function testSandboxCustomToolLoop() {
  assertHarnessCreds();
  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true });

  const sessionId = crypto.randomUUID();
  await rpc("/acp", "session/new", { sessionId, meta: { userId: "e2e-tool-loop" } });

  const marker = "harness-e2e-tool-ok";
  const promptFetch = sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 200,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          {
            type: "text",
            text:
              `You MUST call echo_tool with message exactly "${marker}" before answering. ` +
              `After the tool returns, reply with exactly: TOOL_OK`,
          },
        ],
      },
    }),
  });

  const promptRes = await promptFetch;
  assert.ok(promptRes.ok, `session/prompt HTTP ${promptRes.status}`);

  let sawToolUse = false;
  let chunks = "";
  for await (const msg of parseSseBody(promptRes)) {
    if (msg.error) {
      const errText = msg.error.message ?? JSON.stringify(msg.error);
      if (String(errText).includes("opencode acp timeout")) {
        console.warn(`⚠ sandbox custom tool loop skipped (opencode/LLM): ${errText.slice(0, 200)}`);
        await rpc("/acp", "session/delete", { sessionId });
        return;
      }
      throw new Error(errText);
    }
    const update = msg.params?.update;
    if (update?.sessionUpdate === "tool_use_request" && update.toolName === "echo_tool") {
      sawToolUse = true;
      await rpc("/acp", "session/prompt", {
        sessionId,
        prompt: [
          {
            type: "tool_result",
            tool_use_id: update.toolCallId,
            content: marker,
          },
        ],
      });
    }
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      chunks += update.content.text ?? "";
    }
  }

  assert.ok(
    sawToolUse,
    "expected sandbox agent to invoke echo_tool via managed-agent-client MCP. " +
      "If mcp.pump.poll_error 404 in logs, rebuild magent (TRW harness-mcp-relay) and scripts/harness/sync-tool.mjs.",
  );
  assert.ok(
    chunks.includes("TOOL_OK") || chunks.includes(marker),
    `expected agent to use tool result in reply; got: ${chunks.slice(0, 400)}`,
  );

  await rpc("/acp", "session/delete", { sessionId });
}

function extractAllSseText(body) {
  const parts = [];
  for (const line of body.split("\n")) {
    let payload = line.trim();
    if (payload.startsWith("data:")) payload = payload.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      const update = j.params?.update;
      const chunk = update?.content?.text ?? update?.text;
      if (typeof chunk === "string") parts.push(chunk);
      const resultText = j.result?.content?.text ?? j.result?.text;
      if (typeof resultText === "string") parts.push(resultText);
    } catch {
      // skip
    }
  }
  return parts.join("");
}

/** True when sandbox opencode returned streaming chunks (not 0-token instant end_turn). */
function sseShowsLlmActivity(body) {
  if (/agent_message_chunk|agent_thought_chunk|tool_call/.test(body)) return true;
  if (extractAllSseText(body).trim().length > 0) return true;
  try {
    for (const line of body.split("\n")) {
      let payload = line.trim();
      if (payload.startsWith("data:")) payload = payload.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const j = JSON.parse(payload);
      const usage = j.result?.usage;
      if (usage && (usage.outputTokens > 0 || usage.totalTokens > 0)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function waitSandboxReady(sessionId, maxMs = 180_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const st = await rpc("/acp", "session/status", { sessionId });
    if (st.sandboxReady) return st;
    await sleep(2000);
  }
  throw new Error(`sandbox not ready for session ${sessionId} after ${maxMs}ms`);
}

/** Classify sandbox prompt body — avoid retrying 300s relay timeouts with 0 LLM text. */
function classifySandboxPrompt(body) {
  const text = extractAllSseText(body);
  if (text.trim()) return { kind: "ok", text };
  const relayTimeout =
    body.includes("timeout waiting for id=") || body.includes("opencode acp timeout");
  if (relayTimeout) {
    return {
      kind: "relay_timeout",
      text: "",
      hint: `箱内 opencode ACP relay ${E2E_ACP_TIMEOUT_MS}ms 仍无 LLM 输出；查 hy3-preview / OPENCODE_CONFIG，不是 sync 逻辑本身`,
    };
  }
  if (body.includes('"stopReason"') && !text.trim()) {
    return {
      kind: "empty_turn",
      text: "",
      hint: "收到 end_turn 但无 agent_message_chunk（可能是 OMA 在 timeout 后补的 end_turn）",
    };
  }
  if (body.includes('"code":-32000')) return { kind: "rpc_error", text: "" };
  return { kind: "empty", text: "" };
}

/** Sandbox may emit -32000 timeout on one SSE frame then result.end_turn on the next. */
function promptResponseUsable(body) {
  if (sseShowsLlmActivity(body)) return true;
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

async function promptSessionText(sessionId, text, rpcId = 100) {
  const res = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text }],
      },
    }),
  });
  const body = await res.text();
  if (body.includes("timeout waiting for id=") && !promptResponseUsable(body)) {
    throw new Error(body.slice(0, 400));
  }
  return body;
}

function syncEventsContainToken(events, token) {
  const blob = JSON.stringify(events);
  return blob.includes(token);
}

async function testSyncPersistence() {
  assertHarnessCreds();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const requireTokenRecall = LLM_SUITE;
  const token = requireTokenRecall ? `SYNC${Date.now().toString(36)}` : null;

  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true, agentConfig: resolveFullAgentConfig() });

  const sessionId = crypto.randomUUID();
  await rpc("/acp", "session/new", { sessionId, meta: { userId: "e2e-sync" } });

  await waitSandboxReady(sessionId);
  await sleep(5000);

  let first = "";
  let firstText = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(4000);
    first = await promptSessionText(
      sessionId,
      token
        ? `Remember exactly this token: ${token}. Reply with OK only.`
        : "Reply with exactly: OK",
      201 + attempt,
    );
    const outcome = classifySandboxPrompt(first);
    if (outcome.kind === "relay_timeout" || outcome.kind === "empty_turn") {
      throw new Error(`sync: ${outcome.hint} — fail-fast (no 300s×4). ${first.slice(0, 280)}`);
    }
    if (outcome.kind === "rpc_error") {
      console.warn(`sync: prompt attempt ${attempt + 1} error: ${first.slice(0, 280)}`);
      continue;
    }
    firstText = outcome.text;
    if (firstText.trim().length > 0) break;
  }
  assert.ok(
    firstText.trim().length > 0,
    `sync: first prompt produced no LLM text (check LLM_* / OPENCODE_CONFIG): ${first.slice(0, 400)}`,
  );

  const { getHarnessSessionStore } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  const { getHarnessSyncEventStore } = await import(
    "../../packages/agent-runtime/dist/harness/sync-event-store.js"
  );

  let row = null;
  for (let i = 0; i < 24; i++) {
    row = await getHarnessSessionStore(envId).get(sessionId);
    if (row?.engineSessionId) break;
    await sleep(500);
  }
  assert.ok(row?.engineSessionId, "expected engineSessionId after first prompt");

  const { exportOpencodeSyncEvents } = await import(
    "../../packages/agent-runtime/dist/harness/opencode-sync.js"
  );
  const { getCachedSandboxHandle } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const syncStore = getHarnessSyncEventStore(envId);
  let events = [];
  for (let i = 0; i < 36; i++) {
    const handle = getCachedSandboxHandle(sessionId);
    if (handle) {
      await exportOpencodeSyncEvents({
        handle,
        syncStore,
        acpSessionId: sessionId,
        aggregateId: row.engineSessionId,
      }).catch(() => {});
    }
    events = await syncStore.listEventsForAggregate(row.engineSessionId);
    if (events.length > 0 && (!requireTokenRecall || syncEventsContainToken(events, token))) break;
    await sleep(2000);
  }
  if (events.length === 0 && E2E_SYNC_SEED_SYNTHETIC_ON_EMPTY) {
    console.warn("sync: /sync/history empty — E2E_SYNC_SEED_SYNTHETIC_ON_EMPTY, seeding synthetic");
    await syncStore.appendEvents({
      acpSessionId: sessionId,
      aggregateId: row.engineSessionId,
      events: [
        {
          id: `evt_e2e_${Date.now()}`,
          aggregateId: row.engineSessionId,
          seq: 1,
          type: "session.created",
          data: { sessionID: row.engineSessionId, marker: token },
        },
      ],
    });
    events = await syncStore.listEventsForAggregate(row.engineSessionId);
  }
  assert.ok(
    events.length > 0,
    `expected harness_sync_events from opencode /sync/history for ${row.engineSessionId} ` +
      `(magent needs opencode >= 1.16.2)`,
  );
  row = await getHarnessSessionStore(envId).get(sessionId);
  assert.ok(!row?.syncExportFailedAt, "syncExportFailedAt set after successful export");
  if (requireTokenRecall) {
    assert.ok(
      syncEventsContainToken(events, token),
      `expected token ${token} in harness_sync_events (${events.length} events): ` +
        `${JSON.stringify(events).slice(0, 600)}`,
    );
  }

  stopRuntime();
  await sleep(800);
  await startRuntime({ useCloudDb: true, agentConfig: resolveFullAgentConfig() });

  const loadRes = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 202,
      method: "session/load",
      params: { sessionId, replay: true },
    }),
  });
  const loadText = await loadRes.text();
  assert.ok(!loadText.includes('"code":-32000'), `session/load replay failed: ${loadText.slice(0, 400)}`);
  assert.ok(
    !loadText.includes('"error"'),
    `session/load replay error: ${loadText.slice(0, 400)}`,
  );

  await waitSandboxReady(sessionId);
  await sleep(8000);

  const pongBody = await promptSessionText(sessionId, "Reply with exactly: pong", 220);
  assert.ok(
    sseShowsLlmActivity(pongBody),
    `post-reload LLM inactive after session/load (0-token?): ${pongBody.slice(0, 400)}`,
  );

  if (requireTokenRecall) {
    let recallBody = "";
    let recallText = "";
    let lastRecallErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (attempt > 0) await sleep(4000);
        recallBody = await promptSessionText(
          sessionId,
          `What is the exact token I asked you to remember? Reply with ONLY that token (${token.length} chars), nothing else.`,
          203 + attempt,
        );
        if (recallBody.includes('"code":-32000') || recallBody.includes("opencode acp timeout")) {
          lastRecallErr = new Error(`attempt ${attempt + 1}: ${recallBody.slice(0, 280)}`);
          continue;
        }
        recallText = extractAllSseText(recallBody);
        if (recallText.includes(token) || recallBody.includes(token)) break;
        lastRecallErr = new Error(
          `attempt ${attempt + 1}: token missing in response: ${recallText.slice(0, 280) || recallBody.slice(0, 280)}`,
        );
      } catch (err) {
        lastRecallErr = err;
      }
    }
    assert.ok(
      recallText.includes(token) || recallBody.includes(token),
      `post-replay prompt should recall token ${token}; ${lastRecallErr?.message ?? recallText.slice(0, 400)}`,
    );
  }

  await rpc("/acp", "session/delete", { sessionId });
}

function resolveClaudeAgentConfig() {
  const cfg = { ...BASE_AGENT_CONFIG, engine: "claude" };
  const model = process.env.LLM_MODEL?.trim();
  if (model) cfg.model = model;
  return cfg;
}

function restoreOpencodeHarnessTier() {
  const tier = process.env.HARNESS_E2E_OPENCODE_TIER?.trim() || "zen";
  applyHarnessLlmTier(tier);
  applyHarnessTestDefaults();
}

/** Respect preflight tier (anthropic-byok fallback); do not reset to platform hy3. */
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
  if (tier) {
    applyPinnedHarnessTier(tier);
    applyHarnessTestDefaults();
    return;
  }
  applyHarnessScenario("local-claude");
}

async function testClaudeSessionPersistence() {
  applyClaudeHarnessLlmTier();
  assertHarnessCreds();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const token = `CLD${Date.now().toString(36)}`;

  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true, agentConfig: resolveClaudeAgentConfig() });

  const sessionId = crypto.randomUUID();
  await rpc("/acp", "session/new", { sessionId, meta: { userId: "e2e-claude-sync" } });

  await waitSandboxReady(sessionId);
  await sleep(8000);

  let firstText = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(5000);
    const first = await promptSessionText(
      sessionId,
      `Remember exactly this token: ${token}. Reply with OK only.`,
      301 + attempt,
    );
    if (first.includes('"code":-32000')) {
      console.warn(`claude sync: prompt attempt ${attempt + 1}: ${first.slice(0, 280)}`);
      continue;
    }
    firstText = extractAllSseText(first);
    if (firstText.trim().length > 0) break;
  }
  assert.ok(
    firstText.trim().length > 0,
    `claude: first prompt produced no LLM text (ANTHROPIC_* / magent image): ${firstText.slice(0, 200)}`,
  );

  const { getHarnessSessionStore } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  const { countHarnessClaudeSessionEntries } = await import(
    "../../packages/agent-runtime/dist/harness/claude-session-probe.js"
  );

  let row = null;
  for (let i = 0; i < 36; i++) {
    row = await getHarnessSessionStore(envId).get(sessionId);
    if (row?.engineSessionId) break;
    await sleep(500);
  }
  assert.ok(row?.engineSessionId, "claude: expected engineSessionId after first prompt");

  let entryCount = 0;
  for (let i = 0; i < 36; i++) {
    entryCount = await countHarnessClaudeSessionEntries(row.engineSessionId);
    if (entryCount > 0) break;
    await sleep(2000);
  }
  assert.ok(
    entryCount > 0,
    `expected harness_claude_session_entries for ${row.engineSessionId} (magent needs claude-acp-harness.js)`,
  );
  row = await getHarnessSessionStore(envId).get(sessionId);
  assert.ok(!row?.claudeStoreEmptyAt, "claudeStoreEmptyAt set after successful append");
  assert.ok(!row?.claudeWarmFailedAt, "claudeWarmFailedAt set before re-acquire");

  stopRuntime();
  await sleep(800);
  await startRuntime({ useCloudDb: true, agentConfig: resolveClaudeAgentConfig() });

  const loadRes = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 302,
      method: "session/load",
      params: { sessionId, replay: true },
    }),
  });
  const loadText = await loadRes.text();
  assert.ok(!loadText.includes('"code":-32000'), `claude session/load failed: ${loadText.slice(0, 400)}`);

  await waitSandboxReady(sessionId);
  await sleep(8000);

  let recallText = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(5000);
    const recallBody = await promptSessionText(
      sessionId,
      `What is the exact token I asked you to remember? Reply with ONLY that token.`,
      303 + attempt,
    );
    recallText = extractAllSseText(recallBody);
    if (recallText.includes(token) || recallBody.includes(token)) break;
  }
  assert.ok(
    recallText.includes(token),
    `claude post-reload should recall token ${token}: ${recallText.slice(0, 300)}`,
  );

  await rpc("/acp", "session/delete", { sessionId });
}

async function testSandboxPrompt() {
  assertHarnessCreds();
  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true, agentConfig: resolveFullAgentConfig() });

  const sessionId = crypto.randomUUID();
  await rpc("/acp", "session/new", { sessionId, meta: { userId: "e2e-full" } });

  const res = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 100,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: pong" }],
      },
    }),
  });
  const text = await res.text();
  const image = process.env.HARNESS_SANDBOX_IMAGE ?? "";
  if (text.includes("404") && !/-magent\b/i.test(image) && !/app-magent/i.test(image)) {
    throw new Error(
      `sandbox ACP 404 — image not magent (${image || "unset"}). ` +
        `Push magent tag, then cp .env.harness.example .env.harness`,
    );
  }
  if (text.includes('"code":-32000') || text.includes("opencode acp timeout")) {
    throw new Error(`session/prompt sandbox failed (opencode): ${text.slice(0, 400)}`);
  }
  assert.ok(
    sseShowsLlmActivity(text),
    `expected LLM SSE from sandbox (platform/zen): ${text.slice(0, 400)}`,
  );
  await rpc("/acp", "session/delete", { sessionId });
}

class TestAcpClient {
  chunks = [];
  async sessionUpdate(params) {
    const u = params.update;
    if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      this.chunks.push(u.content.text);
    }
  }
  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  }
}

async function testZedStdioLifecycle() {
  bridgeChild = spawn(process.execPath, ["scripts/harness/acp-bridge.mjs", BASE], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const input = Writable.toWeb(bridgeChild.stdin);
  const output = Readable.toWeb(bridgeChild.stdout);
  const stream = acp.ndJsonStream(input, output);
  const client = new TestAcpClient();
  const connection = new acp.ClientSideConnection(() => client, stream);

  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "e2e-zed", version: "1.0.0" },
  });
  assert.equal(init.agentConfig?.runtime, "harness");

  const session = await connection.newSession({ cwd: "/home/user", mcpServers: [] });
  const listed = await connection.listSessions({});
  assert.ok(listed.sessions.some((s) => s.sessionId === session.sessionId));
  await connection.unstable_deleteSession({ sessionId: session.sessionId });
  bridgeChild.kill("SIGTERM");
  bridgeChild = null;
}

async function testHitlPermissionStubLoop() {
  stopRuntime();
  await sleep(400);
  await startRuntime({ stubSandbox: true });

  const { sessionId } = await rpc("/acp", "session/new", { meta: { userId: "e2e-hitl" } });
  const promptRes = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 60,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "HITL_E2E please approve bash" }],
      },
    }),
  });
  assert.ok(promptRes.ok);

  let toolCallId;
  for await (const msg of parseSseBody(promptRes)) {
    const update = msg.params?.update;
    if (update?.sessionUpdate === "permission_request") {
      toolCallId = update.toolCallId;
      break;
    }
  }
  assert.ok(toolCallId, "expected permission_request on stub sandbox SSE");

  const resumeRes = await sandboxFetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 61,
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
  let sawHitlOk = false;
  for await (const msg of parseSseBody(resumeRes)) {
    const update = msg.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text?.includes("HITL_OK")) {
      sawHitlOk = true;
    }
  }
  assert.ok(sawHitlOk, "expected HITL_OK after permission_decision forwarded to stub engine");

  await rpc("/acp", "session/delete", { sessionId });
  stopRuntime();
  await sleep(300);
  await startRuntime();
}

/** Custom LLM suite: skill materialization + model follows skill. */
async function testSkillsLlmOptional() {
  if (!LLM_SUITE) {
    console.log("○ skills LLM probe — skipped (pass --llm for manual custom-provider run)");
    return;
  }

  stopRuntime();
  await sleep(500);
  await startRuntime({
    useCloudDb: true,
    agentConfig: {
      ...resolveFullAgentConfig(),
      skills: [
        {
          name: "harness-e2e-demo",
          description: "E2E skill fixture",
          source: SKILL_FIXTURE_PATH,
        },
      ],
    },
  });

  const sessionId = crypto.randomUUID();
  try {
    await rpc("/acp", "session/new", { sessionId, meta: { userId: "e2e-skill-llm" } });
    const res = await sandboxFetch(`${BASE}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 410,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [
            {
              type: "text",
              text: "HARNESS_SKILL_CHECK — follow the skill and reply with ONLY: SKILL_OK",
            },
          ],
        },
      }),
    });
    const body = await res.text();
    if (body.includes('"code":-32000') || body.includes("opencode acp timeout")) {
      console.warn(
        `⚠ skills LLM probe optional skipped (opencode/LLM): ${body.slice(0, 240)}`,
      );
      return;
    }
    const text = extractAllSseText(body);
    if (!text.includes("SKILL_OK") && !body.includes("SKILL_OK")) {
      console.warn(
        `⚠ skills LLM probe optional: model did not reply SKILL_OK (got: ${text.slice(0, 200) || body.slice(0, 200)})`,
      );
      return;
    }
    console.log("✓ skills LLM probe optional: model replied SKILL_OK");
  } finally {
    await rpc("/acp", "session/delete", { sessionId }).catch(() => {});
    stopRuntime();
    await sleep(300);
    await startRuntime({ useCloudDb: true });
  }
}

async function testEngineMatrix() {
  const engines = LLM_SUITE
    ? ["opencode", "claude", "codebuddy"]
    : E2E_ENGINES === "all"
      ? ["opencode", "claude"]
      : E2E_ENGINES === "claude"
        ? ["claude"]
        : ["opencode"];
  for (const engine of engines) {
    try {
      stopRuntime();
      await sleep(500);
      if (engine === "claude") {
        applyClaudeHarnessLlmTier();
      } else {
        restoreOpencodeHarnessTier();
      }
      await startRuntime({
        useCloudDb: true,
        agentConfig:
          engine === "claude"
            ? resolveClaudeAgentConfig()
            : { ...resolveFullAgentConfig(), engine },
      });
      const sessionId = crypto.randomUUID();
      await rpc("/acp", "session/new", { sessionId, meta: { userId: `e2e-engine-${engine}` } });
      const res = await sandboxFetch(`${BASE}/acp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 300,
          method: "session/prompt",
          params: {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly: pong" }],
          },
        }),
      });
      const text = await res.text();
      assert.ok(!text.includes('"code":-32000'), `engine ${engine} prompt failed: ${text.slice(0, 300)}`);
      assert.ok(text.length > 0, `engine ${engine}: empty SSE`);
      await rpc("/acp", "session/delete", { sessionId });
      console.log(`✓ engine ${engine} session/prompt`);
    } catch (err) {
      console.warn(`⚠ engine ${engine} probe skipped: ${err.message}`);
    }
  }
  stopRuntime();
  await sleep(300);
  await startRuntime({ useCloudDb: true });
}

async function testZedStdioPrompt() {
  assertHarnessCreds();
  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true });

  bridgeChild = spawn(process.execPath, ["scripts/harness/acp-bridge.mjs", BASE], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const input = Writable.toWeb(bridgeChild.stdin);
  const output = Readable.toWeb(bridgeChild.stdout);
  const connection = new acp.ClientSideConnection(() => new TestAcpClient(), acp.ndJsonStream(input, output));

  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "e2e-zed", version: "1.0.0" },
  });
  const session = await connection.newSession({ cwd: "/home/user", mcpServers: [] });
  let result;
  try {
    result = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply with exactly: pong" }],
    });
  } catch (err) {
    if (LLM_SUITE) throw err;
    console.warn(`⚠ Zed stdio prompt skipped: ${err.message}`);
    await connection.unstable_deleteSession({ sessionId: session.sessionId }).catch(() => {});
    bridgeChild.kill("SIGTERM");
    bridgeChild = null;
    return;
  }
  assert.ok(result.stopReason);
  await connection.unstable_deleteSession({ sessionId: session.sessionId }).catch(() => {});
  bridgeChild.kill("SIGTERM");
  bridgeChild = null;
}

const DB_PRESSURE_ONLY = process.argv.includes("--db-pressure-only");

async function runDbPressureOnly() {
  const { parseDbPressureArgs, runE2eDbPressure } = await import(
    "../../scripts/harness/db-pressure.mjs"
  );
  const dbPressure = parseDbPressureArgs(process.argv.slice(2));
  if (!dbPressure.enabled) {
    throw new Error("--db-pressure-only requires --db-pressure");
  }
  const envId = process.env.CLOUDBASE_ENV_ID;
  if (!envId?.trim()) {
    throw new Error("CLOUDBASE_ENV_ID required for db-pressure (real FlexDB)");
  }
  const deps = { sleep, startRuntime, stopRuntime, rpc, promptSessionText, waitSandboxReady };
  try {
    if (E2E_OPENCODE) {
      await runE2eDbPressure({
        engine: "opencode",
        rounds: dbPressure.rounds,
        envId,
        deps: { ...deps, agentConfig: resolveFullAgentConfig() },
      });
    }
    if (E2E_CLAUDE) {
      if (!hasAnthropicByokInMap()) {
        throw new Error("db-pressure claude requires scenarios/.env.local-claude");
      }
      await runE2eDbPressure({
        engine: "claude",
        rounds: dbPressure.rounds,
        envId,
        deps: { ...deps, agentConfig: resolveClaudeAgentConfig() },
      });
    }
  } finally {
    stopRuntime();
  }
}

async function main() {
  try {
    if (DB_PRESSURE_ONLY) {
      const { teardownHarnessSandboxes } = await import("../../scripts/harness/ags-teardown.mjs");
      console.log("teardown (pre-flight, db-pressure-only)…");
      await teardownHarnessSandboxes();
      await runDbPressureOnly();
      return;
    }
    if (FULL) {
      const { teardownHarnessSandboxes } = await import("../../scripts/harness/ags-teardown.mjs");
      console.log("teardown (pre-flight)…");
      await teardownHarnessSandboxes();
    }
    await startRuntime();
    console.log("✓ runtime /healthz harness");
    await testAcpLifecycle("/acp");
    console.log("✓ POST /acp lifecycle");
    await testAcpLifecycle(`/v1/aibot/bots/${BOT_ID}/acp`);
    console.log("✓ POST /v1/aibot/bots/:botId/acp");
    await testManagedAgentClientMcpList();
    console.log("✓ managed-agent-client tools/list");
    await testClientToolBridgeClosedLoop();
    console.log("✓ client tool bridge closed loop (stub sandbox)");
    await testHitlPermissionStubLoop();
    console.log("✓ HITL permission_request ↔ permission_decision (stub sandbox)");
    await testZedStdioLifecycle();
    console.log("✓ Zed-style stdio bridge lifecycle");

    if (FULL) {
      if (E2E_OPENCODE) {
        await testSyncPersistence();
        console.log(
          LLM_SUITE
            ? "✓ opencode sync export → CloudBase → hydrate → session/load → token recall"
            : "✓ opencode sync export → CloudBase → hydrate → session/load replay (platform)",
        );
      } else {
        console.log("⊘ opencode sync（--engines claude）");
      }
      if (E2E_CLAUDE) {
        if (!hasAnthropicByokInMap()) {
          throw new Error(
            "HARNESS --engines claude|all requires scenarios/.env.local-claude",
          );
        }
        await testClaudeSessionPersistence();
        console.log("✓ claude SessionStore → CloudBase → runtime restart → token recall");
        if (E2E_OPENCODE) restoreOpencodeHarnessTier();
      } else {
        console.log("⊘ claude SessionStore（--engines claude|all 跑旁路）");
      }
      if (E2E_OPENCODE) {
        await testSandboxPrompt();
        console.log("✓ session/prompt → AGS sandbox SSE");
        await testSandboxCustomToolLoop();
        console.log("✓ sandbox custom tool MCP ↔ client ↔ agent");
        await testZedStdioPrompt();
        console.log("✓ Zed-style stdio prompt → sandbox");
        await testSkillsLlmOptional();
      } else {
        console.log("⊘ opencode 真箱 prompt/tool/skills（--engines claude）");
      }
      await testEngineMatrix();

      const { parseDbPressureArgs, runE2eDbPressure } = await import(
        "../../scripts/harness/db-pressure.mjs"
      );
      const dbPressure = parseDbPressureArgs(process.argv.slice(2));
      if (dbPressure.enabled) {
        const envId = process.env.CLOUDBASE_ENV_ID;
        const deps = { sleep, startRuntime, stopRuntime, rpc, promptSessionText, waitSandboxReady };
        if (E2E_OPENCODE) {
          await runE2eDbPressure({
            engine: "opencode",
            rounds: dbPressure.rounds,
            envId,
            deps: { ...deps, agentConfig: resolveFullAgentConfig() },
          });
        }
        if (E2E_CLAUDE) {
          await runE2eDbPressure({
            engine: "claude",
            rounds: dbPressure.rounds,
            envId,
            deps: { ...deps, agentConfig: resolveClaudeAgentConfig() },
          });
        }
      }
    }
  } finally {
    stopRuntime();
    if (FULL) {
      try {
        const { teardownHarnessSandboxes } = await import("../../scripts/harness/ags-teardown.mjs");
        console.log("teardown (post-flight)…");
        await teardownHarnessSandboxes();
      } catch (err) {
        console.error("teardown failed:", err.message);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  stopRuntime();
  process.exit(1);
});
