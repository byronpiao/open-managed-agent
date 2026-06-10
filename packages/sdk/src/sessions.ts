/**
 * SessionsResource — `runtime=harness` → Managed Agents HTTP; `managed` → ACP.
 */

import type {
  Session,
  CreateSessionParams,
  ListResponse,
  ManagedAgentsConfig,
  AgentEvent,
} from "./types.js";
import type { AcpStreamEvent } from "./acp-client.js";
import { AcpClient } from "./acp-client.js";
import { ManagedAgentsClient } from "./managed-agents-client.js";

function isHarnessRuntime(config: ManagedAgentsConfig): boolean {
  return config.runtime === "harness";
}

function toMaSession(record: {
  id: string;
  agentId: string;
  environmentId?: string;
  status: string;
  createdAt: string;
  metadata?: Record<string, string>;
}): Session {
  return {
    id: record.id,
    object: "session",
    agent: record.agentId,
    environment_id: record.environmentId,
    title: record.metadata?.title ?? "",
    status: record.status as Session["status"],
    created_at: Math.floor(Date.parse(record.createdAt) / 1000) || Math.floor(Date.now() / 1000),
  };
}

function outboundToAgentEvent(record: {
  event: { type: string; session_id?: string; [key: string]: unknown };
  sessionId: string;
}): AgentEvent | null {
  const ev = record.event;
  if (!ev?.type) return null;
  const session_id = ev.session_id ?? record.sessionId;
  return { ...ev, session_id } as AgentEvent;
}

function maEventToAcpStream(record: {
  event: { type: string; [key: string]: unknown };
}): AcpStreamEvent | null {
  const ev = record.event;
  if (!ev?.type) return null;
  if (ev.type === "session.message" && typeof ev.text === "string") {
    return { type: "chunk", text: ev.text };
  }
  if (ev.type === "session.status_idle") {
    return { type: "done", stopReason: "end_turn" };
  }
  if (ev.type === "session.status_terminated") {
    return { type: "done", stopReason: "end_turn" };
  }
  return null;
}

export class SessionsResource {
  private acp?: AcpClient;
  private ma?: ManagedAgentsClient;
  private initialized = false;

  constructor(private config: ManagedAgentsConfig) {
    if (isHarnessRuntime(config)) {
      this.ma = new ManagedAgentsClient(config);
    } else {
      this.acp = new AcpClient(config);
    }
  }

  private async ensureInit() {
    if (!this.initialized && this.acp) {
      await this.acp.initialize();
      this.initialized = true;
    }
  }

