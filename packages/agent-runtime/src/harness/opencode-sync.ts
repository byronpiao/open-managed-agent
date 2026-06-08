/**
 * OpenCode serve /sync/* bridge: export events to CloudBase, replay on new sandbox.
 */

import type { AgentConfig } from "../config.js";
import { resolveRuntime } from "../config.js";
import { DEFAULT_HARNESS_SANDBOX_CWD } from "./deploy.js";
import { harnessLog } from "./logging.js";
import { isE2eStubSandboxEnabled } from "./sandbox/e2e-stub.js";
import { getCachedSandboxHandle } from "./sandbox/orchestrator.js";
import { getHarnessSessionStore } from "./sandbox/session-store.js";
import type { HarnessSandboxHandle } from "./sandbox/orchestrator.js";
import { getHarnessSyncEventStore } from "./sync-event-store.js";
import type { HarnessSyncEventStore, OpencodeSyncEventRow } from "./sync-event-store.js";

/** Backoff between export retries (initial attempt has no leading delay). */
const EXPORT_RETRY_DELAYS_MS = [0, 500, 1500] as const;

export type OpencodeSyncExportReason = "prompt_end" | "idle_pause" | "session_delete";

const OPENCODE_SERVE_PREFIX = "/api/agents/opencode";
const OPENCODE_DIRECTORY_HEADER = "x-opencode-directory";
const OPENCODE_READY_POLL_MS = 2_000;
const OPENCODE_READY_TIMEOUT_MS = 90_000;

interface OpencodeHealthBody {
  ok?: boolean;
  acpReady?: boolean;
  serveReady?: boolean;
}

async function waitOpencodeServeReady(handle: HarnessSandboxHandle): Promise<void> {
  const deadline = Date.now() + OPENCODE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await handle.request(`${OPENCODE_SERVE_PREFIX}/health`);
      const body = (await res.json()) as OpencodeHealthBody;
      if (res.status === 200 && body.ok && body.acpReady && body.serveReady) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, OPENCODE_READY_POLL_MS));
  }
  throw new Error("opencode serve+acp not ready for sync");
}

export const OPENCODE_SYNC_DIRECTORY = DEFAULT_HARNESS_SANDBOX_CWD;

