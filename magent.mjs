#!/usr/bin/env node
/**
 * magent - OpenManagedAgent CLI
 *
 * Usage:
 *   magent <command> [options]
 *
 * Commands:
 *   login                                     Login to CloudBase (proxied to tcb)
 *
 *   agent:create   -n <name> [options]
 *   agent:list     [-e <envId>]
 *   agent:get      [-a <agent-id>]
 *   agent:delete   [-a <agent-id>]
 *   agent:update   [-a <id>] [options]
 *
 *   env:list                                  List CloudBase environments (proxied to tcb)
 *
 *   session:create -a <agent-id> [--title <title>]
 *   session:list
 *   session:get    -i <session-id>
 *   session:delete -i <session-id>
 *
 *   chat           -s <session-id> -m <text>
 *   run            -a <agent-id>   -m <text>  (one-shot: create session + chat + stream)
 *   repl           -a <agent-id>              (interactive REPL)
 *
 *   <anything else>                           Transparently proxied to tcb CLI
 */

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

import { getNodeExecutable, getTcbScript } from "./lib/tcb.mjs";
import { red, dim, bold } from "./lib/ui.mjs";
import { agentCommands } from "./lib/commands/agent.mjs";
import { sessionCommands } from "./lib/commands/session.mjs";
import { chatCommands } from "./lib/commands/chat.mjs";
import { envCommands } from "./lib/commands/env.mjs";
import { cloudrunCommands } from "./lib/commands/cloudrun.mjs";

// ── Load .env file ──────────────────────────────────────────────────────────
const envFile = new URL(".env", import.meta.url).pathname;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val; // don't override existing
  }
}

// ── Short-flag map ────────────────────────────────────────────────────────────

const SHORT_FLAGS = {
  e: "env",
  a: "agent",    // agent ID for all agent commands
  i: "id",       // session ID for session:get/delete
  m: "message",
  s: "session",
  f: "file",
  n: "name",
  o: "output",
};

// ── Arg parser (supports --key value and -k value) ────────────────────────────

