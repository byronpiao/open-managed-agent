# OpenManagedAgent

一个兼容 Anthropic Managed Agents API 的 TypeScript SDK + Runtime，基于腾讯云 CloudBase 构建。

## 它是什么

OpenManagedAgent 让你用与 [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents) 兼容的 API 构建 AI Agent，底层使用 CloudBase 云函数 + 混元大模型。

```typescript
import ManagedAgents from "open-managed-agent-sdk";

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

## 选择路径

| | **托管 Agent**（默认） | **沙箱内 Agent**（`runtime: harness`） |
|---|------------------------|----------------------------------------|
| 执行位置 | 网关 Runtime（SCF / 云托管） | **AGS 远程沙箱**内的 OpenCode / Claude Code |
| 典型场景 | 对话、MCP、轻量工具 | 远程 bash、读写项目文件、完整编码环境 |
| 默认模型 | CloudBase 混元 / DeepSeek 等 | CloudBase AI **`hy3-preview`**（环境 API Key） |
| 配置要点 | `agent.yaml` 省略 `runtime` | `runtime: harness` + `engine: opencode` 或 `claude` |
| 详细文档 | 下文 [快速开始](#快速开始) | [用户故事](./docs/harness-user-story.md) → [使用指南](./docs/harness-tutorial.md) |

---

## 凭证速查（沙箱 Agent）

详见 [docs/harness-credentials.md](./docs/harness-credentials.md)。

| 步骤 | 做法 |
|------|------|
| 日常 | `magent login` + `magent env list` +`magent env use <环境 ID>` |
| 部署前（推荐） | `npm run check:harness` |
| 部署后 | 记下 `CLOUDBASE_AGENT_ID` |
| CI / 无交互 | [凭证 · CI 与流水线](./docs/harness-credentials.md#ci-与无交互部署) |

网关鉴权由 CAM **自动换取**，无需单独配置 API Key。

---

## 快速开始

### 前置条件

- Node.js ≥ 20
- 腾讯云 CloudBase 环境（[创建环境](https://tcb.cloud.tencent.com)）
- 已开通 **CloudBase AI** 并启用体验模型（沙箱 Agent 默认 `hy3-preview` 时需要）

### 1. 安装 `magent` CLI

**方式一：从源码安装（开发中）**

```bash
git clone <this-repo>
cd open-managed-agent
npm install          # 同时安装内置的 @cloudbase/cli（无需单独安装 tcb）
npm run build        # 构建 SDK 和 Runtime
npm link             # 全局注册 magent 命令
```

**方式二：从 npm 安装（发布后可用）**

```bash
npm install -g open-managed-agent
```

> `@cloudbase/cli`（tcb）作为内置依赖随 `open-managed-agent` 一起安装，**不需要手动安装 tcb**。

### 2. 登录并选环境

```bash
magent login                    # 浏览器授权；等同 tcb login，共用 ~/.config/.cloudbase/
magent env use <your-env-id>    # 选默认环境；可省略后续命令的 -e

# CI / 无交互：magent login --apiKeyId <id> --apiKey <key>
# 或手填变量，见 docs/harness-credentials.md#ci-与无交互部署
```

### 3. 查看可用环境（可选）

```bash
magent env:list
```

### 4. 部署 Agent

**托管 Agent（默认）** — 思考与工具在网关 Runtime 执行：

```bash
# 创建并部署（内部自动调用 tcb agent create）
magent agent:create \
  --name my-agent \
  --system "You are a helpful coding assistant." \
  # -e <env-id> 可选：已 tcb env use 时可省略
```

**沙箱内 Agent** — 见 [沙箱内 Agent](#沙箱内-agent)（`runtime: harness`；[RoleArn](#首次使用沙箱工具与-rolearn) 仅首次创 Tool 时可能需）。

未 `magent env use` 且未传 `-e` / `CLOUDBASE_ENV_ID` 时，`magent` 会提示先选环境。

> 首次部署前需构建代码：`cd packages/agent-runtime && npm run build`

### 5. 配置 Agent

部署完成后，使用 `magent agent:update` 配置 Agent 的行为（不需要重新部署代码，约 8 秒生效）：

```bash
# 可选：记下 agent id，后续省略 -a
export CLOUDBASE_AGENT_ID=<agent-id>
# 更新 system prompt
magent agent:update --system "You are a helpful coding assistant."

