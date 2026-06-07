/**
 * COS harness helpers — avoid racing TRW debounced sync (DEBOUNCE_MS=2s).
 * See tcb-remote-workspace/src/cos-sync.ts.
 */
import { setTimeout as sleep } from "node:timers/promises";

/** After workspace write, wait past debounce + typical first sync before manual snapshot. */
export const COS_POST_WRITE_SETTLE_MS = 8_000;

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
