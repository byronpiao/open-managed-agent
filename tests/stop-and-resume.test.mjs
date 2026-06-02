/**
 * Stop-and-resume mode unit tests
 *
 * Verifies the new client-side tool flow without a real kernel/SDK:
 *   - pumpEvents intercepts the client-tool sentinel from a tool_result event
 *     and rewrites stopReason to 'tool_use' with a pendingToolUse payload.
 *   - tool_approval_required is surfaced as permission_request SSE update +
 *     stopReason='awaiting_permission' + pendingPermission payload.
 *   - normal text flow still ends with stopReason='end_turn'.
 *   - makeClientSideToolDefinition produces a ToolDefinition whose execute()
 *     throws an Error containing the sentinel.
 *
 * Run: node tests/stop-and-resume.test.mjs
 * Exits with non-zero status on first failure.
 */

import { strict as assert } from "node:assert";

import {
  pumpEvents,
  makeClientSideToolDefinition,
  outcomeToDecision,
} from "../packages/agent-runtime/dist/kernel-adapter.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function makeFakeSse() {
  const frames = [];
  return {
    sink: { write: (frame) => frames.push(frame) },
    frames,
  };
}

/** Filter out diagnostic log frames (sessionUpdate === "log") added by pumpEvents. */
function nonLogFrames(frames) {
  return frames.filter((f) => f?.params?.update?.sessionUpdate !== "log");
}

async function* fromArray(events) {
  for (const e of events) yield e;
}

// ── 1. Plain text flow — should produce end_turn ────────────────────────────

test("plain message flow ends with end_turn", async () => {
  const { sink, frames } = makeFakeSse();
  const events = fromArray([
    { type: "message_delta", text: "Hello " },
    { type: "message_delta", text: "world" },
    { type: "session_idle", reason: "completed" },
  ]);
  const result = await pumpEvents(events, /*session*/ {}, {
    sse: sink,
    rpcId: 1,
    acpSessionId: "sess-1",
  });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.pendingToolUse, undefined);
  assert.equal(result.pendingPermission, undefined);
  // Two agent_message_chunk frames were emitted.
  const real = nonLogFrames(frames);
  assert.equal(real.length, 2);
  for (const f of real) {
    assert.equal(f.params.update.sessionUpdate, "agent_message_chunk");
  }
});

// ── 2. Client-side tool sentinel → stopReason='tool_use' ────────────────────

test("client-side tool sentinel → stopReason=tool_use + pendingToolUse", async () => {
  const { sink, frames } = makeFakeSse();

  // Build a sentinel-bearing error message exactly the way our tool's
  // execute() would throw it (the SDK relays the thrown error message into
  // tool_result.output as text).
  const payload = {
    __OAK_CLIENT_TOOL_PENDING__: true,
    toolUseId: "tu-abc",
    toolName: "read_file",
    input: { path: "/src/main.ts" },
  };
  const sentinelText = `__OAK_CLIENT_TOOL_PENDING__:${JSON.stringify(payload)}`;

  const events = fromArray([
    {
      type: "tool_call",
      toolUseId: "tu-abc",
      toolName: "read_file",
      input: { path: "/src/main.ts" },
    },
    {
      type: "tool_result",
      toolUseId: "tu-abc",
      toolName: "read_file",
      output: sentinelText,
      isError: true,
    },
    // SDK ended the turn after the synthetic error
    { type: "session_idle", reason: "completed" },
  ]);

  const result = await pumpEvents(events, {}, {
    sse: sink,
    rpcId: 2,
    acpSessionId: "sess-2",
  });

  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.pendingToolUse, {
    toolUseId: "tu-abc",
    toolName: "read_file",
    input: { path: "/src/main.ts" },
  });
  // Critically: the SSE stream got the tool_call frame but NOT a
  // tool_call_update with a fake error (we suppressed it).
  const real = nonLogFrames(frames);
  assert.equal(real.length, 1);
  assert.equal(real[0].params.update.sessionUpdate, "tool_call");
  assert.equal(real[0].params.update.toolCallId, "tu-abc");
});

// ── 2b. Sentinel embedded in array-typed output (SDK sometimes wraps) ───────

test("sentinel in array-shaped tool_result.output is detected", async () => {
  const { sink } = makeFakeSse();
  const payload = {
    __OAK_CLIENT_TOOL_PENDING__: true,
    toolUseId: "tu-xyz",
    toolName: "fs_write",
    input: { path: "/tmp/a", content: "hi" },
  };
  const text = `prefix __OAK_CLIENT_TOOL_PENDING__:${JSON.stringify(payload)}`;
  const events = fromArray([
    { type: "tool_call", toolUseId: "tu-xyz", toolName: "fs_write", input: payload.input },
    {
      type: "tool_result",
      toolUseId: "tu-xyz",
      toolName: "fs_write",
      output: [{ type: "text", text }],
      isError: true,
    },
    { type: "session_idle", reason: "completed" },
  ]);
  const result = await pumpEvents(events, {}, {
    sse: sink,
    rpcId: 3,
    acpSessionId: "sess-3",
  });
  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.pendingToolUse?.toolUseId, "tu-xyz");
  assert.equal(result.pendingToolUse?.toolName, "fs_write");
});

// ── 3. tool_approval_required → stopReason='awaiting_permission' ────────────

