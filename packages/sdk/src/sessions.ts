/**
 * SessionsResource — Managed Agents HTTP (/v1/sessions).
 */

import type {
  Session,
  CreateSessionParams,
  ListResponse,
  ManagedAgentsConfig,
  AgentEvent,
} from "./types.js";
import { ManagedAgentsClient } from "./managed-agents-client.js";

function toSession(record: {
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

export class SessionsResource {
  private client: ManagedAgentsClient;

  constructor(config: ManagedAgentsConfig) {
    this.client = new ManagedAgentsClient(config);
  }

  async create(params: CreateSessionParams = {}): Promise<Session> {
    if (!params.agent) {
      throw new Error("sessions.create() requires params.agent (Managed Agents agent id)");
    }
    const record = await this.client.createSession({
      agentId: params.agent,
      environmentId: params.environment_id,
    });
    return toSession(record);
  }

  async retrieve(sessionId: string): Promise<Session> {
    return toSession(await this.client.getSession(sessionId));
  }

  async list(): Promise<ListResponse<Session>> {
    throw new Error("sessions.list() is not supported by Managed Agents HTTP; use retrieve(sessionId)");
  }

  async delete(sessionId: string): Promise<{ id: string; deleted: boolean }> {
    return this.client.deleteSession(sessionId);
  }

  async resume(sessionId: string): Promise<{ sessionId: string }> {
    await this.client.getSession(sessionId);
    return { sessionId };
  }

  async history(sessionId: string) {
    const session = await this.client.getSession(sessionId);
    const events = await this.client.listSessionEvents(sessionId);
    return {
      sessionId: session.id,
      model: "",
      system: "",
      messages: events
        .filter((e) => e.direction === "outbound")
        .map((e) => ({ id: e.id, role: "assistant", content: JSON.stringify(e.event), timestamp: 0 })),
      createdAt: Math.floor(Date.parse(session.createdAt) / 1000),
      updatedAt: Math.floor(Date.parse(session.updatedAt) / 1000),
    };
  }

  prompt(sessionId: string, text: string): AsyncGenerator<AgentEvent> {
    return this._runTurn(sessionId, {
      type: "user.message",
      commandId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      text,
    });
  }

  promptToolResult(
    sessionId: string,
    _toolUseId: string,
    content: string,
    _isError = false,
  ): AsyncGenerator<AgentEvent> {
    return this._runTurn(sessionId, {
      type: "user.custom_tool_result",
      commandId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      serverId: "client",
      toolName: "client_tool",
      argumentsJson: content,
    });
  }

  promptPermission(
    sessionId: string,
    requestId: string,
    decision: "allow_once" | "reject_once",
  ): AsyncGenerator<AgentEvent> {
    return this._runTurn(sessionId, {
      type: "user.tool_confirmation",
      commandId: crypto.randomUUID(),
      requestId,
      decision,
    });
  }

  private async *_runTurn(
    sessionId: string,
    inbound: Record<string, unknown>,
  ): AsyncGenerator<AgentEvent> {
    const stream = this.client.streamSessionEvents(sessionId);
    const accepted = this.client.sendSessionEvent(sessionId, inbound);

    for await (const record of stream) {
      const agentEvent = outboundToAgentEvent(record);
      if (agentEvent) {
        yield agentEvent;
        if (
          agentEvent.type === "session.status_idle" ||
          agentEvent.type === "session.status_terminated"
        ) {
          break;
        }
      }
    }
    await accepted;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.client.sendSessionEvent(sessionId, {
      type: "user.interrupt",
      commandId: crypto.randomUUID(),
    });
  }

  loadHistory(sessionId: string): AsyncGenerator<AgentEvent> {
    return this._loadHistory(sessionId);
  }

  private async *_loadHistory(sessionId: string): AsyncGenerator<AgentEvent> {
    const events = await this.client.listSessionEvents(sessionId);
    for (const record of events) {
      const ev = outboundToAgentEvent(record);
      if (ev) yield ev;
    }
  }
}
