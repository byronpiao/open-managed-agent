# OpenManagedAgent

一个兼容 Anthropic Managed Agents API 的 TypeScript SDK + Runtime，基于腾讯云 CloudBase 构建。

## 它是什么

OpenManagedAgent 让你用与 [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents) 兼容的 API 构建 AI Agent，底层使用 CloudBase 云函数 + 混元大模型。

```typescript
import ManagedAgents from "open-managed-agent";

const client = new ManagedAgents({
  envId: "<env-id>",
  agentId: "<agent-id>",
  accessKey: "<your-access-key>",
});

const session = await client.sessions.create({ title: "Code review" });

for await (const event of client.sessions.prompt(session.id, "Review this PR")) {
  if (event.type === "chunk") process.stdout.write(event.text);
}
```

---

## 快速开始

### 前置条件

- Node.js ≥ 20
- 腾讯云 CloudBase 环境（[创建环境](https://tcb.cloud.tencent.com)）

### 1. 安装 `magent` CLI

**方式一：从源码安装（开发中）**

```bash
git clone <this-repo>
cd cloudbase-managed-agent
npm install          # 同时安装内置的 @cloudbase/cli（无需单独安装 tcb）
npm run build        # 构建 SDK 和 Runtime
npm link             # 全局注册 magent 命令
```

**方式二：从 npm 安装（发布后可用）**

```bash
npm install -g open-managed-agent
```

> `@cloudbase/cli`（tcb）作为内置依赖随 `open-managed-agent` 一起安装，**不需要手动安装 tcb**。

### 2. 登录 CloudBase

```bash
# 交互式登录（浏览器授权）
magent login

# 或使用 API Key 登录
magent login --apiKeyId <SecretId> --apiKey <SecretKey>
```

等效于 `tcb login`，但无需单独安装 tcb。

### 3. 查看可用环境

```bash
magent env:list
```

### 4. 部署 Agent

```bash
# 创建并部署（内部自动调用 tcb agent create）
magent agent:create \
  --name my-agent \
  --system "You are a helpful coding assistant." \
  -e <your-env-id>      # 也可用 --env <your-env-id>
```

如果不带 `-e` 参数且未设置 `CLOUDBASE_ENV_ID`，`magent` 会自动列出可用环境并报错提示。

> 首次部署前需构建代码：`cd packages/agent-runtime && npm run build`

### 5. 配置 Agent

部署完成后，使用 `magent agent:update` 配置 Agent 的行为（不需要重新部署代码，约 8 秒生效）：

```bash
# 设置环境变量（后续命令省略重复传参）
export CLOUDBASE_ENV_ID=<your-env-id>
export CLOUDBASE_AGENT_ID=<agent-id>
export CLOUDBASE_ACCESS_KEY=<your-jwt-token>

# 更新 system prompt
magent agent:update --system "You are a helpful coding assistant."

# 或从 YAML 文件加载完整配置
magent agent:update --file ./agent.yaml
```

### 6. 使用 SDK 对话

```typescript
import ManagedAgents from "open-managed-agent";

const client = new ManagedAgents({
  envId: "<env-id>",
  agentId: "<agent-id>",
  accessKey: "<your-access-key>",
});

// 创建会话 → 发送消息 → 流式获取结果
const session = await client.sessions.create({ title: "Hello" });
for await (const event of client.sessions.prompt(session.id, "Hello!")) {
  if (event.type === "chunk") process.stdout.write(event.text);
  if (event.type === "done") console.log(`\n[${event.stopReason}]`);
}
```

---

## Agent 配置

Agent 通过 `agent.yaml` 文件配置，结构兼容 [Anthropic Agent Setup](https://platform.claude.com/docs/en/managed-agents/agent-setup)。

### 完整配置示例

```yaml
# agent.yaml
name: My Coding Agent
model: hunyuan-t1-latest
system: |
  You are a helpful coding assistant.
  You can read, write, and execute code.
description: A coding agent with file system and shell access.

# 工具配置
tools:
  # 内置工具集（bash, read_file, write_file, list_files）
  - type: agent_toolset
    default_config:
      enabled: true
      permission_policy:
        type: always_allow          # always_allow | always_ask
    configs:
      - name: bash
        permission_policy:
          type: always_ask          # bash 需要用户确认
      - name: web_fetch
        enabled: false              # 禁用 web_fetch

  # MCP 工具集（远程 MCP 服务器提供的工具）
  - type: mcp_toolset
    mcp_server_name: github
    default_config:
      permission_policy:
        type: always_allow
    configs:
      - name: delete_repository
        enabled: false              # 禁止危险操作

  # 自定义工具（客户端执行，服务端只声明）
  - type: custom
    name: query_database
    description: Execute a read-only SQL query
    input_schema:
      type: object
      properties:
        sql:
          type: string
          description: The SQL SELECT query to execute
      required: [sql]

# MCP 服务器声明
mcp_servers:
  - type: url
    name: github
    url: https://api.githubcopilot.com/mcp/

# Skills（领域知识）
skills:
  - name: code-review
    description: Code review best practices
    source: ./skills/code-review.md

# 自定义元数据
metadata:
  team: backend
  version: "1.0"

# 存储配置（可选）
sessions_collection: acp_sessions   # Session 存储的集合名，启动时自动创建
```

### 配置字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Agent 名称 |
| `model` | string | 模型名。可选：`hunyuan-t1-latest`、`deepseek-v3.2` 等 |
| `system` | string | System prompt，定义 Agent 行为 |
| `description` | string | Agent 描述 |
| `tools` | array | 工具配置（见下方详细说明） |
| `mcp_servers` | array | MCP 服务器声明 |
| `skills` | array | 领域知识文件 |
| `sessions_collection` | string | Session 存储的 NoSQL 集合名（默认 `acp_sessions`，启动时自动创建） |
| `metadata` | object | 自定义键值对 |

### 工具类型

| 类型 | 说明 | 执行方 |
|------|------|--------|
| `agent_toolset` | 内置工具（bash, read_file, write_file, list_files） | 服务端 |
| `mcp_toolset` | 远程 MCP 服务器提供的工具 | 服务端代理 |
| `custom` | 自定义工具，Agent 请求调用后由客户端执行 | 客户端 |

### Permission Policy

| 策略 | 行为 |
|------|------|
| `always_allow` | 工具自动执行，不需要确认 |
| `always_ask` | 暂停等待客户端发送 `user.tool_confirmation` 事件 |

---

## 更新 Agent 配置（`magent agent:update`）

**不需要重新部署代码。** 约 8 秒生效：

```bash
# 更新 system prompt
magent agent:update --system "You are a strict code reviewer."

# 更新模型
magent agent:update --model deepseek-v3.2

# 从 YAML 文件加载完整配置
magent agent:update --file ./new-config.yaml

# 添加 MCP 服务器
magent agent:update \
  --mcp-servers '[{"type":"url","name":"linear","url":"https://mcp.linear.app/sse"}]'

# 修改工具权限
magent agent:update \
  --tools '[{"type":"agent_toolset","configs":[{"name":"bash","permission_policy":{"type":"always_ask"}}]}]'
```

### 工作原理

```
magent agent:update --system "new prompt"
    │
    ├─ 1. 从运行中的 Agent 获取当前配置（via ACP initialize）
    ├─ 2. Merge 用户指定的字段（只改你传的，其余保留）
    ├─ 3. 序列化为 AGENT_CONFIG_B64（Base64 编码）
    └─ 4. 写入环境变量: tcb agent update <id> --env "..." (~8s)
```

### 配置加载优先级（Runtime 内部）

```
AGENT_CONFIG / AGENT_CONFIG_B64 环境变量    ← magent agent:update 写入
        ↓ fallback
agent.yaml 文件                             ← 随代码部署
        ↓ fallback
AGENT_MODEL + AGENT_SYSTEM 环境变量         ← 向后兼容
```

---

## CLI 参考（`magent`）

`magent` 是本项目提供的 CLI 工具，用于管理 Agent 配置和进行对话。所有未知命令会**透明代理**到内置的 `tcb` CLI（无需单独安装 tcb）。

### 安装方式

```bash
# 从源码
npm install && npm link

# 从 npm（发布后）
npm install -g open-managed-agent
```

### 短标志（Short Flags）

所有命令均支持短标志缩写：

| 短标志 | 长标志 | 说明 |
|--------|--------|------|
| `-e <envId>` | `--env <envId>` | CloudBase 环境 ID |
| `-a <agentId>` | `--agent <agentId>` | Agent ID |
| `-i <id>` | `--id <id>` | 资源 ID |
| `-m <msg>` | `--message <msg>` | 消息文本 |
| `-s <id>` | `--session <id>` | Session ID |
| `-f <path>` | `--file <path>` | 文件路径 |
| `-n <name>` | `--name <name>` | 名称 |

### 环境变量

| 变量 | 说明 |
|------|------|
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID（可用 `-e` 覆盖） |
| `CLOUDBASE_AGENT_ID` | 默认 Agent ID（可免 `--id`） |
| `CLOUDBASE_ACCESS_KEY` | API Key（JWT Token） |
| `CLOUDBASE_SERVER_URL` | 自定义 Server URL |

### 命令列表

```bash
# ─── 登录 / 环境 ──────────────────────────────────────────
magent login                              # 登录（代理 tcb login）
magent login --apiKeyId <AK> --apiKey <SK>  # API Key 登录
magent env:list                           # 列出 CloudBase 环境

# ─── Agent 管理 ───────────────────────────────────────────
magent agent:create  --name <name> [options]  # 创建并部署 Agent
magent agent:list   [-e <envId>]              # 列出所有 Agents
magent agent:get    --id <id>   [-e <envId>]  # 查看 Agent 详情
magent agent:delete --id <id>   [-e <envId>]  # 删除 Agent

# ─── Agent 配置 ───────────────────────────────────────────
magent agent:update  [--id <id>] [options]   # 更新配置（~8s，不重新部署）
  --system <prompt>       更新 system prompt
  --model <model>         更新模型
  --name <name>           更新名称
  --file <path>           从 YAML/JSON 文件加载配置
  --tools <json>          替换 tools 数组
  --mcp-servers <json>    替换 mcp_servers 数组
  --skills <json>         替换 skills 数组

# ─── 对话 ─────────────────────────────────────────────────
magent run   -a <id> -m "..."    # 一次性对话（自动创建/销毁 session）
magent chat  -s <id> -m "..."    # 向已有 session 发消息
magent repl  -a <id>             # 交互式 REPL

# ─── Session 管理 ─────────────────────────────────────────
magent session:create --agent <id>
magent session:list
magent session:get    --id <session-id>
magent session:delete --id <session-id>

# ─── 透明代理（任意 tcb 命令）────────────────────────────
magent functions:list -e <envId>    # 等效 tcb functions:list
magent storage:list                 # 等效 tcb storage:list
# 所有未识别命令均透明转发给内置 tcb CLI
```

### 缺少 envId 时的行为

若命令需要 `-e <envId>` 但未提供且未设置 `CLOUDBASE_ENV_ID`，`magent` 会自动列出可用环境并给出提示：

```
Error: -e <envId> is required (or set CLOUDBASE_ENV_ID)

Available CloudBase environments:
┌─────────────────────────────────────────────────────────────────────────────────────────────────
│ EnvId                          │ EnvName              │ Status    │ PackageName │ CreateTime          │
├─────────────────────────────────────────────────────────────────────────────────────────────────
│ prod-abc123                    │ 生产环境              │ NORMAL    │ postpay     │ 2024-01-01 ...      │
└─────────────────────────────────────────────────────────────────────────────────────────────────
```

---

## SDK 参考

### 安装

```bash
npm install open-managed-agent
```

### 初始化

```typescript
import ManagedAgents from "open-managed-agent";

const client = new ManagedAgents({
  envId: "your-env-id",
  agentId: "your-agent-id",
  accessKey: "your-jwt-token",  // 可选
});
```

### Sessions API

```typescript
// 创建会话
const session = await client.sessions.create({ title: "My task" });

// 发送消息（流式响应）
for await (const event of client.sessions.prompt(session.id, "Hello")) {
  switch (event.type) {
    case "chunk":     process.stdout.write(event.text); break;
    case "tool_call": console.log(`Tool: ${event.name} [${event.status}]`); break;
    case "error":     console.error(event.message); break;
    case "done":      console.log(`\nDone: ${event.stopReason}`); break;
  }
}

// 多轮对话（上下文自动保留）
for await (const event of client.sessions.prompt(session.id, "Now add tests")) {
  if (event.type === "chunk") process.stdout.write(event.text);
}

// 列出会话
const list = await client.sessions.list();

// 获取历史
const history = await client.sessions.history(session.id);
console.log(history.messages);

// 删除
await client.sessions.delete(session.id);
```

### 流式事件类型

| 事件 | 字段 | 说明 |
|------|------|------|
| `chunk` | `text` | 文本增量 |
| `tool_call` | `name`, `status`, `result?` | 工具调用（pending → completed） |
| `error` | `message` | 错误 |
| `done` | `stopReason` | 完成（`end_turn` / `cancelled`） |

---

## 架构

```
┌─────────────────────┐         ┌──────────────────────────────────────┐
│   Client            │         │   CloudBase SCF Web Function         │
│   (SDK / CLI)       │         │   (packages/agent-runtime)           │
│                     │         │                                      │
│  ManagedAgents      │  HTTPS  │  Express Server                      │
│    .sessions        ├────────►│    ├─ /v1/aibot/bots/:id/acp (ACP)  │
│    .prompt()        │         │    ├─ /send-message (AG-UI SSE)      │
│                     │◄────────┤    └─ /healthz                       │
│  NDJSON Stream      │         │                                      │
└─────────────────────┘         │  HunyuanAgent                        │
                                │    ├─ CloudBase AI (hunyuan/deepseek)│
                                │    ├─ 内置工具 (bash/file)            │
                                │    └─ MCP 代理 (远程工具)             │
                                │                                      │
                                │  NoSQL DB: acp_sessions              │
                                └──────────────────────────────────────┘
```

### 两层操作说明

`magent` 是唯一对外的 CLI。内部实现上：

| 命令 | 内部调用 | 耗时 | 频率 |
|------|----------|------|------|
| `magent agent:create` | `tcb agent create`（上传代码包） | ~60s | 首次部署 |
| `magent agent:update` | `tcb agent update --env`（只更新环境变量） | ~8s | 日常配置 |
| `magent agent:delete` | `tcb agent delete`（删除云函数） | ~5s | 清理 |

> 你不需要直接使用 `tcb` CLI（除非调试底层问题）。

### 协议说明

- **ACP (Agent Client Protocol)**: JSON-RPC 2.0 over HTTP + NDJSON 流式通知。SDK 默认使用此协议。
- **AG-UI**: 兼容 CopilotKit 的 SSE 协议，通过 `/send-message` 端点访问。
- **网关路由**: CloudBase 网关将完整路径 `/v1/aibot/bots/{agentId}/acp` 透传给 Express。

---

## 部署详解

### 首次部署（`magent agent:create`）

```bash
# 1. 构建 runtime 代码
cd packages/agent-runtime && npm run build && cd ../..

# 2. 部署
magent agent:create --name my-agent --env <env-id>

# 3. 等待就绪
magent agent:get --id <agent-id>
```

`agent:create` 会自动打包 `packages/agent-runtime` 代码并部署为云函数。

可通过 `--code` 指定自定义代码路径，`--file` 指定初始配置文件：

```bash
magent agent:create \
  --name my-agent \
  --file ./my-agent.yaml \
  --code ./packages/agent-runtime \
  --env <env-id>
```

### 配置更新（`magent agent:update`）

日常改配置不需要重新部署代码：

```bash
magent agent:update --system "New prompt" --model deepseek-v3.2
magent agent:update --file ./new-config.yaml
```

### 代码更新

当 runtime 源码变更时（新功能、bug fix），需要重新部署：

```bash
cd packages/agent-runtime && npm run build && cd ../..
magent agent:create --name my-agent --env <env-id>
# 或直接用 tcb:
# tcb agent update <agent-id> --code /path/to/deploy -e <env-id>
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CLOUDBASE_ENV_ID` | **必需**。CloudBase 环境 ID | - |
| `AGENT_CONFIG_B64` | 完整 JSON 配置（Base64，由 `magent agent:update` 写入） | - |
| `AGENT_CONFIG` | 完整 JSON 配置（明文，手动设置时可用） | - |
| `AGENT_MODEL` | 覆盖模型名 | `hunyuan-t1-latest` |
| `AGENT_SYSTEM` | 覆盖 system prompt | `You are a helpful assistant.` |
| `AGENT_NAME` | 覆盖 agent 名称 | `open-managed-agent` |
| `PORT` | 服务监听端口 | `9000` |

---

## 支持的模型

| Provider | 模型 | 推荐 |
|----------|------|------|
| `hunyuan-exp` | `hunyuan-t1-latest`, `hunyuan-turbos-latest`, `hunyuan-2.0-instruct-20251111` | ✅ `hunyuan-t1-latest` |
| `deepseek` | `deepseek-v3.2`, `deepseek-r1-0528` | ✅ `deepseek-v3.2` |

---

## 项目结构

```
cloudbase-managed-agent/
├── packages/
│   ├── sdk/                  # 客户端 SDK (open-managed-agent)
│   │   └── src/
│   │       ├── index.ts      # ManagedAgents 入口
│   │       ├── sessions.ts   # Sessions API (create/prompt/list/delete)
│   │       ├── acp-client.ts # ACP JSON-RPC 客户端
│   │       └── types.ts      # 类型定义
│   └── agent-runtime/        # 服务端运行时（部署到 SCF）
│       ├── src/
│       │   ├── index.ts      # Express 服务入口
│       │   ├── config.ts     # 配置加载（AGENT_CONFIG > YAML > env vars）
│       │   ├── acp-endpoint.ts # ACP JSON-RPC 处理
│       │   └── hunyuan-agent.ts # AI Agent 核心逻辑
│       ├── agent.yaml        # 默认配置模板
│       └── scf_bootstrap     # SCF 启动脚本
├── tests/
│   ├── integration.ts        # SDK 集成测试（ACP 全流程）
│   └── agui-integration.ts   # AG-UI 协议测试
├── magent.mjs                # CLI 工具
└── README.md
```

---

## License

MIT
