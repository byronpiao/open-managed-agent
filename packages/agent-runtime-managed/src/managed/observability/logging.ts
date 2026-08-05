/**
 * Managed runtime logging (evlog). Skill materialization + cold-start diagnostics.
 */

import { createRequestLogger, initLogger, log } from "evlog";

const REDACT_KEY = /secret|password|token|authorization|apikey|api_key|b64|credential/i;

let initialized = false;

export function isManagedLogDebug(): boolean {
  const lvl = (process.env.LOG_LEVEL ?? "").toLowerCase();
  return process.env.DEBUG === "1" || lvl === "debug" || lvl === "trace";
}

export function initManagedLogging(): void {
  if (initialized) return;
  initLogger({
    env: {
      service: "oma-managed",
      environment: process.env.NODE_ENV ?? "development",
    },
  });
  initialized = true;
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
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

export interface ManagedLogHandle {
  set(fields: Record<string, unknown>): void;
  phase(name: string, fields?: Record<string, unknown>): void;
  milestone(name: string, fields?: Record<string, unknown>): void;
  error(err: unknown, fields?: Record<string, unknown>): void;
  emit(extra?: Record<string, unknown>): void;
}

export function managedLog(scope: Record<string, unknown>): ManagedLogHandle {
  initManagedLogging();
  const wl = createRequestLogger(
    sanitize({
      component: "oma-managed",
      ...scope,
    }),
  );
  let sealed = false;

  const apply = (fields: Record<string, unknown>) => {
    if (sealed) return;
    wl.set(sanitize(fields));
  };

  return {
    set(fields) {
      apply(fields);
    },
    phase(name, fields) {
      apply({ phase: name, ...fields });
      if (isManagedLogDebug()) {
        log.debug(
          sanitize({
            component: "oma-managed",
            phase: name,
            ...scope,
            ...fields,
          }),
        );
      }
    },
    milestone(name, fields) {
      const payload = sanitize({
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
      wl.error(error, sanitize(fields ?? {}));
    },
    emit(extra) {
      if (sealed) return;
      sealed = true;
      wl.emit(sanitize(extra ?? {}));
    },
  };
}

export function managedTrace(scope: string, fields?: Record<string, unknown>): void {
  if (!isManagedLogDebug()) return;
  initManagedLogging();
  log.debug(sanitize({ component: "oma-managed", scope, ...fields }));
}
