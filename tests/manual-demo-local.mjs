#!/usr/bin/env node
/**
 * Local-only stop-and-resume demo. No CloudBase deployment needed.
 *
 * Prereqs (in another terminal):
 *   cd /Users/yang/git/open-managed-agent
 *   export CLOUDBASE_ENV_ID=test-6g2rfs50c69b7fb8
 *   export PORT=9000
 *   node packages/agent-runtime/dist/index.js
 *
 * Then in this terminal:
 *   node tests/manual-demo-local.mjs            # uses /etc/hostname
 *   node tests/manual-demo-local.mjs /etc/shells  # custom path
 *
 * The SDK normally requires { envId, agentId, accessKey }, but we can pass
 * baseURL=http://localhost:9000 directly — the runtime serves the same
 * /acp endpoint, just without gateway/auth.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ManagedAgents from "../packages/sdk/dist/index.js";

const target = process.argv[2] || "/etc/shells";
const baseURL = process.env.RUNTIME_URL || "http://localhost:9001";

const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(bold("\n=== stop-and-resume demo (local) ===\n"));
console.log(dim(`runtime: ${baseURL}`));
console.log(dim(`target : ${target}\n`));

// envId/agentId are required by the SDK constructor but unused when baseURL
// is supplied — the runtime ignores them too on /acp.
const client = new ManagedAgents({
  baseURL,
  envId: "local",
  agentId: "local",
});

console.log(cyan("[1] sessions.create()"));
const session = await client.sessions.create({});
console.log(dim(`    sessionId = ${session.id}\n`));

async function drain(stream, label) {
  console.log(cyan(`[${label}] streaming...`));
  let pendingToolUse = null;
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
          yellow(`\n    🔐 permission requested: ${ev.toolName}\n    `),
        );
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
  return { stopReason, pendingToolUse };
}

console.log(cyan(`[2] sessions.prompt("What's in ${target}?")`));
const r1 = await drain(
  client.sessions.prompt(session.id, `What's in ${target}? Read it and summarize in one short sentence.`),
  "2",
);

if (r1.stopReason !== "tool_use" || !r1.pendingToolUse) {
  console.error("Expected stopReason='tool_use' with a pendingToolUse, got:", r1);
  process.exit(2);
}

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

console.log(cyan(`[4] sessions.promptToolResult(toolUseId=${r1.pendingToolUse.toolUseId})`));
const r2 = await drain(
  client.sessions.promptToolResult(session.id, r1.pendingToolUse.toolUseId, content, isError),
  "4",
);

if (r2.stopReason === "end_turn") {
  console.log(green("\n✅ stop-and-resume verified end-to-end."));
  process.exit(0);
} else if (r2.stopReason === "tool_use") {
  console.log(yellow(`\nModel wants another tool: ${r2.pendingToolUse?.toolName}`));
  process.exit(0);
} else {
  console.error(`Unexpected stopReason after resume: ${r2.stopReason}`);
  process.exit(3);
}
