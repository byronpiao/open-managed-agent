/**
 * Tracing helpers — no-op unless OTEL_TRACES_EXPORTER is set to a non-"none" value.
 *
 * Runtime-agnostic shim (shared by managed & harness runtimes). Only depends on
 * @opentelemetry/api — the OTel SDK/exporters are initialized per runtime (e.g.
 * harness/telemetry/telemetry-init.ts), and this module reads the same env var
 * the SDK init uses, so spans are only emitted when a provider is registered.
 */
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

const TRACER_NAME = "oma";

/** Mirrors telemetry-init's parseTracesExporters: traces require an explicit non-"none" OTEL_TRACES_EXPORTER. */
export function isTracingEnabled(): boolean {
  const explicit = process.env.OTEL_TRACES_EXPORTER?.trim().toLowerCase();
  if (!explicit || explicit === "none") return false;
  return explicit
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length > 0;
}

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export function injectOutboundTraceHeaders(headers: Headers | Record<string, string>): void {
  if (!isTracingEnabled()) return;
  if (headers instanceof Headers) {
    propagation.inject(context.active(), headers, {
      set(carrier, key, value) {
        carrier.set(key, value);
      },
    });
    return;
  }
  propagation.inject(context.active(), headers, {
    set(carrier, key, value) {
      carrier[key] = value;
    },
  });
}

type SpanFn<T> = (span: Span | undefined) => T | Promise<T>;

export async function withActiveSpan<T>(
  name: string,
  attributes: Attributes,
  fn: SpanFn<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  if (!isTracingEnabled()) {
    return fn(undefined);
  }
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      if (err instanceof Error) {
        span.recordException(err);
      }
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
