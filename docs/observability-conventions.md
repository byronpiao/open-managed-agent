# Observability Conventions

Shared conventions for OMA and TRW observability. Both projects implement independently — this document is the only contract.

## Span Naming

| Pattern | Scope | Example |
|---------|-------|---------|
| `{METHOD} {path}` | HTTP server (auto via traceMiddleware) | `GET /health` |
| `harness.{operation}` | OMA harness control plane | `harness.acquire`, `harness.prompt` |
| `managed.{operation}` | OMA managed runtime | `managed.session.prompt` |
| `bridge.{toolName}` | OMA MCP bridge | `bridge.github_search` |
| `db.{collection}.{op}` | Database operations | `db.sessions.read` |
| `tool.{name}` | TRW tool execution | `tool.bash`, `tool.write` |
| `tool.bash.exec` | TRW bash command | — |
| `cos.{operation}` | TRW COS sync | `cos.snapshot`, `cos.restore` |
| `pty.{operation}` | TRW PTY lifecycle | `pty.create`, `pty.kill` |
| `process.{operation}` | TRW process lifecycle | `process.spawn`, `process.exit` |

## Shared Attribute Keys

| Key | Type | Description |
|-----|------|-------------|
| `request_id` | string | Inbound request ID (platform header) |
| `trace_id` | string | W3C trace ID (32 hex) |
| `span_id` | string | W3C span ID (16 hex) |
| `acp_session_id` | string | ACP session identifier |
| `engine` | string | `opencode` \| `claude` |
| `tool` | string | Tool name |
| `duration_ms` | number | Operation duration in milliseconds |
| `status` | string | `ok` \| `error` |
| `error.type` | string | Error classification |
| `sandbox_id` | string | Sandbox instance ID |

## Correlation Headers

Both projects propagate trace context via:

1. **W3C `traceparent`** (preferred): `00-{traceId32}-{spanId16}-{flags2}`
2. **CloudBase `x-cloudbase-trace`** (fallback): base64-encoded `{traceId},{spanId},{on|off}`
3. **`X-Request-Id`**: request correlation ID

Priority: `traceparent` > `x-cloudbase-trace`

## Safety

- All OTel instrumentation is noop-by-default (zero overhead without exporter)
- `withActiveSpan` passes `undefined` to callback when tracing disabled
- Catch blocks never throw from observability code
- Metrics are OTel API interfaces — noop until MeterProvider registered
