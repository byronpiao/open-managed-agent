/**
 * CloudBase FlexDB-backed Managed Agents store (Layer A).
 * Session id = acpSessionId (1:1 with harness_sessions).
 */

import { resolveCamControlPlaneCredentials } from "../../harness/harness-env.js";
import { harnessTrace } from "../../harness/logging.js";
import { projectDriverEventToCma } from "../vendor/projections-cma.js";
import type { DriverEventInput } from "../vendor/driver-event-types.js";
import { createCmaMemoryStore, CmaMemoryStore } from "../vendor/cma-memory-store.js";
import type {
  CmaAppendInboundEventInput,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaSessionEventRecord,
  CmaStore,
} from "../vendor/cma-store-types.js";
import {
  MANAGED_AGENTS_AGENTS_COLLECTION,
  MANAGED_AGENTS_ENVIRONMENTS_COLLECTION,
  MANAGED_AGENTS_SESSION_EVENTS_COLLECTION,
  MANAGED_AGENTS_SESSIONS_COLLECTION,
  MANAGED_AGENTS_SESSION_EVENTS_PAGE_SIZE,
  MANAGED_AGENTS_SSE_POLL_MS,
} from "./managed-agents-collections.js";

interface CloudBaseCredentials {
  envId: string;
  secretId: string;
  secretKey: string;
  sessionToken?: string;
  region?: string;
}

type CloudBaseDatabase = {
  collection(name: string): {
    add(data: Record<string, unknown>): Promise<unknown>;
    doc(id: string): { set(data: Record<string, unknown>): Promise<unknown>; get(): Promise<{ data?: unknown }> };
    where(query: Record<string, unknown>): {
      orderBy(field: string, direction: "asc" | "desc"): {
        limit(n: number): { get(): Promise<{ data?: unknown[] }> };
        skip(n: number): { limit(n: number): { get(): Promise<{ data?: unknown[] }> } };
      };
      limit(n: number): { get(): Promise<{ data?: unknown[] }> };
    };
  };
  createCollection(name: string): Promise<unknown>;
};

interface CmaSessionEventRow {
  id: string;
  sessionId: string;
  seq: number;
  direction: "inbound" | "outbound";
  event: unknown;
  command: unknown;
  commandResult: unknown;
  driverEvent: unknown;
  createdAt: string;
}

export class CloudBaseManagedAgentsStore implements CmaStore {
  readonly #memory: CmaMemoryStore;
  #dbPromise: Promise<CloudBaseDatabase> | null = null;
  readonly #collectionsReady = new Set<string>();

  constructor() {
    this.#memory = createCmaMemoryStore();
  }

