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
 *   session:get    -i <session-id>                       (metadata only)
 *   session:events:list -i <session-id> [--format jsonl] (conversation history)
 *   session:delete -i <session-id>
 *
 *   chat           -s <session-id> -m <text>
 *   run            -a <agent-id>   -m <text>  (one-shot: create session + chat + stream)
 *   repl           -a <agent-id>              (interactive REPL)
 *
 *   sync-image                                同步预构建镜像到 TCR（无需密码，流水线自动推送）
 *     -i sandbox,tcbr,scf,all
 *
 *   <anything else>                           Transparently proxied to tcb CLI
 */

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

import { Command } from "commander";
import { getNodeExecutable, getTcbScript } from "./lib/tcb.mjs";
import { red } from "./lib/ui.mjs";
import { registerAgentCommands } from "./lib/commands/agent.mjs";
import { registerSessionCommands } from "./lib/commands/session.mjs";
import { registerChatCommands } from "./lib/commands/chat.mjs";
import { registerEnvCommands } from "./lib/commands/env.mjs";
import { registerCloudrunCommands } from "./lib/commands/cloudrun.mjs";
import { registerInitCommand } from "./lib/commands/init.mjs";
import { registerSyncImageCommand } from "./lib/commands/sync-image.mjs";
import { initManagedLogging } from "./lib/managed-logging.mjs";

initManagedLogging();

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

// ── CLI setup ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("magent")
  .description("OpenManagedAgent CLI — manage CloudBase AI agents from the command line")
  .version("0.1.0");

// Register command groups
registerAgentCommands(program);
registerSessionCommands(program);
registerChatCommands(program);
registerSyncImageCommand(program);
registerEnvCommands(program);
registerCloudrunCommands(program);
registerInitCommand(program);

// ── Login (proxy to tcb) ────────────────────────────────────────────────────
program
  .command("login")
  .description("Login to CloudBase (proxied to tcb)")
  .allowUnknownOption()
  .action(() => {
    const rawIdx = process.argv.indexOf("login");
    const rest = rawIdx >= 0 ? process.argv.slice(rawIdx + 1) : [];
    spawnSync(getNodeExecutable(), [getTcbScript(), "login", ...rest], { stdio: "inherit" });
  });

// ── TCB passthrough: unknown commands ───────────────────────────────────────
// Check before parse — if the command isn't one we registered, proxy to tcb.
const KNOWN_COMMANDS = new Set(program.commands.map((c) => c.name()));
const userCmd = process.argv[2];
if (userCmd && !userCmd.startsWith("-") && !KNOWN_COMMANDS.has(userCmd)) {
  const result = spawnSync(
    getNodeExecutable(),
    [getTcbScript(), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 0);
}

// ── Parse & run ─────────────────────────────────────────────────────────────

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // commander help/version are "errors" with specific exit codes
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.exitCode === 0) {
    process.exit(0);
  }
  if (err.code === "commander.missingArgument" ||
      err.code === "commander.unknownOption" ||
      err.code === "commander.missingMandatoryOptionValue") {
    // commander already printed the error
    process.exit(1);
  }
  // Action errors
  console.error(red(`\nError: ${err.message}`));
  process.exit(1);
}
