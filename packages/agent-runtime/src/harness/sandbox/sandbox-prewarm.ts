/**
 * Async sandbox prewarm on session/new + idle pause after inactivity.
 */

import type { AgentConfig } from "../../config.js";
import { resolveRuntime } from "../../config.js";
import { buildHarnessSandboxEnv } from "../deploy.js";
import { harnessLog } from "../observability/logging.js";
import { withActiveSpan } from "../telemetry/telemetry.js";
import { warmClaudeEngineSession } from "../engine/claude/claude-session-warm.js";
import { markClaudeWarmOutcome, noteClaudeSessionEntryCount } from "../engine/claude/claude-session-health.js";
import { countHarnessClaudeSessionFootprint } from "../engine/claude/claude-session-probe.js";
import { hydrateOpencodeSyncEvents, persistOpencodeSyncForSession } from "../engine/opencode/opencode-sync.js";
import { getHarnessSyncEventStore } from "../sync-event-store.js";
import {
  createE2eStubSandboxHandle,
  isE2eStubSandboxEnabled,
} from "./e2e-stub.js";
import {
  cacheSandboxHandle,
  getCachedSandboxHandle,
  getSandboxOrchestrator,
  type HarnessSandboxHandle,
} from "./orchestrator.js";
import { harnessCallbackBase } from "../callback-base.js";
import { resolveHarnessEnvId } from "../harness-env.js";
import { getHarnessSessionStore, type HarnessSessionRecord } from "./session-store.js";

const prewarmInflight = new Map<string, Promise<{ syncHydrated: number }>>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Agent config per ACP session — used for idle-pause opencode export. */
const sessionAgentConfigs = new Map<string, AgentConfig>();

function harnessEnvIdOrThrow(): string {
  try {
    return resolveHarnessEnvId();
  } catch (err) {
    throw Object.assign(new Error((err as Error).message), { rpcCode: -32000 });
  }
}

/** Default 20 min idle before pause; set HARNESS_SANDBOX_IDLE_PAUSE_MS=0 to disable. */
export function resolveHarnessSandboxIdlePauseMs(): number {
  const raw = process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS?.trim();
  if (raw === "0" || raw === "off" || raw === "false") return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return 20 * 60 * 1000;
}

async function hydrateEngineStateAfterBind(args: {
  handle: HarnessSandboxHandle;
  config: AgentConfig;
  record: HarnessSessionRecord;
  acpSessionId: string;
  envId: string;
}): Promise<number> {
  const { handle, config, record, acpSessionId, envId } = args;
  if (record.engine === "opencode" && record.engineSessionId) {
    const hydrated = await hydrateOpencodeSyncEvents({
      handle,
      syncStore: getHarnessSyncEventStore(envId),
      acpSessionId,
      aggregateId: record.engineSessionId,
    });
    return hydrated.replayed;
  }
  if (record.engine === "claude" && record.engineSessionId) {
    const warm = await warmClaudeEngineSession({
      handle,
      config,
      acpSessionId,
      engineSessionId: record.engineSessionId,
    });
    await markClaudeWarmOutcome({ acpSessionId, ok: warm.ok });
    if (warm.ok) {
      const footprint = await countHarnessClaudeSessionFootprint(record.engineSessionId);
      await noteClaudeSessionEntryCount({ acpSessionId, entries: footprint.entries });
    }
  }
  return 0;
}

/** Acquire (or stub) sandbox and bind to session — shared by prewarm and prompt path. */
export async function bindSandboxForSession(
  config: AgentConfig,
  acpSessionId: string,
): Promise<{ syncHydrated: number }> {
  sessionAgentConfigs.set(acpSessionId, config);
  const envId = harnessEnvIdOrThrow();
  const store = getHarnessSessionStore(envId);
  let record = await store.get(acpSessionId);
  if (!record) {
    throw Object.assign(new Error(`Session not found: ${acpSessionId}`), { rpcCode: -32602 });
  }
  if (!record.secretMasterKey) {
    record = await store.ensureSecretMasterKey(acpSessionId);
  }

  const existing = getCachedSandboxHandle(acpSessionId);
  if (existing) {
    await existing.resumeIfPaused();
    const token = existing.instanceAccessToken;
    if (token) {
      await store.setInstanceAccessToken(acpSessionId, token);
    }
    return { syncHydrated: 0 };
  }

  const callbackBase = harnessCallbackBase();
  const boundInstanceId = record.instanceId;
  const boundToolId = record.toolId;

  // SCF (and any cold host): reattach to FlexDB-bound AGS instance instead of
  // stopping it and starting a fresh box — required for Claude SessionStore continuity.
  if (boundInstanceId && boundToolId && !isE2eStubSandboxEnabled(config)) {
    try {
      const orchestrator = getSandboxOrchestrator();
      const reconnectEnv = buildHarnessSandboxEnv({
        config,
        engine: record.engine,
        clientToolCallbackBase: callbackBase,
        acpSessionId,
        secretMasterKey: record.secretMasterKey,
      });
      const handle = await orchestrator.connectToInstance(
        boundInstanceId,
        envId,
        boundToolId,
        reconnectEnv,
      );
      await handle.resumeIfPaused();
      const syncHydrated = await hydrateEngineStateAfterBind({
        handle,
        config,
        record,
        acpSessionId,
        envId,
      });
      await store.bindInstance(acpSessionId, {
        instanceId: handle.instanceId,
        toolId: handle.toolId,
        instanceAccessToken: handle.instanceAccessToken,
      });
      cacheSandboxHandle(acpSessionId, handle);
      scheduleIdlePause(acpSessionId);
      harnessLog({
        lane: "orchestrator",
        operation: "instance.reconnect",
        acpSessionId,
        instanceId: boundInstanceId,
      }).emit({ status: "ok" });
      return { syncHydrated };
    } catch (err) {
      harnessLog({
        lane: "orchestrator",
        operation: "instance.reconnect",
        acpSessionId,
        instanceId: boundInstanceId,
      }).error(err);
      harnessLog({
        lane: "orchestrator",
        operation: "instance.reconnect",
        acpSessionId,
        instanceId: boundInstanceId,
      }).emit({
        status: "warn",
        message: "reconnect failed; clearing binding and acquiring a new sandbox",
      });
      try {
        await getSandboxOrchestrator().stopInstanceForEnv(boundInstanceId, envId);
      } catch (stopErr) {
        harnessLog({
          lane: "orchestrator",
          operation: "stale_instance.stop",
          acpSessionId,
          instanceId: boundInstanceId,
        }).error(stopErr);
      }
      await store.clearInstanceBinding(acpSessionId);
      record = (await store.get(acpSessionId)) ?? record;
    }
  }

  let syncHydrated = 0;
  let handle;

  if (isE2eStubSandboxEnabled(config)) {
    handle = createE2eStubSandboxHandle(acpSessionId);
  } else {
    const orchestrator = getSandboxOrchestrator();
    handle = await orchestrator.acquire({
      envId,
      agentConfig: config,
      engine: record.engine,
      acpSessionId,
      instanceEnv: buildHarnessSandboxEnv({
        config,
        engine: record.engine,
        clientToolCallbackBase: callbackBase,
        acpSessionId,
        secretMasterKey: record.secretMasterKey,
      }),
    });
    syncHydrated = await hydrateEngineStateAfterBind({
      handle,
      config,
      record,
      acpSessionId,
      envId,
    });
    await store.bindInstance(acpSessionId, {
      instanceId: handle.instanceId,
      toolId: handle.toolId,
      instanceAccessToken: handle.instanceAccessToken,
    });
  }

  cacheSandboxHandle(acpSessionId, handle);
  scheduleIdlePause(acpSessionId);
  return { syncHydrated };
}