  #credentials(): CloudBaseCredentials | null {
    const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
    if (!envId) return null;
    const cred = resolveCamControlPlaneCredentials();
    if (!cred.secretId || !cred.secretKey) return null;
    return {
      envId,
      secretId: cred.secretId,
      secretKey: cred.secretKey,
      sessionToken: cred.sessionToken,
    };
  }

  async #db(): Promise<CloudBaseDatabase | null> {
    const cred = this.#credentials();
    if (!cred) return null;
    if (!this.#dbPromise) {
      this.#dbPromise = (async () => {
        const mod = await import("@cloudbase/node-sdk");
        const app = mod.default.init({
          env: cred.envId,
          secretId: cred.secretId,
          secretKey: cred.secretKey,
          sessionToken: cred.sessionToken,
          region: cred.region,
        });
        return app.database() as CloudBaseDatabase;
      })();
    }
    return this.#dbPromise;
  }

  async #ensureCollection(name: string): Promise<CloudBaseDatabase | null> {
    const db = await this.#db();
    if (!db) return null;
    if (this.#collectionsReady.has(name)) return db;
    try {
      await db.createCollection(name);
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      if (!/exist|already/i.test(msg)) {
        harnessTrace("managed_agents_store.create_collection", { collection: name, error: msg });
      }
    }
    this.#collectionsReady.add(name);
    return db;
  }

  async #maxSeq(sessionId: string): Promise<number> {
    const db = await this.#ensureCollection(MANAGED_AGENTS_SESSION_EVENTS_COLLECTION);
    if (!db) return 0;
    const res = await db
      .collection(MANAGED_AGENTS_SESSION_EVENTS_COLLECTION)
      .where({ sessionId })
      .orderBy("seq", "desc")
      .limit(1)
      .get();
    const rows = (res.data ?? []) as CmaSessionEventRow[];
    return rows.length ? rows[0]!.seq : 0;
  }

  async #persistEvent(record: CmaSessionEventRecord): Promise<void> {
    const db = await this.#ensureCollection(MANAGED_AGENTS_SESSION_EVENTS_COLLECTION);
    if (!db) return;
    const seq = await this.#maxSeq(record.sessionId);
    const row: CmaSessionEventRow = {
      id: record.id,
      sessionId: record.sessionId,
      seq: seq + 1,
      direction: record.direction,
      event: record.event,
      command: record.command,
      commandResult: record.commandResult,
      driverEvent: record.driverEvent,
      createdAt: record.createdAt,
    };
    try {
      await db.collection(MANAGED_AGENTS_SESSION_EVENTS_COLLECTION).doc(record.id).set({ ...row });
    } catch {
      await db.collection(MANAGED_AGENTS_SESSION_EVENTS_COLLECTION).add({ ...row });
    }
  }

  async #listPersistedEvents(sessionId: string, afterSeq = 0): Promise<CmaSessionEventRow[]> {
    const db = await this.#ensureCollection(MANAGED_AGENTS_SESSION_EVENTS_COLLECTION);
    if (!db) return [];
    const out: CmaSessionEventRow[] = [];
    let skip = 0;
    for (;;) {
      const res = await db
        .collection(MANAGED_AGENTS_SESSION_EVENTS_COLLECTION)
        .where({ sessionId })
        .orderBy("seq", "asc")
        .skip(skip)
        .limit(MANAGED_AGENTS_SESSION_EVENTS_PAGE_SIZE)
        .get();
      const page = (res.data ?? []) as CmaSessionEventRow[];
      if (!page.length) break;
      for (const row of page) {
        if (row.seq > afterSeq) out.push(row);
      }
      if (page.length < MANAGED_AGENTS_SESSION_EVENTS_PAGE_SIZE) break;
      skip += page.length;
    }
    return out;
  }

  #rowToRecord(row: CmaSessionEventRow): CmaSessionEventRecord {
    return {
      id: row.id,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      direction: row.direction,
      event: row.event as CmaSessionEventRecord["event"],
      command: row.command as CmaSessionEventRecord["command"],
      commandResult: row.commandResult as CmaSessionEventRecord["commandResult"],
      driverEvent: row.driverEvent as CmaSessionEventRecord["driverEvent"],
    };
  }

  // ── CmaStore delegation: metadata CRUD via memory (FlexDB mirror optional later) ──

  appendDriverEvent(sessionId: string, driverEvent: DriverEventInput) {
    return this.#memory.appendDriverEvent(sessionId, driverEvent).then(async (records) => {
      for (const record of records) {
        await this.#persistEvent(record);
      }
      return records;
    });
  }

  appendInboundEvent(input: CmaAppendInboundEventInput) {
    return this.#memory.appendInboundEvent(input).then(async (record) => {
      await this.#persistEvent(record);
      return record;
    });
  }

  archiveEnvironment(id: string) {
    return this.#memory.archiveEnvironment(id);
  }

  async createAgent(input: CmaCreateAgentInput) {
    const agent = await this.#memory.createAgent(input);
    const db = await this.#ensureCollection(MANAGED_AGENTS_AGENTS_COLLECTION);
    if (db) {
      await db.collection(MANAGED_AGENTS_AGENTS_COLLECTION).doc(agent.id).set({ ...agent });
    }
    return agent;
  }

  async createEnvironment(input: CmaCreateEnvironmentInput) {
    const environment = await this.#memory.createEnvironment(input);
    const db = await this.#ensureCollection(MANAGED_AGENTS_ENVIRONMENTS_COLLECTION);
    if (db) {
      await db.collection(MANAGED_AGENTS_ENVIRONMENTS_COLLECTION).doc(environment.id).set({ ...environment });
    }
    return environment;
  }

  async createSession(input: CmaCreateSessionInput) {
    const session = await this.#memory.createSession(input);
    const db = await this.#ensureCollection(MANAGED_AGENTS_SESSIONS_COLLECTION);
    if (db) {
      await db.collection(MANAGED_AGENTS_SESSIONS_COLLECTION).doc(session.id).set({ ...session });
    }
    return session;
  }

  deleteEnvironment(id: string) {
    return this.#memory.deleteEnvironment(id);
  }

  getAgent(id: string) {
    return this.#memory.getAgent(id);
  }

  getEnvironment(id: string) {
    return this.#memory.getEnvironment(id);
  }

  getSession(id: string) {
    return this.#memory.getSession(id);
  }

  listAgents() {
    return this.#memory.listAgents();
  }

  listEnvironments() {
    return this.#memory.listEnvironments();
  }

  async listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]> {
    const persisted = await this.#listPersistedEvents(sessionId);
    if (persisted.length) {
      return persisted.map((row) => this.#rowToRecord(row));
    }
    return this.#memory.listSessionEvents(sessionId);
  }

  /**
   * SCF multi-instance: replay FlexDB history then poll for new rows (no in-memory-only SSE).
   */
  async *watchSessionEvents(sessionId: string): AsyncIterable<CmaSessionEventRecord> {
    let lastSeq = 0;
    const initial = await this.#listPersistedEvents(sessionId);
    for (const row of initial) {
      lastSeq = row.seq;
      yield this.#rowToRecord(row);
    }

    for (;;) {
      const session = await this.getSession(sessionId);
      const polled = await this.#listPersistedEvents(sessionId, lastSeq);
      for (const row of polled) {
        lastSeq = row.seq;
        yield this.#rowToRecord(row);
      }
      if (session?.status === "terminated") return;
      await new Promise((r) => setTimeout(r, MANAGED_AGENTS_SSE_POLL_MS));
    }
  }
}