interface RawHistoryEvent {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

function toRow(raw: RawHistoryEvent): OpencodeSyncEventRow {
  return {
    id: raw.id,
    aggregateId: raw.aggregate_id,
    seq: raw.seq,
    type: raw.type,
    data: raw.data ?? {},
  };
}

function toReplayPayload(events: OpencodeSyncEventRow[]) {
  return events.map((ev) => ({
    id: ev.id,
    aggregateID: ev.aggregateId,
    seq: ev.seq,
    type: ev.type,
    data: ev.data,
  }));
}

async function opencodeServeJson<T>(
  handle: HarnessSandboxHandle,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await handle.request(`${OPENCODE_SERVE_PREFIX}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [OPENCODE_DIRECTORY_HEADER]: OPENCODE_SYNC_DIRECTORY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`opencode sync ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

/** Best-effort: start opencode workspace sync loops before /sync/history. */
export async function ensureOpencodeSyncStarted(
  handle: HarnessSandboxHandle,
): Promise<void> {
  try {
    await opencodeServeJson<boolean>(handle, "/sync/start", {});
  } catch (err) {
    harnessLog({ lane: "opencode_sync", operation: "sync.start" }).error(err);
  }
}

/** Attach session to workspace sync plane (required before events appear in /sync/history). */
export async function stealOpencodeSessionForSync(
  handle: HarnessSandboxHandle,
  sessionId: string,
): Promise<void> {
  try {
    await opencodeServeJson<{ sessionID: string }>(handle, "/sync/steal", {
      sessionID: sessionId,
    });
  } catch (err) {
    harnessLog({
      lane: "opencode_sync",
      operation: "sync.steal",
      aggregateId: sessionId,
    }).error(err);
  }
}

/** Incremental pull from sandbox opencode serve. */
export async function fetchOpencodeSyncHistory(
  handle: HarnessSandboxHandle,
  cursor: Record<string, number>,
): Promise<OpencodeSyncEventRow[]> {
  await ensureOpencodeSyncStarted(handle);
  const raw = await opencodeServeJson<RawHistoryEvent[]>(
    handle,
    "/sync/history",
    cursor,
  );
  return raw.map(toRow);
}

/** Replay events into sandbox opencode serve (hydrate local SQLite). */
export async function replayOpencodeSyncEvents(
  handle: HarnessSandboxHandle,
  events: OpencodeSyncEventRow[],
): Promise<{ sessionID: string }> {
  if (!events.length) {
    throw new Error("replayOpencodeSyncEvents: no events");
  }
  return opencodeServeJson<{ sessionID: string }>(handle, "/sync/replay", {
    directory: OPENCODE_SYNC_DIRECTORY,
    events: toReplayPayload(events),
  });
}

/** Pull new events from sandbox and persist to harness_sync_events. */
export async function exportOpencodeSyncEvents(args: {
  handle: HarnessSandboxHandle;
  syncStore: HarnessSyncEventStore;
  acpSessionId: string;
  aggregateId: string;
}): Promise<{ pulled: number; inserted: number }> {
  const wl = harnessLog({
    lane: "opencode_sync",
    operation: "export",
    acpSessionId: args.acpSessionId,
    aggregateId: args.aggregateId,
  });
  const startedAt = Date.now();
  try {
    await waitOpencodeServeReady(args.handle);
    const lastSeq = await args.syncStore.maxSeqForAggregate(args.aggregateId);
    const cursor =
      lastSeq > 0 ? { [args.aggregateId]: lastSeq } : ({} as Record<string, number>);

    await stealOpencodeSessionForSync(args.handle, args.aggregateId);

    let pulled: OpencodeSyncEventRow[] = [];
    let forAggregate: OpencodeSyncEventRow[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      pulled = await fetchOpencodeSyncHistory(args.handle, cursor);
      forAggregate = pulled.filter((e) => e.aggregateId === args.aggregateId);
      if (forAggregate.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const { inserted } = await args.syncStore.appendEvents({
      acpSessionId: args.acpSessionId,
      aggregateId: args.aggregateId,
      events: forAggregate,
    });
    wl.emit({
      status: "ok",
      durationMs: Date.now() - startedAt,
      pulled: forAggregate.length,
      inserted,
      lastSeq,
    });
    return { pulled: forAggregate.length, inserted };
  } catch (err) {
    wl.error(err);
    wl.emit({ status: "error", durationMs: Date.now() - startedAt });
    throw err;
  }
}

/** Replay CloudBase events into a fresh sandbox before ACP session/load. */
export async function hydrateOpencodeSyncEvents(args: {
  handle: HarnessSandboxHandle;
  syncStore: HarnessSyncEventStore;
  acpSessionId: string;
  aggregateId: string;
}): Promise<{ replayed: number }> {
  const wl = harnessLog({
    lane: "opencode_sync",
    operation: "hydrate",
    acpSessionId: args.acpSessionId,
    aggregateId: args.aggregateId,
  });
  const startedAt = Date.now();
  try {
    const events = await args.syncStore.listEventsForAggregate(args.aggregateId);
    if (!events.length) {
      wl.emit({ status: "skip", reason: "no_events", durationMs: Date.now() - startedAt });
      return { replayed: 0 };
    }
    await waitOpencodeServeReady(args.handle);
    await ensureOpencodeSyncStarted(args.handle);
    try {
      await replayOpencodeSyncEvents(args.handle, events);
      wl.emit({
        status: "ok",
        durationMs: Date.now() - startedAt,
        replayed: events.length,
      });
      return { replayed: events.length };
    } catch (replayErr) {
      wl.error(replayErr);
      wl.emit({
        status: "replay_failed",
        durationMs: Date.now() - startedAt,
        replayed: 0,
      });
      return { replayed: 0 };
    }
  } catch (err) {
    wl.error(err);
    wl.emit({ status: "error", durationMs: Date.now() - startedAt });
    throw err;
  }
}

function envIdFromProcess(): string {
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
  if (!envId) {
    throw new Error("CLOUDBASE_ENV_ID is required for opencode sync export");
  }
  return envId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Export opencode sync events with retries; updates harness_sessions.syncExportFailedAt on failure.
 */
export async function persistOpencodeSyncForSession(args: {
  acpSessionId: string;
  config: AgentConfig;
  reason: OpencodeSyncExportReason;
}): Promise<{ ok: boolean; inserted?: number }> {
  const wl = harnessLog({
    lane: "opencode_sync",
    operation: "persist",
    acpSessionId: args.acpSessionId,
    reason: args.reason,
  });
  const startedAt = Date.now();

  const { engine } = resolveRuntime(args.config);
  if (engine !== "opencode" || isE2eStubSandboxEnabled(args.config)) {
    wl.emit({ status: "skip", durationMs: Date.now() - startedAt });
    return { ok: true };
  }

  const envId = envIdFromProcess();
  const sessionStore = getHarnessSessionStore(envId);
  const row = await sessionStore.get(args.acpSessionId);
  if (!row?.engineSessionId) {
    wl.emit({ status: "skip", detail: "no_engine_session", durationMs: Date.now() - startedAt });
    return { ok: true };
  }

  const handle = getCachedSandboxHandle(args.acpSessionId);
  if (!handle) {
    wl.emit({ status: "skip", detail: "no_sandbox_handle", durationMs: Date.now() - startedAt });
    return { ok: true };
  }

  const syncStore = getHarnessSyncEventStore(envId);
  let lastErr: unknown;

  for (let attempt = 0; attempt < EXPORT_RETRY_DELAYS_MS.length; attempt++) {
    const delay = EXPORT_RETRY_DELAYS_MS[attempt]!;
    if (delay > 0) await sleep(delay);
    try {
      const { inserted } = await exportOpencodeSyncEvents({
        handle,
        syncStore,
        acpSessionId: args.acpSessionId,
        aggregateId: row.engineSessionId,
      });
      await sessionStore.setSyncExportFailedAt(args.acpSessionId, undefined);
      wl.emit({
        status: "ok",
        attempt: attempt + 1,
        inserted,
        durationMs: Date.now() - startedAt,
      });
      return { ok: true, inserted };
    } catch (err) {
      lastErr = err;
      wl.error(err);
      wl.emit({
        status: "retry",
        attempt: attempt + 1,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const failedAt = Date.now();
  await sessionStore.setSyncExportFailedAt(args.acpSessionId, failedAt).catch((markErr) => {
    wl.error(markErr);
  });
  wl.emit({
    status: "error",
    syncExportFailedAt: failedAt,
    durationMs: Date.now() - startedAt,
  });
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("persistOpencodeSyncForSession failed");
}

/** TRW workspace snapshot (COS) when mount is configured. */
export async function snapshotWorkspaceIfAvailable(
  handle: HarnessSandboxHandle,
): Promise<{ ok: boolean; skipped?: boolean }> {
  const wl = harnessLog({ lane: "opencode_sync", operation: "workspace.snapshot" });
  const startedAt = Date.now();
  try {
    const res = await handle.request("/api/workspace/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.status === 200) {
      wl.emit({ status: "ok", durationMs: Date.now() - startedAt });
      return { ok: true };
    }
    const body = (await res.text()).slice(0, 200);
    wl.emit({
      status: "skip",
      httpStatus: res.status,
      detail: body,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, skipped: true };
  } catch (err) {
    wl.error(err);
    wl.emit({ status: "error", durationMs: Date.now() - startedAt });
    return { ok: false, skipped: true };
  }
}
