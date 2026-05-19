import { AbstractAgent, RunAgentInput, BaseEvent, EventType } from "@ag-ui/client";
import { Observable, Subscriber } from "rxjs";
import cloudbase from "@cloudbase/node-sdk";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

interface HunyuanAgentOptions {
  model: string;
  system: string;
}

// ── CloudBase AI client ───────────────────────────────────────────────────────

const cbApp = cloudbase.init({
  env: process.env.CLOUDBASE_ENV_ID ?? "",
});
const cbAI = cbApp.ai();

// ── Built-in tool definitions ─────────────────────────────────────────────────

const BUILTIN_TOOLS = [
  {
    name: "bash",
    description: "Execute a shell command and return stdout/stderr",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        timeout: { type: "number", description: "Timeout in ms (default 30000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file (creates parent dirs automatically)",
    parameters: {
      type: "object",
      properties: {
        path:    { type: "string", description: "File path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
      },
      required: ["path"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "bash": {
        const { stdout, stderr } = await execAsync(String(args.command), {
          timeout: Number(args.timeout ?? 30000),
        });
        return (stdout + stderr).trim();
      }
      case "read_file":
        return await fs.readFile(String(args.path), "utf-8");
      case "write_file": {
        const p = String(args.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, String(args.content), "utf-8");
        return `Written: ${p}`;
      }
      case "list_files": {
        const entries = await fs.readdir(String(args.path), { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

// ── HunyuanAgent ─────────────────────────────────────────────────────────────

export class HunyuanAgent extends AbstractAgent {
  private model: string;
  private system: string;

  constructor(opts: HunyuanAgentOptions) {
    super();
    this.model  = opts.model;
    this.system = opts.system;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      this._run(subscriber, input).catch((err) => {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: String(err),
        } as BaseEvent);
        subscriber.complete();
      });
    });
  }

  private async _run(subscriber: Subscriber<BaseEvent>, input: RunAgentInput) {
    const { messages, runId, threadId, tools: clientTools } = input;

    subscriber.next({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);

    // Merge built-in tools with any client-provided tools
    const allTools = [...BUILTIN_TOOLS, ...(clientTools ?? [])];

    // Convert AG-UI messages to CloudBase AI format
    const cbMessages: Array<{ role: string; content: string }> = [];
    if (this.system) {
      cbMessages.push({ role: "system", content: this.system });
    }
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        cbMessages.push({ role: msg.role, content: msg.content ?? "" });
      } else if (msg.role === "tool") {
        cbMessages.push({ role: "tool", content: msg.content ?? "" });
      }
    }

    const MAX_ITERATIONS = 20;
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Call CloudBase AI (streamText for streaming)
      const stream = await cbAI.streamText({
        model: this.model,
        messages: cbMessages,
        tools: allTools,
      });

      const messageId = `msg_${runId}_${iterations}`;
      let textStarted = false;
      let currentText = "";

      // Process stream chunks
      for await (const chunk of stream) {
        // Text delta
        if (chunk.textDelta) {
          if (!textStarted) {
            subscriber.next({
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            } as BaseEvent);
            textStarted = true;
          }
          currentText += chunk.textDelta;
          subscriber.next({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: chunk.textDelta,
          } as BaseEvent);
        }

        // Tool call
        if (chunk.toolCalls?.length) {
          if (textStarted) {
            subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
            textStarted = false;
            cbMessages.push({ role: "assistant", content: currentText });
          }

          for (const toolCall of chunk.toolCalls) {
            const toolCallId = toolCall.id ?? `tc_${Date.now()}`;
            const argsStr = JSON.stringify(toolCall.input ?? {});

            // Emit tool call events
            subscriber.next({
              type: EventType.TOOL_CALL_START,
              toolCallId,
              toolCallName: toolCall.name,
              parentMessageId: messageId,
            } as BaseEvent);
            subscriber.next({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: argsStr,
            } as BaseEvent);
            subscriber.next({
              type: EventType.TOOL_CALL_END,
              toolCallId,
            } as BaseEvent);

            // Check if this is a client tool (not built-in)
            const isClientTool = clientTools?.some((t) => t.name === toolCall.name);

            if (isClientTool) {
              // Pause: emit RUN_FINISHED so client can execute and resume
              subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
              subscriber.complete();
              return;
            }

            // Execute built-in tool
            const result = await executeTool(toolCall.name, toolCall.input ?? {});

            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              toolCallId,
              messageId: `tr_${toolCallId}`,
              content: result,
            } as BaseEvent);

            // Feed result back into message history
            cbMessages.push({ role: "tool", content: result });
          }

          // Continue the loop (tool calls happened, keep going)
          continue;
        }
      }

      // Close text message if open
      if (textStarted) {
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
        cbMessages.push({ role: "assistant", content: currentText });
      }

      // No tool calls this iteration → done
      break;
    }

    subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
    subscriber.complete();
  }
}
