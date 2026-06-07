/**
 * COS harness helpers — manual snapshot (TRW snapshotNow) cancels debounced
 * sync and waits for in-flight idle; optional short settle for virtiofs only.
 * See tcb-remote-workspace/src/cos-sync.ts prepareForManualSnapshot.
 */
import { setTimeout as sleep } from "node:timers/promises";

/** Optional post-write delay before POST /api/workspace/snapshot (0 = rely on TRW idle wait + retry). */
export const COS_POST_WRITE_SETTLE_MS = 0;

export async function postWorkspaceSnapshot(handle, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 8;
  const intervalMs = opts.intervalMs ?? 3_000;
  let last = { status: 0, text: "" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await handle.request("/api/workspace/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    last = { status: res.status, text: await res.text() };
    if (res.status === 200) {
      return { ok: true, attempt, ...last, body: JSON.parse(last.text) };
    }
    const retryable =
      /in progress|zstd persist failed|retry shortly/i.test(last.text) && attempt < maxAttempts;
    if (!retryable) break;
    await sleep(intervalMs);
  }

  return { ok: false, ...last };
}
