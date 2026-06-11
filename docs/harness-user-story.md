# Harness 用户故事

> 读者：选型、产品、集成方。  
> 本文只回答 **「我是谁、走哪条路」**；部署步骤见 [沙箱使用指南](./harness-tutorial.md)，MA HTTP 细节见 [Managed Agents 使用指南](./managed-agents-guide.md)。

同一份 CloudBase 部署（`runtime: harness`）上，可以走 **两条接入面**。它们服务不同角色，可以并存，但不要混用协议语义。

![Two client stories on one harness deploy](./diagrams/harness-two-stories.svg)

---

## 先选故事，再读文档

| 你的情况 | 读哪篇 |
|----------|--------|
| 我要在沙箱里跑编码 Agent，用 CLI 或现有 ACP 客户端 | **故事 A** → [harness-tutorial.md](./harness-tutorial.md) |
| 我的服务要按 Managed Agents 文档发 HTTP + 收 SSE | **故事 B** → [managed-agents-guide.md](./managed-agents-guide.md) |
| 还不确定 | 读完下面两个故事里的「我是谁」 |

**不适用本文两条路径**：`runtime: managed`（默认托管 Agent，无沙箱、无 MA HTTP）。见 [README 快速开始](../README.md)。

---

## 故事 A：选用 Harness 运行时

### 我是谁

- 开发者或运维，想尽快在**远程沙箱**里跑 OpenCode / Claude Code。
- 习惯 `magent run`、JSON-RPC ACP、或已有 ACP 兼容客户端（IDE 插件、内部工具链）。
- 不需要自己实现 REST 资源模型；会话由 ACP `session/new`、`session/prompt` 驱动。

### 我要什么

- 沙箱里能 bash、读写项目、跑完整 coding loop。
- 用 CloudBase CAM 鉴权，不必手搓网关 Token 协议。
- 可选：COS 工作区持久化、自定义 LLM、多引擎（`engine: opencode|claude|codebuddy`）。

### 典型一天

1. `magent login` → `tcb env use <envId>`；准备 `agent.yaml`（`runtime: harness` + `engine`）。
2. `magent agent:create` 部署 Runtime；记下 `CLOUDBASE_AGENT_ID`。
3. `magent run -a <agent-id> -m "在沙箱里执行 uname -a"` — 冷启动可能 1–3 分钟。
4. 需要长期编码任务时，按需开 COS、改 `model` / 自定义 LLM（见 [凭证](./harness-credentials.md)；CI 手填见 [Advanced settings](./harness-env.md#advanced-settings)）。

### 我不会做的事

- 不把 `api.anthropic.com` 或 ant CLI 指到这台 Agent（那是 Anthropic 云，不是 CloudBase Host）。
- 不在同一次集成里把 ACP 和 MA HTTP 当成同一套「会话 ID 规则」混用——底层虽共享沙箱，协议层是两条路。

### 下一步

| 文档 | 内容 |
|------|------|
| [harness-tutorial.md](./harness-tutorial.md) | 从零部署、第一次对话 |
| [harness-opencode.md](./harness-opencode.md) / [harness-claude-code.md](./harness-claude-code.md) | 按引擎进阶 |
| [harness-credentials.md](./harness-credentials.md) | CAM、可选 LLM、RoleArn |

---

## 故事 B：使用 MA HTTP 协议接入

### 我是谁

- 应用后端、自动化平台、或已按 [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents) 形状写过一版客户端的团队。
- 需要 **REST + SSE**：创建 Agent / Environment / Session，订阅事件流，发送 `user.message`、处理 HITL。
- 希望用 `open-managed-agent-sdk` 或自研 HTTP，而不是嵌 ACP JSON-RPC。

### 我要什么

- 与官方 MA **协议面**对齐（路径、事件类型、beta header），鉴权换成 **CloudBase Bearer（CAM）**。
- 会话与事件可审计、可重连 SSE；Environment / Agent 的 `metadata` 参与合并有效配置再起箱。
- 执行仍在 **AGS 沙箱**，不是把算力搬到 Anthropic 云。

### 典型一天

1. 按 [harness-tutorial.md](./harness-tutorial.md) 部署 **`runtime: harness`** 的 Agent（与故事 A 同一份部署基线）。
2. 用 CAM 换网关 Bearer Token；`createManagedAgentsClient({ envId, agentId, accessKey })`。
3. `createEnvironment` → `createAgent` → `createSession`；**先** `streamSessionEvents`，**再** `sendSessionEvent(user.message)`。
4. 收到 `session.status_idle` 结束本轮；需要人确认时走 `user.tool_confirmation`。
5. 收尾 `deleteSession`。

### 谁能用、谁不能

| 方式 | 结论 |
|------|------|
| `open-managed-agent-sdk` / 自研 HTTP | ✅ |
| 已按 MA 文档写的应用（换 base URL + 鉴权） | ✅ 大部分流程 |
| ant CLI、Anthropic 官方 SDK 默认 endpoint | ✗ |
| `magent run`（ACP） | 另一条路，见故事 A |

协议覆盖一览见 [managed-agents-guide.md#协议实现了什么一览](./managed-agents-guide.md#协议实现了什么一览)。

### 我不会做的事

- 不把 `runtime: managed` 当成 MA HTTP Host（托管路径只有 ACP）。
- 不期待 `sessions.list()` 或官方预览能力（Multiagent / Outcomes）已在本 Host 实现——见 [已知缺口](./managed-agents-http.md#已知缺口)。

### 下一步

| 文档 | 内容 |
|------|------|
| [managed-agents-guide.md](./managed-agents-guide.md) | SDK 示例、端点、对齐表 |
| [managed-agents-http.md](./managed-agents-http.md) | 协议与实现（研发向） |
| [harness-tutorial.md](./harness-tutorial.md) | 部署沙箱 Agent（前置条件） |

---

## 两条故事如何并存

- **运维 / 开发自测** → `magent run`（ACP）· 故事 A  
- **线上业务流量** → `/v1/sessions/...`（MA HTTP）· 故事 B  

- **配置基线**：部署时的 `agent.yaml` 是 Host 进程默认值；MA 的 Environment / Agent `metadata` 在 `createSession` 时合并进有效配置（见 [managed-agents-guide 概念对照](./managed-agents-guide.md#概念对照官方-ma--cloudbase--oma)）。
- **隔离边界**：CloudBase `envId` 是平台租户；MA 的 Environment / Agent 是会话编排与配置源，不是 `envId` 本身。

---

## 研发验收（内部）

场景矩阵与命令见仓库根 [Harness一条龙.md](../../Harness一条龙.md) 与 [scenarios/README.md](../scripts/harness/scenarios/README.md)。与对客路径对应关系：

| 对客故事 | 验收侧重 |
|----------|----------|
| A · Harness 运行时 | `test:full`、`harness:cloud`（ACP smoke） |
| B · MA HTTP | `npm test`（stub）+ `npm run ma-protocol`（云上） |
| A · Claude 旁路 | `npm run harness:local-claude` 或 `harness:local-all` |

---

## 相关文档

- [沙箱使用指南](./harness-tutorial.md)
- [Managed Agents HTTP 使用指南](./managed-agents-guide.md)
- [凭证说明](./harness-credentials.md)
- [架构（研发）](./harness-architecture.md)
