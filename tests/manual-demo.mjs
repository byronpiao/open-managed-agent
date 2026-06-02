#!/usr/bin/env node
/**
 * Manual demo for stop-and-resume mode (client-side custom tools).
 *
 * What this proves end-to-end:
 *   1. Send a normal user message via session/prompt.
 *   2. Agent decides to call the YAML-declared client-side tool `read_file`.
 *   3. Server emits a tool_call SSE update, then ends the turn with
 *      stopReason='tool_use' and a pendingToolUse hint.
 *   4. We "execute" the tool locally (here: actually read the file from
 *      the filesystem), then resume the turn by calling
 *      sessions.promptToolResult(sessionId, toolUseId, content).
 *   5. Agent continues the turn, summarizes the file, and ends with
 *      stopReason='end_turn'.
 *
 * Usage:
 *   node tests/manual-demo.mjs <agentId> [envId] [path-to-read]
 *
 * Env:
 *   CLOUDBASE_ACCESS_KEY  Bearer token for the gateway (long-lived API key)
 *   CLOUDBASE_ENV_ID      Default env id (overridden by argv[3])
 *   CLOUDBASE_AGENT_ID    Default agent id (overridden by argv[2])
 *
 * Example:
 *   CLOUDBASE_ACCESS_KEY=eyJhbGc... \
 *     node tests/manual-demo.mjs agent-stop-resume-demo-xxxx test-6g2rfs50c69b7fb8 /etc/hostname
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ManagedAgents from "../packages/sdk/dist/index.js";

const agentId = process.argv[2] || process.env.CLOUDBASE_AGENT_ID;
const envId   = process.argv[3] || process.env.CLOUDBASE_ENV_ID;
const target  = process.argv[4] || "/etc/hostname";
const accessKey = process.env.CLOUDBASE_ACCESS_KEY;

if (!agentId || !envId) {
  console.error("Usage: node tests/manual-demo.mjs <agentId> [envId] [path]");
  console.error("Or set CLOUDBASE_AGENT_ID + CLOUDBASE_ENV_ID env vars.");
  process.exit(1);
}
if (!accessKey) {
  console.error("CLOUDBASE_ACCESS_KEY is required (a Bearer token for the gateway).");
  process.exit(1);
}

const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(bold("\n=== stop-and-resume demo ===\n"));
console.log(dim(`agent : ${agentId}`));
console.log(dim(`env   : ${envId}`));
console.log(dim(`target: ${target}\n`));

const client = new ManagedAgents({ agentId, envId, accessKey });

// 1. Create session (initialize is lazy; first prompt triggers it).
console.log(cyan("[1] sessions.create()"));
const session = await client.sessions.create({});
console.log(dim(`    sessionId = ${session.id}\n`));

// Helper: drain a stream and capture any pending action.
async function drain(stream, label) {
  console.log(cyan(`[${label}] streaming...`));
  let pendingToolUse = null;
  let pendingPermission = null;
  let stopReason = "?";
  process.stdout.write(dim("    "));
  for await (const ev of stream) {
    switch (ev.type) {
      case "chunk":
        process.stdout.write(ev.text);
        break;
      case "tool_call":
        process.stdout.write(yellow(`\n    🔧 tool_call: ${ev.name} [${ev.status}]\n    `));
        break;
      case "tool_use_request":
        process.stdout.write(
          yellow(`\n    🛠  client-side tool requested: ${ev.toolName} input=${JSON.stringify(ev.input)}\n    `),
        );
        pendingToolUse = ev;
        break;
      case "permission_request":
        process.stdout.write(
          yellow(`\n    🔐 permission requested: ${ev.toolName} args=${JSON.stringify(ev.args)}\n    `),
        );
        pendingPermission = ev;
        break;
      case "error":
        process.stdout.write(`\n    ❌ ${ev.message}\n    `);
        break;
      case "done":
        stopReason = ev.stopReason;
        break;
    }
  }
  console.log("\n");
  console.log(dim(`    [${label}] stopReason = ${stopReason}\n`));
  return { stopReason, pendingToolUse, pendingPermission };
}

// 2. First prompt — model should call read_file → turn ends with tool_use.
console.log(cyan(`[2] sessions.prompt("What's in ${target}?")`));
const r1 = await drain(
  client.sessions.prompt(session.id, `What's in ${target}? Read it and summarize.`),
  "2",
);

if (r1.stopReason !== "tool_use" || !r1.pendingToolUse) {
  console.error("Expected stopReason='tool_use' with a pendingToolUse, got:", r1);
  process.exit(2);
}

// 3. "Execute" the tool — actually read the file.
console.log(cyan(`[3] executing client-side tool '${r1.pendingToolUse.toolName}' locally`));
const path = r1.pendingToolUse.input?.path ?? target;
let content;
let isError = false;
try {
  content = readFileSync(resolve(path), "utf-8").trim();
  console.log(dim(`    file: ${path}`));
  console.log(dim(`    content: ${JSON.stringify(content.slice(0, 200))}\n`));
} catch (err) {
  content = `Error reading ${path}: ${err.message}`;
  isError = true;
  console.log(yellow(`    ${content}\n`));
}

// 4. Resume the turn with the tool_result.
console.log(cyan(`[4] sessions.promptToolResult(toolUseId=${r1.pendingToolUse.toolUseId})`));
const r2 = await drain(
  client.sessions.promptToolResult(session.id, r1.pendingToolUse.toolUseId, content, isError),
  "4",
);

if (r2.stopReason === "end_turn") {
  console.log(green("\n✅ stop-and-resume verified end-to-end."));
  process.exit(0);
} else if (r2.stopReason === "tool_use") {
  console.log(yellow(`\nModel asked for another tool: ${r2.pendingToolUse?.toolName}`));
  console.log(yellow("(Re-run this script with logic to handle multi-step calls.)"));
  process.exit(0);
} else {
  console.error(`Unexpected stopReason after resume: ${r2.stopReason}`);
  process.exit(3);
}
