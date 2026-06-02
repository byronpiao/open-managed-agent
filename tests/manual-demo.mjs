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
 *   node tests/manual-demo.mjs                                     (uses defaults)
 *   node tests/manual-demo.mjs <agentId>                           (override agent)
 *   node tests/manual-demo.mjs <agentId> <envId> [path]            (override all)
 *
 * Defaults are baked in below for the stop-resume-demo agent. Override via
 * argv or env vars (CLOUDBASE_AGENT_ID, CLOUDBASE_ENV_ID, CLOUDBASE_ACCESS_KEY).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ManagedAgents from "../packages/sdk/dist/index.js";

// ── Defaults baked in for the stop-resume-demo agent ────────────────────────
// Override any of these via process.argv or env vars below.
const DEFAULT_AGENT_ID = "agent-stop-resume-demo-400a44d4b";
const DEFAULT_ENV_ID   = "test-6g2rfs50c69b7fb8";
// CloudBase gateway Bearer token (long-lived API key issued for env above).
const DEFAULT_ACCESS_KEY =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6IjlkMWRjMzFlLWI0ZDAtNDQ4Yi1hNzZmLWIwY2M2M2Q4MTQ5OCJ9." +
  "eyJhdWQiOiJ0ZXN0LTZnMnJmczUwYzY5YjdmYjgiLCJleHAiOjI1MzQwMjMwMDc5OSwiaWF0IjoxNzc4MTQ3OTQzLCJhdF9oYXNoIjoic0xBTGRZTXFSNGVSMGRCa2xlY2VXdyIsInByb2plY3RfaWQiOiJ0ZXN0LTZnMnJmczUwYzY5YjdmYjgiLCJtZXRhIjp7InBsYXRmb3JtIjoiQXBpS2V5In0sImFkbWluaXN0cmF0b3JfaWQiOiIxODkyNzc2NjkzMzM2Njg2NTk0IiwidXNlcl90eXBlIjoiIiwiY2xpZW50X3R5cGUiOiJjbGllbnRfc2VydmVyIiwiaXNfc3lzdGVtX2FkbWluIjp0cnVlfQ." +
  "EMw1mDROkqNHN-7HXUz2uWy7MqtKNsdsJoV5cdh1ElDNC6l9acbIeenwT5SdPPFM3M7E0BwbyszTWHmkq_nhPKXyqIXqI3854jYQEqC-cpE6FjPCbdCp4kxIafruoakKsCVPHcYkeSBxUdzdhG4Pvqwm3_t9ljqSY3Uaq6m7zaNZOa0MXLCa9uT9G-eaP9qHdEJ65LsuAits05iLlkBluQw5NNWT-IjzdsJnBM--hZKyyOgCoBHux6uJ5b4Q6kO01AQ2D_zQBH-BdbafnccRFAJIYs8Bk8BVDAFt7Gr4LI2LE_ZuV2KlGjVs97ICw-EOvL28GAxj2NxhbAy6-oUK1g";

const agentId   = process.argv[2] || process.env.CLOUDBASE_AGENT_ID  || DEFAULT_AGENT_ID;
const envId     = process.argv[3] || process.env.CLOUDBASE_ENV_ID    || DEFAULT_ENV_ID;
const target    = process.argv[4] || "/etc/hostname";
const accessKey = process.env.CLOUDBASE_ACCESS_KEY || DEFAULT_ACCESS_KEY;

if (!agentId || !envId || !accessKey) {
  console.error("Missing config. Set agentId, envId, and CLOUDBASE_ACCESS_KEY.");
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
