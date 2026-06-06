#!/usr/bin/env node
/**
 * Smoke: harness tool auto-ensure (no HARNESS_TOOL_ID pin).
 * Validates createHarnessTool template + optional full custom-tool loop.
 *
 *   node scripts/harness-auto-tool-smoke.mjs
 *   node scripts/harness-auto-tool-smoke.mjs --e2e
 */
import { loadEnv, assertHarnessCreds } from "./load-env.mjs";
import { execSync, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessToolNameForEnv } from "../packages/agent-runtime/dist/config.js";

loadEnv();
assertHarnessCreds();

// Force auto-ensure path (ignore pinned tool in .env.harness)
delete process.env.HARNESS_TOOL_ID;

const runE2e = process.argv.includes("--e2e");
const envId = process.env.CLOUDBASE_ENV_ID;
const expectedToolName = harnessToolNameForEnv(envId);
const expectedImage =
  process.env.HARNESS_SANDBOX_IMAGE ?? "";

function listTools() {
  const raw = execSync("tcb sandbox tool list --json", {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw.slice(raw.indexOf("{"))).data?.SandboxToolSet ?? [];
}

function assertToolTemplate(tool) {
  const cfg = tool.CustomConfiguration ?? {};
  const errors = [];
  const img = String(cfg.Image ?? "");
  if (expectedImage && !img.includes(expectedImage.split(":").pop() ?? "")) {
    errors.push(`Image mismatch: ${img} (want tag ${expectedImage.split(":").pop()})`);
  }
  if (JSON.stringify(cfg.Command) !== JSON.stringify(["/init"])) {
    errors.push(`Command: ${JSON.stringify(cfg.Command)}`);
  }
  const res = cfg.Resources ?? {};
  if (res.CPU !== "2" || res.Memory !== "2Gi") {
    errors.push(`Resources: ${JSON.stringify(res)}`);
  }
  const ports = cfg.Ports ?? [];
  const trw = ports.find((p) => p.Name === "trw");
  const envd = ports.find((p) => p.Name === "envd");
  if (!trw || trw.Port !== 9000) errors.push(`Ports.trw: ${JSON.stringify(ports)}`);
  if (!envd || envd.Port !== 49983) errors.push(`Ports.envd missing`);
  const probe = cfg.Probe?.HttpGet;
  if (probe?.Path !== "/health" || probe?.Port !== 9000) {
    errors.push(`Probe: ${JSON.stringify(cfg.Probe)}`);
  }
  if (tool.NetworkConfiguration?.NetworkMode !== "PUBLIC") {
    errors.push(`NetworkMode: ${tool.NetworkConfiguration?.NetworkMode}`);
  }
  return errors;
}

async function acquireSmoke() {
  const { getSandboxOrchestrator } = await import(
    "../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const { buildHarnessSandboxEnv } = await import("../packages/agent-runtime/dist/harness/deploy.js");

  const before = listTools().find((t) => t.ToolName === expectedToolName);
  console.log(`tool name: ${expectedToolName}`);
  console.log(`before: ${before ? `exists ${before.ToolId}` : "not found (will create)"}`);

  const acpSessionId = crypto.randomUUID();
  const config = {
    name: "auto-tool-smoke",
    model: "hunyuan-t1-latest",
    system: "smoke",
    runtime: "harness",
    engine: "opencode",
    tools: [
      {
        type: "custom",
        name: "echo_tool",
        description: "Echo",
        input_schema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
  };

  const orch = getSandboxOrchestrator();
  const handle = await orch.acquire({
    envId,
    agentConfig: config,
    engine: "opencode",
    acpSessionId,
    instanceEnv: buildHarnessSandboxEnv({
      config,
      engine: "opencode",
      clientToolCallbackBase:
        process.env.CLOUDBASE_SERVER_URL ?? "http://127.0.0.1:9000",
      acpSessionId,
    }),
  });

  const after = listTools().find((t) => t.ToolName === expectedToolName);
  if (!after) throw new Error(`tool ${expectedToolName} not found after acquire`);
  console.log(`after: ${after.ToolId} (instance ${handle.instanceId})`);

  const tmplErrors = assertToolTemplate(after);
  if (tmplErrors.length) {
    console.error("template validation FAILED:");
    for (const e of tmplErrors) console.error("  -", e);
    process.exit(1);
  }
  console.log("template validation OK");

  const relayUrl = `/api/harness/mcp-relay?sessionId=${encodeURIComponent(acpSessionId)}`;
  const listRes = await handle.request(relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    }),
  });
  console.log("relay initialize HTTP", listRes.status);

  try {
    await handle.stop();
  } catch (err) {
    console.warn("stop:", err.message);
  }

  return { toolId: after.ToolId, justCreated: !before };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (runE2e) {
  console.log("\n--- full harness e2e (no HARNESS_TOOL_ID) ---\n");
  const child = spawn(
    process.execPath,
    ["tests/harness/e2e.test.mjs", "--full"],
    {
      cwd: repoRoot,
      env: { ...process.env, HARNESS_TOOL_ID: "" },
      stdio: "inherit",
    },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const { justCreated } = await acquireSmoke();
  console.log(`justCreated=${justCreated}`);
  console.log("Done. Run with --e2e for full harness e2e.");
}
