/**
 * Harness runtime logging (evlog). Managed runtime uses console, not this module.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequestLogger, initLogger, log } from "evlog";

const requestContext = new AsyncLocalStorage<{ requestId?: string }>();

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
  /** Always info — cloud milestones (orchestrator phases, session.new). */
  milestone(name: string, fields?: Record<string, unknown>): void;
  error(err: unknown, fields?: Record<string, unknown>): void;
  emit(extra?: Record<string, unknown>): void;
}

function headerOne(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

/** Gateway / SCF request id for cross-layer correlation. */
export function resolveHarnessRequestId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  for (const key of [
    "x-request-id",
    "x-scf-request-id",
    "x-cloudbase-request-id",
    "x-trace-id",
  ]) {
    const v = headerOne(headers, key);
    if (v) return v;
  }
  return undefined;
}

export function harnessRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export async function runWithHarnessRequestContext<T>(
  headers: Record<string, string | string[] | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const requestId = resolveHarnessRequestId(headers);
  if (!requestId) return fn();
  return requestContext.run({ requestId }, fn);
}

/** One wide event per logical operation (ACP RPC, acquire, MCP call, …). */
export function harnessLog(scope: Record<string, unknown>): HarnessLogHandle {
  initHarnessLogging();
  const rid = harnessRequestId();
  const wl = createRequestLogger(
    sanitizeHarnessLogFields({
      component: "harness",
      ...(rid ? { requestId: rid } : {}),
      ...scope,
    }),
  );
  let sealed = false;

  const apply = (fields: Record<string, unknown>) => {
    if (sealed) return;
    wl.set(sanitizeHarnessLogFields(fields));
  };

  return {
    set(fields) {
      apply(fields);
    },
    phase(name, fields) {
      apply({ phase: name, ...fields });
      if (isHarnessLogDebug()) {
        log.debug(
          sanitizeHarnessLogFields({
            component: "harness",
            phase: name,
            ...(rid ? { requestId: rid } : {}),
            ...scope,
            ...fields,
          }),
        );
      }
    },
    milestone(name, fields) {
      const payload = sanitizeHarnessLogFields({
        component: "harness",
        phase: name,
        ...(rid ? { requestId: rid } : {}),
        ...scope,
        ...fields,
      });
      apply(payload);
      log.info(payload);
    },
    error(err, fields) {
      if (sealed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      wl.error(error, sanitizeHarnessLogFields(fields ?? {}));
    },
    emit(extra) {
      if (sealed) return;
      sealed = true;
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
