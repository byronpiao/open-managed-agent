#!/usr/bin/env node
/**
 * Live check: after opencode ACP prompt, does /sync/history return events?
 */
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv, assertHarnessCreds } from "./load-env.mjs";
import { buildParityAgentConfig } from "./harness-parity-smoke.mjs";

loadEnv();
assertHarnessCreds();

const envId = process.env.CLOUDBASE_ENV_ID;
const acpSessionId = crypto.randomUUID();
const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "http://127.0.0.1:9000";
const E2E_PORT = 19091;
const BASE = `http://127.0.0.1:${E2E_PORT}`;

const agentConfig = {
  ...buildParityAgentConfig(),
  model: process.env.LLM_MODEL ?? "mimo-v2.5",
  runtime: "harness",
  engine: "opencode",
};

const { spawn } = await import("node:child_process");
const repoRoot = new URL("..", import.meta.url).pathname;

function startRuntime() {
  const child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      CLOUDBASE_SERVER_URL: BASE,
      CLOUDBASE_ENV_ID: envId,
      AGENT_CONFIG: JSON.stringify(agentConfig),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stderr.write(d));
  child.stderr?.on("data", (d) => process.stderr.write(d));
  return child;
}

async function waitHealthz() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      const j = await res.json();
      if (j.ok) return;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error("runtime not ready");
}

async function rpc(method, params, id = 1) {
  const res = await fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return res.json();
}

async function promptText(sessionId, text) {
  const { Agent } = await import("undici");
  const http = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });
  const res = await fetch(`${BASE}/acp`, {
    dispatcher: http,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    }),
  });
  return res.text();
}

const child = startRuntime();
try {
  await waitHealthz();
  const sessionId = crypto.randomUUID();
  await rpc("session/new", { sessionId, meta: { userId: "sync-live" } });
  const token = `LIVE${Date.now().toString(36)}`;
  console.log("prompting…", token);
  const sse = await promptText(sessionId, `Remember token ${token}. Reply OK only.`);
  console.log("prompt sse tail:", sse.slice(-400));

  const { getHarnessSessionStore } = await import(
    "../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  const { fetchOpencodeSyncHistory, stealOpencodeSessionForSync, ensureOpencodeSyncStarted } =
    await import("../packages/agent-runtime/dist/harness/opencode-sync.js");

  const row = await getHarnessSessionStore(envId).get(sessionId);
  console.log("engineSessionId:", row?.engineSessionId, "instanceId:", row?.instanceId);

  const { getSandboxOrchestrator } = await import(
    "../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  async function bash(h, command) {
    const res = await h.request("/api/tools/bash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const j = await res.json();
    return String(j.output ?? j.result?.output ?? "");
  }

  const orch = getSandboxOrchestrator();
  const handle = row?.instanceId
    ? await orch.connectToInstance(row.instanceId, envId)
    : null;
  if (!handle) throw new Error("no instanceId on harness session");

  await ensureOpencodeSyncStarted(handle);
  if (row?.engineSessionId) await stealOpencodeSessionForSync(handle, row.engineSessionId);

  for (let i = 0; i < 5; i++) {
    const history = await fetchOpencodeSyncHistory(handle, {});
    console.log(`history[${i}] count=`, history.length);
    if (history.length) {
      console.log("sample:", JSON.stringify(history.slice(0, 3), null, 2));
      break;
    }
    await sleep(1000);
  }

  const histRes = await handle.request("/api/agents/opencode/sync/history", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-directory": "/home/user",
    },
    body: "{}",
  });
  console.log("raw history status:", histRes.status, (await histRes.text()).slice(0, 500));

  const dbPaths = await bash(
    handle,
    "find /home/user/.local/share/opencode /home/user/.opencode -name '*.db' 2>/dev/null | head -10",
  );
  console.log("db paths:", dbPaths.trim() || "(none)");

  const dbPath = await bash(handle, "opencode db path 2>/dev/null || echo unknown");
  console.log("opencode db path:", dbPath.trim());

  if (row?.engineSessionId) {
    const sid = row.engineSessionId;
    const diag = await bash(
      handle,
        `echo version=$(opencode --version 2>/dev/null | head -1); ` +
        `opencode db "select name from sqlite_master where type='table' order by 1" 2>/dev/null | head -20; ` +
        `echo event_total=$(opencode db "select count(*) as c from event" 2>/dev/null | tail -1); ` +
        `echo event_seq_total=$(opencode db "select count(*) as c from event_sequence" 2>/dev/null | tail -1); ` +
        `echo event_session=$(opencode db "select count(*) as c from event where aggregate_id='${sid}'" 2>/dev/null | tail -1); ` +
        `echo session_rows=$(opencode db "select count(*) as c from session" 2>/dev/null | tail -1); ` +
        `echo message_rows=$(opencode db "select count(*) as c from message" 2>/dev/null | tail -1); ` +
        `python3 -c "
import sqlite3,glob
for p in sorted(set(glob.glob('/home/user/.local/share/opencode/*.db')+glob.glob('/home/user/.opencode/**/*.db',recursive=True))):
  try:
    c=sqlite3.connect(p)
    n=c.execute('select count(*) from event').fetchone()[0]
    print(f'events_in {p}: {n}')
  except Exception as e:
    print(f'skip {p}: {e}')
" 2>/dev/null || true`,
    );
    console.log("db diag:\n", diag.trim());

    const sessRes = await handle.request("/api/agents/opencode/session", {
      method: "GET",
      headers: { "x-opencode-directory": "/home/user" },
    });
    console.log("session list:", sessRes.status, (await sessRes.text()).slice(0, 400));
  }

  await rpc("session/delete", { sessionId }, 2);
} finally {
  child.kill("SIGTERM");
}
