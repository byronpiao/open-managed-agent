# Claude Managed Agents HTTP — 使用指南

在腾讯云 CloudBase 上，用与 [Anthropic Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents) **同形的 HTTP API**，驱动**远程沙箱内**的编码 Agent（OpenCode / Claude Code）。

> **适用场景**：你要按官方 MA 文档或 SDK 习惯集成（`agents` / `environments` / `sessions` / SSE 事件流），而不是走 `magent run` 的 ACP 通道。  
> **不适用**：默认托管 Agent（`runtime: managed`）— 该路径仍只有 ACP，见 [README](../README.md#快速开始)。

协议细节与研发说明见 [managed-agents-http.md](./managed-agents-http.md) · 沙箱部署见 [harness-tutorial.md](./harness-tutorial.md)。

---

## 这是什么？

**Claude Managed Agents** 是 Anthropic 的托管 Agent 产品：用 REST + SSE 管理 Agent 配置、运行环境、会话与事件流。官方客户端包括：

- **[ant CLI](https://platform.claude.com/docs/en/managed-agents/quickstart)** — 运维与脚本（连 `api.anthropic.com`）
- **官方 TypeScript / Python SDK** — 应用集成
- **任意 HTTP 客户端** — `curl` + SSE

**OpenManagedAgent（OMA）** 在 `runtime: harness` 上提供**形状兼容**的 HTTP 面，后端是 **CloudBase 网关 + AGS 远程沙箱**，不是 Anthropic 云。你可以：

- 用 **`open-managed-agent-sdk`** 的 `createManagedAgentsClient` 或高层 `ManagedAgents` 类对话；
- 或按 [官方 API 文档](https://platform.claude.com/docs/en/managed-agents) 自行发 HTTP，把 base URL 换成 CloudBase 网关即可。

---

## 和 `magent run` 怎么选？

| | **Managed Agents HTTP**（本文） | **`magent run` / REPL** |
|--|--------------------------------|-------------------------|
| 协议 | REST `/v1/agents|sessions|...` + SSE | JSON-RPC `POST .../acp` |
| 典型用户 | 应用、自动化、对接 MA 生态 | 终端快速试跑、运维 |
| 需要 SDK | 推荐 `open-managed-agent-sdk` | 不需要（CLI 内置） |
| Runtime | **仅 `runtime: harness`** | managed 与 harness 均支持 |

两条路可以并存：同一套 harness 部署上，`magent run` 走 ACP，你的服务走 `/v1/sessions`。

---

## 快速开始

### 1. 部署沙箱 Agent

与 [沙箱使用指南](./harness-tutorial.md) 相同：凭证 → `agent.yaml`（`runtime: harness`）→ `magent agent:create`。

```bash
magent login
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai

cp docs/examples/agent.sandbox.opencode.min.yaml ./agent.sandbox.yaml
cd packages/agent-runtime && npm run build && cd ../..

magent agent:create \
  --name my-ma-agent \
  --runtime harness \
  --engine opencode \
  --file ./agent.sandbox.yaml \
  --code ./packages/agent-runtime \
  -e "$CLOUDBASE_ENV_ID"

export CLOUDBASE_AGENT_ID=agent-xxxxxxxx
```

凭证说明：[harness-credentials.md](./harness-credentials.md)。

### 2. 用 SDK 创建会话并发消息

网关鉴权使用 **CAM 换取的 Bearer token**（与 `magent run` 同源，不必使用 Anthropic API Key）。

```typescript
import { createManagedAgentsClient } from "open-managed-agent-sdk";

const client = createManagedAgentsClient({
  envId: process.env.CLOUDBASE_ENV_ID!,
  agentId: process.env.CLOUDBASE_AGENT_ID!,
  accessKey: process.env.ACCESS_TOKEN!, // CAM clientCredential JWT
});

// 1. 创建 Agent / Environment / Session（与官方 MA 流程一致）
const agent = await client.createAgent({ name: "Reviewer" });
const env = await client.createEnvironment({ name: "default" });
const session = await client.createSession({
  agentId: agent.id,
  environmentId: env.id,
});

// 2. 先订阅 SSE，再 POST user.message（避免漏事件）
const ac = new AbortController();
const stream = (async () => {
  for await (const record of client.streamSessionEvents(session.id, { signal: ac.signal })) {
    if (record.direction !== "outbound") continue;
    console.log(record.event.type, record.event);
    if (record.event.type === "session.status_idle") break;
  }
})();

await client.sendSessionEvent(session.id, {
  type: "user.message",
  commandId: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  text: "在沙箱里执行 uname -a",
});

await stream;
ac.abort();

// 3. 结束会话
await client.deleteSession(session.id);
```

**高层封装**（把 MA 事件映射为 `chunk` / `done` 等）：`new ManagedAgents({ envId, agentId, accessKey })` 的 `sessions.prompt()`，内部同样走 Managed Agents HTTP。

### 3. 端点与请求头

| 场景 | Base URL |
|------|----------|
| 经 CloudBase 网关（推荐） | `https://{envId}.api.tcloudbasegateway.com/v1/aibot/bots/{agentId}` |
| 本地研发（直连 runtime） | `http://127.0.0.1:9000` |

资源路径挂在 base 后的 `/v1/...`：

| 资源 | 方法 | 路径 |
|------|------|------|
| Agent | POST / GET | `/v1/agents` · `/v1/agents/{id}` |
| Environment | POST / GET / DELETE | `/v1/environments` · `/v1/environments/{id}` |
| Session | POST / GET / DELETE | `/v1/sessions` · `/v1/sessions/{id}` |
| Events | GET / POST | `/v1/sessions/{id}/events`（GET + `Accept: text/event-stream` 为 SSE） |

每个请求需要：

```http
Authorization: Bearer <token>
anthropic-beta: managed-agents-2026-04-01
Content-Type: application/json
```

人机确认（HITL）：SSE 上出现 `session.status_idle` 且带 `requiresAction` 时，POST `user.tool_confirmation` 继续，与官方 MA 事件模型一致。

---

## 与 Anthropic 官方的对齐程度

OMA 实现的是 **协议面（HTTP + 事件形状）对齐**，不是 **把 `api.anthropic.com` 换成 CloudBase 就能用 ant**。

| 能力 | Anthropic 官方 | OMA（harness） |
|------|----------------|----------------|
| `/v1/agents` CRUD | ✓ | ✓（POST/GET/list） |
| `/v1/environments` | ✓ | ✓ |
| `/v1/sessions` | ✓ | ✓（无 list 接口） |
| `/v1/sessions/{id}/events` SSE | ✓ | ✓ |
| `user.message` / `user.tool_confirmation` / `user.interrupt` | ✓ | ✓ |
| Beta header `managed-agents-2026-04-01` | ✓ | ✓ |
| 鉴权 | Anthropic `x-api-key` | CloudBase Bearer（CAM） |
| 执行环境 | Anthropic 托管容器 | 腾讯云 AGS + 箱内 OpenCode/Claude |
| **ant CLI 直连** | ✓ | ✗（端点与密钥不同） |
| `runtime: managed` 托管 Agent | N/A（官方无此模式） | ✗（仅 ACP，无 MA HTTP） |
| `sessions.list()` | 视官方版本 | ✗ |
| Multiagent / Outcomes 等预览能力 | 需单独申请 | ✗ |
| Agent 模型字段与官方 toolset 全量 | 官方定义 | 部分：会话行为由 `agent.yaml` + 沙箱引擎决定 |

**结论**：已有按官方 MA HTTP 写的应用，可把 base URL 和鉴权换成 CloudBase，在 **harness 沙箱 Agent** 上复用大部分会话流程；**不能**把 `ant` 或 Anthropic API Key 直接指向 OMA。

更完整的缺口列表见 [managed-agents-http.md#已知缺口](./managed-agents-http.md#已知缺口)。

---

## 架构概览（实现结构）

对集成方，只需记住：**你的 HTTP 请求在网关 Runtime 终止，真正执行在远程沙箱。**

```text
你的应用 / SDK (ManagedAgentsClient)
    │  HTTPS  /v1/sessions/.../events  (SSE)
    ▼
CloudBase 网关  …/v1/aibot/bots/{agentId}/v1/*
    ▼
OMA agent-runtime  (runtime=harness)
    │  Managed Agents HTTP 层（协议、存储、SSE）
    │  → 转为 harness 调度（起沙箱、ACP 转发）
    ▼
AGS 远程沙箱  (OpenCode / Claude Code)
    │  箱内仍走 ACP :9000
    ▼
工具执行、文件读写、模型调用
```

**会话数据两层**（仅在与持久化/恢复相关时需要了解）：

| 层 | 作用 |
|----|------|
| **协议事件**（FlexDB `managed_agents_*`） | 给 MA 客户端 SSE 重连、审计 |
| **引擎状态**（`harness_*` 集合） | 沙箱崩溃后恢复 OpenCode/Claude 会话 |

`session.id` 与内部 `acpSessionId` 一一对应。

研发向细节（vendor 协议层、dispatcher、FlexDB 集合名）见 [managed-agents-http.md](./managed-agents-http.md) 与 [harness-architecture.md](./harness-architecture.md)。

---

## 常见问题

**Q：README 里的 `ManagedAgents` 示例，托管 Agent 能用吗？**  
A：默认 `runtime: managed` 走 **ACP**，不是 MA HTTP。MA HTTP 指南仅适用于 **`runtime: harness`**。托管场景请用 `magent run` 或 SDK 的 `AcpClient`。

**Q：和 Anthropic 官方 SDK 能混用吗？**  
A：不能把 `api.anthropic.com` 的配置原样指向 OMA。请用 **`open-managed-agent-sdk`**，或自写 HTTP 并替换 base URL 与 Bearer token。

**Q：第一次发消息很慢？**  
A：沙箱冷启动与预热需要 1–3 分钟，与 `magent run` 相同。可先 `magent run` 暖箱，或接受首条延迟。

**Q：本地如何自测？**  
A：`OAK_USE_MEMORY_STORE=1 npm run build` 后运行 `tests/managed-agents/e2e-managed-agents-harness.test.mjs`（完整 runtime + SDK）。见 [managed-agents-http.md](./managed-agents-http.md#本地研发)。

---

## 相关文档

- [沙箱 Agent 上手](./harness-tutorial.md)
- [凭证说明](./harness-credentials.md)
- [OpenCode / Claude Code 引擎](./harness-opencode.md) · [harness-claude-code.md](./harness-claude-code.md)
- [协议与实现细节](./managed-agents-http.md)
- [Anthropic 官方 Quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart)

---

## 概念对照（官方 MA ↔ CloudBase / OMA）

读 API 文档时最容易混淆的是：**HTTP 路径和事件形状与官方一致，但底层资源并不一一对应**。下表说明「协议里有什么」和「CloudBase 里真正驱动行为的是什么」。

| 官方 / 协议概念 | OMA 里存哪 | 是否改变沙箱或模型行为 | 说明 |
|-----------------|------------|------------------------|------|
| **Environment**（`networking`、`packages` 等） | FlexDB `managed_agents_environments` + 进程内缓存 | **否** | 仅满足 MA CRUD / 会话元数据；**不会**选择 AGS 镜像、装包或改网络。沙箱能力由 **AGS 沙箱工具 + TRW 镜像 + `agent.yaml`** 决定。 |
| **Agent**（`POST /v1/agents`） | FlexDB `managed_agents_agents` | **否** | 协议侧 Agent 记录（name、metadata）。真正生效的是 **`magent agent:create` 部署的 Agent** 及其 **`agent.yaml`（model、system、tools）**。 |
| **Session** | `managed_agents_sessions` + `harness_sessions`（同 id） | **是** | `session.id` = `acpSessionId`；起箱、ACP 转发、恢复都绑在这条 id 上。 |
| **Events**（`user.message`、SSE 出站） | `managed_agents_session_events` + harness sync | **是** | 对话与 HITL 的主通道；Layer A 给 MA 客户端，Layer B 给引擎恢复。 |
| **CloudBase Agent**（`CLOUDBASE_AGENT_ID`） | 云函数 / 云托管 + `AGENT_CONFIG` | **是** | 网关路由、`agent.yaml`、runtime 模式（managed / harness）的载体；**≠** MA API 里的 `agentId` 字符串。 |
| **ant CLI / `api.anthropic.com`** | — | — | 官方托管；**不能**把 endpoint 或 API Key 直接指向 OMA。 |

**集成建议**

- 可以按官方教程创建 Environment / Agent 以通过校验，但**不必指望** `config.packages` 等字段在 CloudBase 上生效。
- 行为以 **`agent.yaml` + 已部署的 harness Agent** 为准；MA 的 `createAgent` 更适合「会话编排、多 agent 元数据」而非替换部署配置。
- 若只需要对话，最小路径：`createSession({ agentId })`（`environmentId` 可省略，对沙箱无实质影响）。
