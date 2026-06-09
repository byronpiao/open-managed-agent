# Claude Managed Agents HTTP（Harness 对外协议面）

> **对客使用指南**（快速开始、选型、对齐说明）见 [managed-agents-guide.md](./managed-agents-guide.md)。本文偏协议与实现细节。

OMA `runtime=harness` 在既有 ACP 沙箱链路上方暴露 **Anthropic Claude Managed Agents 兼容 HTTP**。

## 路由

| 资源 | 方法 | 路径 |
|------|------|------|
| Agent | POST/GET | `/v1/agents` · `/v1/agents/{id}` |
| Environment | POST/GET/DELETE | `/v1/environments` · `/v1/environments/{id}` |
| Session | POST/GET/DELETE | `/v1/sessions` · `/v1/sessions/{id}` |
| Events | GET/POST | `/v1/sessions/{id}/events` |

经 CloudBase 网关访问时，路径前缀为：

`/v1/aibot/bots/{agentId}/v1/...`

本地直连 Runtime（`:9000`）时使用无前缀的 `/v1/...`。

## 鉴权

- `Authorization: Bearer <token>`（必填）
- `anthropic-beta: managed-agents-2026-04-01`（必填）

## 双层存储

| 层 | 存储 | 用途 |
|----|------|------|
| **Layer A** | FlexDB `managed_agents_*` 集合 | 协议事件、SSE 重连、多端审计 |
| **Layer B** | `harness_sessions` / `harness_sync_events` / `harness_claude_*` | 引擎恢复、re-acquire hydrate |

Managed Agents `session.id` 与 `acpSessionId` **1:1**。prompt 收尾必须同时写 Layer A 事件并触发 `persistOpencodeSyncForSession`（Layer B）。

## 客户端

对外协议与 [mosoo-agent-driver](https://github.com/langgenius/mosoo-agent-driver) 同形；OMA 发货 **`open-managed-agent-sdk` 的 `ManagedAgentsClient` / `createManagedAgentsClient`**，直连本服务 HTTP（`POST/GET /v1/sessions/.../events`，SSE `Accept: text/event-stream`），不经过 ACP JSON-RPC。

```typescript
import { createManagedAgentsClient } from "open-managed-agent-sdk";

const client = createManagedAgentsClient({
  envId: process.env.CLOUDBASE_ENV_ID!,
  agentId: process.env.AGENT_ID!,
  accessKey: process.env.ACCESS_TOKEN!,
  // 默认: https://{envId}.api.tcloudbasegateway.com/v1/aibot/bots/{agentId}
});

const agent = await client.createAgent({ name: "Reviewer" });
const session = await client.createSession({ agentId: agent.id });

for await (const record of client.streamSessionEvents(session.id)) {
  console.log(record.event.type, record.event);
}

await client.sendSessionEvent(session.id, {
  type: "user.message",
  commandId: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  text: "Hello",
});
```

高层封装：`ManagedAgents`（`sessions` / `agents` / `environments`）内部同样走 `ManagedAgentsClient`。

E2E 验收：`tests/managed-agents/e2e-managed-agents-harness.test.mjs` 启动完整 `agent-runtime` + `ManagedAgentsClient` 走 HTTP/SSE（含网关前缀路径）。

## 本地研发

```bash
cd open-managed-agent
OAK_USE_MEMORY_STORE=1 npm run build
OAK_USE_MEMORY_STORE=1 node tests/managed-agents/unit.test.mjs
npm run build && OAK_USE_MEMORY_STORE=1 node tests/managed-agents/e2e-managed-agents-harness.test.mjs
```

无 FlexDB 凭证时 Store 自动退回内存（与 `OAK_USE_MEMORY_STORE=1` 相同逻辑）。

## 与沙箱的关系

- **不在 TRW 沙箱内嵌 mosoo driver**；箱内仍走 `POST /api/agents/{slug}/acp`（:9000）。
- OMA Host：vendor `createCmaHttpHandler` → `createHarnessManagedAgentsDispatcher` → `forwardAcpToSandbox`。
- TRW：单一 stdio ACP relay + 反向 RPC（permission / fs）。

## 已知缺口

- OpenCode 轮中崩溃仍可能丢未 checkpoint 的段（Layer B 既有缺口，未在本期修复）。
- `sessions.list()` 未在 Managed Agents HTTP 暴露；按 session id 检索即可。