test("tool_approval_required → permission_request frame + awaiting_permission", async () => {
  const { sink, frames } = makeFakeSse();
  const events = fromArray([
    {
      type: "tool_approval_required",
      toolUseId: "tu-bash-1",
      toolName: "bash",
      input: { command: "rm -rf /" },
      hints: { suggestedScopes: ["once", "session"] },
      runStateJson: "{}",
    },
    // pumpEvents should return as soon as it sees this — anything after
    // shouldn't matter, but include a session_idle to be defensive.
    { type: "session_idle", reason: "requires_action" },
  ]);

  const result = await pumpEvents(events, {}, {
    sse: sink,
    rpcId: 4,
    acpSessionId: "sess-4",
  });

  assert.equal(result.stopReason, "awaiting_permission");
  assert.ok(result.pendingPermission);
  assert.equal(result.pendingPermission.toolUseId, "tu-bash-1");
  assert.equal(result.pendingPermission.toolName, "bash");
  assert.deepEqual(result.pendingPermission.args, { command: "rm -rf /" });
  // Exactly one real SSE frame: permission_request
  const real = nonLogFrames(frames);
  assert.equal(real.length, 1);
  assert.equal(real[0].params.update.sessionUpdate, "permission_request");
  assert.equal(real[0].params.update.toolCallId, "tu-bash-1");
  // Options should include allow-once / reject-once / allow-always / reject-always
  const optionIds = real[0].params.update.options.map((o) => o.optionId);
  assert.ok(optionIds.includes("allow-once"));
  assert.ok(optionIds.includes("reject-once"));
  assert.ok(optionIds.includes("allow-always"));
  assert.ok(optionIds.includes("reject-always"));
});

// ── 4. Real tool_result (non-sentinel) is forwarded normally ────────────────

test("non-sentinel tool_result emits tool_call_update completed", async () => {
  const { sink, frames } = makeFakeSse();
  const events = fromArray([
    { type: "tool_call", toolUseId: "tu-real", toolName: "ls", input: {} },
    {
      type: "tool_result",
      toolUseId: "tu-real",
      toolName: "ls",
      output: "file1\nfile2",
      isError: false,
    },
    { type: "session_idle", reason: "completed" },
  ]);
  const result = await pumpEvents(events, {}, {
    sse: sink,
    rpcId: 5,
    acpSessionId: "sess-5",
  });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.pendingToolUse, undefined);
  // Two real frames: tool_call (in_progress) + tool_call_update (completed)
  const real = nonLogFrames(frames);
  assert.equal(real.length, 2);
  assert.equal(real[0].params.update.status, "in_progress");
  assert.equal(real[1].params.update.status, "completed");
  assert.equal(real[1].params.update.result, "file1\nfile2");
});

// ── 5. makeClientSideToolDefinition produces a sentinel-throwing tool ───────

test("makeClientSideToolDefinition throws sentinel error from execute()", async () => {
  const def = makeClientSideToolDefinition({
    name: "fetch_url",
    description: "Fetch a URL on behalf of the model.",
    input_schema: { type: "object", properties: { url: { type: "string" } } },
  });

  assert.equal(def.name, "fetch_url");
  assert.equal(def.description, "Fetch a URL on behalf of the model.");
  assert.equal(typeof def.execute, "function");
  // parameters is a Zod schema
  assert.ok(def.parameters && typeof def.parameters.parse === "function");

  let thrown;
  try {
    await def.execute({ url: "https://example.com" }, {
      toolUseId: "tu-fetch-1",
      conversationId: "sess-test",
      userId: "u",
      envId: "env-test",
      signal: new AbortController().signal,
    });
    throw new Error("execute() should have thrown");
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown.message.includes("__OAK_CLIENT_TOOL_PENDING__"));
  // Round-trip the JSON payload from the message
  const idx = thrown.message.indexOf("{");
  const payload = JSON.parse(thrown.message.slice(idx));
  assert.equal(payload.toolUseId, "tu-fetch-1");
  assert.equal(payload.toolName, "fetch_url");
  assert.deepEqual(payload.input, { url: "https://example.com" });
});

// ── 6. outcomeToDecision maps optionIds to ApprovalDecision ─────────────────

test("outcomeToDecision maps the four canonical optionIds", async () => {
  assert.deepEqual(
    outcomeToDecision({ outcome: "selected", optionId: "allow-once" }),
    { kind: "allow", scope: "once" },
  );
  assert.deepEqual(
    outcomeToDecision({ outcome: "selected", optionId: "allow-always" }),
    { kind: "allow", scope: "session" },
  );
  const denyOnce = outcomeToDecision({ outcome: "selected", optionId: "reject-once" });
  assert.equal(denyOnce.kind, "deny");
  assert.equal(denyOnce.scope, "once");
  const cancelled = outcomeToDecision({ outcome: "cancelled" });
  assert.equal(cancelled.kind, "deny");
  assert.equal(cancelled.interrupt, true);
});

// ── 7. error event → stopReason='error' + log frame ─────────────────────────

test("kernel error event maps to stopReason='error' with log frame", async () => {
  const { sink, frames } = makeFakeSse();
  const events = fromArray([
    { type: "error", error: new Error("kernel boom") },
  ]);
  const result = await pumpEvents(events, {}, {
    sse: sink,
    rpcId: 7,
    acpSessionId: "sess-7",
  });
  assert.equal(result.stopReason, "error");
  // Find the error log frame (level=error). Diagnostic debug logs may also exist.
  const errLog = frames.find(
    (f) => f?.params?.update?.sessionUpdate === "log" && f?.params?.update?.level === "error",
  );
  assert.ok(errLog, "expected an error-level log frame");
  assert.match(errLog.params.update.message, /kernel boom/);
});

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${t.name}`);
    console.error(err?.stack ?? err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
