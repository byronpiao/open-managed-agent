/**
 * ACP (Agent Client Protocol) Client
 *
 * JSON-RPC 2.0 over HTTP, with NDJSON streaming for prompts and session/load.
 *
 * Usage:
 *   const acp = new AcpClient({ baseURL: "http://localhost:9000" });
 *   await acp.initialize();
 *   const { sessionId } = await acp.sessionNew();
 *   for await (const update of acp.sessionPrompt(sessionId, "Hello!")) {
 *     if (update.type === "chunk") process.stdout.write(update.text);
 *   }
 */

import type { ManagedAgentsConfig } from "./types.js";

let _rpcId = 0;
const nextId = () => ++_rpcId;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AcpSessionInfo {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface AcpSessionDetail {
  sessionId: string;
  model: string;
  system: string;
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>;
  createdAt: number;
  updatedAt: number;
}

export type AcpStreamEvent =
  | { type: "chunk"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; status: string; result?: string }
  | {
      type: "tool_use_request";
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "permission_request";
      toolCallId: string;
      toolName: string;
      args: unknown;
      options: Array<{ optionId: string; name: string; kind: string }>;
      hints?: unknown;
    }
  | { type: "error"; message: string }
  | {
      type: "done";
      stopReason: string;
      pendingToolUse?: { toolUseId: string; toolName: string; input: unknown };
      pendingPermission?: {
        toolUseId: string;
        toolName: string;
        args: unknown;
        options: Array<{ optionId: string; name: string; kind: string }>;
      };
    };

export interface AcpCapabilities {
  loadSession: boolean;
  sessionList: boolean;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class AcpClient {
  private baseURL: string;
  private headers: Record<string, string>;
  capabilities: AcpCapabilities = { loadSession: false, sessionList: false };

  constructor(config: ManagedAgentsConfig) {
    this.baseURL = (config.baseURL ?? `https://${config.envId}.api.tcloudbasegateway.com/v1/aibot/bots/${config.agentId}`).replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(config.accessKey ? { Authorization: `Bearer ${config.accessKey}` } : {}),
      ...(config.envId     ? { "X-CloudBase-Env-Id": config.envId }          : {}),
    };
  }

  // ── JSON-RPC helper (non-streaming) ────────────────────────────────────────

  private async rpc<T>(method: string, params: unknown = {}): Promise<T> {
    const res = await fetch(`${this.baseURL}/acp`, {
      method:  "POST",
      headers: this.headers,
      body:    JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
    });
    const data = await res.json() as { result?: T; error?: { message: string } };
    if (data.error) throw new Error(`ACP error: ${data.error.message}`);
    return data.result as T;
  }

  // ── Streaming JSON-RPC (NDJSON) ───────────────────────────────────────────

  private async *rpcStream<TNotification, TResult>(
    method: string,
    params: unknown = {}
  ): AsyncGenerator<{ notification: TNotification } | { result: TResult }> {
    const id = nextId();
    const res = await fetch(`${this.baseURL}/acp`, {
      method:  "POST",
      headers: this.headers,
      body:    JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok || !res.body) throw new Error(`ACP stream error: ${res.status}`);

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf      = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // SSE frames are `data: <payload>`. Strip the prefix; ignore terminator.
        let payload = trimmed;
        if (payload.startsWith("data:")) {
          payload = payload.slice(5).trim();
        }
        if (!payload || payload === "[DONE]") continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // Skip non-JSON heartbeats/comments
          continue;
        }
        if ("method" in msg) {
          yield { notification: msg as unknown as TNotification };
        } else if ("result" in msg || "error" in msg) {
          if (msg.error) throw new Error(`ACP error: ${(msg.error as { message: string }).message}`);
          yield { result: msg.result as TResult };
        }
      }
    }
  }

  // ── initialize ────────────────────────────────────────────────────────────

  async initialize(): Promise<{ agentInfo: { name: string; version: string } }> {
    const result = await this.rpc<{
      agentCapabilities: AcpCapabilities;
      agentInfo: { name: string; version: string };
    }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "open-managed-agent", version: "0.1.0" },
    });
    this.capabilities = result.agentCapabilities;
    return result;
  }

  // ── session/new ───────────────────────────────────────────────────────────

  async sessionNew(cwd = "/"): Promise<{ sessionId: string }> {
    return this.rpc("session/new", { cwd, mcpServers: [] });
  }

  // ── session/list ──────────────────────────────────────────────────────────

  async sessionList(): Promise<AcpSessionInfo[]> {
    const result = await this.rpc<{ sessions: AcpSessionInfo[] }>("session/list", {});
    return result.sessions;
  }

  // ── session/resume ────────────────────────────────────────────────────────

  async sessionResume(sessionId: string): Promise<{ sessionId: string }> {
    return this.rpc("session/resume", { sessionId, cwd: "/", mcpServers: [] });
  }

  // ── session/load (streams history replay) ────────────────────────────────

  async *sessionLoad(sessionId: string): AsyncGenerator<AcpStreamEvent> {
    type Notif = { method: string; params: { update: { sessionUpdate: string; content?: { text: string } } } };
    for await (const item of this.rpcStream<Notif, { sessionId: string }>(
      "session/load", { sessionId, cwd: "/", mcpServers: [] }
    )) {
      if ("notification" in item) {
        const update = item.notification.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
          yield { type: "chunk", text: update.content.text };
        }
      } else {
        yield { type: "done", stopReason: "loaded" };
      }
    }
  }

  // ── session/prompt (streams response) ─────────────────────────────────────

  async *sessionPrompt(sessionId: string, text: string): AsyncGenerator<AcpStreamEvent> {
    yield* this._sessionPromptInternal(sessionId, [{ type: "text", text }]);
  }

  /**
   * Resume a paused turn by submitting a tool_result for a pending client-side
   * tool call. Use after receiving a `done` event with stopReason='tool_use'.
   */
  async *sessionPromptToolResult(
    sessionId: string,
    toolUseId: string,
    content: string,
    isError = false,
  ): AsyncGenerator<AcpStreamEvent> {
    yield* this._sessionPromptInternal(sessionId, [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      },
    ]);
  }

  /**
   * Resume a paused turn by submitting a permission decision for a pending
   * approval request. Use after receiving a `done` event with
   * stopReason='awaiting_permission'.
   */
  async *sessionPromptPermission(
    sessionId: string,
    toolUseId: string,
    decision: string, // optionId, e.g. "allow-once" / "reject-once" / "cancelled"
  ): AsyncGenerator<AcpStreamEvent> {
    yield* this._sessionPromptInternal(sessionId, [
      {
        type: "permission_decision",
        tool_use_id: toolUseId,
        decision,
      },
    ]);
  }

  private async *_sessionPromptInternal(
    sessionId: string,
    prompt: Array<Record<string, unknown>>,
  ): AsyncGenerator<AcpStreamEvent> {
    type Notif = {
      method: string;
      params: {
        update: {
          sessionUpdate: string;
          content?: { text: string };
          toolCall?: { id: string; name: string; status: string; result?: string };
          toolCallId?: string;
          toolName?: string;
          input?: unknown;
          args?: unknown;
          options?: Array<{ optionId: string; name: string; kind: string }>;
          hints?: unknown;
          message?: string;
        };
      };
    };
    type DoneResult = {
      stopReason: string;
      pendingToolUse?: { toolUseId: string; toolName: string; input: unknown };
      pendingPermission?: {
        toolUseId: string;
        toolName: string;
        args: unknown;
        options: Array<{ optionId: string; name: string; kind: string }>;
      };
    };
    for await (const item of this.rpcStream<Notif, DoneResult>(
      "session/prompt",
      { sessionId, prompt },
    )) {
      if ("notification" in item) {
        const update = item.notification.params?.update;
        switch (update?.sessionUpdate) {
          case "agent_message_chunk":
            yield { type: "chunk", text: update.content?.text ?? "" };
            break;
          case "tool_call":
            yield {
              type: "tool_call",
              toolCallId: update.toolCall?.id ?? "",
              name: update.toolCall?.name ?? "",
              status: update.toolCall?.status ?? "",
              result: update.toolCall?.result,
            };
            break;
          case "permission_request":
            yield {
              type: "permission_request",
              toolCallId: update.toolCallId ?? "",
              toolName: update.toolName ?? "",
              args: update.args,
              options: update.options ?? [],
              hints: update.hints,
            };
            break;
          case "tool_use_request":
            yield {
              type: "tool_use_request",
              toolUseId: update.toolCallId ?? "",
              toolName: update.toolName ?? "",
              input: update.input,
            };
            break;
          case "error":
            yield { type: "error", message: update.message ?? "unknown error" };
            break;
        }
      } else if ("result" in item) {
        const r = item.result;
        // Synthesize a tool_use_request event when the turn ended for a
        // client-side tool, so consumers can react in a single stream.
        if (r.stopReason === "tool_use" && r.pendingToolUse) {
          yield {
            type: "tool_use_request",
            toolUseId: r.pendingToolUse.toolUseId,
            toolName: r.pendingToolUse.toolName,
            input: r.pendingToolUse.input,
          };
        }
        yield {
          type: "done",
          stopReason: r.stopReason,
          pendingToolUse: r.pendingToolUse,
          pendingPermission: r.pendingPermission,
        };
      }
    }
  }

  // ── session/cancel ────────────────────────────────────────────────────────

  async sessionCancel(sessionId: string): Promise<void> {
    await fetch(`${this.baseURL}/acp`, {
      method:  "POST",
      headers: this.headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method:  "session/cancel",
        params:  { sessionId },
        // No id — notification
      }),
    });
  }

  // ── REST convenience (GET /acp/sessions) ─────────────────────────────────

  async getSession(sessionId: string): Promise<AcpSessionDetail> {
    const res = await fetch(`${this.baseURL}/acp/sessions/${sessionId}`, { headers: this.headers });
    if (!res.ok) throw new Error(`Session not found: ${sessionId}`);
    return res.json() as Promise<AcpSessionDetail>;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fetch(`${this.baseURL}/acp/sessions/${sessionId}`, {
      method: "DELETE", headers: this.headers,
    });
  }
}
