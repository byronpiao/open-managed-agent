/**
 * Harness correlation ids — inbound trust rules and trace context parsing.
 *
 * - traceId / spanId: traceparent (W3C, preferred) or x-cloudbase-trace
 * - requestId: per HTTP / ACP request (platform headers or local UUID)
 * - acpSessionId: harness session (separate; set on harnessLog scope)
 */

import { randomBytes } from "node:crypto";

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
export const TRACEPARENT_HEADER = "traceparent";

/** W3C traceparent: `{version}-{trace-id}-{parent-id}-{flags}` */
const TRACEPARENT_RE = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;

export type TraceContextSource = "traceparent" | "cloudbase";

export interface InboundTraceContext {
  traceId?: string;
  spanId?: string;
  /** Raw inbound header value (traceparent or x-cloudbase-trace). */
  raw?: string;
  source?: TraceContextSource;
}

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
): { traceId?: string; spanId?: string; raw?: string } {
  if (!headerValue?.trim()) return {};
  const raw = headerValue.trim();
  if (raw.length > CLOUDBASE_TRACE_HEADER_MAX) return {};
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    const [traceIdPart, spanIdPart] = decoded.split(",");
    const id = traceIdPart?.trim();
    if (!id || id.length > TRACE_ID_MAX_LENGTH || !TRACE_ID_PATTERN.test(id)) {
      return {};
    }
    const spanHex = spanIdPart?.trim() ? spanIdToW3cHex(spanIdPart.trim()) : undefined;
    return { traceId: id, spanId: spanHex, raw };
  } catch {
    // invalid base64 — ignore
  }
  return {};
}

export function traceIdToW3cHex(traceId: string): string | undefined {
  const hex = traceId.replace(/-/g, "").toLowerCase();
  return /^[\da-f]{32}$/.test(hex) ? hex : undefined;
}

export function spanIdToW3cHex(spanId: string): string | undefined {
  const hex = spanId.replace(/-/g, "").toLowerCase();
  return /^[\da-f]{16}$/.test(hex) ? hex : undefined;
}

/** Build W3C traceparent when only CloudBase trace header is present (sandbox data plane). */
export function buildSyntheticTraceparent(
  traceId: string,
  spanId?: string,
): string | undefined {
  const tid = traceIdToW3cHex(traceId);
  if (!tid) return undefined;
  const sid = (spanId && spanIdToW3cHex(spanId)) || randomBytes(8).toString("hex");
  return `00-${tid}-${sid}-01`;
}

export function parseTraceparent(
  headerValue: string | undefined | null,
): InboundTraceContext {
  if (!headerValue?.trim()) return {};
  const raw = headerValue.trim();
  const m = TRACEPARENT_RE.exec(raw);
  if (!m) return {};
  return {
    traceId: m[1]!.toLowerCase(),
    spanId: m[2]!.toLowerCase(),
    raw,
    source: "traceparent",
  };
}

export function resolveInboundTraceContext(
  getHeader: (name: string) => string | undefined,
): InboundTraceContext {
  const fromTraceparent = parseTraceparent(getHeader(TRACEPARENT_HEADER));
  if (fromTraceparent.traceId) return fromTraceparent;

  const cloudbase = parseCloudbaseTraceHeader(getHeader(CLOUDBASE_TRACE_HEADER));
  if (cloudbase.traceId) {
    return {
      traceId: cloudbase.traceId,
      spanId: cloudbase.spanId,
      raw: cloudbase.raw,
      source: "cloudbase",
    };
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
  spanId?: string;
  /** Raw inbound trace header (traceparent or x-cloudbase-trace). */
  traceRaw?: string;
  traceSource?: TraceContextSource;
  /**
   * @deprecated use traceRaw when traceSource === "cloudbase"
   * Kept for callers that only pass cloudbase blob.
   */
  cloudbaseTrace?: string;
}

export function resolveHarnessCorrelationFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): HarnessCorrelationContext {
  const getHeader = (name: string) => {
    const v = headerOne(headers, name);
    return v || undefined;
  };
  const trace = resolveInboundTraceContext(getHeader);
  const inbound = resolveInboundRequestIdFromHeaders(getHeader);
  const cloudbaseTrace =
    trace.source === "cloudbase" && trace.raw
      ? headerOne(headers, CLOUDBASE_TRACE_HEADER) || undefined
      : undefined;
  return {
    requestId: inbound ?? crypto.randomUUID(),
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceRaw: trace.raw,
    traceSource: trace.source,
    cloudbaseTrace,
  };
}

/** Headers OMA may add on sandbox data-plane calls (never forge X-Scf-*). */
export function buildHarnessOutboundCorrelationHeaders(
  ctx: HarnessCorrelationContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.requestId) {
    out["X-Request-Id"] = ctx.requestId;
  }
  if (ctx.traceSource === "traceparent" && ctx.traceRaw) {
    out[TRACEPARENT_HEADER] = ctx.traceRaw;
  } else if (ctx.traceSource === "cloudbase" && ctx.traceRaw) {
    out[CLOUDBASE_TRACE_HEADER] = ctx.traceRaw;
    const synthetic = buildSyntheticTraceparent(ctx.traceId ?? "", ctx.spanId);
    if (synthetic) {
      out[TRACEPARENT_HEADER] = synthetic;
    }
  } else if (ctx.cloudbaseTrace) {
    out[CLOUDBASE_TRACE_HEADER] = ctx.cloudbaseTrace;
  }
  return out;
}
