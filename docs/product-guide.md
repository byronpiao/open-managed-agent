# OpenManagedAgent 产品文档

## 概述

OpenManagedAgent 是一个兼容 [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents) API 的 AI Agent 框架，基于腾讯云 CloudBase 构建。通过简单的 CLI 命令和 SDK 调用，你可以创建、配置、部署并与 AI Agent 对话。

**核心能力：**
- 一键创建 Agent（自动部署为云函数）
- 沙箱内 Agent（OpenCode / Claude Code，在远程沙箱中运行）
- YAML 声明式配置（tools、MCP、skills、permission policy）
- 热更新配置（~8s 生效，无需重新部署代码）
- TypeScript SDK 流式对话
- 多轮上下文保持
- **同步镜像到容器镜像服务** — [`magent sync-image`](./sync-image.md)

---

## 快速开始

### 前置条件

```bash
# 1. Node.js >= 20
node --version

# 2. 安装 tcb CLI 并登录
npm install -g @cloudbase/cli
tcb login --apiKeyId <YOUR_AK> --apiKey <YOUR_SK>
```

### 安装

```bash
git clone <repo-url>
cd cloudbase-managed-agent
npm install
npm run build
```

### 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：
```ini
CLOUDBASE_ENV_ID=your-env-id
CLOUDBASE_APIKEY=your-apikey
```

#### 模型凭证（二选一）

Agent runtime 需要能访问到 LLM。**推荐用 ModelSpec 在配置里直接声明**，而不是分散到环境变量。

#### 方式 1（推荐）：在 agent.yaml 用 ModelSpec 对象

`model` 字段既可以是字符串（仅模型 ID，走 CloudBase TokenHub），也可以是完整的 ModelSpec 对象：

```yaml
model:
  id: mimo-v2.5-pro                                        # 模型 ID
  apiKey: tp-xxxxxxxxxxxxxxxxxxxxxxxx                       # 自带的 API key
  apiBaseUrl: https://your-proxy.example.com/anthropic     # 自带 endpoint
  options:                                                  # 可选，透传到底层 provider
    max_tokens: 4096
```

ModelSpec 字段说明（与 kernel 的 `ModelSpec` 接口对齐）：

| 字段         | 类型                       | 说明                                                      |
| ------------ | -------------------------- | --------------------------------------------------------- |
| `id`         | `string`                   | 模型 ID，如 `hy3` / `deepseek-v4-flash` / `gpt-5` |
| `apiKey`     | `string?`                  | 不传则走 CloudBase 网关代理（计费走平台）；传则用自带 key |
| `apiBaseUrl` | `string?`                  | 自带 key 时的 endpoint（任意 Anthropic-compatible 代理）  |
| `options`    | `Record<string, unknown>?` | 透传到底层 provider 的额外选项                            |

只用 ID 字符串的简写形式（适用于平台模型，如混元 / DeepSeek）：

```yaml
model: hy3
```

#### 方式 2：用 CloudBase TokenHub（仅 ID 字符串场景）

