import type {
  Session,
  CreateSessionParams,
  ListResponse,
  CloudbaseAgentsConfig,
} from "./types.js";
import { EventsResource } from "./events.js";

export class SessionsResource {
  readonly events: EventsResource;

  constructor(private config: CloudbaseAgentsConfig) {
    this.events = new EventsResource(config);
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    if (this.config.envId) h["X-CloudBase-Env-Id"] = this.config.envId;
    return h;
  }

  async create(params: CreateSessionParams): Promise<Session> {
    const res = await fetch(`${this.config.baseURL}/sessions`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Session>;
  }

  async retrieve(sessionId: string): Promise<Session> {
    const res = await fetch(`${this.config.baseURL}/sessions/${sessionId}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to retrieve session: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Session>;
  }

  async list(): Promise<ListResponse<Session>> {
    const res = await fetch(`${this.config.baseURL}/sessions`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to list sessions: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ListResponse<Session>>;
  }

  async delete(sessionId: string): Promise<{ id: string; deleted: boolean }> {
    const res = await fetch(`${this.config.baseURL}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to delete session: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ id: string; deleted: boolean }>;
  }
}
