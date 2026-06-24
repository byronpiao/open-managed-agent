/**
 * Optional OpenTelemetry metrics + traces (noop when env unset).
 * Must load before `metrics.ts` creates instruments.
 */
import { metrics, propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { Resource } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export type MetricsExportMode = "noop" | "otlp" | "prometheus" | "otlp,prometheus";
export type TracesExportMode = "noop" | "otlp";

let metricsExportMode: MetricsExportMode = "noop";
let tracesExportMode: TracesExportMode = "noop";
let prometheusExporter: PrometheusExporter | undefined;
let meterProvider: MeterProvider | undefined;
let tracerProvider: NodeTracerProvider | undefined;

function serviceName(): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || "oma-harness";
}

function sharedResource(): Resource {
  return new Resource({
    [ATTR_SERVICE_NAME]: serviceName(),
  });
}

function parseMetricsExporters(): Set<string> {
  const explicit = process.env.OTEL_METRICS_EXPORTER?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "none") return new Set();
    return new Set(
      explicit
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
    return new Set(["otlp"]);
  }
  return new Set();
}

/** Traces require explicit OTEL_TRACES_EXPORTER — never auto-enable from OTLP endpoint alone. */
function parseTracesExporters(): Set<string> {
  const explicit = process.env.OTEL_TRACES_EXPORTER?.trim().toLowerCase();
  if (!explicit || explicit === "none") return new Set();
  return new Set(
    explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function metricExportIntervalMs(): number {
  const raw = process.env.OTEL_METRIC_EXPORT_INTERVAL?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 60_000;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

export function resolveOtlpSignalUrl(
  signalEnvKey: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" | "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  resourcePath: "v1/metrics" | "v1/traces",
): string | undefined {
  const specific = process.env[signalEnvKey]?.trim();
  if (specific) return specific;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return undefined;
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith(resourcePath)) return trimmed;
  return `${trimmed}/${resourcePath}`;
}

function initMetricsProvider(resource: Resource): void {
  const exporters = parseMetricsExporters();
  if (exporters.size === 0) return;

  const readers: MetricReader[] = [];
  const modes: string[] = [];

  if (exporters.has("otlp")) {
    const url = resolveOtlpSignalUrl("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "v1/metrics");
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(url ? { url } : undefined),
        exportIntervalMillis: metricExportIntervalMs(),
      }),
    );
    modes.push("otlp");
  }

  if (exporters.has("prometheus")) {
    prometheusExporter = new PrometheusExporter({ preventServerStart: true });
    readers.push(prometheusExporter);
    modes.push("prometheus");
  }

  if (readers.length === 0) return;

  meterProvider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);
  metricsExportMode = modes.join(",") as MetricsExportMode;
}

function initTracerProvider(resource: Resource): void {
  const exporters = parseTracesExporters();
  if (!exporters.has("otlp")) return;

  const url = resolveOtlpSignalUrl("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "v1/traces");

  tracerProvider = new NodeTracerProvider({ resource });
  tracerProvider.addSpanProcessor(
    new BatchSpanProcessor(new OTLPTraceExporter(url ? { url } : undefined)),
  );
  tracerProvider.register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
  });
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  tracesExportMode = "otlp";
}

export function initTelemetry(): void {
  const metricsOn = parseMetricsExporters().size > 0;
  const tracesOn = parseTracesExporters().has("otlp");
  if (!metricsOn && !tracesOn) return;

  const resource = sharedResource();
  if (metricsOn) initMetricsProvider(resource);
  if (tracesOn) initTracerProvider(resource);
}

export function isTracingEnabled(): boolean {
  return tracesExportMode !== "noop";
}

export function getMetricsExportMode(): MetricsExportMode {
  return metricsExportMode;
}

export function getTracesExportMode(): TracesExportMode {
  return tracesExportMode;
}

export function getTelemetrySummary(): { metrics: MetricsExportMode; traces: TracesExportMode } {
  return { metrics: metricsExportMode, traces: tracesExportMode };
}

export async function scrapePrometheusMetricsText(): Promise<string | null> {
  if (!prometheusExporter) return null;
  const collection = await prometheusExporter.collect();
  const serializer = new PrometheusSerializer();
  return serializer.serialize(collection.resourceMetrics);
}

export async function shutdownTelemetry(): Promise<void> {
  await Promise.all([meterProvider?.shutdown(), tracerProvider?.shutdown()]);
  meterProvider = undefined;
  tracerProvider = undefined;
  prometheusExporter = undefined;
  metricsExportMode = "noop";
  tracesExportMode = "noop";
}
