# 沙箱 Agent — 可观测性

`runtime: harness` 的日志、请求关联与可选 OpenTelemetry。默认**零配置**即可排错；OTEL 为可选增强。

> 上手：[使用指南](./harness-tutorial.md) · 凭证：[凭证说明](./harness-credentials.md)

---

## 默认行为（不配置 OTEL）

| 信号 | 行为 |
|------|------|
| **日志** | OMA Runtime **stdout** 结构化宽事件（`harnessLog` / evlog） |
| **指标 / 链路** | **不导出**（无额外进程） |
| **沙箱内** | 远程工作区服务自有 stdout / 实例日志采集 |

CloudBase [服务调用日志](https://docs.cloudbase.net/logger/tracelog) 可与 `traceId` 对齐。

---

## 请求关联（推荐）

从客户端或网关调用 OMA（ACP / Managed Agents HTTP）时，建议透传：

| Header | 说明 |
|--------|------|
| `traceparent` | **W3C 标准**（Jaeger / Tempo 等）；**优先** |
| `x-cloudbase-trace` | CloudBase 控制台 trace（base64） |
| `X-Request-Id` | 单次 HTTP 请求 ID |
| `x-cloudbase-request-id` | 平台请求 ID（优先于 `x-request-id`） |

**优先级**

- Trace：`traceparent` > `x-cloudbase-trace`
- Request：`x-cloudbase-request-id` > `x-scf-request-id` > `x-request-id` > `x-trace-id`

OMA Runtime 日志字段（`harnessLog`）：

| 字段 | 含义 |
|------|------|
| `requestId` | 单次请求 |
| `traceId` | 跨服务 trace |
| `spanId` | W3C parent span（有则写） |
| `acpSessionId` | harness 会话 |
| `lane` / `phase` | 子系统与阶段 |

向沙箱数据面转发请求时，OMA 透传 `traceparent` 或 `x-cloudbase-trace` + `X-Request-Id`（**不伪造** `X-Scf-*`）。

### 网关示例

```bash
TRACE='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

curl -sS \
  -H "X-Cloudbase-Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "E2b-Sandbox-Id: $INSTANCE_ID" \
  -H "E2b-Sandbox-Port: 9000" \
  -H "X-Access-Token: $SIT" \
  -H "X-Request-Id: my-req-001" \
  -H "traceparent: $TRACE" \
  -H "Content-Type: application/json" \
  -d '{"command":"echo hello"}' \
  "https://${ENV_ID}.api.tcloudbasegateway.com/v1/sandbox/-/api/tools/bash"
```

---

## 查看日志

### OMA Runtime（tcbr / SCF）

```bash
tcb fn log <agent-id> -e "$CLOUDBASE_ENV_ID" | rg 'traceId|requestId|acpSessionId|lane'
```

调试：

```bash
LOG_LEVEL=debug npm run dev:harness
```

### 沙箱实例内

经网关进入实例后，工作区服务日志由平台采集；也可在实例内查看 `/var/log/trw/*.jsonl`（若镜像启用文件日志）。

按 `request_id` 过滤：

```bash
cat /var/log/trw/*.jsonl | jq 'select(.request_id=="my-req-001")'
```

---

## 健康检查

`GET /healthz`（harness）除沙箱缓存外，含 **OMA Runtime** 的 telemetry 摘要：

```json
"telemetry": { "metrics": "noop", "traces": "noop" }
```

未配置 OTEL 时为 `noop`；不影响 `ok` 语义。

沙箱内 `GET /health`（经网关 :9000）另有该进程的 telemetry 字段（若镜像版本支持）。

---

## 可选：OpenTelemetry

### OMA Runtime 进程

在部署环境变量中开启（tcbr / SCF **函数 env**）：

| 变量 | 说明 |
|------|------|
| `OTEL_METRICS_EXPORTER` | `otlp` / `prometheus` / `otlp,prometheus` / `none` |
| `OTEL_TRACES_EXPORTER` | 须显式 `otlp` 才开启 trace |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector 基址（如 `http://collector:4318`） |
| `OTEL_SERVICE_NAME` | 默认 `oma-harness` |

已有埋点（noop 直到开启）：`harness.acquire.duration_ms`、`harness.prompt.duration_ms` 等。

### 沙箱内远程工作区

在 **`magent agent:create` 之前** 注入实例 env（与 COS 相同时机）：

```yaml
# agent.harness.yaml
sandbox:
  env:
    OTEL_METRICS_EXPORTER: otlp
    OTEL_TRACES_EXPORTER: otlp
    OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector.observability.svc:4318
    OTEL_SERVICE_NAME: my-sandbox-workspace
```

或 export 后创建新 Agent。Collector 须从沙箱网络可达。

| 现象 | 处理 |
|------|------|
| 有 endpoint 无 trace | 沙箱内须另设 `OTEL_TRACES_EXPORTER=otlp` |
| 日志无 `trace_id` | 确认请求带 `traceparent` 或 `x-cloudbase-trace` |
| 担心性能 | 不配置 OTEL 即可；默认 noop |

---

## 相关文档

- [使用指南](./harness-tutorial.md)
> 排障见 [使用指南](./harness-tutorial.md#常见问题)
- [凭证说明](./harness-credentials.md)