/** Fire-and-forget prewarm after session/new (no-op when stub or already bound). */
export function startSandboxPrewarm(config: AgentConfig, acpSessionId: string): void {
  if (isE2eStubSandboxEnabled(config)) return;
  if (getCachedSandboxHandle(acpSessionId)) return;
  if (prewarmInflight.has(acpSessionId)) return;

  const wl = harnessLog({
    lane: "sandbox",
    operation: "prewarm.start",
    acpSessionId,
  });
  const promise = withActiveSpan(
    "harness.prewarm",
    { acpSessionId, engine: config.engine ?? "unknown" },
    async () => bindSandboxForSession(config, acpSessionId),
  )
    .then((result) => {
      wl.emit({ status: "ok", syncHydrated: result.syncHydrated });
      return result;
    })
    .catch((err) => {
      wl.error(err);
      wl.emit({ status: "error" });
      throw err;
    })
    .finally(() => {
      prewarmInflight.delete(acpSessionId);
    });
  prewarmInflight.set(acpSessionId, promise);
  void promise;
}

/** Await in-flight prewarm before prompt/load (errors fall through to bind retry). */
export async function waitForSandboxPrewarm(acpSessionId: string): Promise<void> {
  const inflight = prewarmInflight.get(acpSessionId);
  if (!inflight) return;
  try {
    await inflight;
  } catch {
    // prompt path may retry via bindSandboxForSession
  }
}

export function clearSandboxPrewarmState(acpSessionId: string): void {
  prewarmInflight.delete(acpSessionId);
  sessionAgentConfigs.delete(acpSessionId);
  clearIdlePauseTimer(acpSessionId);
}

/** Reset idle pause timer after sandbox activity. */
export function touchSandboxActivity(acpSessionId: string): void {
  if (getCachedSandboxHandle(acpSessionId)) {
    scheduleIdlePause(acpSessionId);
  }
}

function clearIdlePauseTimer(acpSessionId: string): void {
  const timer = idleTimers.get(acpSessionId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(acpSessionId);
  }
}

function scheduleIdlePause(acpSessionId: string): void {
  const ms = resolveHarnessSandboxIdlePauseMs();
  if (ms <= 0) return;
  clearIdlePauseTimer(acpSessionId);
  idleTimers.set(
    acpSessionId,
    setTimeout(() => {
      idleTimers.delete(acpSessionId);
      void pauseIdleSandbox(acpSessionId);
    }, ms),
  );
}

async function pauseIdleSandbox(acpSessionId: string): Promise<void> {
  const handle = getCachedSandboxHandle(acpSessionId);
  if (!handle) return;
  const wl = harnessLog({
    lane: "sandbox",
    operation: "idle.pause",
    acpSessionId,
  });
  try {
    const config = sessionAgentConfigs.get(acpSessionId);
    if (config) {
      await persistOpencodeSyncForSession({
        acpSessionId,
        config,
        reason: "idle_pause",
      }).catch((err) => {
        harnessLog({
          lane: "opencode_sync",
          operation: "persist.idle_pause",
          acpSessionId,
        }).error(err);
      });
    }
    await handle.pause();
    wl.emit({ status: "ok" });
  } catch (err) {
    wl.error(err);
    wl.emit({ status: "error" });
  }
}

export function isSandboxReadyForSession(acpSessionId: string): boolean {
  return !!getCachedSandboxHandle(acpSessionId);
}

export function isSandboxPrewarmInFlight(acpSessionId: string): boolean {
  return prewarmInflight.has(acpSessionId);
}

export function getSandboxPrewarmStats(): { prewarmInFlight: number } {
  return { prewarmInFlight: prewarmInflight.size };
}

export function resetSandboxPrewarmForTests(): void {
  prewarmInflight.clear();
  sessionAgentConfigs.clear();
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
}
