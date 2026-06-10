import type { AgentEvent, SendEventsParams, ManagedAgentsConfig } from "./types.js";
import {
  ManagedAgentsClient,
  type ManagedAgentsSessionEventRecord,
} from "./managed-agents-client.js";

function outboundToAgentEvent(record: ManagedAgentsSessionEventRecord): AgentEvent | null {
  const ev = record.event;
  if (!ev?.type) return null;
  const session_id = ev.session_id ?? record.sessionId;
  return { ...ev, session_id } as AgentEvent;
}

export class EventStream implements AsyncIterable<AgentEvent> {
  private client: ManagedAgentsClient;
  private sessionId: string;

  constructor(sessionId: string, config: ManagedAgentsConfig) {
    this.sessionId = sessionId;
    this.client = new ManagedAgentsClient(config);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    for await (const record of this.client.streamSessionEvents(this.sessionId)) {
      const event = outboundToAgentEvent(record);
      if (!event) continue;
      yield event;
      if (
        event.type === "session.status_idle" ||
        event.type === "session.status_terminated"
      ) {
        return;
      }
    }
  }

  abort(): void {
    // stream ends when the async iterator is discarded
  }
}

export class EventsResource {
  private config: ManagedAgentsConfig;

  constructor(config: ManagedAgentsConfig) {
    this.config = config;
  }

  stream(sessionId: string): EventStream {
    return new EventStream(sessionId, this.config);
  }

  async send(sessionId: string, params: SendEventsParams): Promise<{ ok: boolean }> {
    const client = new ManagedAgentsClient(this.config);
    for (const event of params.events) {
      await client.sendSessionEvent(sessionId, {
        ...event,
        commandId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
      } as Record<string, unknown>);
    }
    return { ok: true };
  }
}
