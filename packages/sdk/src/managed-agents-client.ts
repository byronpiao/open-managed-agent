/**
 * Claude Managed Agents HTTP client.
 */

import type { ManagedAgentsConfig } from "./types.js";

export const MANAGED_AGENTS_BETA_HEADER_NAME = "anthropic-beta";
export const MANAGED_AGENTS_BETA_HEADER_VALUE = "managed-agents-2026-04-01";

export interface ManagedAgentsAgentRecord {
  id: string;
  name: string;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedAgentsEnvironmentRecord {
  id: string;
  name: string;
  config: Record<string, unknown>;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ManagedAgentsSessionRecord {
  id: string;
  agentId: string;
  environmentId?: string;
  status: "idle" | "running" | "terminated";
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedAgentsSessionEventRecord {
  id: string;
  sessionId: string;
  seq: number;
  direction: "inbound" | "outbound";
  event: { type: string; session_id?: string; [key: string]: unknown };
  command: unknown;
  commandResult: unknown;
  driverEvent: unknown;
  createdAt: string;
}

export interface ManagedAgentsInboundUserMessage {
  type: "user.message";
  commandId: string;
  requestId: string;
  runId: string;
  text: string;
  attachmentIds?: string[];
}

export interface ManagedAgentsInboundToolConfirmation {
  type: "user.tool_confirmation";
  commandId: string;
  requestId: string;
  decision: "allow_once" | "reject_once";
}

export type ManagedAgentsInboundEvent =
  | ManagedAgentsInboundUserMessage
  | ManagedAgentsInboundToolConfirmation
  | Record<string, unknown>;

export class ManagedAgentsClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ManagedAgentsConfig) {
    const root = (config.baseURL ??
      `https://${config.envId}.api.tcloudbasegateway.com/v1/aibot/bots/${config.agentId}`).replace(
      /\/$/,
      "",
    );
    this.baseUrl = `${root}/v1`;
    this.headers = {
      "Content-Type": "application/json",
      [MANAGED_AGENTS_BETA_HEADER_NAME]: MANAGED_AGENTS_BETA_HEADER_VALUE,
      ...(config.accessKey ? { Authorization: `Bearer ${config.accessKey}` } : {}),
      ...(config.envId ? { "X-CloudBase-Env-Id": config.envId } : {}),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body as { error?: { message?: string; code?: string } };
      throw new Error(
        err.error?.message ??
          `Managed Agents HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    return (body as { data: T }).data;
  }

  createAgent(input: {
    name: string;
    metadata?: Record<string, string>;
  }): Promise<ManagedAgentsAgentRecord> {
    return this.request("/agents", { method: "POST", body: JSON.stringify(input) });
  }

  getAgent(id: string): Promise<ManagedAgentsAgentRecord> {
    return this.request(`/agents/${encodeURIComponent(id)}`);
  }

  listAgents(): Promise<ManagedAgentsAgentRecord[]> {
    return this.request("/agents", { method: "GET" });
  }

  createEnvironment(input: {
    name: string;
    config?: Record<string, unknown>;
    metadata?: Record<string, string>;
  }): Promise<ManagedAgentsEnvironmentRecord> {
    return this.request("/environments", { method: "POST", body: JSON.stringify(input) });
  }

  getEnvironment(id: string): Promise<ManagedAgentsEnvironmentRecord> {
    return this.request(`/environments/${encodeURIComponent(id)}`);
  }

  listEnvironments(): Promise<ManagedAgentsEnvironmentRecord[]> {
    return this.request("/environments", { method: "GET" });
  }

  createSession(input: {
    agentId: string;
    environmentId?: string;
  }): Promise<ManagedAgentsSessionRecord> {
    return this.request("/sessions", { method: "POST", body: JSON.stringify(input) });
  }

  getSession(id: string): Promise<ManagedAgentsSessionRecord> {
    return this.request(`/sessions/${encodeURIComponent(id)}`);
  }

  deleteSession(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  sendSessionEvent(sessionId: string, event: ManagedAgentsInboundEvent): Promise<unknown> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  listSessionEvents(sessionId: string): Promise<ManagedAgentsSessionEventRecord[]> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/events`, { method: "GET" });
  }

  async *streamSessionEvents(
    sessionId: string,
    options: { lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ManagedAgentsSessionEventRecord> {
    const headers: Record<string, string> = {
      ...this.headers,
      Accept: "text/event-stream",
    };
    if (options.lastEventId) headers["Last-Event-ID"] = options.lastEventId;

    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers,
      signal: options.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Managed Agents SSE failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length) {
            const record = JSON.parse(dataLines.join("\n")) as ManagedAgentsSessionEventRecord;
            yield record;
          }
          sep = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function createManagedAgentsClient(config: ManagedAgentsConfig): ManagedAgentsClient {
  return new ManagedAgentsClient(config);
}
