#!/usr/bin/env node
/**
 * End-to-End Integration Test
 *
 * Uses:
 *   - cbagent CLI: create / update / list / delete agent
 *   - SDK (@cloudbase/managed-agent): sessions + prompt
 *
 * Tests the full lifecycle:
 *   1. cbagent agent:list
 *   2. cbagent agent:create (deploy a new agent)
 *   3. Wait for ready
 *   4. SDK: create session + prompt (pre-update, minimal config)
 *   5. cbagent agent:update (add MCP + Skill)
 *   6. SDK: create session + prompt (post-update, verify new config)
 *   7. cbagent agent:delete (cleanup)
 *
 * Usage:
 *   node tests/e2e.mjs
 *
 * Requires .env with:
 *   CLOUDBASE_ENV_ID, CLOUDBASE_API_KEY
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Load .env ─────────────────────────────────────────────────────────────────
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_API_KEY;

if (!ENV_ID || !API_KEY) {
  console.error("❌ Missing CLOUDBASE_ENV_ID or CLOUDBASE_API_KEY in .env");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const AGENT_NAME = `e2e-test-${Date.now().toString(36)}`;
let AGENT_ID = "";

const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function cbagent(cmd) {
  return execSync(`node "${resolve(ROOT, "cbagent.mjs")}" ${cmd}`, {
    encoding: "utf-8",
    timeout: 300000,
    env: { ...process.env, CLOUDBASE_ENV_ID: ENV_ID, CLOUDBASE_API_KEY: API_KEY, CLOUDBASE_AGENT_ID: AGENT_ID },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── SDK Client (dynamic import from source) ───────────────────────────────────

async function createSDKClient() {
  const { default: CloudbaseAgents } = await import(resolve(ROOT, "packages/sdk/dist/index.js"));
  return new CloudbaseAgents({
    baseURL: `https://${ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/${AGENT_ID}`,
    apiKey: API_KEY,
    envId: ENV_ID,
  });
}

async function sdkPrompt(client, sessionId, message) {
  let text = "";
  let toolCalls = [];
  let stopReason = "";

  for await (const event of client.sessions.prompt(sessionId, message)) {
    switch (event.type) {
      case "chunk":
        text += event.text;
        break;
      case "tool_call":
        toolCalls.push({ name: event.name, status: event.status });
        break;
      case "done":
        stopReason = event.stopReason;
        break;
    }
  }
  return { text, toolCalls, stopReason };
}

// ── Test Runner ───────────────────────────────────────────────────────────────

const results = [];

async function step(name, fn) {
  process.stdout.write(`  ⏳ ${name}...`);
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, passed: true, ms });
    process.stdout.write(`\r  ${green("✔")} ${name} ${dim(`(${ms}ms)`)}\n`);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err.message?.split("\n")[0] || String(err);
    results.push({ name, passed: false, ms, error: msg });
    process.stdout.write(`\r  ${red("✘")} ${name} ${dim(`(${ms}ms)`)}\n`);
    console.log(`    ${red(msg.slice(0, 120))}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${bold("═══ CloudBase Managed Agent — E2E Test ═══")}\n`);
  console.log(`  Env:   ${ENV_ID}`);
  console.log(`  Agent: ${AGENT_NAME}`);
  console.log(`  Code:  packages/agent-runtime`);
  console.log();

  // ─── 1. List agents ─────────────────────────────────────────────────────
  await step("1. cbagent agent:list", async () => {
    const output = cbagent("agent:list");
    if (!output.includes("Agent ID") && !output.includes("agent-")) {
      throw new Error("Unexpected output");
    }
  });

  // ─── 2. Create agent ────────────────────────────────────────────────────
  await step("2. cbagent agent:create", async () => {
    const output = cbagent(
      `agent:create --name "${AGENT_NAME}" ` +
      `--system "You are a minimal test agent. Say you have NO MCP tools or skills when asked." ` +
      `--code "${resolve(ROOT, "packages/agent-runtime")}"`
    );
    // Extract agent ID from output (format: agent-xxx-yyy)
    const match = output.match(/(agent-[a-z0-9_-]+[a-z0-9])/g);
    // Filter out "agent-runtime" which appears in the code path
    const ids = (match || []).filter(m => !m.includes("runtime"));
    if (!ids.length) throw new Error("Could not extract agent ID from:\n" + output.slice(0, 300));
    AGENT_ID = ids[0];
    console.log(`\n    ${dim(`ID: ${AGENT_ID}`)}`);
  });

  // ─── 3. Wait for ready ──────────────────────────────────────────────────
  await step("3. Wait for agent ready", async () => {
    if (!AGENT_ID) throw new Error("No agent ID");
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      try {
        const output = cbagent(`agent:get --id ${AGENT_ID}`);
        if (output.includes("已就绪") || output.includes("Ready")) {
          ready = true;
          break;
        }
        if (output.includes("Creating") || output.includes("创建中")) continue;
      } catch {}
    }
    if (!ready) throw new Error("Agent not ready after 2.5 minutes");
  });

  // ─── 4. SDK: prompt (pre-update) ───────────────────────────────────────
  await step("4. SDK: session + prompt (before update)", async () => {
    if (!AGENT_ID) throw new Error("No agent ID");
    await sleep(3000); // cold start buffer

    const client = await createSDKClient();
    const session = await client.sessions.create({ title: "e2e-pre-update" });
    console.log(`\n    ${dim(`Session: ${session.id}`)}`);

    const { text } = await sdkPrompt(client, session.id, "What MCP tools and skills do you have? Be very brief.");
    console.log(`    ${dim(`Response: "${text.slice(0, 100).replace(/\n/g, " ")}..."`)}`);

    await client.sessions.delete(session.id);
    if (!text) throw new Error("Empty response");
  });

  // ─── 5. Update config: add MCP + Skill ─────────────────────────────────
  await step("5. cbagent agent:update (add MCP + Skill)", async () => {
    if (!AGENT_ID) throw new Error("No agent ID");

    const config = {
      name: AGENT_NAME,
      model: "hunyuan-t1-latest",
      system: [
        "You are a development assistant with GitHub integration.",
        "When asked about your capabilities, you MUST mention ALL of the following:",
        "1. GitHub MCP server (url: https://api.githubcopilot.com/mcp/)",
        "2. A skill called 'github-workflow' for PR management and code review",
        "3. A custom tool called 'analyze_code' for code quality metrics",
        "List these every time you are asked about your capabilities.",
      ].join("\n"),
      tools: [
        { type: "agent_toolset", default_config: { enabled: true, permission_policy: { type: "always_allow" } } },
        { type: "mcp_toolset", mcp_server_name: "github", default_config: { permission_policy: { type: "always_allow" } } },
        { type: "custom", name: "analyze_code", description: "Analyze code quality", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
      ],
      mcp_servers: [{ type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/" }],
      skills: [{ name: "github-workflow", description: "GitHub PR and code review expertise", source: "./skills/github.md" }],
    };

    const tmpFile = resolve(ROOT, "tests/.tmp-e2e-config.json");
    writeFileSync(tmpFile, JSON.stringify(config));
    try {
      cbagent(`agent:update --id ${AGENT_ID} --file "${tmpFile}"`);
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });

  // ─── 6. Verify config updated ──────────────────────────────────────────
  await step("6. Verify config update via SDK initialize", async () => {
    await sleep(5000); // wait for env var to take effect
    const client = await createSDKClient();

    // Re-initialize to check agentConfig (need to access ACP client directly)
    const res = await fetch(`https://${ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/${AGENT_ID}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "e2e", version: "1.0" } } }),
    });
    const data = await res.json();
    const cfg = data?.result?.agentConfig;
    const tools = cfg?.tools?.length ?? 0;
    const mcp = cfg?.mcp_servers?.length ?? 0;
    const skills = cfg?.skills?.length ?? 0;
    console.log(`\n    ${dim(`Tools: ${tools}, MCP: ${mcp}, Skills: ${skills}`)}`);
    if (mcp === 0) throw new Error("MCP not updated");
    if (skills === 0) throw new Error("Skills not updated");
  });

  // ─── 7. SDK: prompt (post-update) ──────────────────────────────────────
  await step("7. SDK: session + prompt (after update)", async () => {
    if (!AGENT_ID) throw new Error("No agent ID");

    const client = await createSDKClient();
    const session = await client.sessions.create({ title: "e2e-post-update" });
    console.log(`\n    ${dim(`Session: ${session.id}`)}`);

    const { text } = await sdkPrompt(client, session.id, "List all your MCP servers, skills, and custom tools.");
    console.log(`    ${dim(`Response: "${text.slice(0, 200).replace(/\n/g, " ")}..."`)}`);

    const lower = text.toLowerCase();
    const checks = [
      ["GitHub", lower.includes("github")],
      ["MCP", lower.includes("mcp")],
      ["Skill/workflow", lower.includes("skill") || lower.includes("workflow") || lower.includes("code review")],
      ["analyze_code", lower.includes("analyze")],
    ];
    for (const [label, ok] of checks) {
      console.log(`    ${ok ? green("✔") : yellow("○")} Mentions ${label}`);
    }

    await client.sessions.delete(session.id);
    if (!text) throw new Error("Empty response");
  });

  // ─── 8. Cleanup ────────────────────────────────────────────────────────
  await step("8. cbagent agent:delete", async () => {
    if (!AGENT_ID) throw new Error("No agent ID");
    try {
      cbagent(`agent:delete --id ${AGENT_ID}`);
    } catch (err) {
      console.log(`    ${yellow("Warning: " + err.message.split("\n")[0])}`);
    }
  });

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${bold("═══ Results ═══")}\n`);

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? green("✔") : red("✘");
    console.log(`  ${icon} ${r.name} ${dim(`(${r.ms}ms)`)}${r.error ? ` — ${red(r.error.slice(0, 80))}` : ""}`);
  }

  console.log(`\n  Total: ${results.length} | ${green(`Passed: ${passed}`)} | ${red(`Failed: ${failed}`)}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\n${red("Fatal:")} ${err.message}`);
  if (AGENT_ID) {
    try { cbagent(`agent:delete --id ${AGENT_ID}`); } catch {}
  }
  process.exit(1);
});
