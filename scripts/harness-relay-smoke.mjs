#!/usr/bin/env node
/**
 * Smoke: sandbox mcp-relay tools/list + pump loop (needs .env + .env.harness).
 */
import { loadEnv, assertHarnessCreds } from "./load-env.mjs";
loadEnv();
assertHarnessCreds();

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_PORT = 19091;
const BASE = `http://127.0.0.1:${SMOKE_PORT}`;

const AGENT_CONFIG = {
  name: "RelaySmoke",
  model: "hunyuan-t1-latest",
  system: "Harness relay smoke",
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

async function rpc(method, params = {}) {
  const res = await fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  const child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(SMOKE_PORT),
      CLOUDBASE_SERVER_URL: BASE,
      AGENT_CONFIG: JSON.stringify(AGENT_CONFIG),
      DEBUG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));

  for (let i = 0; i < 40; i++) {
    try {
      const h = await fetch(`${BASE}/healthz`);
      if ((await h.json()).runtime === "harness") break;
    } catch {
      // retry
    }
    await sleep(250);
  }

  const sessionId = crypto.randomUUID();
  await rpc("session/new", { sessionId, meta: { userId: "relay-smoke" } });

  const promptP = fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "ping" }],
      },
    }),
  });

  await sleep(8000);

  const listRes = await fetch(
    `${BASE}/internal/harness/mcp?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    },
  );
  console.log("gateway tools/list:", await listRes.json());

  child.kill("SIGTERM");
  await promptP.catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
