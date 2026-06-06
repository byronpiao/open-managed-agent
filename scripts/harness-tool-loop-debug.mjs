#!/usr/bin/env node
import { loadEnv, assertHarnessCreds } from "./load-env.mjs";
loadEnv();
assertHarnessCreds();

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 19091;
const BASE = `http://127.0.0.1:${PORT}`;

const AGENT_CONFIG = {
  name: "HarnessE2E",
  model: "hunyuan-t1-latest",
  system: "When asked to use echo_tool, you MUST call it before answering.",
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

let child;
async function rpc(method, params = {}) {
  const res = await fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function main() {
  child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      CLOUDBASE_SERVER_URL: BASE,
      AGENT_CONFIG: JSON.stringify(AGENT_CONFIG),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));

  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`${BASE}/healthz`)).json();
      if (j.ok) break;
    } catch {}
    await sleep(250);
  }

  const { sessionId } = await rpc("session/new", { meta: { userId: "debug" } });
  const marker = "debug-tool-marker";
  const res = await fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          {
            type: "text",
            text: `You MUST call echo_tool with message exactly "${marker}" before answering. Reply TOOL_OK after.`,
          },
        ],
      },
    }),
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const updates = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const msg = JSON.parse(raw);
        const u = msg.params?.update;
        if (u?.sessionUpdate) updates.push(u.sessionUpdate);
        if (u?.sessionUpdate === "tool_use_request") {
          console.log("TOOL_USE", JSON.stringify(u));
        }
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.text) {
          process.stdout.write(u.content.text);
        }
      } catch {}
    }
    buf = buf.split("\n").pop() ?? "";
  }
  console.log("\n--- sessionUpdates ---");
  console.log([...new Set(updates)].join(", "));
  console.log("counts", updates.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {}));
  child.kill("SIGTERM");
}

main().catch((e) => {
  console.error(e);
  child?.kill("SIGTERM");
  process.exit(1);
});
