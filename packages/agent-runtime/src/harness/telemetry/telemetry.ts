/**
 * Tracing helpers — no-op unless OTEL_TRACES_EXPORTER=otlp.
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
import { isTracingEnabled } from "./telemetry-init.js";

const TRACER_NAME = "oma-harness";

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
