/**
 * harness_sessions — harness runtime session index (D2 / E1).
 * Does not write oak_* collections.
 */

import type { HarnessEngine } from "../../config.js";
import { harnessTrace, harnessLog } from "../logging.js";

export const HARNESS_SESSIONS_COLLECTION = "harness_sessions";

export type HarnessSessionStatus = "pending" | "active" | "ended";

export interface HarnessSessionRecord {
  acpSessionId: string;
  userId: string;
  engine: HarnessEngine;
  status: HarnessSessionStatus;
  instanceId?: string;
  toolId?: string;
  engineSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HarnessSessionStore {
  create(args: {
    acpSessionId: string;
    userId: string;
    engine: HarnessEngine;
  }): Promise<HarnessSessionRecord>;
  get(acpSessionId: string): Promise<HarnessSessionRecord | null>;
  list(args: { limit?: number }): Promise<HarnessSessionRecord[]>;
  bindInstance(
    acpSessionId: string,
    patch: { instanceId: string; toolId: string; engineSessionId?: string },
  ): Promise<HarnessSessionRecord>;
  setEngineSessionId(acpSessionId: string, engineSessionId: string): Promise<void>;
  setStatus(acpSessionId: string, status: HarnessSessionStatus): Promise<void>;
  remove(acpSessionId: string): Promise<void>;
}

class InMemoryHarnessSessionStore implements HarnessSessionStore {
  private readonly rows = new Map<string, HarnessSessionRecord>();

  async create(args: {
    acpSessionId: string;
    userId: string;
    engine: HarnessEngine;
  }): Promise<HarnessSessionRecord> {
    const now = Date.now();
    const row: HarnessSessionRecord = {
      acpSessionId: args.acpSessionId,
      userId: args.userId,
      engine: args.engine,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(args.acpSessionId, row);
    return row;
  }

  async get(acpSessionId: string): Promise<HarnessSessionRecord | null> {
    return this.rows.get(acpSessionId) ?? null;
  }

  async list(args: { limit?: number }): Promise<HarnessSessionRecord[]> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    return Array.from(this.rows.values())
      .filter((r) => r.status !== "ended")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async bindInstance(
    acpSessionId: string,
    patch: { instanceId: string; toolId: string; engineSessionId?: string },
  ): Promise<HarnessSessionRecord> {
    const row = this.rows.get(acpSessionId);
    if (!row) throw new Error(`harness session not found: ${acpSessionId}`);
    const updated: HarnessSessionRecord = {
      ...row,
      instanceId: patch.instanceId,
      toolId: patch.toolId,
      engineSessionId: patch.engineSessionId ?? row.engineSessionId,
      status: "active",
      updatedAt: Date.now(),
    };
    this.rows.set(acpSessionId, updated);
    return updated;
  }

  async setEngineSessionId(acpSessionId: string, engineSessionId: string): Promise<void> {
    const row = this.rows.get(acpSessionId);
    if (!row) return;
    this.rows.set(acpSessionId, {
      ...row,
      engineSessionId,
      updatedAt: Date.now(),
    });
  }

  async setStatus(acpSessionId: string, status: HarnessSessionStatus): Promise<void> {
    const row = this.rows.get(acpSessionId);
    if (!row) return;
    this.rows.set(acpSessionId, { ...row, status, updatedAt: Date.now() });
  }

  async remove(acpSessionId: string): Promise<void> {
    this.rows.delete(acpSessionId);
  }
}

interface CloudBaseCredentials {
  envId: string;
  secretId: string;
  secretKey: string;
  sessionToken?: string;
  region?: string;
}

function recordFromCloudBaseDoc(doc: Record<string, unknown>): HarnessSessionRecord {
  const { _id: _ignoredId, projectKey: _ignoredPk, ...rest } = doc;
  return rest as unknown as HarnessSessionRecord;
}

class CloudBaseHarnessSessionStore implements HarnessSessionStore {
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
          region: this.credentials.region ?? "ap-shanghai",
        });
        return app.database() as CloudBaseDatabase;
      })();
    }
    return this.dbPromise;
  }

  private async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;
    const database = await this.db();
    try {
      await database.createCollection(HARNESS_SESSIONS_COLLECTION);
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      if (!/exist|already/i.test(msg)) {
        harnessTrace("session_store.create_collection", { error: msg });
      }
    }
    this.collectionReady = true;
  }

  private async col() {
    await this.ensureCollection();
    const d = await this.db();
    return d.collection(HARNESS_SESSIONS_COLLECTION);
  }

  async create(args: {
    acpSessionId: string;
    userId: string;
    engine: HarnessEngine;
  }): Promise<HarnessSessionRecord> {
    const now = Date.now();
    const row: HarnessSessionRecord = {
      acpSessionId: args.acpSessionId,
      userId: args.userId,
      engine: args.engine,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const collection = await this.col();
    await collection.doc(args.acpSessionId).set({
      ...row,
      projectKey: this.projectKey,
    });
    harnessLog({
      lane: "session_store",
      operation: "session.create",
      acpSessionId: args.acpSessionId,
      engine: args.engine,
      userId: args.userId,
    }).emit({ status: "ok" });
    return row;
  }

  async get(acpSessionId: string): Promise<HarnessSessionRecord | null> {
    const collection = await this.col();
    const res = await collection.doc(acpSessionId).get();
    const doc = res.data?.[0] as Record<string, unknown> | undefined;
    if (!doc) return null;
    return recordFromCloudBaseDoc(doc);
  }

  async list(args: { limit?: number }): Promise<HarnessSessionRecord[]> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const collection = await this.col();
    const res = await collection
      .where({ projectKey: this.projectKey })
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    return (res.data ?? [])
      .map((d) => recordFromCloudBaseDoc(d as Record<string, unknown>))
      .filter((r) => r.status !== "ended");
  }

  async bindInstance(
    acpSessionId: string,
    patch: { instanceId: string; toolId: string; engineSessionId?: string },
  ): Promise<HarnessSessionRecord> {
    const row = await this.get(acpSessionId);
    if (!row) throw new Error(`harness session not found: ${acpSessionId}`);
    const updatedAt = Date.now();
    const collection = await this.col();
    await collection.doc(acpSessionId).update({
      instanceId: patch.instanceId,
      toolId: patch.toolId,
      ...(patch.engineSessionId ? { engineSessionId: patch.engineSessionId } : {}),
      status: "active",
      updatedAt,
    });
    const updated = {
      ...row,
      instanceId: patch.instanceId,
      toolId: patch.toolId,
      engineSessionId: patch.engineSessionId ?? row.engineSessionId,
      status: "active" as const,
      updatedAt,
    };
    harnessLog({
      lane: "session_store",
      operation: "session.bind",
      acpSessionId,
      instanceId: patch.instanceId,
      toolId: patch.toolId,
    }).emit({ status: "ok" });
    return updated;
  }

  async setEngineSessionId(acpSessionId: string, engineSessionId: string): Promise<void> {
    const collection = await this.col();
    await collection.doc(acpSessionId).update({
      engineSessionId,
      updatedAt: Date.now(),
    });
    harnessTrace("session_store.engine_session_id", { acpSessionId, engineSessionId });
  }

  async setStatus(acpSessionId: string, status: HarnessSessionStatus): Promise<void> {
    const collection = await this.col();
    await collection.doc(acpSessionId).update({ status, updatedAt: Date.now() });
  }

  async remove(acpSessionId: string): Promise<void> {
    const collection = await this.col();
    await collection.doc(acpSessionId).remove();
  }
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
  update(doc: Record<string, unknown>): Promise<unknown>;
  remove(): Promise<unknown>;
  get(): Promise<{ data: Array<Record<string, unknown>> }>;
}

