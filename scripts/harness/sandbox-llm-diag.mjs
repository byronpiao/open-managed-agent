#!/usr/bin/env node
/**
 * Sandbox LLM diagnostics — acquire AGS directly, bash checks inside box.
 *
 *   node scripts/harness/sandbox-llm-diag.mjs [platform|byok]
 */
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import {
  loadEnv,
  assertHarnessCreds,
  applyHarnessLlmTier,
  applyHarnessTestDefaults,
} from "./load-env.mjs";

const tier = process.argv[2]?.trim() || "platform";

loadEnv();
assertHarnessCreds();
applyHarnessLlmTier(tier);
applyHarnessTestDefaults();

const AGENT_CONFIG = {
  name: "SandboxLlmDiag",
  system: "Reply briefly.",
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

async function bash(handle, command) {
  const res = await handle.request("/api/tools/bash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  const output = json.output ?? json.result?.output ?? "";
  return { exitCode: json.exitCode ?? 0, output: String(output) };
}

async function main() {
  const { buildHarnessOpencodeConfigContent, buildHarnessSandboxEnv } = await import(
    "../../packages/agent-runtime/dist/harness/deploy.js"
  );
  const { cloudBaseAiGatewayBaseUrl } = await import(
    "../../packages/agent-runtime/dist/harness/llm-providers.js"
  );

  console.log(`=== sandbox LLM diag (tier=${tier}) ===`);

  if (tier === "platform") {
    const {
      probeCloudBasePlatformLlm,
      formatPlatformProbeFailureGuide,
    } = await import("../../packages/agent-runtime/dist/harness/llm-probe.js");
    const p = await probeCloudBasePlatformLlm();
    if (!p.ok) {
      console.error(formatPlatformProbeFailureGuide(p));
      process.exit(1);
    }
    console.log(`host platform probe: ${p.latencyMs}ms ${p.model} ${p.replySnippet}`);
  } else {
    const { probeHarnessOpenAiLlm } = await import(
      "../../packages/agent-runtime/dist/harness/llm-probe.js"
    );
    const p = await probeHarnessOpenAiLlm({ timeoutMs: 30000 });
    console.log(
      `host BYOK probe: ok=${p.ok} http=${p.httpStatus} ${p.error ?? p.replySnippet ?? ""}`,
    );
  }

  const ocExpected = buildHarnessOpencodeConfigContent({
    ...AGENT_CONFIG,
  });
  assert.ok(ocExpected, "expected OPENCODE_CONFIG_CONTENT from host builder");
  const ocParsed = JSON.parse(ocExpected);
  console.log("host expects model:", ocParsed.model);
  console.log("host expects baseURL:", ocParsed.provider?.["openai-compat"]?.options?.baseURL);

  const { getSandboxOrchestrator } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const acpSessionId = crypto.randomUUID();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "http://127.0.0.1:19090";

  console.log("\nacquiring sandbox…");
  const handle = await getSandboxOrchestrator().acquire({
    envId,
    agentConfig: AGENT_CONFIG,
    engine: "opencode",
    acpSessionId,
    instanceEnv: buildHarnessSandboxEnv({
      config: AGENT_CONFIG,
      engine: "opencode",
      clientToolCallbackBase: callbackBase,
      acpSessionId,
    }),
  });
  console.log("instance:", handle.instanceId);

  await sleep(8000);

  const checks = [
    ["OPENCODE_CONFIG_CONTENT bytes", "printenv OPENCODE_CONFIG_CONTENT | wc -c"],
    ["OPENCODE_CONFIG file env", "printenv OPENCODE_CONFIG || echo '(unset)'"],
    ["model snippet", "printenv OPENCODE_CONFIG_CONTENT | head -c 400"],
    ["TCB_API_KEY set", "test -n \"$TCB_API_KEY\" && echo SET || echo MISSING"],
    [
      "opencode models (90s)",
      "timeout 90 opencode models 2>&1 | head -25 || echo TIMEOUT",
    ],
    [
      "opencode run smoke (120s)",
      'timeout 120 opencode run "Reply with exactly: OK" 2>&1 | tail -15 || echo RUN_TIMEOUT',
    ],
    ["agents json", "curl -sf http://127.0.0.1:9000/api/agents 2>&1 | head -c 600"],
  ];

  if (tier === "platform") {
    const url = `${cloudBaseAiGatewayBaseUrl(envId)}/v1/chat/completions`;
    checks.push([
      "curl platform (TCB_API_KEY env)",
      `curl -s -m 30 -w '\\nhttp_code=%{http_code}' -X POST '${url}' ` +
        `-H 'Authorization: Bearer '"$TCB_API_KEY" -H 'Content-Type: application/json' ` +
        `-d '{"model":"hy3-preview","messages":[{"role":"user","content":"pong"}],"max_tokens":8}'`,
    ]);
    checks.push([
      "curl platform (key from OPENCODE_CONFIG JSON)",
      `KEY=$(python3 -c "import os,json; c=json.loads(os.environ['OPENCODE_CONFIG_CONTENT']); print(c['provider']['openai-compat']['options']['apiKey'])") && ` +
        `curl -s -m 30 -w '\\nhttp_code=%{http_code}' -X POST '${url}' ` +
        `-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' ` +
        `-d '{"model":"hy3-preview","messages":[{"role":"user","content":"pong"}],"max_tokens":8}'`,
    ]);
  } else if (process.env.OPENAI_BASE_URL && process.env.LLM_API_KEY) {
    const base = process.env.OPENAI_BASE_URL.replace(/\/$/, "");
    const model = process.env.LLM_MODEL;
    checks.push([
      "curl BYOK from box",
      `curl -s -m 30 -w '\\nhttp_code=%{http_code}' -X POST '${base}/chat/completions' ` +
        `-H 'Authorization: Bearer '"$LLM_API_KEY" -H 'Content-Type: application/json' ` +
        `-d '{"model":"${model}","messages":[{"role":"user","content":"pong"}],"max_tokens":8}'`,
    ]);
  }

  console.log("\n--- in-sandbox ---");
  for (const [label, cmd] of checks) {
    const { exitCode, output } = await bash(handle, cmd);
    console.log(`\n[${label}] exit=${exitCode}`);
    console.log(output.slice(0, 1500));
  }

  const { buildHarnessAcpMcpServers, SANDBOX_TRW_MCP_RELAY_PATH } = await import(
    "../../packages/agent-runtime/dist/harness/deploy.js"
  );
  const mcpUrl = `http://127.0.0.1:9000${SANDBOX_TRW_MCP_RELAY_PATH}?sessionId=${encodeURIComponent(acpSessionId)}`;
  const mcpList = await bash(
    handle,
    `curl -s -m 15 -X POST '${mcpUrl}' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 500`,
  );
  console.log("\n[mcp-relay tools/list]", mcpList.output.slice(0, 400));

  console.log("\n--- opencode ACP prompt, mcpServers=[] ---");
  const initRes = await handle.request("/api/agents/opencode/acp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "diag", version: "0" } },
    }),
  });
  console.log("initialize:", (await initRes.text()).slice(0, 200));

  const newRes = await handle.request("/api/agents/opencode/acp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/home/user", mcpServers: [] },
    }),
  });
  const newBody = await newRes.text();
  console.log("session/new:", newBody.slice(0, 300));
  let engineSid = "";
  try {
    engineSid = JSON.parse(newBody).result?.sessionId ?? "";
  } catch {
    // ignore
  }

  const promptRes = await handle.request("/api/agents/opencode/acp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: engineSid,
        prompt: [{ type: "text", text: "Reply with exactly: OK" }],
      },
    }),
  });
  const promptBody = await promptRes.text();
  console.log("has chunk:", /agent_message_chunk/.test(promptBody));
  console.log("timeout:", /timeout waiting/.test(promptBody));
  console.log(promptBody.slice(0, 800));

  const mcpServers = buildHarnessAcpMcpServers({
    config: AGENT_CONFIG,
    clientToolCallbackBase: callbackBase,
    acpSessionId,
  });
  console.log("\n--- opencode ACP prompt, with managed-agent-client MCP ---");
  console.log("mcp url:", mcpServers[0]?.url ?? "(none)");
  const new2 = await handle.request("/api/agents/opencode/acp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "session/new",
      params: { cwd: "/home/user", mcpServers },
    }),
  });
  const new2Body = await new2.text();
  let sid2 = "";
  try {
    sid2 = JSON.parse(new2Body).result?.sessionId ?? "";
  } catch {
    // ignore
  }
  const pr2 = await handle.request("/api/agents/opencode/acp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: {
        sessionId: sid2,
        prompt: [{ type: "text", text: "Reply with exactly: OK" }],
      },
    }),
  });
  const pr2Body = await pr2.text();
  console.log("has chunk:", /agent_message_chunk/.test(pr2Body));
  console.log("timeout:", /timeout waiting/.test(pr2Body));
  console.log(pr2Body.slice(0, 800));

  try {
    await getSandboxOrchestrator().stopInstanceForEnv(handle.instanceId, envId);
  } catch {
    // best effort
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
