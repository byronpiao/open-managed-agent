/**
 * Bridges sandbox managed-agent-client MCP tools/call → ACP tool_use_request on active prompt SSE.
 */

import { harnessTrace, harnessLog } from "./logging.js";

export interface PendingClientTool {
  acpSessionId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  resolve: (result: { content: string; isError: boolean }) => void;
  reject: (err: Error) => void;
  createdAt: number;
}

export interface ActivePromptRegistration {
  acpSessionId: string;
  writeFrame: (frame: unknown) => void;
}

const activePrompts = new Map<string, ActivePromptRegistration>();
const pendingByToolUseId = new Map<string, PendingClientTool>();
const pendingBySession = new Map<string, string>();

const CLIENT_TOOL_TIMEOUT_MS = 120_000;

export function registerActivePrompt(
  acpSessionId: string,
  writeFrame: (frame: unknown) => void,
): void {
  activePrompts.set(acpSessionId, { acpSessionId, writeFrame });
}

export function unregisterActivePrompt(acpSessionId: string): void {
  activePrompts.delete(acpSessionId);
  const toolUseId = pendingBySession.get(acpSessionId);
  if (toolUseId) {
    pendingByToolUseId.delete(toolUseId);
    pendingBySession.delete(acpSessionId);
  }
}

export function hasActivePrompt(acpSessionId: string): boolean {
  return activePrompts.has(acpSessionId);
}

/**
 * Called from POST /internal/harness/mcp (JSON-RPC tools/call).
 */
export async function invokeClientToolFromSandbox(args: {
  acpSessionId: string;
  toolName: string;
  input: unknown;
}): Promise<{ content: unknown; isError?: boolean }> {
  const ctx = activePrompts.get(args.acpSessionId);
  if (!ctx) {
    throw new Error(
      `No active session/prompt for ${args.acpSessionId}; client tool requires an in-flight prompt`,
    );
  }

  const toolUseId = crypto.randomUUID();
  const result = await new Promise<{ content: string; isError: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByToolUseId.delete(toolUseId);
      pendingBySession.delete(args.acpSessionId);
      harnessLog({
        lane: "client_tool",
        operation: "client_tool.timeout",
        acpSessionId: args.acpSessionId,
        toolName: args.toolName,
        toolUseId,
      }).emit({ status: "error", timeoutMs: CLIENT_TOOL_TIMEOUT_MS });
      reject(new Error(`Client tool '${args.toolName}' timed out after ${CLIENT_TOOL_TIMEOUT_MS}ms`));
    }, CLIENT_TOOL_TIMEOUT_MS);

    const pending: PendingClientTool = {
      acpSessionId: args.acpSessionId,
      toolUseId,
      toolName: args.toolName,
      input: args.input,
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      createdAt: Date.now(),
    };
    pendingByToolUseId.set(toolUseId, pending);
    pendingBySession.set(args.acpSessionId, toolUseId);

    harnessLog({
      lane: "client_tool",
      operation: "client_tool.request",
      acpSessionId: args.acpSessionId,
      toolName: args.toolName,
      toolUseId,
    }).emit({ status: "ok" });
    harnessTrace("client_tool.request", {
      acpSessionId: args.acpSessionId,
      toolUseId,
      toolName: args.toolName,
    });

    ctx.writeFrame({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: args.acpSessionId,
        update: {
          sessionUpdate: "tool_use_request",
          toolCallId: toolUseId,
          toolName: args.toolName,
          input: args.input,
        },
      },
    });
  });

  return {
    content: result.content,
    isError: result.isError,
  };
}

/**
 * Resume path: client POST session/prompt with tool_result block.
 * Returns true if the result was consumed by the bridge (do not forward to sandbox).
 */
export function deliverClientToolResult(args: {
  acpSessionId: string;
  toolUseId: string;
  content: unknown;
  isError?: boolean;
}): boolean {
  const pending = pendingByToolUseId.get(args.toolUseId);
  if (!pending || pending.acpSessionId !== args.acpSessionId) {
    return false;
  }
  pendingByToolUseId.delete(args.toolUseId);
  pendingBySession.delete(args.acpSessionId);
  const content =
    typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "");
  pending.resolve({ content, isError: args.isError ?? false });
  harnessLog({
    lane: "client_tool",
    operation: "client_tool.result",
    acpSessionId: args.acpSessionId,
    toolUseId: args.toolUseId,
    isError: args.isError ?? false,
  }).emit({ status: "ok" });
  return true;
}

export function getPendingToolUseIdForSession(acpSessionId: string): string | undefined {
  return pendingBySession.get(acpSessionId);
}

/** Test helper */
export function resetClientToolBridgeForTests(): void {
  activePrompts.clear();
  pendingByToolUseId.clear();
  pendingBySession.clear();
}
