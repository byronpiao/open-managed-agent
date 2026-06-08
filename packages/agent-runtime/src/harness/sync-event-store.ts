/**
 * harness_sync_events — authoritative opencode sync event log (CloudBase or memory).
 */

import { resolveCamControlPlaneCredentials } from "./harness-env.js";
import { harnessLog, harnessTrace } from "./logging.js";

export const HARNESS_SYNC_EVENTS_COLLECTION = "harness_sync_events";

export interface OpencodeSyncEventRow {
  id: string;
  aggregateId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface HarnessSyncEventStore {
  appendEvents(args: {
    acpSessionId: string;
    aggregateId: string;
    events: OpencodeSyncEventRow[];
  }): Promise<{ inserted: number }>;
  listEventsForAggregate(aggregateId: string): Promise<OpencodeSyncEventRow[]>;
  maxSeqForAggregate(aggregateId: string): Promise<number>;
}

class InMemoryHarnessSyncEventStore implements HarnessSyncEventStore {
  private readonly rows = new Map<string, OpencodeSyncEventRow>();

  async appendEvents(args: {
    acpSessionId: string;
    aggregateId: string;
    events: OpencodeSyncEventRow[];
  }): Promise<{ inserted: number }> {
    void args.acpSessionId;
    let inserted = 0;
    for (const ev of args.events) {
      if (ev.aggregateId !== args.aggregateId) continue;
      if (this.rows.has(ev.id)) continue;
      this.rows.set(ev.id, ev);
      inserted++;
    }
    return { inserted };
  }

  async listEventsForAggregate(aggregateId: string): Promise<OpencodeSyncEventRow[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.aggregateId === aggregateId)
      .sort((a, b) => a.seq - b.seq);
  }

  async maxSeqForAggregate(aggregateId: string): Promise<number> {
    const rows = await this.listEventsForAggregate(aggregateId);
    return rows.length ? rows[rows.length - 1]!.seq : 0;
  }
}

interface CloudBaseCredentials {
  envId: string;
  secretId: string;
  secretKey: string;
  sessionToken?: string;
  region?: string;
}

interface CloudBaseDatabase {
  collection(name: string): CloudBaseCollection;
  createCollection(name: string): Promise<unknown>;
}

interface CloudBaseCollection {
  doc(id: string): CloudBaseDocRef;
  where(filter: Record<string, unknown>): CloudBaseQuery;
}

interface CloudBaseQuery {
  orderBy(field: string, direction: "asc" | "desc"): CloudBaseQuery;
  limit(n: number): CloudBaseQuery;
  get(): Promise<{ data: Array<Record<string, unknown>> }>;
}

interface CloudBaseDocRef {
  set(doc: Record<string, unknown>): Promise<unknown>;
  get(): Promise<{ data: Array<Record<string, unknown>> }>;
}

function rowFromDoc(doc: Record<string, unknown>): OpencodeSyncEventRow {
  return {
    id: String(doc.id),
    aggregateId: String(doc.aggregateId),
    seq: Number(doc.seq),
    type: String(doc.type),
    data: (doc.data as Record<string, unknown>) ?? {},
  };
}

class CloudBaseHarnessSyncEventStore implements HarnessSyncEventStore {
  private dbPromise: Promise<CloudBaseDatabase> | null = null;
  private collectionReady = false;

  constructor(
    private readonly projectKey: string,
    private readonly credentials: CloudBaseCredentials,
  ) {}

  private async db(): Promise<CloudBaseDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const mod = await import("@cloudbase/node-sdk");
        const app = mod.default.init({
          env: this.credentials.envId,
          secretId: this.credentials.secretId,
          secretKey: this.credentials.secretKey,
          sessionToken: this.credentials.sessionToken,
          region: this.credentials.region,
        });
        return app.database() as CloudBaseDatabase;
      })();
    }
    return this.dbPromise;
  }

  private async col() {
    if (!this.collectionReady) {
      const database = await this.db();
      try {
        await database.createCollection(HARNESS_SYNC_EVENTS_COLLECTION);
      } catch (err) {
        const msg = (err as Error)?.message ?? "";
        if (!/exist|already/i.test(msg)) {
          harnessTrace("sync_event_store.create_collection", { error: msg });
        }
      }
      this.collectionReady = true;
    }
    const d = await this.db();
    return d.collection(HARNESS_SYNC_EVENTS_COLLECTION);
  }

  async appendEvents(args: {
    acpSessionId: string;
    aggregateId: string;
    events: OpencodeSyncEventRow[];
  }): Promise<{ inserted: number }> {
    const collection = await this.col();
    let inserted = 0;
    for (const ev of args.events) {
      if (ev.aggregateId !== args.aggregateId) continue;
      const ref = collection.doc(ev.id);
      const existing = await ref.get();
      if (existing.data?.length) continue;
      await ref.set({
        projectKey: this.projectKey,
        acpSessionId: args.acpSessionId,
        aggregateId: ev.aggregateId,
        id: ev.id,
        seq: ev.seq,
        type: ev.type,
        data: ev.data,
        createdAt: Date.now(),
      });
      inserted++;
    }
    return { inserted };
  }

  async listEventsForAggregate(aggregateId: string): Promise<OpencodeSyncEventRow[]> {
    const collection = await this.col();
    const res = await collection
      .where({ projectKey: this.projectKey, aggregateId })
      .orderBy("seq", "asc")
      .limit(5000)
      .get();
    return (res.data ?? []).map((d) => rowFromDoc(d as Record<string, unknown>));
  }

  async maxSeqForAggregate(aggregateId: string): Promise<number> {
    const rows = await this.listEventsForAggregate(aggregateId);
    return rows.length ? rows[rows.length - 1]!.seq : 0;
  }
}

function resolveCloudBaseCredentials(envId: string): CloudBaseCredentials | null {
  const cam = resolveCamControlPlaneCredentials();
  const region = process.env.TCB_REGION?.trim();
  if (!cam.secretId || !cam.secretKey || !region) return null;
  return {
    envId,
    secretId: cam.secretId,
    secretKey: cam.secretKey,
    sessionToken: cam.sessionToken,
    region,
  };
}

let _syncStore: HarnessSyncEventStore | null = null;

export function getHarnessSyncEventStore(projectKey: string): HarnessSyncEventStore {
  if (_syncStore) return _syncStore;
  const useMemory =
    process.env.OAK_USE_MEMORY_STORE === "1" || !resolveCloudBaseCredentials(projectKey);
  if (useMemory) {
    _syncStore = new InMemoryHarnessSyncEventStore();
    harnessLog({
      lane: "sync_event_store",
      operation: "driver.init",
      driver: "memory",
    }).emit({ status: "ok" });
    return _syncStore;
  }
  const creds = resolveCloudBaseCredentials(projectKey)!;
  _syncStore = new CloudBaseHarnessSyncEventStore(projectKey, creds);
  harnessLog({
    lane: "sync_event_store",
    operation: "driver.init",
    driver: "cloudbase",
    collection: HARNESS_SYNC_EVENTS_COLLECTION,
  }).emit({ status: "ok" });
  return _syncStore;
}

export function resetHarnessSyncEventStoreForTests(): void {
  _syncStore = null;
}
