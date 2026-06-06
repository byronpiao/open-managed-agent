/**
 * Harness runtime e2e — agent-in-sandbox chain (local stub + optional real AGS).
 *
 *   npm run harness:e2e
 *   npm run harness:full
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
import * as acp from "@agentclientprotocol/sdk";

const FULL = process.argv.includes("--full");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_PORT = 19090;
const BASE = `http://127.0.0.1:${E2E_PORT}`;
/** Child runtime only — not a user-facing env var. */
const E2E_STUB_SANDBOX_ENV = "HARNESS_E2E_STUB_SANDBOX";
const BOT_ID = "e2e-bot";

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

let activeAgentConfig = { ...BASE_AGENT_CONFIG };

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
  agentConfig = activeAgentConfig,
} = {}) {
  activeAgentConfig = agentConfig;
  const childEnv = {
    ...process.env,
    PORT: String(E2E_PORT),
    CLOUDBASE_SERVER_URL: BASE,
    CLOUDBASE_ENV_ID: process.env.CLOUDBASE_ENV_ID ?? "test-local-harness",
    AGENT_CONFIG: JSON.stringify(agentConfig),
  };
  if (stubSandbox) {
    childEnv[E2E_STUB_SANDBOX_ENV] = "1";
  }
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

  const promptRes = await fetch(`${BASE}/acp`, {
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

  await fetch(`${BASE}/acp`, {
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
  const promptFetch = fetch(`${BASE}/acp`, {
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
      throw new Error(msg.error.message ?? JSON.stringify(msg.error));
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

async function testSandboxPrompt() {
  assertHarnessCreds();
  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true });

  const sessionId = crypto.randomUUID();
  await rpc("/acp", "session/new", { sessionId, meta: { userId: "e2e-full" } });

  const res = await fetch(`${BASE}/acp`, {
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
  assert.ok(!text.includes('"code":-32000'), `session/prompt failed: ${text.slice(0, 400)}`);
  assert.ok(text.length > 0, "expected SSE from sandbox");
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
  const promptRes = await fetch(`${BASE}/acp`, {
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

  const resumeRes = await fetch(`${BASE}/acp`, {
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
    const strict = engine === "opencode";
    try {
      stopRuntime();
      await sleep(500);
      await startRuntime({
        useCloudDb: true,
        agentConfig: { ...BASE_AGENT_CONFIG, engine },
      });
      const sessionId = crypto.randomUUID();
      await rpc("/acp", "session/new", { sessionId, meta: { userId: `e2e-engine-${engine}` } });
      const res = await fetch(`${BASE}/acp`, {
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
      if (strict) throw err;
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
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: pong" }],
  });
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