function parseFlags(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const val = next && !next.startsWith("-") ? argv[++i] : true;
      args[key] = val;
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = SHORT_FLAGS[arg[1]] ?? arg[1];
      const next = argv[i + 1];
      const val = next && !next.startsWith("-") ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

// ── Command registry ──────────────────────────────────────────────────────────

const COMMANDS = {
  ...agentCommands,
  ...sessionCommands,
  ...chatCommands,
  ...envCommands,
  ...cloudrunCommands,

  // ─── Login (proxy to tcb) ─────────────────────────────────────────────────
  "login": async (args, rest) => {
    spawnSync(getNodeExecutable(), [getTcbScript(), "login", ...rest], { stdio: "inherit" });
  },
};

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${bold("magent")} — OpenManagedAgent CLI

${bold("USAGE")}
  magent <command> [options]

${bold("ENVIRONMENT")}
  CLOUDBASE_ENV_ID       CloudBase environment ID (auto-detected via tcb if not set)
  CLOUDBASE_AGENT_ID     Default agent ID (used when -a is omitted)
  CLOUDBASE_ACCESS_KEY   API key for agent access

${bold("AUTHENTICATION")}
  login [options]              Login to CloudBase
                               Proxied to: tcb login [options]

${bold("AGENT COMMANDS")}
  agent:create  -n <name> [options]           Create and deploy a new agent
    -n, --name <name>           Agent name (required)
        --type <scf|tcbr>       Compute backend (default: scf)
                                  scf  = SCF cloud function (~60-90s deploy)
                                  tcbr = CloudRun container (~3-5min deploy,
                                         needs Docker image, supports custom
                                         system libs)
        --model <model>         Model (default: hunyuan-t1-latest)
        --system <prompt>       System prompt
    -f, --file <path>           Load config from YAML/JSON file
        --code <path>           Code directory (default: ./packages/agent-runtime)
        --runtime <rt>          [scf only] Runtime (default: Nodejs20.19)
        --service <name>        [tcbr only] Override cloudrun service name
    -e, --env <envId>           CloudBase environment ID (auto-detected if not set)

  agent:update  [-a <id>] [options]           Update agent config
                                              (scf: ~8s no redeploy;
                                               tcbr: ~60-90s rolling redeploy)
        --system <prompt>       Update system prompt
        --model <model>         Update model
    -n, --name <name>           Update agent name
        --tools <json>          Replace tools array (JSON)
        --mcp-servers <json>    Replace mcp_servers array (JSON)
        --skills <json>         Replace skills array (JSON)
    -f, --file <path>           Load full config from YAML/JSON file
    -e, --env <envId>           CloudBase environment ID (auto-detected if not set)

  agent:list    [-e <envId>]                  List all agents
  agent:get     [-a <id>]                     Get agent details
  agent:export  [-a <id>] [-o <file>]         Export live agent config to YAML
                                              (round-trip safe; use with agent:update -f)
    -o, --output <path>     Output file path (omit to print to stdout)
    -e, --env <envId>       CloudBase environment ID (auto-detected if not set)
  agent:delete  [-a <id>]                     Delete an agent (also cleans up
                                              the underlying SCF function or
                                              CloudRun service)

${bold("CLOUDBASE ENVIRONMENT COMMANDS")}
  env:list [options]           List CloudBase environments
                               Proxied to: tcb env:list [options]

${bold("SESSION COMMANDS")}
  session:create  -a <agent-id> [--title <title>] [-e <env-id>]
  session:list    -a <agent-id>
  session:get     -i <session-id> -a <agent-id>
  session:delete  -i <session-id> -a <agent-id>

${bold("MESSAGING COMMANDS")}
  run    -a <id> -m <text>                    One-shot (auto-creates and cleans up session)
           [--auto-approve]                   Auto-approve tool calls
  chat   -s <id> -m <text>                    Send message to an existing session
  repl   -a <id>                              Interactive REPL

${bold("SHORT FLAGS")}
  -e <envId>     Same as --env       (CloudBase environment ID, auto-detected)
  -a <agentId>   Same as --agent     (agent ID — unified for all agent commands)
  -i <id>        Same as --id        (session ID for session:get/delete)
  -m <text>      Same as --message
  -s <sessionId> Same as --session
  -f <path>      Same as --file
  -n <name>      Same as --name

${bold("TCB PASSTHROUGH")}
  Any command not listed above is forwarded transparently to the tcb CLI.
  Example:
    magent functions:list -e myenv   →  tcb functions:list -e myenv
    magent storage:list              →  tcb storage:list

${bold("EXAMPLES")}
  # First-time setup
  magent login
  magent env:list

  # Create and deploy an agent
  magent agent:create -n "Coder" --system "You are a coding assistant"

  # List agents (env auto-detected from tcb)
  magent agent:list

  # Update config without redeploying
  magent agent:update -a agent_xxx --system "You are a strict code reviewer"
  magent agent:update -a agent_xxx -f ./agent.yaml
  magent agent:update -a agent_xxx --model deepseek-v3.2

  # Export live config to file (then edit and push back)
  magent agent:export -a agent_xxx -o ./agent.yaml
  magent agent:update -a agent_xxx -f ./agent.yaml

  # One-shot task
  magent run -a agent_xxx -m "Write a bubble sort in Python"

  # Multi-turn conversation
  magent session:create -a agent_xxx --title "My project"
  magent chat -s sess_xxx -m "Hello"
  magent chat -s sess_xxx -m "Now add error handling"

  # Interactive REPL
  magent repl -a agent_xxx
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...rest] = process.argv;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  // Parse flags — supports both --key value and -k value
  const args = parseFlags(rest);

  // Early env propagation: -e / --env → CLOUDBASE_ENV_ID so all downstream
  // code (including tcb commands) picks up the override automatically.
  if (args.env) {
    process.env.CLOUDBASE_ENV_ID = args.env;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    // Transparently proxy all unrecognized commands to the tcb CLI
    const result = spawnSync(getNodeExecutable(), [getTcbScript(), cmd, ...rest], { stdio: "inherit" });
    process.exit(result.status ?? 0);
    return;
  }

  try {
    await handler(args, rest);
  } catch (err) {
    console.error(red(`\nError: ${err.message}`));
    process.exit(1);
  }
}

main();