如果你的 `model` 是字符串（如 `hy3` / `deepseek-v4-flash`），runtime 会自动走 CloudBase TokenHub。
在 [TokenHub 控制台](https://console.cloud.tencent.com/tokenhub) 创建 API key 并设置：

```ini
TENCENTCLOUD_TOKENHUB_API_KEY=xxxxxxxx
# 或 forward-compatible 别名：
CLOUDBASE_API_KEY=xxxxxxxx
```

#### CloudBase 凭证（仅 tcbr 容器需要）

SCF 函数会被自动注入 `TENCENTCLOUD_SECRETID/KEY/SESSIONTOKEN`，无需手工设置。
TCBR 云托管容器**不会自动注入**，所以 `agent:create --type tcbr` 时 magent 会按以下顺序选择凭证写进 `EnvParam`：

1. shell 中的 `TCB_SECRET_ID` + `TCB_SECRET_KEY`（推荐 — 永久密钥不会过期）
2. fallback 到 `tcb login` 的 STS 临时凭证（约 2h 后过期，过期后 agent 调用会 `MISSING_CREDENTIALS`）

生产环境务必走 1。

---

## 完整使用流程

以下流程基于 E2E 测试验证通过，可直接复现。

### Step 1: 列出现有 Agents

```bash
$ magent agent:list
```

输出：
```
┌──────────────────────────────────┬────────────────────┬─────────────┬────────┬─────────────────────┐
│ Agent ID                         │ Name               │ Type        │ Status │ Update Time         │
├──────────────────────────────────┼────────────────────┼─────────────┼────────┼─────────────────────┤
│ agent-managed-agent-test-60ab640 │ managed-agent-test │ SCF 云函数  │ -      │ 2026/05/19 14:26:00 │
└──────────────────────────────────┴────────────────────┴─────────────┴────────┴─────────────────────┘
```

### Step 2: 创建 Agent

```bash
$ magent agent:create \
    --name "my-agent" \
    --system "You are a helpful coding assistant." \
    --code "./packages/agent-runtime"
```

输出：
```
Creating agent...
  name: my-agent
  model: hy3
  code: ./packages/agent-runtime
  runtime: Nodejs20.19

  Installing dependencies... OK
✅ Agent created: agent-my-agent-65abf85e
  name: my-agent
  runtime: Nodejs20.19

Next steps:
  1. Wait for ready: magent agent:get -a agent-my-agent-65abf85e
  2. Update config:  magent agent:update -a agent-my-agent-65abf85e -f agent.yaml
  3. Start chatting: magent run -a agent-my-agent-65abf85e -m "Hello"
```

> **想部署成容器型（TCBR 云托管）？** 在 `agent:create` 上加 `--type tcbr`：
>
> ```bash
> $ magent agent:create --name "my-agent" --type tcbr \
>     --system "You are a helpful coding assistant."
> ```
>
> 容器路径会用 `packages/agent-runtime/Dockerfile` 构建镜像、走云托管部署。
> 整个过程约 3-5 分钟（vs SCF 的 60-90s），但能装系统库、用任意 Node 版本，且写权限不像 SCF 那样受限。
> 之后所有 `agent:get / agent:update / agent:delete / run / chat` 命令都通用，magent 自动按 `AgentType` 分发到正确的 API 路径。

### Step 3: 等待就绪

```bash
$ magent agent:get -a agent-my-agent-65abf85e
```

等待输出显示 `Ready: ✅ 已就绪，可以调用`（通常需要 60-90s）。

### Step 4: 使用 SDK 对话

```typescript
import ManagedAgents from "open-managed-agent-sdk";

const client = new ManagedAgents({
  envId: "<env-id>",
  agentId: "<agent-id>",
  accessKey: "<your-access-key>",
});

// 创建 Session
const session = await client.sessions.create({ title: "my-task" });
console.log("Session ID:", session.id);

// 发送消息，流式接收
for await (const event of client.sessions.prompt(session.id, "Hello!")) {
  if (event.type === "chunk") process.stdout.write(event.text);
  if (event.type === "done") console.log("\n[Done:", event.stopReason, "]");
}

// 删除 Session
await client.sessions.delete(session.id);
```

输出示例：
```
Session ID: sess_mpdz5r4a_ulqn3
Agent: 你好！我是一个编程助手，可以帮你写代码、读写文件、执行命令。有什么可以帮你的？
[Done: end_turn]
```

### Step 5: 更新配置（添加 MCP + Skill）

准备配置文件 `agent.yaml`：

```yaml
name: my-agent
model: hy3
system: |
  You are a dev assistant with GitHub integration.
  When asked about capabilities, mention your MCP servers, skills, and tools.

tools:
  - type: agent_toolset
    default_config:
      enabled: true
      permission_policy:
        type: always_allow
  - type: mcp_toolset
    mcp_server_name: github
    default_config:
      permission_policy:
        type: always_allow
  - type: custom
    name: analyze_code
    description: Analyze code quality and return metrics
    input_schema:
      type: object
      properties:
        file_path:
          type: string
      required: [file_path]

mcp_servers:
  - type: url
    name: github
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: Bearer <token>

skills:
  - name: github-workflow
    description: GitHub PR and code review expertise
    source: ./skills/github.md
```

执行更新：

```bash
$ magent agent:update --file ./agent.yaml
```

> SCF agent 走 `tcb agent update`，约 8s 完成，不重启函数。
> TCBR agent 走 `SubmitServerConfigChangeDiff`（无 in-place 接口），会触发一次滚动重启，整体 60-90s。

输出（SCF agent 示例）：
```
Fetching current config... OK

Updated config (942 bytes):
  name: my-agent
  model: hy3
  system: You are a dev assistant with GitHub integration...
  tools: 3 items
  mcp_servers: 1 items
  skills: 1 items

Applying via tcb agent update... OK
  Elapsed: 5s

✅ Agent agent-my-agent-65abf85e updated successfully.
```

### Step 6: 验证配置生效

使用 SDK 再次对话，Agent 会反映新配置：

```typescript
const session = await client.sessions.create({ title: "verify" });
for await (const event of client.sessions.prompt(session.id, "列出你所有的 MCP 服务器、Skill 和自定义工具。")) {
  if (event.type === "chunk") process.stdout.write(event.text);
}
```

输出：
```
Agent: 我支持以下能力：

1. GitHub MCP 服务器：https://api.githubcopilot.com/mcp/
2. github-workflow 技能
3. analyze_code 自定义工具
```

### Step 7: 删除 Agent

```bash
$ magent agent:delete -a agent-my-agent-65abf85e

Deleting agent registration... OK
Deleting cloud function 'agent-my-agent-65abf85e'... OK
✅ Agent agent-my-agent-65abf85e deleted.
```

> 删除会级联清理底层资源：SCF 类型的 Agent 同步删除云函数，TCBR 类型的 Agent 同步删除云托管服务，避免遗留计费资源。

---

## Agent 配置参考

### 配置格式（agent.yaml）

```yaml
name: My Agent                    # Agent 名称
model: hy3          # 模型
system: |                         # System Prompt
  You are a helpful assistant.
description: Agent description    # 描述（可选）

tools:                            # 工具列表
  - type: agent_toolset           # 内置工具集
    default_config:
      enabled: true
      permission_policy:
        type: always_allow
    configs:                      # 逐个工具覆盖
      - name: bash
        permission_policy:
          type: always_ask        # bash 需确认

  - type: mcp_toolset             # MCP 工具集
    mcp_server_name: github
    default_config:
      permission_policy:
        type: always_allow
    configs:
      - name: delete_repository
        enabled: false            # 禁用危险操作

  - type: custom                  # 自定义工具（客户端执行）
    name: query_db
    description: Execute SQL query
    input_schema:
      type: object
      properties:
        sql: { type: string }
      required: [sql]

mcp_servers:                      # MCP 服务器声明
  - type: url
    name: github
    url: https://api.githubcopilot.com/mcp/
    headers:                      # 可自定义 headers
      Authorization: Bearer <token>

skills:                           # 领域知识
  - name: code-review
    description: Code review best practices
    source: ./skills/code-review.md

sessions_collection: acp_sessions # Session 存储集合名（可选）

metadata:                         # 自定义元数据（可选）
  team: backend
```

### 字段说明

| 字段                  | 类型                | 必需 | 说明                                                                                                   |
| --------------------- | ------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `name`                | string              | ✓    | Agent 名称                                                                                             |
| `model`               | string \| ModelSpec | ✓    | 模型 ID（字符串）或完整 ModelSpec 对象（带 `apiKey` / `apiBaseUrl` / `options`）。详见上文「模型凭证」 |
| `system`              | string              | ✓    | System prompt                                                                                          |
| `tools`               | array               | -    | 工具配置                                                                                               |
| `mcp_servers`         | array               | -    | MCP 服务器声明                                                                                         |
| `skills`              | array               | -    | 领域知识文件                                                                                           |
| `sessions_collection` | string              | -    | NoSQL 集合名（默认 `acp_sessions`，自动创建）                                                          |

### `mcp_servers` 条目

| 字段 | 必需 | 说明 |
|------|------|------|
| `type` | ✓ | 固定写 `url` |
| `name` | ✓ | 服务器名 |
| `url` | ✓ | HTTP MCP 地址 |
| `headers` | - | 自定义 HTTP headers |
| 其他 | - | 直接透传给 OpenAgentKernel 或 mcporter |

### 工具类型

| 类型            | 执行方     | 说明                                              |
| --------------- | ---------- | ------------------------------------------------- |
| `agent_toolset` | 服务端     | 内置工具：bash, read_file, write_file, list_files |
| `mcp_toolset`   | 服务端代理 | 远程 MCP 服务器提供的工具                         |
| `custom`        | 客户端     | Agent 请求调用，由你的代码执行后返回结果          |

### Permission Policy

| 策略           | 行为                                   |
| -------------- | -------------------------------------- |
| `always_allow` | 工具自动执行                           |
| `always_ask`   | 暂停等待 `user.tool_confirmation` 事件 |

### 支持的模型

| Provider    | 模型                                        | 推荐      |
| ----------- | ------------------------------------------- | --------- |
| `cloudbase` | `hy3`, `deepseek-v4-flash`, `glm-5` | ✅ `glm-5` |

---

## CLI 命令参考

### 环境变量

```ini
CLOUDBASE_ENV_ID=xxx        # CloudBase 环境 ID（未设置时自动从 tcb 检测）
CLOUDBASE_AGENT_ID=xxx      # 默认 Agent ID（可省略 -a）
CLOUDBASE_API_KEY=xxx       # JWT Token
```

### Agent 管理

```bash
# 创建（部署云函数，约 60-90s）
magent agent:create --name <name> [--system <prompt>] [--model <model>] [--file <yaml>] [--code <path>]

# 更新配置（不重新部署，约 8s）
magent agent:update [-a <id>] [--system <prompt>] [--model <model>] [--file <yaml>]
magent agent:update --tools '[...]' --mcp-servers '[...]' --skills '[...]'

# 查看 / 列出 / 删除
magent agent:get [-a <id>]
magent agent:list
magent agent:delete [-a <id>]    # 同步清理底层 SCF 函数或 TCBR 云托管
```

### 对话

```bash
# 一次性对话（自动创建/销毁 session）
magent run --agent <id> --message "Write hello world in Python"

# 交互式 REPL
magent repl --agent <id>

# 向已有 session 发消息
magent chat --session <id> --message "Add unit tests"
```

`magent run` 响应示例：

```
$ magent run -a agent-my-agent-7gi10oad3e9b3e8c -m "Hello" -e test-6g2rfs50c69b7fb8
Connecting to agent... my-agent
Creating session... sess_mpp8aw36_dmi18

You: Hello

Agent:
Hello! How can I help you today? I can assist you with coding tasks, file operations, running shell commands, and more. Just let me know what you'd like to work on! 😊

✅ Done (end_turn)
```

### Session 管理

```bash
magent session:create -a <agent-id> [--title <title>]
magent session:list   -a <agent-id>
magent session:get    -i <session-id> -a <agent-id>
magent session:delete -i <session-id> -a <agent-id>
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
  envId,
  agentId,
  accessKey: "your-access-key",
});
```

### Session 生命周期

```typescript
// 创建
const session = await client.sessions.create({ title: "Task" });

// 对话（流式）
for await (const event of client.sessions.prompt(session.id, "Hello")) {
  switch (event.type) {
    case "chunk":     process.stdout.write(event.text); break;
    case "tool_call": console.log(`Tool: ${event.name} [${event.status}]`); break;
    case "error":     console.error(event.message); break;
    case "done":      console.log(`Done: ${event.stopReason}`); break;
  }
}

// 多轮（上下文自动保留）
for await (const event of client.sessions.prompt(session.id, "Now refactor it")) { ... }

// 历史
const history = await client.sessions.history(session.id);

// 列出
const list = await client.sessions.list();

// 删除
await client.sessions.delete(session.id);
```

### 流式事件

| 事件类型    | 字段                        | 说明                            |
| ----------- | --------------------------- | ------------------------------- |
| `chunk`     | `text`                      | 文本增量                        |
| `tool_call` | `name`, `status`, `result?` | 工具调用 (pending → completed)  |
| `error`     | `message`                   | 错误                            |
| `done`      | `stopReason`                | 结束 (`end_turn` / `cancelled`) |

---

## 架构

```
┌─────────────────────┐         ┌───────────────────────────────────────┐
│   Client            │         │   CloudBase SCF Web Function          │
│                     │         │                                       │
│  magent CLI         │         │   Express Server                      │
│  SDK (TypeScript)   │  HTTPS  │     POST /v1/aibot/bots/:id/acp      │
│                     ├────────►│     POST /send-message (AG-UI)        │
│  ← NDJSON Stream    │◄────────┤     GET  /healthz                     │
│                     │         │                                       │
└─────────────────────┘         │   HunyuanAgent                        │
                                │     ├─ CloudBase AI (混元/DeepSeek)    │
                                │     ├─ 内置工具 (bash/file)            │
                                │     └─ MCP 代理                        │
                                │                                       │
                                │   Config: AGENT_CONFIG_B64 env var     │
                                │   Storage: NoSQL (acp_sessions)        │
                                └───────────────────────────────────────┘
```

**配置加载优先级：**
```
AGENT_CONFIG_B64 环境变量    ← magent agent:update 写入
       ↓ fallback
agent.yaml 文件              ← 随代码部署
       ↓ fallback
AGENT_MODEL / AGENT_SYSTEM   ← 单独环境变量（仅 AGENT_ENV_OVERRIDES=1 时覆盖 yaml）
```

---

## 运行 E2E 测试

```bash
# 确保 .env 已配置
node tests/e2e.mjs
```

测试覆盖完整流程：创建 → 对话 → 更新配置 → 验证 → 删除。

---

## License

MIT
