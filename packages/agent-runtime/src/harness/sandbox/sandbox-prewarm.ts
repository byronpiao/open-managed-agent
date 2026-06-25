/**
 * Async sandbox prewarm on session/new + idle pause after inactivity.
 */

import type { AgentConfig } from "../../config.js";
import { resolveRuntime } from "../../config.js";
import { buildHarnessSandboxEnv } from "../deploy.js";
import { harnessLog } from "../observability/logging.js";
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
} from "./orchestrator.js";
import { getHarnessSessionStore } from "./session-store.js";

const prewarmInflight = new Map<string, Promise<{ syncHydrated: number }>>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Agent config per ACP session — used for idle-pause opencode export. */
const sessionAgentConfigs = new Map<string, AgentConfig>();

function envIdFromProcess(): string {
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
  if (!envId) {
    throw Object.assign(new Error("CLOUDBASE_ENV_ID is required for harness runtime"), {
      rpcCode: -32000,
    });
  }
  return envId;
}

function harnessCallbackBase(): string {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");
  const port = process.env.PORT ?? 9000;
  return `http://127.0.0.1:${port}`;
}

/** Default 20 min idle before pause; set HARNESS_SANDBOX_IDLE_PAUSE_MS=0 to disable. */
export function resolveHarnessSandboxIdlePauseMs(): number {
  const raw = process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS?.trim();
  if (raw === "0" || raw === "off" || raw === "false") return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return 20 * 60 * 1000;
}

/** Acquire (or stub) sandbox and bind to session — shared by prewarm and prompt path. */
export async function bindSandboxForSession(
  config: AgentConfig,
  acpSessionId: string,
): Promise<{ syncHydrated: number }> {
  sessionAgentConfigs.set(acpSessionId, config);
  const envId = envIdFromProcess();
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
  const staleInstanceId = record.instanceId;

  if (staleInstanceId && record.toolId && !isE2eStubSandboxEnabled(config)) {
    try {
      await getSandboxOrchestrator().stopInstanceForEnv(staleInstanceId, envId);
    } catch (err) {
      harnessLog({
        lane: "orchestrator",
        operation: "stale_instance.stop",
        acpSessionId,
        instanceId: staleInstanceId,
      }).error(err);
    }
    await store.clearInstanceBinding(acpSessionId);
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
    if (record.engine === "opencode" && record.engineSessionId) {
      const hydrated = await hydrateOpencodeSyncEvents({
        handle,
        syncStore: getHarnessSyncEventStore(envId),
        acpSessionId,
        aggregateId: record.engineSessionId,
      });
      syncHydrated = hydrated.replayed;
    } else if (record.engine === "claude" && record.engineSessionId) {
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
  const promise = bindSandboxForSession(config, acpSessionId)
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
