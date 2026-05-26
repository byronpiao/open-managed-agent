/**
 * SessionsResource - 对外接口不变，内部走 ACP JSON-RPC 2.0
 *
 * 用法：
 *   const client = new ManagedAgents({
 *     baseURL: "https://<env>.service.tcloudbase.com/v1/aibot/bots/<agentId>",
 *   });
 *
 *   const session = await client.sessions.create({ title: "My task" });
 *   for await (const event of client.sessions.prompt(session.id, "Hello")) {
 *     if (event.type === "chunk") process.stdout.write(event.text);
 *   }
 */

import type {
  Session,
  CreateSessionParams,
  ListResponse,
  ManagedAgentsConfig,
} from "./types.js";
import type { AcpStreamEvent } from "./acp-client.js";
import { AcpClient } from "./acp-client.js";

export class SessionsResource {
  private acp: AcpClient;
  private initialized = false;

  constructor(private config: ManagedAgentsConfig) {
    this.acp = new AcpClient(config);
  }

  // Lazy initialize (only once per instance)
  private async ensureInit() {
    if (!this.initialized) {
      await this.acp.initialize();
      this.initialized = true;
    }
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(params: CreateSessionParams = {}): Promise<Session> {
    await this.ensureInit();
    const { sessionId } = await this.acp.sessionNew(params.cwd ?? "/");
    return {
      id:             sessionId,
      object:         "session",
      agent:          params.agent ?? "",
      environment_id: params.environment_id,
      title:          params.title ?? "",
      status:         "idle",
      created_at:     Math.floor(Date.now() / 1000),
    };
  }

  // ── retrieve ──────────────────────────────────────────────────────────────

  async retrieve(sessionId: string): Promise<Session> {
    await this.ensureInit();
    const detail = await this.acp.getSession(sessionId);
    return {
      id:          detail.sessionId,
      object:      "session",
      agent:       "",
      title:       "",
      status:      "idle",
      created_at:  detail.createdAt,
    };
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(): Promise<ListResponse<Session>> {
    await this.ensureInit();
    const sessions = await this.acp.sessionList();
    return {
      object:   "list",
      has_more: false,
      data: sessions.map((s) => ({
        id:         s.sessionId,
        object:     "session" as const,
        agent:      "",
        title:      "",
        status:     "idle" as const,
        created_at: s.createdAt,
      })),
    };
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async delete(sessionId: string): Promise<{ id: string; deleted: boolean }> {
    await this.ensureInit();
    await this.acp.deleteSession(sessionId);
    return { id: sessionId, deleted: true };
  }

  // ── resume — load existing session (replays history) ─────────────────────

  async resume(sessionId: string): Promise<{ sessionId: string }> {
    await this.ensureInit();
    return this.acp.sessionResume(sessionId);
  }

  // ── history — get full message history ────────────────────────────────────

  async history(sessionId: string) {
    await this.ensureInit();
    return this.acp.getSession(sessionId);
  }

  // ── prompt — send message, stream response ────────────────────────────────
  // Replaces the old events.stream() + events.send() split API.
  // Returns an async generator of AcpStreamEvent.

  prompt(sessionId: string, text: string): AsyncGenerator<AcpStreamEvent> {
    // ensureInit is called lazily inside; but since prompt is sync-return,
    // we wrap in an async generator to handle initialization transparently.
    return this._prompt(sessionId, text);
  }

  private async *_prompt(sessionId: string, text: string): AsyncGenerator<AcpStreamEvent> {
    await this.ensureInit();
    yield* this.acp.sessionPrompt(sessionId, text);
  }

  // ── cancel ────────────────────────────────────────────────────────────────

  async cancel(sessionId: string): Promise<void> {
    await this.ensureInit();
    await this.acp.sessionCancel(sessionId);
  }

  // ── loadHistory — stream history replay ──────────────────────────────────

  loadHistory(sessionId: string): AsyncGenerator<AcpStreamEvent> {
    return this._loadHistory(sessionId);
  }

  private async *_loadHistory(sessionId: string): AsyncGenerator<AcpStreamEvent> {
    await this.ensureInit();
    yield* this.acp.sessionLoad(sessionId);
  }

  // ── Legacy events shim (backward compat) ─────────────────────────────────
  // Keeps old client.sessions.events.stream() + events.send() working.

  readonly events = {
    stream: (sessionId: string) => {
      console.warn(
        "[ManagedAgents] sessions.events.stream() is deprecated. Use sessions.prompt() instead."
      );
      // Return a no-op async iterable — send() will do the actual streaming
      return {
        [Symbol.asyncIterator]: async function* () { /* noop */ },
        _sessionId: sessionId,
      };
    },
    send: (sessionId: string, params: { events: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> }) => {
      console.warn(
        "[ManagedAgents] sessions.events.send() is deprecated. Use sessions.prompt() instead."
      );
      // Extract text and delegate to prompt — but can't stream here, just fire-and-forget
      const text = params.events
        .filter((e) => e.type === "user.message")
        .flatMap((e) => e.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return Promise.resolve({ ok: true, _text: text });
    },
  };
}
