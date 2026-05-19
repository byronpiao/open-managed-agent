#!/usr/bin/env node
/**
 * cbagent - CloudBase Managed Agent CLI
 *
 * Usage:
 *   cbagent <command> [options]
 *
 * Commands:
 *   agent:create   --name <name> [--model <model>] [--system <prompt>]
 *   agent:list
 *   agent:get      --id <agent-id>
 *   agent:delete   --id <agent-id>
 *
 *   env:create     --name <name>
 *   env:list
 *   env:delete     --id <env-id>
 *
 *   session:create --agent <agent-id> [--env <env-id>] [--title <title>]
 *   session:list
 *   session:get    --id <session-id>
 *   session:delete --id <session-id>
 *
 *   chat           --session <session-id> --message <text>
 *   run            --agent <agent-id> --message <text>   (one-shot: create session + chat + stream)
 */

import { parseArgs } from "util";
import { createInterface } from "readline";
import { execSync } from "child_process";
import { readFileSync } from "fs";

const BASE_URL = process.env.CLOUDBASE_SERVER_URL ?? "http://localhost:3000";
const ENV_ID   = process.env.CLOUDBASE_ENV_ID ?? "";
const AGENT_ID = process.env.CLOUDBASE_AGENT_ID ?? "";

// ── HTTP helpers ─────────────────────────────────────────────────────────────

const headers = {
  "Content-Type": "application/json",
  ...(ENV_ID ? { "X-CloudBase-Env-Id": ENV_ID } : {}),
};

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const get  = (path)        => api("GET",    path);
const post = (path, body)  => api("POST",   path, body);
const del  = (path)        => api("DELETE", path);

// ── SSE stream helper ─────────────────────────────────────────────────────────

