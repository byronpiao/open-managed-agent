/**
 * Harness #7 — opencode HITL on real AGS (manual / debug; not in test:merge or harness cloud-*).
 *
 *   node tests/harness/hitl-opencode.test.mjs
 *
 * Requires `.env.harness` with LLM_API_KEY, OPENAI_BASE_URL, LLM_MODEL.
 */

import { loadEnv, assertHarnessCreds } from "../../scripts/harness/load-env.mjs";
import { resolveHarnessByokModel } from "../../lib/harness-llm-env.mjs";
loadEnv();

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 19091;
const BASE = `http://127.0.0.1:${PORT}`;
const SANDBOX_HTTP = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

function sandboxFetch(url, init = {}) {
  return fetch(url, { ...init, dispatcher: SANDBOX_HTTP });
}

const HITL_AGENT_CONFIG = {
  name: "HarnessHitlOpencode",
  model: resolveHarnessByokModel(),
  system:
    "When the user asks you to run a shell command, you MUST use bash. " +
    "Do not refuse; run the command they ask for.",
  runtime: "harness",
  engine: "opencode",
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

let child;
let rpcSeq = 0;

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

async function startRuntime() {
  const { assertHarnessLlmSuiteEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessLlmSuiteEnv();

  child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      CLOUDBASE_SERVER_URL: BASE,
      AGENT_CONFIG: JSON.stringify(HITL_AGENT_CONFIG),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stderr.write(d));
  child.stderr?.on("data", (d) => process.stderr.write(d));
  await waitHealthz();
}

function stopRuntime() {
  if (child && !child.killed) child.kill("SIGTERM");
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
      const t = line.trim();
      if (!t.startsWith("data: ")) continue;
      const raw = t.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        yield JSON.parse(raw);
      } catch {
        // skip
      }
    }
  }
}

async function main() {
  assertHarnessCreds();
  const { teardownHarnessSandboxes } = await import("../../scripts/harness/ags-teardown.mjs");
  console.log("teardown (pre-flight)…");
  await teardownHarnessSandboxes();

  const { buildHarnessOpencodeConfigContent } = await import(
    "../../packages/agent-runtime/dist/harness/deploy.js"
  );
  const opencodeCfg = buildHarnessOpencodeConfigContent(HITL_AGENT_CONFIG);
  assert.ok(
    opencodeCfg?.includes('"bash":"ask"') || opencodeCfg?.includes('"bash": "ask"'),
    `OPENCODE_CONFIG should set bash ask; got ${opencodeCfg?.slice(0, 200)}`,
  );

  try {
    await startRuntime();
    const { sessionId } = await rpc("session/new", { meta: { userId: "hitl-opencode" } });

    let toolCallId;
    let lastErr;
    for (let attempt = 0; attempt < 2 && !toolCallId; attempt++) {
      if (attempt > 0) await sleep(3000);
      const promptRes = await sandboxFetch(`${BASE}/acp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 70 + attempt,
          method: "session/prompt",
          params: {
            sessionId,
            prompt: [
              {
                type: "text",
                text:
                  "Use bash to run exactly: echo HITL_OPENCODE_PROBE. " +
                  "You must invoke the bash tool; do not answer without running it.",
              },
            ],
          },
        }),
      });
      const body = await promptRes.text();
      if (body.includes('"code":-32000') || body.includes("opencode acp timeout")) {
        lastErr = new Error(body.slice(0, 400));
        continue;
      }
      for await (const msg of parseSseBody(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      )) {
        const update = msg.params?.update;
        if (update?.sessionUpdate === "permission_request") {
          toolCallId = update.toolCallId;
          break;
        }
      }
      if (!toolCallId) lastErr = new Error(`no permission_request in SSE: ${body.slice(0, 500)}`);
    }
    assert.ok(toolCallId, lastErr?.message ?? "expected permission_request from opencode");

    const resumeRes = await sandboxFetch(`${BASE}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 72,
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
    for await (const msg of parseSseBody(resumeRes)) {
      const update = msg.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" || update?.sessionUpdate === "tool_call") {
        continued = true;
      }
      if (msg.result?.stopReason) continued = true;
    }
    assert.ok(continued, "expected conversation to continue after allow-once");

    await rpc("session/delete", { sessionId });
    console.log("✓ #7 opencode HITL: permission_request → allow-once → continue");
  } finally {
    stopRuntime();
    try {
      console.log("teardown (post-flight)…");
      await teardownHarnessSandboxes();
    } catch (err) {
      console.warn("teardown:", err.message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  stopRuntime();
  process.exit(1);
});
