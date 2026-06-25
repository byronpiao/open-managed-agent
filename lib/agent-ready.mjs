// ── Agent readiness polling ──────────────────────────────────────────────────
// Reused across agent:create paths (scf / tcbr) to wait for the freshly-created
// agent resource to report "已就绪" via `tcb agent detail`. Mirrors the polling
// pattern used by tests/e2e-cli.mjs (5s interval, "已就绪" && !"未就绪" check).

import { runTcb } from "./tcb.mjs";
import { dim, green, yellow } from "./ui.mjs";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

/**
 * Whether `tcb agent detail` output shows the agent is ready.
 * Matches "已就绪" and rejects "未就绪" (which would otherwise be a false positive),
 * with an English "Ready" fallback for environments that localize the CLI output.
 */
export function isAgentReady(detailOutput) {
  const s = stripAnsi(detailOutput);
  return (s.includes("已就绪") && !s.includes("未就绪")) || /\bReady\b/i.test(s);
}

/**
 * Poll `tcb agent detail` until the agent reports ready or the timeout elapses.
 * Never throws — callers decide how to present a timeout.
 *
 * @param {{ envId: string, agentId: string, timeoutMs?: number, intervalMs?: number }} opts
 * @returns {Promise<{ ready: boolean, elapsedMs: number, lastOutput: string }>}
 */
export async function waitForAgentReady({
  envId,
  agentId,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 5000,
}) {
  const start = Date.now();
  let lastOutput = "";
  for (;;) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      return { ready: false, elapsedMs: elapsed, lastOutput };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      lastOutput = runTcb(["agent", "detail", agentId, "-e", envId], { timeout: 30000 });
    } catch {
      // detail call failed (agent may not be fully registered yet) → keep polling
      continue;
    }
    if (isAgentReady(lastOutput)) {
      return { ready: true, elapsedMs: Date.now() - start, lastOutput };
    }
  }
}

/**
 * Shared helper for the three create paths: prints a waiting line, polls, then
 * prints a success/timeout summary. Returns true if ready, false on timeout or
 * when polling was skipped (in which case the user is pointed at `agent:get`).
 *
 * @param {{ envId: string, agentId: string, wait?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<boolean>}
 */
export async function pollAndReportAgentReady({ envId, agentId, wait = true, timeoutMs }) {
  if (!wait) {
    console.log(dim(`  Check ready: magent agent:get -a ${agentId} -e ${envId}`));
    return false;
  }
  const minutes = Math.round((timeoutMs ?? 0) / 60000);
  console.log(dim(`  Waiting for agent ready (polling every 5s, up to ${minutes}m)...`));
  const { ready, elapsedMs } = await waitForAgentReady({ envId, agentId, timeoutMs });
  if (ready) {
    console.log(green(`  → Agent 就绪 ✓ (${Math.round(elapsedMs / 1000)}s)`));
    return true;
  }
  console.log(yellow(`  ⚠ Agent 仍在部署中,未在 ${minutes} 分钟内就绪`));
  console.log(dim(`    继续查看: magent agent:get -a ${agentId} -e ${envId}`));
  return false;
}
