#!/usr/bin/env node
/** OMA gateway path — mirrors e2e testSandboxPrompt / testSyncPersistence first prompt. */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
import {
  loadEnv,
  assertHarnessCreds,
  applyHarnessLlmTier,
  applyHarnessTestDefaults,
} from "./load-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 19093;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT = Number(process.env.HARNESS_OPENCODE_ACP_TIMEOUT_MS) || 90_000;
const HTTP = new Agent({
  headersTimeout: TIMEOUT + 60_000,
  bodyTimeout: TIMEOUT + 60_000,
});

loadEnv();
assertHarnessCreds();
applyHarnessLlmTier("platform");
applyHarnessTestDefaults();

const AGENT_CONFIG = {
  name: "HarnessE2E",
  system: "Harness e2e agent.",
  runtime: "harness",
  engine: "opencode",
  tools: process.argv.includes("--with-tools")
    ? [
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
      ]
    : [],
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
  const { teardownHarnessSandboxes } = await import("./ags-teardown.mjs");
  await teardownHarnessSandboxes();

  child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      CLOUDBASE_SERVER_URL: BASE,
      CLOUDBASE_ENV_ID: process.env.CLOUDBASE_ENV_ID,
      AGENT_CONFIG: JSON.stringify(AGENT_CONFIG),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));

  for (let i = 0; i < 40; i++) {
    try {
      const h = await fetch(`${BASE}/healthz`);
      const j = await h.json();
      if (j.ok && j.runtime === "harness") break;
    } catch {
      // retry
    }
    await sleep(250);
  }

  await rpc("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "oma-diag", version: "0" },
  });

  const sessionId = crypto.randomUUID();
  await rpc("session/new", { sessionId, meta: { userId: "oma-diag" } });

  for (let i = 0; i < 90; i++) {
    const st = await rpc("session/status", { sessionId });
    if (st.sandboxReady) break;
    await sleep(2000);
  }

  await sleep(5000);
  const st = await rpc("session/status", { sessionId });
  console.log("session/status before prompt:", JSON.stringify(st));

  const { getHarnessSessionStore } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  const row = await getHarnessSessionStore(process.env.CLOUDBASE_ENV_ID).get(sessionId);
  console.log("store engineSessionId:", row?.engineSessionId ?? "(unset)");

  console.log("prompt via OMA gateway…");
  const t0 = Date.now();
  const res = await fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    dispatcher: HTTP,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 100,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: OK" }],
      },
    }),
  });
  const body = await res.text();
  const ms = Date.now() - t0;
  console.log(`elapsed ${ms}ms`);
  console.log("chunk:", /agent_message_chunk/.test(body));
  console.log("timeout:", /timeout waiting/.test(body));
  console.log("session/update:", /session\/update/.test(body));
  console.log(body.slice(0, 1200));

  child.kill("SIGTERM");
  await teardownHarnessSandboxes();
}

main().catch((e) => {
  console.error(e);
  child?.kill("SIGTERM");
  process.exit(1);
});
