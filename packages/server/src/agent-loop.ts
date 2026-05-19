import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

interface AgentConfig {
  model: string;
  system: string;
  tools: unknown[];
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface Event {
  type: string;
  content?: ContentBlock[];
  session_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
}

// Tool handler dispatcher
async function handleToolCall(
  toolName: string,
  input: Record<string, unknown>
): Promise<{ content: ContentBlock[]; is_error: boolean }> {
  try {
    if (toolName === "bash") {
      const cmd = String(input.command ?? "");
      if (!cmd) throw new Error("command is required");
      const timeout = Number(input.timeout ?? 30000);
      const { stdout, stderr } = await execAsync(cmd, { timeout });
      return {
        content: [{ type: "text", text: (stdout + stderr).trim() }],
        is_error: false,
      };
    }

    if (toolName === "read_file" || toolName === "view") {
      const filePath = String(input.path ?? "");
      const content = await fs.readFile(filePath, "utf-8");
      return { content: [{ type: "text", text: content }], is_error: false };
    }

    if (toolName === "write_file" || toolName === "create") {
      const filePath = String(input.path ?? "");
      const fileContent = String(input.content ?? "");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fileContent, "utf-8");
      return { content: [{ type: "text", text: `Written ${filePath}` }], is_error: false };
    }

    if (toolName === "list_files" || toolName === "ls") {
      const dir = String(input.path ?? ".");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const listing = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
      return { content: [{ type: "text", text: listing }], is_error: false };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      is_error: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: String(err) }],
      is_error: true,
    };
  }
}

export async function runAgentLoop(
  sessionId: string,
  agentConfig: AgentConfig,
  initialEvents: Event[],
  db: { collection: (name: string) => { where: (q: object) => { update: (d: object) => Promise<void>; get: () => Promise<{ data: object[] }> } } },
  ai: { generateText?: (p: object) => Promise<{ text?: string; thinking?: string; toolCalls?: Array<{ name: string; input: Record<string, unknown> }> }> }
): Promise<void> {
  const SESSIONS_COL = "managed_sessions";

  const appendEvent = async (event: object) => {
    const result = await db.collection(SESSIONS_COL).where({ id: sessionId }).get();
    if (!result.data.length) return;
    const session = result.data[0] as { events: object[] };
    const events = [...(session.events ?? []), { ...event, session_id: sessionId }];
    await db.collection(SESSIONS_COL).where({ id: sessionId }).update({ events });
  };

  const setStatus = async (status: string) => {
    await db.collection(SESSIONS_COL).where({ id: sessionId }).update({ status });
  };

  try {
    // Build messages from events
    const messages: Array<{ role: string; content: string | ContentBlock[] }> = [];

    if (agentConfig.system) {
      messages.push({ role: "system", content: agentConfig.system });
    }

    for (const event of initialEvents) {
      if (event.type === "user.message" && event.content) {
        messages.push({ role: "user", content: event.content });
      }
    }

    const MAX_ITERATIONS = 20;
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (!ai.generateText) {
        throw new Error("AI generateText is not available");
      }

      // Call CloudBase AI
      const response = await ai.generateText({
        model: agentConfig.model,
        messages,
        tools: agentConfig.tools,
      });

      // Emit thinking if present
      if (response.thinking) {
        await appendEvent({
          type: "agent.thinking",
          thinking: response.thinking,
        });
      }

      // Emit agent message
      if (response.text) {
        await appendEvent({
          type: "agent.message",
          content: [{ type: "text", text: response.text }],
        });
      }

      // Handle tool calls
      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        // No more tool calls — we're done
        break;
      }

      for (const toolCall of toolCalls) {
        const toolUseId = `tu_${Date.now().toString(36)}`;

        await appendEvent({
          type: "agent.tool_use",
          tool_use_id: toolUseId,
          tool_name: toolCall.name,
          input: toolCall.input,
        });

        const result = await handleToolCall(toolCall.name, toolCall.input);

        await appendEvent({
          type: "agent.tool_result",
          tool_use_id: toolUseId,
          content: result.content,
          is_error: result.is_error,
        });

        // Feed result back into messages
        messages.push({
          role: "tool",
          content: result.content[0]?.text ?? "",
        });
      }
    }

    await appendEvent({ type: "session.status_idle" });
    await setStatus("idle");
  } catch (err) {
    console.error("Agent loop error:", err);
    await appendEvent({
      type: "session.status_terminated",
      reason: String(err),
    });
    await setStatus("terminated");
  }
}