function resolveCloudBaseCredentials(envId: string): CloudBaseCredentials | null {
  const secretId =
    process.env.TCB_SECRET_ID ?? process.env.TENCENTCLOUD_SECRETID ?? "";
  const secretKey =
    process.env.TCB_SECRET_KEY ?? process.env.TENCENTCLOUD_SECRETKEY ?? "";
  const sessionToken =
    process.env.TCB_TOKEN ?? process.env.TENCENTCLOUD_SESSIONTOKEN ?? undefined;
  if (!secretId || !secretKey) return null;
  return {
    envId,
    secretId,
    secretKey,
    sessionToken,
    region: process.env.TCB_REGION ?? "ap-shanghai",
  };
}

let _store: HarnessSessionStore | null = null;

export function getHarnessSessionStore(projectKey: string): HarnessSessionStore {
  if (_store) return _store;
  const useMemory =
    process.env.OAK_USE_MEMORY_STORE === "1" || !resolveCloudBaseCredentials(projectKey);
  if (useMemory) {
    _store = new InMemoryHarnessSessionStore();
    harnessLog({ lane: "session_store", operation: "driver.init", driver: "memory" }).emit({
      status: "ok",
    });
    return _store;
  }
  const creds = resolveCloudBaseCredentials(projectKey)!;
  _store = new CloudBaseHarnessSessionStore(projectKey, creds);
  harnessLog({
    lane: "session_store",
    operation: "driver.init",
    driver: "cloudbase",
    collection: HARNESS_SESSIONS_COLLECTION,
  }).emit({ status: "ok" });
  return _store;
}

/** Test-only reset */
export function resetHarnessSessionStoreForTests(): void {
  _store = null;
}
