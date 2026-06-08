/**
 * harness_sessions — harness runtime session index (D2 / E1).
 * Does not write oak_* collections.
 */

import type { HarnessEngine } from "../../config.js";
import { resolveCamControlPlaneCredentials } from "../harness-env.js";
import { generateHarnessSecretMasterKey } from "../session-secrets.js";
import { harnessTrace, harnessLog } from "../logging.js";

export const HARNESS_SESSIONS_COLLECTION = "harness_sessions";

export type HarnessSessionStatus = "pending" | "active" | "ended";

export interface HarnessSessionRecord {
  acpSessionId: string;
  userId: string;
  engine: HarnessEngine;
  status: HarnessSessionStatus;
  /** TRW secrets vault key; generated at session/new, stable across sandbox re-acquire. */
  secretMasterKey?: string;
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
  /** Drop sandbox binding after stop/delete; keeps engineSessionId for sync replay. */
  clearInstanceBinding(acpSessionId: string): Promise<void>;
  /** Backfill secretMasterKey for rows created before session-bound secrets. */
  ensureSecretMasterKey(acpSessionId: string): Promise<HarnessSessionRecord>;
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
      secretMasterKey: generateHarnessSecretMasterKey(),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(args.acpSessionId, row);
    return row;
  }

  async ensureSecretMasterKey(acpSessionId: string): Promise<HarnessSessionRecord> {
    const row = this.rows.get(acpSessionId);
    if (!row) throw new Error(`harness session not found: ${acpSessionId}`);
    if (row.secretMasterKey) return row;
    const updated = {
      ...row,
      secretMasterKey: generateHarnessSecretMasterKey(),
      updatedAt: Date.now(),
    };
    this.rows.set(acpSessionId, updated);
    return updated;
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

  async clearInstanceBinding(acpSessionId: string): Promise<void> {
    const row = this.rows.get(acpSessionId);
    if (!row) return;
    const { instanceId: _i, toolId: _t, ...rest } = row;
    this.rows.set(acpSessionId, { ...rest, updatedAt: Date.now() });
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
          region: this.credentials.region,
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
      secretMasterKey: generateHarnessSecretMasterKey(),
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

  async clearInstanceBinding(acpSessionId: string): Promise<void> {
    const database = await this.db();
    const cmd = (database as { command?: { remove: () => unknown } }).command;
    const collection = await this.col();
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (cmd?.remove) {
      patch.instanceId = cmd.remove();
      patch.toolId = cmd.remove();
    } else {
      patch.instanceId = "";
      patch.toolId = "";
    }
    await collection.doc(acpSessionId).update(patch);
    harnessTrace("session_store.clear_instance_binding", { acpSessionId });
  }

  async ensureSecretMasterKey(acpSessionId: string): Promise<HarnessSessionRecord> {
    const row = await this.get(acpSessionId);
    if (!row) throw new Error(`harness session not found: ${acpSessionId}`);
    if (row.secretMasterKey) return row;
    const secretMasterKey = generateHarnessSecretMasterKey();
    const updatedAt = Date.now();
    const collection = await this.col();
    await collection.doc(acpSessionId).update({ secretMasterKey, updatedAt });
    return { ...row, secretMasterKey, updatedAt };
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
  const cam = resolveCamControlPlaneCredentials();
  const secretId = cam.secretId;
  const secretKey = cam.secretKey;
  const sessionToken = cam.sessionToken;
  const region = process.env.TCB_REGION?.trim();
  if (!secretId || !secretKey || !region) return null;
  return {
    envId,
    secretId,
    secretKey,
    sessionToken,
    region,
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

/** Harness /healthz — session index driver, not OAK kernel store. */
export async function getHarnessStoreDiag(projectKey: string): Promise<{
  driver: "memory" | "cloudbase";
  collection: string;
  activeSessions: number;
}> {
  const useMemory =
    process.env.OAK_USE_MEMORY_STORE === "1" || !resolveCloudBaseCredentials(projectKey);
  const store = getHarnessSessionStore(projectKey);
  const sessions = await store.list({ limit: 100 });
  return {
    driver: useMemory ? "memory" : "cloudbase",
    collection: HARNESS_SESSIONS_COLLECTION,
    activeSessions: sessions.length,
  };
}

/** Test-only reset */
export function resetHarnessSessionStoreForTests(): void {
  _store = null;
}
