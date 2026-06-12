/**
 * Harness OpenTelemetry metrics — noop until a MeterProvider is registered.
 */

import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("oma-harness");

const acquireDuration = meter.createHistogram("harness.acquire.duration_ms", {
  description: "Sandbox acquire duration",
  unit: "ms",
});

const promptDuration = meter.createHistogram("harness.prompt.duration_ms", {
  description: "ACP session/prompt relay duration",
  unit: "ms",
});

const permissionFrames = meter.createHistogram("harness.prompt.permission_frames", {
  description: "permission_request SSE frames per prompt",
});

const syncExportedEvents = meter.createHistogram("harness.sync.exported_events", {
  description: "Events exported to harness_sync_events per export",
});

const acceptanceOutcome = meter.createCounter("harness.acceptance.outcome", {
  description: "Product acceptance check outcomes",
});

export function recordHarnessAcquireDuration(
  ms: number,
  attrs: { engine?: string; status?: string } = {},
): void {
  acquireDuration.record(Math.round(ms), attrs);
}

export function recordHarnessPromptDuration(
  ms: number,
  attrs: { engine?: string; status?: string } = {},
): void {
  promptDuration.record(Math.round(ms), attrs);
}

export function recordHarnessPermissionFrames(count: number, engine?: string): void {
  permissionFrames.record(count, { engine: engine ?? "unknown" });
}

export function recordHarnessSyncExported(count: number): void {
  syncExportedEvents.record(count);
}

export function recordHarnessAcceptanceOutcome(status: string, checkId: string): void {
  acceptanceOutcome.add(1, { status, check_id: checkId });
}
