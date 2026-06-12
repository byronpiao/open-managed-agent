/**
 * Harness correlation ids — inbound trust rules and CloudBase trace parsing.
 *
 * - traceId: from x-cloudbase-trace (CloudBase 服务调用日志)
 * - requestId: per HTTP / ACP request (platform headers or local UUID)
 * - acpSessionId: harness session (separate; set on harnessLog scope)
 */

export const REQUEST_ID_MAX_LENGTH = 255;
const REQUEST_ID_PATTERN = /^[\w\-=]+$/;
const TRACE_ID_MAX_LENGTH = 128;
const TRACE_ID_PATTERN = /^[\w-]+$/;
const CLOUDBASE_TRACE_HEADER_MAX = 2048;

/** Read-only inbound request id headers (do not forge X-Scf-* outbound). */
export const INBOUND_REQUEST_ID_HEADERS = [
  "x-cloudbase-request-id",
  "x-scf-request-id",
  "x-request-id",
  "x-trace-id",
] as const;

export const CLOUDBASE_TRACE_HEADER = "x-cloudbase-trace";

export function normalizeInboundRequestId(
  raw: string | undefined | null,
): string | undefined {
  if (raw == null) return undefined;
  const v = raw.trim();
  if (!v || v.length > REQUEST_ID_MAX_LENGTH || !REQUEST_ID_PATTERN.test(v)) {
    return undefined;
  }
  return v;
}

/** Decode CloudBase x-cloudbase-trace (base64 `${traceId},${spanId},${on|off}`). */
export function parseCloudbaseTraceHeader(
  headerValue: string | undefined | null,
): { traceId?: string; raw?: string } {
  if (!headerValue?.trim()) return {};
  const raw = headerValue.trim();
  if (raw.length > CLOUDBASE_TRACE_HEADER_MAX) return {};
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    const [traceId] = decoded.split(",");
    const id = traceId?.trim();
    if (id && id.length <= TRACE_ID_MAX_LENGTH && TRACE_ID_PATTERN.test(id)) {
      return { traceId: id, raw };
    }
  } catch {
    // invalid base64 — ignore
  }
  return {};
}

export function resolveInboundRequestIdFromHeaders(
  getHeader: (name: string) => string | undefined,
): string | undefined {
  for (const key of INBOUND_REQUEST_ID_HEADERS) {
    const v = normalizeInboundRequestId(getHeader(key));
    if (v) return v;
  }
  return undefined;
}

export function headerOne(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

export interface HarnessCorrelationContext {
  requestId: string;
  traceId?: string;
  /** Raw x-cloudbase-trace for safe pass-through to TRW (internal data plane only). */
  cloudbaseTrace?: string;
}

export function resolveHarnessCorrelationFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): HarnessCorrelationContext {
  const cloudbaseTraceRaw = headerOne(headers, CLOUDBASE_TRACE_HEADER);
  const parsed = parseCloudbaseTraceHeader(cloudbaseTraceRaw || undefined);
  const inbound = resolveInboundRequestIdFromHeaders((name) => {
    const v = headerOne(headers, name);
    return v || undefined;
  });
  return {
    requestId: inbound ?? crypto.randomUUID(),
    traceId: parsed.traceId,
    cloudbaseTrace: parsed.raw ? cloudbaseTraceRaw : undefined,
  };
}

/** Headers OMA may add on AGS data-plane calls to TRW (never forge X-Scf-*). */
export function buildHarnessOutboundCorrelationHeaders(
  ctx: HarnessCorrelationContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.cloudbaseTrace) {
    out[CLOUDBASE_TRACE_HEADER] = ctx.cloudbaseTrace;
  }
  if (ctx.requestId) {
    out["X-Request-Id"] = ctx.requestId;
  }
  return out;
}