async function* streamEvents(sessionId) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/events/stream`, {
    headers: { Accept: "text/event-stream", ...(ENV_ID ? { "X-CloudBase-Env-Id": ENV_ID } : {}) },
  });
  if (!res.ok || !res.body) throw new Error(`Stream connect failed: ${res.status}`);

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

// ── Pretty printers ───────────────────────────────────────────────────────────

const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

function printAgent(a) {
  console.log(`  ${bold(a.id)}`);
  console.log(`    name   : ${a.name}`);
  console.log(`    model  : ${a.model}`);
  console.log(`    system : ${dim(a.system?.slice(0, 80) ?? "(none)")}`);
  console.log(`    created: ${dim(new Date(a.created_at * 1000).toLocaleString())}`);
}

function printSession(s) {
  console.log(`  ${bold(s.id)}`);
  console.log(`    title  : ${s.title || dim("(untitled)")}`);
  console.log(`    agent  : ${s.agent}`);
  console.log(`    status : ${s.status === "idle" ? green(s.status) : s.status === "running" ? yellow(s.status) : red(s.status)}`);
  console.log(`    created: ${dim(new Date(s.created_at * 1000).toLocaleString())}`);
}

function printEnv(e) {
  console.log(`  ${bold(e.id)}`);
  console.log(`    name   : ${e.name}`);
  console.log(`    type   : ${e.config?.type ?? "-"}`);
  console.log(`    network: ${e.config?.networking?.type ?? "-"}`);
}

// ── Event renderer (for chat / run) ──────────────────────────────────────────

function renderEvent(event) {
  switch (event.type) {
    case "agent.thinking":
      console.log(dim(`\n💭 ${event.thinking}`));
      break;

    case "agent.message":
      for (const block of event.content ?? []) {
        if (block.type === "text") process.stdout.write(block.text ?? "");
      }
      process.stdout.write("\n");
      break;

    case "agent.tool_use":
      console.log(yellow(`\n🔧 Tool: ${event.tool_name}`));
      console.log(dim(`   ${JSON.stringify(event.input)}`));
      break;

    case "agent.tool_result":
      if (event.is_error) {
        console.log(red(`   ❌ ${event.content?.[0]?.text ?? "error"}`));
      } else {
        console.log(dim(`   ✓ ${event.content?.[0]?.text?.slice(0, 120) ?? ""}`));
      }
      break;

    case "agent.custom_tool_use":
      console.log(cyan(`\n🔌 Custom tool: ${event.tool_name} (tool_use_id: ${event.tool_use_id})`));
      console.log(dim(`   ${JSON.stringify(event.input)}`));
      break;

    case "session.status_idle":
      console.log(green("\n✅ Done."));
      break;

    case "session.status_terminated":
      console.log(red(`\n❌ Terminated: ${event.reason ?? "unknown"}`));
      break;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

const COMMANDS = {

  // ─── Agent ────────────────────────────────────────────────────────────────

  "agent:create": async (args) => {
    const { name, model, system } = args;
    if (!name) throw new Error("--name is required");
    const agent = await post("/agents", {
      name,
      model:  model  ?? "hunyuan-2.0-instruct-20251111",
      system: system ?? "",
    });
    console.log(green("✅ Agent created:"));
    printAgent(agent);
  },

  "agent:list": async () => {
    const { data } = await get("/agents");
    if (!data.length) return console.log(dim("No agents found."));
    console.log(bold(`Agents (${data.length}):`));
    data.forEach(printAgent);
  },

  "agent:get": async (args) => {
    if (!args.id) throw new Error("--id is required");
    const agent = await get(`/agents/${args.id}`);
    printAgent(agent);
  },

  "agent:delete": async (args) => {
    if (!args.id) throw new Error("--id is required");
    await del(`/agents/${args.id}`);
    console.log(green(`✅ Agent ${args.id} deleted.`));
  },

  // ─── Agent Update (config via env var) ───────────────────────────────────

  "agent:update": async (args) => {
    const agentId = args.id ?? AGENT_ID;
    if (!agentId) throw new Error("--id is required (or set CLOUDBASE_AGENT_ID)");
    const envId = args.env ?? ENV_ID;
    if (!envId) throw new Error("--env is required (or set CLOUDBASE_ENV_ID)");

    // Load current config: try fetching from the running agent via ACP initialize
    let currentConfig = {};
    const agentUrl = args.url ?? `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}/acp`;
    const apiKey = args["api-key"] ?? process.env.CLOUDBASE_API_KEY ?? "";

    try {
      process.stdout.write(dim("Fetching current config... "));
      const initRes = await fetch(agentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "cbagent", version: "0.1.0" } } }),
      });
      const initData = await initRes.json();
      if (initData.result?.agentConfig) {
        currentConfig = initData.result.agentConfig;
        // Also grab name/description from agentInfo
        if (initData.result.agentInfo?.name) currentConfig.name = initData.result.agentInfo.name;
        if (initData.result.agentInfo?.title) currentConfig.description = initData.result.agentInfo.title;
      }
      console.log(green("OK"));
    } catch (err) {
      console.log(yellow("(could not fetch, starting fresh)"));
    }

    // Merge updates
    const updates = {};
    if (args.name)    updates.name = args.name;
    if (args.model)   updates.model = args.model;
    if (args.system)  updates.system = args.system;
    if (args.description) updates.description = args.description;
    if (args.tools)   updates.tools = JSON.parse(args.tools);
    if (args["mcp-servers"]) updates.mcp_servers = JSON.parse(args["mcp-servers"]);
    if (args.skills)  updates.skills = JSON.parse(args.skills);

    // Load from YAML file if --file is provided
    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        // Simple YAML-like parse: if it starts with { it's JSON, otherwise try to load as YAML
        let fileConfig;
        if (content.trim().startsWith("{")) {
          fileConfig = JSON.parse(content);
        } else {
          // Basic YAML import (requires yaml package in the environment)
          const { parse } = await import("yaml");
          fileConfig = parse(content);
        }
        Object.assign(updates, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file ${args.file}: ${err.message}`);
      }
    }

    if (Object.keys(updates).length === 0) {
      console.log(yellow("No updates specified. Use --system, --model, --tools, --file, etc."));
      return;
    }

    // Merge: currentConfig + updates
    const merged = { ...currentConfig, ...updates };
    // Ensure required fields
    if (!merged.name) merged.name = "cloudbase-managed-agent";
    if (!merged.model) merged.model = "hunyuan-t1-latest";
    if (!merged.system) merged.system = "You are a helpful assistant.";

    const configJson = JSON.stringify(merged);

    console.log(dim(`\nUpdated config (${configJson.length} bytes):`));
    console.log(dim(`  name: ${merged.name}`));
    console.log(dim(`  model: ${merged.model}`));
    console.log(dim(`  system: ${merged.system?.slice(0, 60)}${merged.system?.length > 60 ? "..." : ""}`));
    console.log(dim(`  tools: ${merged.tools?.length ?? 0} items`));
    console.log(dim(`  mcp_servers: ${merged.mcp_servers?.length ?? 0} items`));
    console.log(dim(`  skills: ${merged.skills?.length ?? 0} items`));
    console.log();

    // Apply via tcb agent update --env
    // Note: tcb --env uses comma-separated KEY=VALUE pairs.
    // Since AGENT_CONFIG contains JSON with commas, we write it to a temp file
    // and use the updateFunctionConfig approach, or we Base64 encode it.
    // Simplest reliable approach: Base64 encode the config JSON.
    process.stdout.write("Applying via tcb agent update... ");
    try {
      const configBase64 = Buffer.from(configJson).toString("base64");
      // tcb --env comma-separates entries. CLOUDBASE_ENV_ID must be preserved.
      const envParts = [
        `CLOUDBASE_ENV_ID=${envId}`,
        `AGENT_CONFIG_B64=${configBase64}`,
      ];
      const envStr = envParts.join(",");
      const cmd = `tcb agent update ${agentId} --env "${envStr}" -e ${envId} --json`;
      const result = execSync(cmd, { encoding: "utf-8", timeout: 120000 });
      const data = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      console.log(green("OK"));
      if (data.data?.elapsedTime) {
        console.log(dim(`  Elapsed: ${Math.round(data.data.elapsedTime / 1000)}s`));
      }
      console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
    } catch (err) {
      throw new Error(`tcb agent update failed: ${err.message}`);
    }
  },

  // ─── Environment ──────────────────────────────────────────────────────────

  "env:create": async (args) => {
    if (!args.name) throw new Error("--name is required");
    const env = await post("/environments", {
      name: args.name,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    console.log(green("✅ Environment created:"));
    printEnv(env);
  },

  "env:list": async () => {
    const { data } = await get("/environments");
    if (!data.length) return console.log(dim("No environments found."));
    console.log(bold(`Environments (${data.length}):`));
    data.forEach(printEnv);
  },

  "env:delete": async (args) => {
    if (!args.id) throw new Error("--id is required");
    await del(`/environments/${args.id}`);
    console.log(green(`✅ Environment ${args.id} deleted.`));
  },

  // ─── Session ──────────────────────────────────────────────────────────────

  "session:create": async (args) => {
    if (!args.agent) throw new Error("--agent is required");
    const session = await post("/sessions", {
      agent:          args.agent,
      environment_id: args.env ?? undefined,
      title:          args.title ?? "",
    });
    console.log(green("✅ Session created:"));
    printSession(session);
  },

  "session:list": async () => {
    const { data } = await get("/sessions");
    if (!data.length) return console.log(dim("No sessions found."));
    console.log(bold(`Sessions (${data.length}):`));
    data.forEach(printSession);
  },

  "session:get": async (args) => {
    if (!args.id) throw new Error("--id is required");
    const session = await get(`/sessions/${args.id}`);
    printSession(session);
  },

  "session:delete": async (args) => {
    if (!args.id) throw new Error("--id is required");
    await del(`/sessions/${args.id}`);
    console.log(green(`✅ Session ${args.id} deleted.`));
  },

  // ─── Chat (send message to existing session, stream response) ─────────────

  "chat": async (args) => {
    if (!args.session) throw new Error("--session is required");
    if (!args.message) throw new Error("--message is required");

    // Start stream before sending to avoid race
    const streamGen = streamEvents(args.session);
    await post(`/sessions/${args.session}/events`, {
      events: [{
        type:    "user.message",
        content: [{ type: "text", text: args.message }],
      }],
    });

    console.log(dim(`\n[Session ${args.session}]`));
    console.log(dim(`You: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const event of streamGen) {
      renderEvent(event);
    }
  },

  // ─── Run (one-shot: create session + send + stream + cleanup) ─────────────

  "run": async (args) => {
    if (!args.agent)   throw new Error("--agent is required");
    if (!args.message) throw new Error("--message is required");

    process.stdout.write(dim("Creating session... "));
    const session = await post("/sessions", {
      agent: args.agent,
      title: args.message.slice(0, 60),
    });
    console.log(dim(`${session.id}\n`));

    const streamGen = streamEvents(session.id);

    await post(`/sessions/${session.id}/events`, {
      events: [{
        type:    "user.message",
        content: [{ type: "text", text: args.message }],
      }],
    });

    console.log(dim(`You: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const event of streamGen) {
      renderEvent(event);
      if (event.type === "session.status_idle" || event.type === "session.status_terminated") break;
    }

    if (!args["keep-session"]) {
      await del(`/sessions/${session.id}`).catch(() => {});
    } else {
      console.log(dim(`\nSession kept: ${session.id}`));
    }
  },

  // ─── Interactive REPL ─────────────────────────────────────────────────────

  "repl": async (args) => {
    if (!args.agent) throw new Error("--agent is required");

    console.log(bold("\n🤖 CloudBase Agent REPL"));
    console.log(dim("Type your message, press Enter. Ctrl+C to exit.\n"));

    process.stdout.write(dim("Creating session... "));
    const session = await post("/sessions", {
      agent: args.agent,
      title: "REPL session",
    });
    console.log(green(session.id));
    console.log();

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = () => {
      rl.question(cyan("You: "), async (message) => {
        if (!message.trim()) return ask();
        try {
          const streamGen = streamEvents(session.id);
          await post(`/sessions/${session.id}/events`, {
            events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
          });
          process.stdout.write(bold("\nAgent: "));
          for await (const event of streamGen) {
            renderEvent(event);
            if (event.type === "session.status_idle" || event.type === "session.status_terminated") break;
          }
          console.log();
        } catch (err) {
          console.error(red(`Error: ${err.message}`));
        }
        ask();
      });
    };

    rl.on("close", async () => {
      console.log(dim("\nCleaning up..."));
      await del(`/sessions/${session.id}`).catch(() => {});
      process.exit(0);
    });

    ask();
  },
};

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${bold("cbagent")} — CloudBase Managed Agent CLI

${bold("USAGE")}
  cbagent <command> [options]

${bold("ENVIRONMENT")}
  CLOUDBASE_SERVER_URL   Server URL (default: http://localhost:3000)
  CLOUDBASE_ENV_ID       CloudBase environment ID
  CLOUDBASE_AGENT_ID     Default agent ID for agent:update
  CLOUDBASE_API_KEY      API key for agent ACP access

${bold("AGENT COMMANDS")}
  agent:create  --name <name> [--model <model>] [--system <prompt>]
  agent:list
  agent:get     --id <agent-id>
  agent:delete  --id <agent-id>
  agent:update  --id <agent-id> [options]
                Update agent configuration (tools, MCP, skills, system prompt)
                without redeploying code. Uses AGENT_CONFIG env var.

    Options:
      --system <prompt>       Update system prompt
      --model <model>         Update model
      --name <name>           Update agent name
      --tools <json>          Replace tools array (JSON)
      --mcp-servers <json>    Replace mcp_servers array (JSON)
      --skills <json>         Replace skills array (JSON)
      --file <path>           Load full config from YAML/JSON file
      --env <envId>           CloudBase environment ID
      --api-key <key>         API key for fetching current config

${bold("ENVIRONMENT COMMANDS")}
  env:create    --name <name>
  env:list
  env:delete    --id <env-id>

${bold("SESSION COMMANDS")}
  session:create  --agent <agent-id> [--env <env-id>] [--title <title>]
  session:list
  session:get     --id <session-id>
  session:delete  --id <session-id>

${bold("MESSAGING COMMANDS")}
  chat   --session <session-id> --message <text>     Send message, stream response
  run    --agent <agent-id> --message <text>         One-shot (auto session)
         [--keep-session]                            Keep session after run
  repl   --agent <agent-id>                          Interactive REPL

${bold("EXAMPLES")}
  # Create an agent
  cbagent agent:create --name "Coder" --system "You are a coding assistant"

  # One-shot task
  cbagent run --agent agent_xxx --message "Write a bubble sort in Python"

  # Start a REPL conversation
  cbagent repl --agent agent_xxx

  # Send to existing session
  cbagent chat --session sess_xxx --message "Now add unit tests"
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...rest] = process.argv;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  // Parse remaining args as --key value pairs
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
      args[key] = val;
    }
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(red(`Unknown command: ${cmd}`));
    printHelp();
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (err) {
    console.error(red(`\nError: ${err.message}`));
    process.exit(1);
  }
}

main();
