/**
 * OpenCode serve /sync/* bridge: export events to CloudBase, replay on new sandbox.
 */

import { DEFAULT_HARNESS_SANDBOX_CWD } from "./deploy.js";
import { harnessLog } from "./logging.js";
import type { HarnessSandboxHandle } from "./sandbox/orchestrator.js";
import type { HarnessSyncEventStore, OpencodeSyncEventRow } from "./sync-event-store.js";

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
