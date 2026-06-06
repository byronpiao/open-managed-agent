#!/usr/bin/env node
/** Direct data-plane smoke for TRW /api/harness/mcp-relay */
import { loadEnv, assertHarnessCreds } from "./load-env.mjs";
loadEnv();
assertHarnessCreds();

const { getSandboxOrchestrator } = await import(
  "../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
);
const { buildHarnessSandboxEnv } = await import("../packages/agent-runtime/dist/harness/deploy.js");

const acpSessionId = crypto.randomUUID();
const config = {
  name: "t",
  model: "m",
  system: "s",
  runtime: "harness",
  engine: "opencode",
  tools: [
    {
      type: "custom",
      name: "echo_tool",
      description: "Echo",
      input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
  ],
};

const envId = process.env.CLOUDBASE_ENV_ID;
const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "http://127.0.0.1:9000";

console.log("acquiring sandbox...");
const orch = getSandboxOrchestrator();
const handle = await orch.acquire({
  envId,
  agentConfig: config,
  engine: "opencode",
  acpSessionId,
  instanceEnv: buildHarnessSandboxEnv({
    config,
    engine: "opencode",
    clientToolCallbackBase: callbackBase,
    acpSessionId,
  }),
});

const relayUrl = `/api/harness/mcp-relay?sessionId=${encodeURIComponent(acpSessionId)}`;
const listRes = await handle.request(relayUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
console.log("relay tools/list status", listRes.status);
console.log(await listRes.text());

const sn = await handle.request("/api/harness/mcp-poll?sessionId=" + encodeURIComponent(acpSessionId), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
console.log("mcp-poll status", sn.status);

try {
  await handle.stop();
} catch (err) {
  console.warn("stop skipped:", err.message);
}
console.log("done");
