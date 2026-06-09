#!/usr/bin/env node
/** Mimic ensureEngineSessionOnSandbox + session/prompt forward (no OMA SSE pipe). */
import { setTimeout as sleep } from "node:timers/promises";
import {
  loadEnv,
  assertHarnessCreds,
  applyHarnessLlmTier,
  applyHarnessTestDefaults,
} from "./load-env.mjs";

loadEnv();
assertHarnessCreds();
applyHarnessLlmTier("platform");
applyHarnessTestDefaults();

const AGENT_CONFIG = {
  name: "ForwardDiag",
  system: "Harness forward diag.",
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

async function drain(res) {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  return { ct, text, status: res.status };
}

async function main() {
  const { teardownHarnessSandboxes } = await import("./ags-teardown.mjs");
  await teardownHarnessSandboxes();

  const { buildHarnessSandboxEnv, buildHarnessAcpMcpServers, DEFAULT_HARNESS_SANDBOX_CWD } =
    await import("../../packages/agent-runtime/dist/harness/deploy.js");
  const { getSandboxOrchestrator } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );

  const acpSessionId = crypto.randomUUID();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "http://127.0.0.1:19093";
  const path = getSandboxOrchestrator().acpPathForEngine("opencode");

  console.log("acp path:", path);
  const instanceEnv = buildHarnessSandboxEnv({
    config: AGENT_CONFIG,
    engine: "opencode",
    clientToolCallbackBase: callbackBase,
    acpSessionId,
  });
  const hostOc = instanceEnv.find((e) => e.Name === "OPENCODE_CONFIG_CONTENT");
  console.log(
    "host OPENCODE:",
    hostOc ? `${hostOc.Value.length}b ${JSON.parse(hostOc.Value).model}` : "(missing)",
  );
  const handle = await getSandboxOrchestrator().acquire({
    envId,
    agentConfig: AGENT_CONFIG,
    engine: "opencode",
    acpSessionId,
    instanceEnv,
  });
  console.log("instance:", handle.instanceId);
  await sleep(8000);

  const boxModel = await handle.request("/api/tools/bash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command:
        "python3 -c \"import os,json; c=os.environ.get('OPENCODE_CONFIG_CONTENT',''); print('bytes',len(c)); d=json.loads(c) if c else {}; print('model',d.get('model','(none)'))\"",
    }),
  });
  console.log("in-box model:", (await boxModel.text()).slice(0, 200));

  const mcpServers = buildHarnessAcpMcpServers({
    config: AGENT_CONFIG,
    clientToolCallbackBase: callbackBase,
    acpSessionId,
  });
  console.log("mcp url:", mcpServers[0]?.url ?? "(none)");

  const cwd = process.argv[2]?.trim() || DEFAULT_HARNESS_SANDBOX_CWD;
  const mcpMode = process.argv[3]?.trim() || "harness";
  const sessionMcp = mcpMode === "none" ? [] : mcpMode === "empty" ? [] : mcpServers;
  console.log("cwd:", cwd, "mcpMode:", mcpMode);

  const newRes = await handle.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "new-1",
      method: "session/new",
      params: {
        cwd,
        mcpServers: sessionMcp,
        meta: { userId: "forward-diag" },
      },
    }),
  });
  const newDrained = await drain(newRes);
  console.log("\n--- session/new ---");
  console.log("status:", newDrained.status, "ct:", newDrained.ct);
  console.log(newDrained.text.slice(0, 500));

  let engineSid = "";
  try {
    engineSid = JSON.parse(newDrained.text).result?.sessionId ?? "";
  } catch {
    const m = newDrained.text.match(/"sessionId"\s*:\s*"(ses_[^"]+)"/);
    engineSid = m?.[1] ?? "";
  }
  console.log("engineSid:", engineSid || "(missing)");

  const promptId = "prompt-1";
  const t0 = Date.now();
  const promptRes = await handle.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: promptId,
      method: "session/prompt",
      params: {
        sessionId: engineSid || acpSessionId,
        prompt: [{ type: "text", text: "Reply with exactly: OK" }],
      },
    }),
  });
  let streamFrames = 0;
  let streamBody = "";
  const ct = promptRes.headers.get("content-type") ?? "";
  if (promptRes.body && ct.includes("event-stream")) {
    const reader = promptRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const raw = trimmed.slice(6).trim();
        if (raw === "[DONE]") continue;
        streamFrames++;
        streamBody += `${trimmed}\n`;
      }
    }
  } else {
    const promptDrained = await drain(promptRes);
    streamBody = promptDrained.text;
    streamFrames = (streamBody.match(/^data: /gm) ?? []).length;
  }
  console.log("\n--- session/prompt ---");
  console.log("elapsed:", Date.now() - t0, "ms");
  console.log("status:", promptRes.status, "ct:", ct, "streamFrames:", streamFrames);
  console.log("has chunk:", /agent_message_chunk/.test(streamBody));
  console.log(streamBody.slice(0, 1200));

  await getSandboxOrchestrator().stopInstanceForEnv(handle.instanceId, envId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
