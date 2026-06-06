/**
 * Harness runtime logging (evlog). Managed runtime uses console, not this module.
 */

import { createRequestLogger, initLogger, log } from "evlog";

const REDACT_KEY = /secret|password|token|authorization|apikey|api_key|b64|credential/i;

let initialized = false;

export function isHarnessLogDebug(): boolean {
  const lvl = (process.env.LOG_LEVEL ?? "").toLowerCase();
  return process.env.DEBUG === "1" || lvl === "debug" || lvl === "trace";
}

export function initHarnessLogging(): void {
  if (initialized) return;
  initLogger({
    env: {
      service: "oma-harness",
      environment: process.env.NODE_ENV ?? "development",
    },
  });
  initialized = true;
}

export function sanitizeHarnessLogFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
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

export interface HarnessLogHandle {
  set(fields: Record<string, unknown>): void;
  phase(name: string, fields?: Record<string, unknown>): void;
  error(err: unknown, fields?: Record<string, unknown>): void;
  emit(extra?: Record<string, unknown>): void;
}

/** One wide event per logical operation (ACP RPC, acquire, MCP call, …). */
export function harnessLog(scope: Record<string, unknown>): HarnessLogHandle {
  initHarnessLogging();
  const wl = createRequestLogger(sanitizeHarnessLogFields({ component: "harness", ...scope }));
  return {
    set(fields) {
      wl.set(sanitizeHarnessLogFields(fields));
    },
    phase(name, fields) {
      wl.set(sanitizeHarnessLogFields({ phase: name, ...fields }));
      if (isHarnessLogDebug()) {
        log.debug(
          sanitizeHarnessLogFields({ component: "harness", phase: name, ...scope, ...fields }),
        );
      }
    },
    error(err, fields) {
      const error = err instanceof Error ? err : new Error(String(err));
      wl.error(error, sanitizeHarnessLogFields(fields ?? {}));
    },
    emit(extra) {
      wl.emit(sanitizeHarnessLogFields(extra ?? {}));
    },
  };
}

/** Lightweight debug line when DEBUG=1 or LOG_LEVEL=debug. */
export function harnessTrace(scope: string, fields?: Record<string, unknown>): void {
  if (!isHarnessLogDebug()) return;
  initHarnessLogging();
  log.debug(sanitizeHarnessLogFields({ component: "harness", scope, ...fields }));
}