  async create(params: CreateSessionParams = {}): Promise<Session> {
    if (this.ma) {
      if (!params.agent) {
        throw new Error("sessions.create() requires params.agent (Managed Agents agent id)");
      }
      const record = await this.ma.createSession({
        agentId: params.agent,
        environmentId: params.environment_id,
      });
      return toMaSession(record);
    }
    await this.ensureInit();
    const { sessionId } = await this.acp!.sessionNew(params.cwd ?? "/");
    return {
      id: sessionId,
      object: "session",
      agent: params.agent ?? "",
      environment_id: params.environment_id,
      title: params.title ?? "",
      status: "idle",
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  async retrieve(sessionId: string): Promise<Session> {
    if (this.ma) {
      return toMaSession(await this.ma.getSession(sessionId));
    }
    await this.ensureInit();
    const detail = await this.acp!.getSession(sessionId);
    return {
      id: detail.sessionId,
      object: "session",
      agent: "",
      title: "",
      status: "idle",
      created_at: detail.createdAt,
    };
  }

  async list(): Promise<ListResponse<Session>> {
    if (this.ma) {
      throw new Error("sessions.list() is not supported by Managed Agents HTTP; use retrieve(sessionId)");
    }
    await this.ensureInit();
    const sessions = await this.acp!.sessionList();
    return {
      object: "list",
      has_more: false,
      data: sessions.map((s) => ({
        id: s.sessionId,
        object: "session" as const,
        agent: "",
        title: "",
        status: "idle" as const,
        created_at: s.createdAt,
      })),
    };
  }

  async delete(sessionId: string): Promise<{ id: string; deleted: boolean }> {
    if (this.ma) {
      return this.ma.deleteSession(sessionId);
    }
    await this.ensureInit();
    await this.acp!.deleteSession(sessionId);
    return { id: sessionId, deleted: true };
  }

  async resume(sessionId: string): Promise<{ sessionId: string }> {
    if (this.ma) {
      await this.ma.getSession(sessionId);
      return { sessionId };
    }
    await this.ensureInit();
    return this.acp!.sessionResume(sessionId);
  }

  async history(sessionId: string) {
    if (this.ma) {
      const session = await this.ma.getSession(sessionId);
      const events = await this.ma.listSessionEvents(sessionId);
      return {
        sessionId: session.id,
        model: "",
        system: "",
        messages: events
          .filter((e) => e.direction === "outbound")
          .map((e) => ({
            id: e.id,
            role: "assistant",
            content: JSON.stringify(e.event),
            timestamp: 0,
          })),
        createdAt: Math.floor(Date.parse(session.createdAt) / 1000),
        updatedAt: Math.floor(Date.parse(session.updatedAt) / 1000),
      };
    }
    await this.ensureInit();
    return this.acp!.getSession(sessionId);
  }

  prompt(sessionId: string, text: string): AsyncGenerator<AcpStreamEvent> {
    return this._prompt(sessionId, text);
  }

  private async *_prompt(sessionId: string, text: string): AsyncGenerator<AcpStreamEvent> {
    if (this.ma) {
      const stream = this.ma.streamSessionEvents(sessionId);
      const accepted = this.ma.sendSessionEvent(sessionId, {
        type: "user.message",
        commandId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        text,
      });
      for await (const record of stream) {
        const mapped = maEventToAcpStream(record);
        if (mapped) {
          yield mapped;
          if (mapped.type === "done") break;
        }
      }
      await accepted;
      return;
    }
    await this.ensureInit();
    yield* this.acp!.sessionPrompt(sessionId, text);
  }

  promptToolResult(
    sessionId: string,
    toolUseId: string,
    content: string,
    isError = false,
  ): AsyncGenerator<AcpStreamEvent> {
    return this._promptToolResult(sessionId, toolUseId, content, isError);
  }

  private async *_promptToolResult(
    sessionId: string,
    toolUseId: string,
    content: string,
    isError: boolean,
  ): AsyncGenerator<AcpStreamEvent> {
    if (this.ma) {
      yield* this._runMaTurn(sessionId, {
        type: "user.custom_tool_result",
        commandId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        serverId: "client",
        toolName: "client_tool",
        argumentsJson: content,
      });
      return;
    }
    await this.ensureInit();
    yield* this.acp!.sessionPromptToolResult(sessionId, toolUseId, content, isError);
  }

  promptPermission(
    sessionId: string,
    requestId: string,
    decision: "allow_once" | "reject_once",
  ): AsyncGenerator<AcpStreamEvent> {
    return this._promptPermission(sessionId, requestId, decision);
  }

  private async *_promptPermission(
    sessionId: string,
    requestId: string,
    decision: "allow_once" | "reject_once",
  ): AsyncGenerator<AcpStreamEvent> {
    if (this.ma) {
      yield* this._runMaTurn(sessionId, {
        type: "user.tool_confirmation",
        commandId: crypto.randomUUID(),
        requestId,
        decision,
      });
      return;
    }
    await this.ensureInit();
    yield* this.acp!.sessionPromptPermission(sessionId, requestId, decision);
  }

  private async *_runMaTurn(
    sessionId: string,
    inbound: Record<string, unknown>,
  ): AsyncGenerator<AcpStreamEvent> {
    const stream = this.ma!.streamSessionEvents(sessionId);
    const accepted = this.ma!.sendSessionEvent(sessionId, inbound);
    for await (const record of stream) {
      const mapped = maEventToAcpStream(record);
      if (mapped) {
        yield mapped;
        if (mapped.type === "done") break;
      }
    }
    await accepted;
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.ma) {
      await this.ma.sendSessionEvent(sessionId, {
        type: "user.interrupt",
        commandId: crypto.randomUUID(),
      });
      return;
    }
    await this.ensureInit();
    await this.acp!.sessionCancel(sessionId);
  }

  loadHistory(sessionId: string): AsyncGenerator<AcpStreamEvent> {
    return this._loadHistory(sessionId);
  }

  private async *_loadHistory(sessionId: string): AsyncGenerator<AcpStreamEvent> {
    if (this.ma) {
      const events = await this.ma.listSessionEvents(sessionId);
      for (const record of events) {
        const ev = outboundToAgentEvent(record);
        if (ev) {
          const mapped = maEventToAcpStream(record);
          if (mapped) yield mapped;
        }
      }
      return;
    }
    await this.ensureInit();
    yield* this.acp!.sessionLoad(sessionId);
  }
}
