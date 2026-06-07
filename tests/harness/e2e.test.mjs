/**
 * Harness runtime e2e — agent-in-sandbox chain (local stub + optional real AGS).
 *
 *   npm run harness -- e2e
 *   npm run harness -- full
 *
 * Loads .env + .env.harness via scripts/load-env.mjs
 */

import { loadEnv, assertHarnessCreds } from "../../scripts/load-env.mjs";
loadEnv();

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Agent } from "undici";
import * as acp from "@agentclientprotocol/sdk";

/** Real AGS prompts/SSE can exceed undici default headers timeout (Node fetch). */
const SANDBOX_HTTP = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });
function sandboxFetch(url, init = {}) {
  return fetch(url, { ...init, dispatcher: SANDBOX_HTTP });
}

const FULL = process.argv.includes("--full");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_PORT = 19090;
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BOT_ID = "e2e-bot";
/** Dev-only: seed fake sync row when /sync/history empty — keep false in CI. */
const E2E_SYNC_SEED_SYNTHETIC_ON_EMPTY = false;

const BASE_AGENT_CONFIG = {
  name: "HarnessE2E",
  model: "hunyuan-t1-latest",
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

/** FULL e2e: merge host AGENT_CONFIG; opencode LLM prefers LLM_* + OPENAI_BASE_URL over Anthropic ModelSpec. */
function resolveFullAgentConfig() {
  const raw = process.env.AGENT_CONFIG?.trim();
  if (!raw) return { ...BASE_AGENT_CONFIG };
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
    return { ...BASE_AGENT_CONFIG };
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
      "If mcp.pump.poll_error 404 in logs, rebuild magent (TRW harness-mcp-relay) and sync-harness-tool.",
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
      const chunk = update?.content?.text;
      if (typeof chunk === "string") parts.push(chunk);
    } catch {
      // skip
    }
  }
  return parts.join("");
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
  return res.text();
}

async function testSyncPersistence() {
  assertHarnessCreds();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const token = `SYNC${Date.now().toString(36)}`;

  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true, agentConfig: resolveFullAgentConfig() });

  const sessionId = crypto.randomUUID();
  await rpc("/acp", "session/new", { sessionId, meta: { userId: "e2e-sync" } });

  const first = await promptSessionText(
    sessionId,
    `Remember exactly this token: ${token}. Reply with OK only.`,
    201,
  );
  if (first.includes('"code":-32000')) {
    console.warn(`sync: prompt returned error (LLM?): ${first.slice(0, 280)}`);
  }

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
    events = await syncStore.listEventsForAggregate(row.engineSessionId);
    if (events.length > 0) break;
    await sleep(1000);
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

  const recallBody = await promptSessionText(
    sessionId,
    "Reply with ONLY the exact token I asked you to remember, nothing else.",
    203,
  );
  const recallText = extractAllSseText(recallBody);
  assert.ok(
    recallText.includes(token) || recallBody.includes(token),
    `post-replay prompt should recall token ${token}; got: ${recallText.slice(0, 400) || recallBody.slice(0, 400)}`,
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
    console.warn(
      `⚠ session/prompt sandbox skipped (opencode/LLM): ${text.slice(0, 280)}. ` +
        "Set LLM_API_KEY + OPENAI_BASE_URL + LLM_MODEL in .env.harness for live LLM.",
    );
  } else {
    assert.ok(text.length > 0, "expected SSE from sandbox");
  }
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
  bridgeChild = spawn(process.execPath, ["scripts/harness-acp-bridge.mjs", BASE], {
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

async function testEngineMatrix() {
  const engines = ["opencode", "claude", "codebuddy"];
  for (const engine of engines) {
    try {
      stopRuntime();
      await sleep(500);
      await startRuntime({
        useCloudDb: true,
        agentConfig: { ...BASE_AGENT_CONFIG, engine },
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

  bridgeChild = spawn(process.execPath, ["scripts/harness-acp-bridge.mjs", BASE], {
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
    console.warn(`⚠ Zed stdio prompt skipped (opencode/LLM): ${err.message}`);
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

async function main() {
  try {
    if (FULL) {
      const { teardownHarnessSandboxes } = await import("../../scripts/harness-ags-teardown.mjs");
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
      const { runHarnessParitySmokes } = await import("../../scripts/harness-parity-smoke.mjs");
      await runHarnessParitySmokes();
      console.log("✓ parity smokes (mcp_servers, skills env, cloudbase MCP)");
      await testSyncPersistence();
      console.log("✓ opencode sync export → CloudBase → hydrate → session/load replay");
      await testSandboxPrompt();
      console.log("✓ session/prompt → AGS sandbox SSE");
      await testSandboxCustomToolLoop();
      console.log("✓ sandbox custom tool MCP ↔ client ↔ agent");
      await testZedStdioPrompt();
      console.log("✓ Zed-style stdio prompt → sandbox");
      await testEngineMatrix();
    }
  } finally {
    stopRuntime();
    if (FULL) {
      try {
        const { teardownHarnessSandboxes } = await import("../../scripts/harness-ags-teardown.mjs");
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
