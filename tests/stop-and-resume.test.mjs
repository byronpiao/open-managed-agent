/**
 * Stop-and-resume mode unit tests (kernel AcpSessionUpdate passthrough).
 *
 * pumpEvents wraps each update in session/update SSE frames and stops on:
 *   - request_permission → awaiting_permission
 *   - ask_user → tool_use
 *   - agent_phase idle → end_turn
 *
 * Run: node tests/stop-and-resume.test.mjs
 */

import { strict as assert } from "node:assert";

import {
  pumpEvents,
  makeClientSideToolDefinition,
  outcomeToDecision,
} from "../packages/agent-runtime-managed/dist/oak-runtime/kernel-adapter.js";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function makeCtx(acpSessionId = "sess-1") {
  const frames = [];
  const sse = { write: (frame) => frames.push(frame) };
  return { sse, frames, ctx: { sse, rpcId: 1, acpSessionId } };
}

async function* fromArray(events) {
  for (const e of events) yield e;
}

test("agent_phase idle ends with end_turn", async () => {
  const { ctx, frames } = makeCtx("sess-1");
  const events = fromArray([
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
      },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_phase", phase: "idle" },
      },
    },
  ]);
  const result = await pumpEvents(events, ctx);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(frames.length, 2);
  assert.equal(frames[1].params.update.sessionUpdate, "agent_phase");
});

test("request_permission → awaiting_permission + pendingPermission", async () => {
  const { ctx, frames } = makeCtx("sess-2");
  const events = fromArray([
    {
      jsonrpc: "2.0",
      method: "session/request_permission",
      params: {
        sessionId: "sess-2",
        toolCall: {
          toolCallId: "tu-bash-1",
          title: "bash",
          rawInput: { command: "rm -rf /" },
        },
        options: [
          { optionId: "allow-once", name: "Allow once" },
          { optionId: "reject-once", name: "Reject once" },
        ],
      },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-2",
        update: { sessionUpdate: "agent_phase", phase: "idle" },
      },
    },
  ]);
  const result = await pumpEvents(events, ctx);
  assert.equal(result.stopReason, "awaiting_permission");
  assert.equal(result.pendingPermission?.toolUseId, "tu-bash-1");
  assert.equal(result.pendingPermission?.toolName, "bash");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, "session/request_permission");
  assert.equal(frames[0].params.toolCall.toolCallId, "tu-bash-1");
});

test("ask_user → tool_use + pendingToolUse", async () => {
  const { ctx } = makeCtx("sess-3");
  const questions = [{ question: "Which file?" }];
  const events = fromArray([
    {
      jsonrpc: "2.0",
      method: "client/AskUserQuestion",
      params: questions,
      _meta: { toolCallId: "tu-ask-1" },
    },
  ]);
  const result = await pumpEvents(events, ctx);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.pendingToolUse, {
    toolUseId: "tu-ask-1",
    toolName: "AskUserQuestion",
    input: questions,
  });
});

test("stream end without idle still returns end_turn", async () => {
  const { ctx } = makeCtx("sess-4");
  const events = fromArray([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
  ]);
  const result = await pumpEvents(events, ctx);
  assert.equal(result.stopReason, "end_turn");
});

test("makeClientSideToolDefinition is a defensive stub (hook should preempt)", async () => {
  const def = makeClientSideToolDefinition({
    name: "fetch_url",
    description: "Fetch a URL on behalf of the model.",
    input_schema: { type: "object", properties: { url: { type: "string" } } },
  });

  assert.equal(def.name, "fetch_url");
  const out = await def.execute({ url: "https://example.com" }, {
    toolUseId: "tu-fetch-1",
    conversationId: "sess-test",
    userId: "u",
    envId: "env-test",
    signal: new AbortController().signal,
  });
  assert.equal(typeof out, "string");
  assert.ok(out.includes("fetch_url"));
  assert.ok(out.includes("client-side"));
});

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
