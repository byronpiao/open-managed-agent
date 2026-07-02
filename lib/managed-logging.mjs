/**
 * Managed agent / magent CLI logging (evlog).
 * Harness uses packages/agent-runtime/src/harness/observability/logging.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRequestLogger, initLogger, log } = require("evlog");

const skillSyncContext = new AsyncLocalStorage();

const REDACT_KEY = /secret|password|token|authorization|apikey|api_key|b64|credential/i;

let initialized = false;

export function isManagedLogDebug() {
  const lvl = (process.env.LOG_LEVEL ?? "").toLowerCase();
  return process.env.DEBUG === "1" || lvl === "debug" || lvl === "trace";
}

export function initManagedLogging() {
  if (initialized) return;
  initLogger({
    env: {
      service: "oma-managed",
      environment: process.env.NODE_ENV ?? "development",
    },
  });
  initialized = true;
}

export function sanitizeManagedLogFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    if (REDACT_KEY.test(key)) {
      out[key] = value ? "***" : undefined;
      continue;
    }
    if (typeof value === "string" && value.length > 800) {
      out[key] = `${value.slice(0, 800)}…(${value.length} chars)`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {Record<string, unknown>} scope
 * @returns {{ set: Function, phase: Function, milestone: Function, error: Function, emit: Function }}
 */
export function managedLog(scope) {
  initManagedLogging();
  const wl = createRequestLogger(
    sanitizeManagedLogFields({
      component: "oma-managed",
      ...scope,
    }),
  );
  let sealed = false;

  const apply = (fields) => {
    if (sealed) return;
    wl.set(sanitizeManagedLogFields(fields));
  };

  return {
    set(fields) {
      apply(fields);
    },
    phase(name, fields) {
      apply({ phase: name, ...fields });
      if (isManagedLogDebug()) {
        log.debug(
          sanitizeManagedLogFields({
            component: "oma-managed",
            phase: name,
            ...scope,
            ...fields,
          }),
        );
      }
    },
    milestone(name, fields) {
      const payload = sanitizeManagedLogFields({
        component: "oma-managed",
        phase: name,
        ...scope,
        ...fields,
      });
      apply(payload);
      log.info(payload);
    },
    error(err, fields) {
      if (sealed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      wl.error(error, sanitizeManagedLogFields(fields ?? {}));
    },
    emit(extra) {
      if (sealed) return;
      sealed = true;
      wl.emit(sanitizeManagedLogFields(extra ?? {}));
    },
  };
}

/** Debug-only line (LOG_LEVEL=debug or DEBUG=1). */
export function managedTrace(scope, fields) {
  if (!isManagedLogDebug()) return;
  initManagedLogging();
  log.debug(sanitizeManagedLogFields({ component: "oma-managed", scope, ...fields }));
}

/** Active skill-sync wide event logger, if inside runWithSkillSyncLog. */
export function skillSyncLog() {
  return skillSyncContext.getStore()?.wl;
}

/** Log a phase on the active skill-sync logger (no-op outside context). */
export function skillSyncPhase(phase, fields) {
  skillSyncLog()?.phase(phase, fields);
}

export function skillSyncMilestone(phase, fields) {
  skillSyncLog()?.milestone(phase, fields);
}

export async function runWithSkillSyncLog(scope, fn) {
  const wl = managedLog({ lane: "skill-sync", ...scope });
  const startedAt = Date.now();
  return skillSyncContext.run({ wl, startedAt, scope }, async () => {
    wl.milestone("sync_start", {
      skillCount: scope.skillCount,
      operation: scope.operation,
    });
    try {
      const result = await fn(wl);
      const summary = result && typeof result === "object" ? result : {};
      wl.emit({
        outcome: "ok",
        durationMs: Date.now() - startedAt,
        ...(summary.syncResult
          ? {
              added: summary.syncResult.added?.length ?? 0,
              updated: summary.syncResult.updated?.length ?? 0,
              removed: summary.syncResult.removed?.length ?? 0,
            }
          : {}),
      });
      return result;
    } catch (err) {
      wl.error(err, { durationMs: Date.now() - startedAt });
      wl.emit({ outcome: "error", durationMs: Date.now() - startedAt });
      throw err;
    }
  });
}

/** Short-lived context for detect-only phases (no terminal emit). */
export async function withSkillSyncContext(scope, fn) {
  const wl = managedLog({ lane: "skill-sync", ...scope });
  return skillSyncContext.run({ wl, startedAt: Date.now(), scope }, fn);
}
