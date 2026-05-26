import type {
  AgentEvent,
  SendEventsParams,
  ManagedAgentsConfig,
} from "./types.js";

export class EventStream implements AsyncIterable<AgentEvent> {
  private sessionId: string;
  private config: ManagedAgentsConfig;
  private controller: AbortController;

  constructor(sessionId: string, config: ManagedAgentsConfig) {
    this.sessionId = sessionId;
    this.config = config;
    this.controller = new AbortController();
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "text/event-stream" };
    if (this.config.accessKey) h["Authorization"] = `Bearer ${this.config.accessKey}`;
    if (this.config.envId) h["X-CloudBase-Env-Id"] = this.config.envId;
    return h;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    const res = await fetch(
      `${this.config.baseURL}/sessions/${this.sessionId}/events/stream`,
      { headers: this.headers, signal: this.controller.signal }
    );
    if (!res.ok || !res.body) {
      throw new Error(`Failed to connect to event stream: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;
            try {
              const event = JSON.parse(data) as AgentEvent;
              yield event;
              if (
                event.type === "session.status_idle" ||
                event.type === "session.status_terminated"
              ) {
                return;
              }
            } catch {
              // ignore parse errors on partial chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  abort(): void {
    this.controller.abort();
  }
}

export class EventsResource {
  constructor(private config: ManagedAgentsConfig) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.accessKey) h["Authorization"] = `Bearer ${this.config.accessKey}`;
    if (this.config.envId) h["X-CloudBase-Env-Id"] = this.config.envId;
    return h;
  }

  stream(sessionId: string): EventStream {
    return new EventStream(sessionId, this.config);
  }

  async send(sessionId: string, params: SendEventsParams): Promise<{ ok: boolean }> {
    const res = await fetch(
      `${this.config.baseURL}/sessions/${sessionId}/events`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(params),
      }
    );
    if (!res.ok) throw new Error(`Failed to send events: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ ok: boolean }>;
  }
}
