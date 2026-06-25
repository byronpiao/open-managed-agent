/**
 * Claude SessionStore ops probes — mirror opencode syncExportFailedAt observability.
 */

import type { AgentConfig } from "../../../config.js";
import { resolveRuntime } from "../../../config.js";
import { isE2eStubSandboxEnabled } from "../../sandbox/e2e-stub.js";
import { countHarnessClaudeSessionFootprint } from "./claude-session-probe.js";
import { harnessLog } from "../../observability/logging.js";
import { getHarnessSessionStore } from "../../sandbox/session-store.js";

const PROBE_DELAY_MS = 1500;

/** Ops threshold for long Claude sessions — no env override. */
export const CLAUDE_SESSION_ENTRY_WARN_THRESHOLD = 3000;

function envIdFromProcess(): string {
  return process.env.CLOUDBASE_ENV_ID?.trim() ?? process.env.TCB_ENV_ID?.trim() ?? "";
}

export function isClaudeEntryCountHigh(entries: number): boolean {
  return entries > CLAUDE_SESSION_ENTRY_WARN_THRESHOLD;
}

/** Update harness_sessions.claudeEntryCountHighAt from a known entry count. */
export async function noteClaudeSessionEntryCount(args: {
  acpSessionId: string;
  entries: number;
}): Promise<void> {
  const envId = envIdFromProcess();
  if (!envId) return;
  const store = getHarnessSessionStore(envId);
  if (isClaudeEntryCountHigh(args.entries)) {
    const flaggedAt = Date.now();
    await store.setClaudeEntryCountHighAt(args.acpSessionId, flaggedAt);
    harnessLog({
      lane: "claude_session",
      operation: "entry_high",
      acpSessionId: args.acpSessionId,
    }).emit({
      status: "warn",
      entries: args.entries,
      threshold: CLAUDE_SESSION_ENTRY_WARN_THRESHOLD,
      claudeEntryCountHighAt: flaggedAt,
    });
    return;
  }
  await store.setClaudeEntryCountHighAt(args.acpSessionId, undefined);
}

/** Record claude session/load warm outcome on harness_sessions (re-acquire path). */
export async function markClaudeWarmOutcome(args: {
  acpSessionId: string;
  ok: boolean;
}): Promise<void> {
  const envId = envIdFromProcess();
  if (!envId) return;
  const store = getHarnessSessionStore(envId);
  await store.setClaudeWarmFailedAt(
    args.acpSessionId,
    args.ok ? undefined : Date.now(),
  );
}

/**
 * After prompt_end, verify FlexDB has transcript entries (SDK append may trail SSE).
 * Sets harness_sessions.claudeStoreEmptyAt when still empty.
 */
export async function probeClaudeSessionStoreAfterPrompt(args: {
  acpSessionId: string;
  config: AgentConfig;
}): Promise<{ ok: boolean; entries: number }> {
  const { engine } = resolveRuntime(args.config);
  if (engine !== "claude" || isE2eStubSandboxEnabled(args.config)) {
    return { ok: true, entries: 0 };
  }

  const envId = envIdFromProcess();
  if (!envId) return { ok: true, entries: 0 };

  const store = getHarnessSessionStore(envId);
  const row = await store.get(args.acpSessionId);
  if (!row?.engineSessionId) return { ok: true, entries: 0 };

  const wl = harnessLog({
    lane: "claude_session",
    operation: "probe",
    acpSessionId: args.acpSessionId,
    engineSessionId: row.engineSessionId,
  });

  await new Promise((r) => setTimeout(r, PROBE_DELAY_MS));
  const footprint = await countHarnessClaudeSessionFootprint(row.engineSessionId);
  await noteClaudeSessionEntryCount({ acpSessionId: args.acpSessionId, entries: footprint.entries });
  if (footprint.entries > 0) {
    await store.setClaudeStoreEmptyAt(args.acpSessionId, undefined);
    wl.emit({
      status: "ok",
      entries: footprint.entries,
      messages: footprint.messages,
    });
    return { ok: true, entries: footprint.entries };
  }

  const failedAt = Date.now();
  await store.setClaudeStoreEmptyAt(args.acpSessionId, failedAt);
  wl.emit({ status: "empty", claudeStoreEmptyAt: failedAt });
  return { ok: false, entries: 0 };
}
