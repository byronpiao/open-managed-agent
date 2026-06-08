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
import { streamEvents, post } from "../api.mjs";
import { renderEvent, dim, bold, green, yellow, red, cyan } from "../ui.mjs";

export const chatCommands = {

  // ─── Chat (send message to existing session, stream response) ─────────────

  "chat": async (args) => {
    if (!args.session) throw new Error("-s / --session is required");
    if (!args.message) throw new Error("-m / --message is required");

    const streamGen = streamEvents(args.session);
    await post(`/sessions/${args.session}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: args.message }] }],
    });

    console.log(dim(`\n[Session ${args.session}]`));
    console.log(dim(`You: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const event of streamGen) {
      renderEvent(event);
    }
  },

  // ─── Run (one-shot: ACP session/new → session/prompt, no persistence) ─────

  "run": async (args) => {
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    if (!args.message) throw new Error("-m / --message is required");

    requireEnvId(args);
    const acpUrl = getAcpUrl(args);

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

    console.log(dim(`\nYou: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const item of acpStream(acpUrl, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: args.message }],
    })) {
      if (item.type === "reverse_request") {
        await handleReverseRequest(acpUrl, item.data, !!(args["auto-approve"] || args.y));
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
  },

  // ─── Interactive REPL (ACP session, multi-turn) ───────────────────────────

  "repl": async (args) => {
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");

    requireEnvId(args);
    const acpUrl = getAcpUrl(args);

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
              await handleReverseRequest(acpUrl, item.data, !!(args["auto-approve"] || args.y));
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
  },
};
