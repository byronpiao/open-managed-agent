// ── Chat, Run, REPL commands ──────────────────────────────────────────────────

import { createInterface } from "readline";
import { requireEnvId } from "../env.mjs";
import {
  getAcpUrl,
  acpCall,
  acpStream,
  handleReverseRequest,
  waitForHarnessSandboxReady,
} from "../acp.mjs";
import { dim, bold, green, yellow, red, cyan } from "../ui.mjs";

async function handleChat(options) {
  if (!options.session) throw new Error("-s / --session is required");
  if (!options.message) throw new Error("-m / --message is required");
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) {
    throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  }

  requireEnvId(options);
  const acpUrl = getAcpUrl(options);

  console.log(dim(`\n[Session ${options.session}]`));
  console.log(dim(`You: ${options.message}\n`));
  console.log(bold("Agent:"));

  for await (const item of acpStream(acpUrl, "session/prompt", {
    sessionId: options.session,
    prompt: [{ type: "text", text: options.message }],
  })) {
    if (item.type === "reverse_request") {
      await handleReverseRequest(acpUrl, item.data, !!(options.autoApprove || options.y));
    } else if (item.type === "notification") {
      const update = item.data.params?.update;
      switch (update?.sessionUpdate) {
        case "agent_message_chunk":
          process.stdout.write(update.content?.text ?? "");
          break;
        case "tool_call":
          console.log(yellow(`\n🔧 Tool: ${update.title ?? update.toolCall?.name ?? "?"} [${update.status ?? update.toolCall?.status}]`));
          break;
        case "tool_call_update":
          if (update.result) console.log(dim(`   ${String(update.result).slice(0, 200)}`));
          else if (update.status) console.log(dim(`   [${update.status}]`));
          break;
        case "log":
          if (update.level === "error") {
            console.log(red(`\n❌ ${update.message ?? "unknown error"}`));
          } else if (process.env.MAGENT_VERBOSE) {
            console.log(dim(`\n  ${update.level ?? "log"}: ${update.message ?? ""}`));
          }
          break;
      }
    } else if (item.type === "result") {
      console.log(green(`\n\n✅ Done (${item.data.stopReason ?? "end_turn"})`));
    }
  }
}

async function handleRun(options) {
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  if (!options.message) throw new Error("-m / --message is required");

  requireEnvId(options);
  const acpUrl = getAcpUrl(options);

  process.stdout.write(dim("Connecting to agent... "));
  const initResult = await acpCall(acpUrl, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "magent-cli", version: "0.1.0" },
  });
  console.log(green(initResult.agentInfo?.name ?? "OK"));

  process.stdout.write(dim("Creating session... "));
  const { sessionId } = await acpCall(acpUrl, "session/new", { cwd: "/", mcpServers: [] });
  console.log(dim(sessionId));
  await waitForHarnessSandboxReady(acpUrl, sessionId, initResult);

  console.log(dim(`\nYou: ${options.message}\n`));
  console.log(bold("Agent:"));

  for await (const item of acpStream(acpUrl, "session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: options.message }],
  })) {
    if (item.type === "reverse_request") {
      await handleReverseRequest(acpUrl, item.data, !!(options.autoApprove || options.y));
    } else if (item.type === "notification") {
      const update = item.data.params?.update;
      switch (update?.sessionUpdate) {
        case "agent_message_chunk":
          process.stdout.write(update.content?.text ?? "");
          break;
        case "tool_call":
          console.log(yellow(`\n🔧 Tool: ${update.title ?? update.toolCall?.name ?? "?"} [${update.status ?? update.toolCall?.status}]`));
          break;
        case "tool_call_update":
          if (update.result) console.log(dim(`   ${String(update.result).slice(0, 200)}`));
          else if (update.status) console.log(dim(`   [${update.status}]`));
          break;
        case "log":
          if (update.level === "error") {
            console.log(red(`\n❌ ${update.message ?? "unknown error"}`));
          } else if (process.env.MAGENT_VERBOSE) {
            console.log(dim(`\n  ${update.level ?? "log"}: ${update.message ?? ""}`));
          }
          break;
      }
    } else if (item.type === "result") {
      console.log(green(`\n\n✅ Done (${item.data.stopReason ?? "end_turn"})`));
    }
  }
}

async function handleRepl(options) {
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");

  requireEnvId(options);
  const acpUrl = getAcpUrl(options);

  console.log(bold("\n🤖 OpenManagedAgent REPL"));
  console.log(dim("Type your message, press Enter. Ctrl+C to exit.\n"));

  process.stdout.write(dim("Connecting... "));
  const initResult = await acpCall(acpUrl, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "magent-cli", version: "0.1.0" },
  });
  console.log(green(initResult.agentInfo?.name ?? "OK"));

  process.stdout.write(dim("Creating session... "));
  const { sessionId } = await acpCall(acpUrl, "session/new", { cwd: "/", mcpServers: [] });
  console.log(green(sessionId));
  await waitForHarnessSandboxReady(acpUrl, sessionId, initResult);
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question(cyan("You: "), async (message) => {
      if (!message.trim()) return ask();
      try {
        process.stdout.write(bold("\nAgent: "));
        for await (const item of acpStream(acpUrl, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: message }],
        })) {
          if (item.type === "reverse_request") {
            await handleReverseRequest(acpUrl, item.data, !!(options.autoApprove || options.y));
          } else if (item.type === "notification") {
            const update = item.data.params?.update;
            switch (update?.sessionUpdate) {
              case "agent_message_chunk":
                process.stdout.write(update.content?.text ?? "");
                break;
              case "tool_call":
                console.log(yellow(`\n🔧 Tool: ${update.title ?? update.toolCall?.name ?? "?"} [${update.status ?? update.toolCall?.status}]`));
                break;
              case "tool_call_update":
                if (update.result) console.log(dim(`   ${String(update.result).slice(0, 200)}`));
                else if (update.status) console.log(dim(`   [${update.status}]`));
                break;
              case "log":
                if (update.level === "error") {
                  console.log(red(`\n❌ ${update.message ?? "unknown error"}`));
                } else if (process.env.MAGENT_VERBOSE) {
                  console.log(dim(`\n  ${update.level ?? "log"}: ${update.message ?? ""}`));
                }
                break;
            }
          } else if (item.type === "result") {
            console.log(green(`\n  (${item.data.stopReason ?? "end_turn"})`));
          }
        }
        console.log();
      } catch (err) {
        console.error(red(`\nError: ${err.message}`));
      }
      ask();
    });
  };

  rl.on("close", () => {
    console.log(dim("\nBye!"));
    process.exit(0);
  });

  ask();
}

export function registerChatCommands(program) {
  program.command("chat")
    .description("Send message to an existing session")
    .option("-s, --session <id>", "Session ID (required)")
    .option("-m, --message <text>", "Message text (required)")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--auto-approve", "Auto-approve tool calls")
    .option("-y", "Alias for --auto-approve")
    .action(handleChat);

  program.command("run")
    .description("One-shot: create session + chat + stream")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("-m, --message <text>", "Message text (required)")
    .option("--auto-approve", "Auto-approve tool calls")
    .option("-y", "Alias for --auto-approve")
    .action(handleRun);

  program.command("repl")
    .description("Interactive REPL")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--auto-approve", "Auto-approve tool calls")
    .option("-y", "Alias for --auto-approve")
    .action(handleRepl);
}
