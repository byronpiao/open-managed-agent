#!/usr/bin/env node
/**
 * OTLP telemetry E2E — validates traces are sent over the wire.
 * Starts a minimal HTTP receiver, creates an OTEL span, checks the payload.
 * No Docker / external collector needed.
 *
 * Run: node tests/otlp-e2e.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

const OTLP_PORT = 14318;
const captured = [];

const server = createServer((req, res) => {
  let buf = "";
  req.on("data", (chunk) => (buf += String(chunk)));
  req.on("end", () => {
    captured.push({ method: req.method, url: req.url, body: buf, headers: req.headers });
    res.writeHead(200);
    res.end(JSON.stringify({}));
  });
});

await new Promise((resolve) => server.listen(OTLP_PORT, resolve));
process.env.OTEL_TRACES_EXPORTER = "otlp";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${OTLP_PORT}`;
process.env.OTEL_SERVICE_NAME = "oma-otlp-e2e";

const { initTelemetry, shutdownTelemetry, isTracingEnabled } = await import(
  "./../packages/agent-runtime/dist/harness/telemetry/telemetry-init.js"
);
const { withActiveSpan, injectOutboundTraceHeaders } = await import(
  "./../packages/agent-runtime/dist/harness/telemetry/telemetry.js"
);

initTelemetry();
assert.ok(isTracingEnabled(), "tracing should be enabled");

// Create a span with attributes and inject a traceparent into outbound headers
let injectedTp;
await withActiveSpan("e2e.acquire", { envId: "e2e", engine: "opencode" }, async () => {
  const headers = {};
  injectOutboundTraceHeaders(headers);
  injectedTp = headers.traceparent;
  // Nested span to verify parent-child relationship
  await withActiveSpan("e2e.acquire.workspace_init", { instance_id: "i-123", duration_ms: 42 }, async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  await new Promise((r) => setTimeout(r, 40));
});

// Wait for the BatchSpanProcessor to export (default 5s interval)
await new Promise((r) => setTimeout(r, 8000));
await shutdownTelemetry();
assert.equal(isTracingEnabled(), false);

server.close();

// Verify OTLP payload was received
assert.ok(captured.length >= 1, `expected >= 1 OTLP requests, got ${captured.length}`);
const post = captured.find((c) => c.method === "POST");
assert.ok(post, "should have received a POST request");
assert.ok(post.url, "request URL should be present");

// Verify traceparent was injected into outbound headers
assert.ok(injectedTp, "traceparent should be injected");
assert.match(injectedTp, /^00-[\da-f]{32}-[\da-f]{16}-01$/, "valid W3C traceparent");

// Verify the payload contains span data (OTLP protobuf is binary, not JSON)
const rawBody = post.body;
assert.ok(rawBody.length > 100, `OTLP payload too small: ${rawBody.length} bytes`);

// Proto-encoded spans contain the operation name as UTF-8 bytes
assert.ok(rawBody.includes("e2e.acquire"), "payload should contain span operation name 'e2e.acquire'");
assert.ok(rawBody.includes("e2e.acquire.workspace_init"), "payload should contain nested span 'e2e.acquire.workspace_init'");

// Proto-encoded span attributes contain key-value pairs
assert.ok(rawBody.includes("envId") || rawBody.includes("engine"), "payload should contain span attribute keys");
assert.ok(rawBody.includes("instance_id") || rawBody.includes("duration_ms"), "payload should contain nested span attributes");

// Verify traceparent was injected into outbound headers (W3C format)
assert.ok(injectedTp, "traceparent should be injected into outbound headers");
assert.match(injectedTp, /^00-[\da-f]{32}-[\da-f]{16}-01$/, "valid W3C traceparent format");

console.log(`otlp e2e passed (${captured.length} OTLP requests, spans found, traceparent verified)`);

delete process.env.OTEL_TRACES_EXPORTER;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_SERVICE_NAME;