# 或从 YAML 文件加载完整配置
magent agent:update --file ./agent.yaml
```

### 6. 使用 SDK 对话

```typescript
import ManagedAgents from "open-managed-agent-sdk";

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

## 沙箱内 Agent

远程 **AGS** 沙箱内运行 **OpenCode** 或 **Claude Code**，支持 bash、读写项目文件。与上文托管 Agent 共用 `magent` / SDK，通过 `runtime: harness` 切换。

### 模型（由简到繁）

| 阶段 | 配置 | 说明 |
|------|------|------|
| 默认 | 省略 `model` 或 `hy3-preview` | [CloudBase AI](https://docs.cloudbase.net/ai/model/model-access)，环境 **API Key**；体验额度用完后可在控制台 [购买 Token](https://docs.cloudbase.net/ai/model/openai-sdk-access) |
| 可选 | `model: zen` | 箱内 OpenCode 内置，**不扣** CloudBase AI 额度（仅 opencode） |
| 可选 | yaml 中 `model` 对象 | 自有 OpenAI / Anthropic 兼容 endpoint + Key |

完整步骤：[用户故事](./docs/harness-user-story.md) → [使用指南](./docs/harness-tutorial.md) · [OpenCode](./docs/harness-opencode.md) · [Claude Code](./docs/harness-claude-code.md)

**Managed Agents HTTP**（`/v1/sessions` + SSE）：[用户故事 · 故事 B](./docs/harness-user-story.md#故事-b使用-ma-http-协议接入) · [使用指南](./docs/managed-agents-guide.md)

### 最小部署

```bash
magent login
magent env use <your-env-id>

cp agent.harness.yaml.example agent.harness.yaml
cd packages/agent-runtime && npm run build && cd ../..

magent agent:create --name my-sandbox --runtime harness --engine opencode \
  --file ./agent.harness.yaml --code ./packages/agent-runtime
```

网关与 CloudBase AI 鉴权由 Runtime **用 CAM 自动换取**，沙箱路径**不必**手填控制台 API Key。见 [凭证说明](./docs/harness-credentials.md)。

`engine: claude` 时在 `agent.harness.yaml` 设 `engine: claude`，见 [harness-claude-code.md](./docs/harness-claude-code.md)。

### 首次使用：沙箱工具与 RoleArn

部署前运行 `node scripts/check-harness-ready.mjs`（或 `npm run check:harness`）。`magent agent:create --runtime harness` 会做同一套检查。

| 你的情况 | 要做什么 |
|----------|----------|
| 检查通过（本环境已有沙箱工具） | 直接 `agent:create` |
| 检查提示需要 RoleArn | 按 [凭证 · 控制台逐步操作](./docs/harness-credentials.md#控制台逐步操作照填) 配置后重试 |

日常对话、换模型、更新 `agent.yaml` **不需要**再配置 RoleArn。

### 自定义数据面镜像（可选）

默认不必改镜像。要预装依赖或自有基础环境：构建镜像并推到与沙箱**同地域**的 [腾讯云 TCR](https://console.cloud.tencent.com/tcr)，在 `agent.harness.yaml` 写 `sandbox.image`。步骤见 [使用指南 · 自定义沙箱镜像](./docs/harness-tutorial.md#自定义沙箱镜像可选)。

### 更多能力

自定义模型、COS 工作区持久化等，见 [沙箱内 Agent 使用指南](./docs/harness-tutorial.md) 的 **进阶** 一节。

---

## Agent 配置

Agent 通过 `agent.yaml` 文件配置，结构兼容 [Anthropic Agent Setup](https://platform.claude.com/docs/en/managed-agents/agent-setup)。

### 完整配置示例

```yaml
# agent.yaml
name: My Coding Agent
model: hy3-preview
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
| `model` | string | 模型名。可选：`hy3-preview`、`deepseek-v4-flash` 等 |
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

### MCP Tool Calling（`runtime=managed`）

MCP 工具调用已在 **TCBR 云托管**（`--type tcbr`）端到端验证：Agent 能发现远程 MCP server 的工具并自动调用。

```bash
magent agent:create -n my-agent --type tcbr -f agent.yaml -e <env-id>
magent run -a <agent-id> -m "现在几点了？"
```

验证链路：`agent.yaml` → `AGENT_CONFIG_B64` → `loadAgentConfig()` → kernel MCP 连接 → 模型发现工具 → 调用 → 结果返回。

> **SCF zip 模式（默认 `agent:create`）**：历史上存在事件流问题（模型已响应但客户端收不到 tool/文本帧）。生产环境推荐 **TCBR**；排障见 [docs/scf-debugging.md](docs/scf-debugging.md)。**沙箱 Agent（`runtime=harness`）** 走 AGS + 箱内引擎，与上述 SCF zip 限制无关，见 [沙箱内 Agent](#沙箱内-agent)。

---

## 更新 Agent 配置（`magent agent:update` / `magent agent:export`）

**不需要重新部署代码。** 约 8 秒生效：

```bash
# 更新 system prompt
magent agent:update --system "You are a strict code reviewer."

# 更新模型
magent agent:update --model deepseek-v4-flash

# 从 YAML 文件加载完整配置
magent agent:update --file ./new-config.yaml

# 添加 MCP 服务器
magent agent:update \
  --mcp-servers '[{"type":"url","name":"linear","url":"https://mcp.linear.app/sse"}]'

# 修改工具权限
magent agent:update \
  --tools '[{"type":"agent_toolset","configs":[{"name":"bash","permission_policy":{"type":"always_ask"}}]}]'
```

### 导出当前配置（`agent:export`）

```bash
# 导出到文件（可直接用于 agent:update -f，round-trip 安全）
magent agent:export -i agent_xxx -e my-env-id -o ./agent.yaml

# 打印到 stdout
magent agent:export -i agent_xxx -e my-env-id

# 典型工作流：导出 → 编辑 → 推回
magent agent:export -i agent_xxx -e my-env-id -o ./agent.yaml
# 编辑 agent.yaml ...
magent agent:update -f ./agent.yaml -e my-env-id
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

> **注意**：若 agent 携带了 `agent.yaml`，yaml 文件优先级最高，`agent:update` 通过环境变量注入的配置将被覆盖。

### 配置加载优先级（Runtime 内部）

```
agent.yaml 文件                             ← 用户主动放置时生效（最高优先级）
        ↓ fallback
AGENT_CONFIG / AGENT_CONFIG_B64 环境变量    ← magent agent:update 写入（默认云端路径）
        ↓ fallback
AGENT_MODEL + AGENT_SYSTEM 环境变量         ← 向后兼容
```

> **设计原则**：`agent.yaml.example` 作为配置模板随代码发布，默认**不包含** `agent.yaml`，因此普通部署通过 `AGENT_CONFIG_B64` 管理配置。用户如需固定配置（如 GitOps 或容器 mounting），只需 `cp agent.yaml.example agent.yaml` 即可接管优先级。

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
| `-o <path>` | `--output <path>` | 输出文件路径 |

### 环境变量

| 变量 | 说明 |
|------|------|
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID（可用 `-e` 覆盖） |
| `CLOUDBASE_AGENT_ID` | 默认 Agent ID（可免 `--id`） |
| `CLOUDBASE_APIKEY` | 环境 API Key（JWT）；SDK `accessKey` 同源，用于 FlexDB / AI Gateway / AGS |
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

magent agent:export  [--id <id>] [-o <file>] # 导出当前运行配置为 YAML
  -o, --output <path>     写入文件（省略则打印到 stdout）

# ─── 对话 ─────────────────────────────────────────────────
magent run   -a <id> -m "..."    # 一次性对话（自动创建/销毁 session）
magent chat  -s <id> -m "..."    # 向已有 session 发消息
magent repl  -a <id>             # 交互式 REPL（多轮，上下文保持）

# ─── Session 管理 ─────────────────────────────────────────
magent session:create -a <agent-id> [--title <title>]
magent session:list   -a <agent-id>
magent session:get    -i <session-id> -a <agent-id>
magent session:delete -i <session-id> -a <agent-id>

# ─── 透明代理（任意 tcb 命令）────────────────────────────
magent functions:list -e <envId>    # 等效 tcb functions:list
magent storage:list                 # 等效 tcb storage:list
# 所有未识别命令均透明转发给内置 tcb CLI
```

### Session 与对话示例

**1) 创建 Agent（TCBR 云托管，推荐生产使用）**

```bash
magent agent:create -n my-agent --type tcbr -e <env-id>
# 输出: ✅ Agent created: agent-my-agent-xxxxx
```

**2) 交互式多轮对话（REPL）**

```bash
magent repl -a agent-my-agent-xxxxx -e <env-id>

🤖 OpenManagedAgent REPL
Type your message, press Enter. Ctrl+C to exit.

Connecting... my-agent
Creating session... f4c937ba-0543-4fca-88ba-727b5b90d576

You: 你好 我叫小明
Agent: 你好，小明！很高兴认识你！我是你的助手。有什么我可以帮助你的吗？😊
  (end_turn)

You: 你还记得我叫什么吗
Agent: 当然记得！你叫小明。这是我们刚才认识时你告诉我的名字。
  (end_turn)

You: <Ctrl+C>  # 退出
```

> REPL 在同一 session 内保持上下文，Agent 能记住前几轮对话内容。

**3) 查看 Session 列表**

```bash
magent session:list -a agent-my-agent-xxxxx -e <env-id>

Sessions (3):
  f4c937ba-0543-4fca-88ba-727b5b90d576
    title  : (untitled)
    status : idle
    created: 6/17/2026, 5:30:12 PM
  ...
```

> Session 数据持久化在 CloudBase FlexDB 中，Agent 冷启动后仍可查看历史 session。

**4) 恢复已有 Session 继续对话**

```bash
# 用 chat 命令在已有 session 上继续对话
magent chat -s f4c937ba-0543-4fca-88ba-727b5b90d576 \
  -a agent-my-agent-xxxxx -e <env-id> \
  -m "你还记得我叫什么吗"
```

**5) 一次性对话（run，不保留 session）**

```bash
magent run -a agent-my-agent-xxxxx -e <env-id> -m "写一个 Python 冒泡排序"
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
import ManagedAgents from "open-managed-agent-sdk";

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

### 部署类型（`runtime=managed`）

| 类型 | 命令 | 耗时 | 适用场景 |
|------|------|------|----------|
| **TCBR 云托管**（推荐） | `--type tcbr` | ~3–5 min | 生产；MCP / 流式事件正常 |
| SCF 云函数 | 默认（省略 `--type`） | ~60–90s | 快速原型；zip 模式流式有已知限制 |

沙箱 Agent 使用 `runtime: harness`，见 [沙箱内 Agent](#沙箱内-agent) 与 [使用指南](./docs/harness-tutorial.md)。

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
magent agent:update --system "New prompt" --model deepseek-v4-flash
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
| `AGENT_MODEL` | 覆盖模型名 | `hy3-preview` |
| `AGENT_SYSTEM` | 覆盖 system prompt | `You are a helpful assistant.` |
| `AGENT_NAME` | 覆盖 agent 名称 | `open-managed-agent` |
| `PORT` | 服务监听端口 | `9000` |

---

## 支持的模型

| Provider | 模型 | 推荐 |
|----------|------|------|
| `hunyuan-exp` | `hy3-preview`, `hunyuan-turbos-latest`, `hunyuan-2.0-instruct-20251111` | ✅ `hy3-preview` |
| `deepseek` | `deepseek-v4-flash`, `deepseek-r1-0528` | ✅ `deepseek-v4-flash` |

---

## 研发贡献（Harness）

| 文档 | 用途 |
|------|------|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 验收两轴 · npm 脚本 · release |
| [Harness一条龙.md](../Harness一条龙.md) | Agent 按步骤跑 + 排障 |
| [scenarios/README.md](./scripts/harness/scenarios/README.md) | 6 格 LLM / COS |

```bash
npm test
npm run test:merge          # 合入门禁（platform preflight）
npm run dev:harness         # local · opencode · model=zen · 无云 COS
npm run harness -- run --infra local --engine opencode
```

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
│       │   ├── config.ts     # 配置加载（agent.yaml > AGENT_CONFIG env var > env vars）
│       │   ├── acp-endpoint.ts # ACP JSON-RPC 处理
│       │   └── hunyuan-agent.ts # AI Agent 核心逻辑
│       ├── agent.yaml.example  # 配置模板（cp 为 agent.yaml 后生效，优先级最高）
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
