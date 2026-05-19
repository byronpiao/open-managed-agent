# CloudBase Managed Agent SDK

A TypeScript SDK inspired by Anthropic's Managed Agents concept, backed by CloudBase instead of Anthropic.

## Overview

This project provides a **drop-in compatible** API surface with Claude's Managed Agents:

```typescript
// Claude:
const agent = await anthropic.beta.agents.create({ ... })

// CloudBase (cleaner, no .beta):
const agent = await client.agents.create({ ... })
```

## Project Structure

```
cloudbase-managed-agent/
├── packages/
│   ├── sdk/              # TypeScript 客户端 SDK (@cloudbase/managed-agent)
│   └── agent-runtime/    # Agent 云函数代码 (部署到 tcb agent)
├── examples/
│   ├── fibonacci/        # 基础示例
│   └── acp-client/       # ACP 协议完整示例
├── cbagent.mjs           # CLI 工具
├── docs/usage-guide.md   # 使用文档
└── README.md
```

## Quick Start

### 1. 部署 Agent

```bash
cd packages/agent-runtime
npm install && npm run build

# 每个 agent 是一个独立云函数，7200s 超时
tcb agent create \
  --name my-agent \
  --code . \
  --env "AGENT_MODEL=hunyuan-2.0-instruct-20251111,AGENT_SYSTEM=You are a helpful assistant" \
  -e $CLOUDBASE_ENV_ID
```

### 2. 客户端直连 Agent（无需 proxy server）

```typescript
import CloudbaseAgents from "@cloudbase/managed-agent";

// 直接指向 tcb agent 端点
const client = new CloudbaseAgents({
  baseURL: `https://${ENV_ID}.service.tcloudbase.com/v1/aibot/bots/my-agent`,
});

// 创建 session
const session = await client.sessions.create({ title: "My task" });

// 发消息，流式获取结果（内部走 ACP）
for await (const event of client.sessions.prompt(session.id, "Hello!")) {
  if (event.type === "chunk") process.stdout.write(event.text);
  if (event.type === "done")  console.log("\nDone:", event.stopReason);
}

// 多轮对话（上下文自动保留）
for await (const event of client.sessions.prompt(session.id, "Now add tests")) {
  if (event.type === "chunk") process.stdout.write(event.text);
}

// 查历史
const history = await client.sessions.history(session.id);
console.log(history.messages);

// 清理
await client.sessions.delete(session.id);
```

### 3. Run the Fibonacci Example

```bash
cd examples/fibonacci
export CLOUDBASE_SERVER_URL=http://localhost:3000
export CLOUDBASE_ENV_ID=your-env-id
npx tsx index.ts
```

## API Reference

### CloudbaseAgents

```typescript
new CloudbaseAgents({ baseURL, envId?, apiKey? })
```

### client.agents

| Method | Description |
|--------|-------------|
| `create(params)` | Create a new agent |
| `retrieve(id)` | Get agent by ID |
| `list()` | List all agents |
| `delete(id)` | Delete an agent |

### client.environments

| Method | Description |
|--------|-------------|
| `create(params)` | Create an environment |
| `retrieve(id)` | Get environment by ID |
| `list()` | List all environments |
| `delete(id)` | Delete an environment |

### client.sessions

| Method | Description |
|--------|-------------|
| `create(params)` | Create a session |
| `retrieve(id)` | Get session by ID |
| `list()` | List all sessions |
| `delete(id)` | Delete a session |
| `events.stream(id)` | Open SSE event stream |
| `events.send(id, params)` | Send user events |

## Supported Models

- `hunyuan-2.0-instruct-20251111` (default, recommended)
- `deepseek-v3.2`
- `hunyuan-image` (image generation)
- Any CloudBase-supported model

## Event Types

**Agent → Client:**
- `agent.message` — text reply from the agent
- `agent.thinking` — internal reasoning (CoT)
- `agent.tool_use` — built-in tool call
- `agent.tool_result` — result of a tool execution
- `agent.custom_tool_use` — custom tool request (client handles)
- `session.status_idle` — task complete
- `session.status_terminated` — fatal error

**Client → Agent:**
- `user.message` — send a message
- `user.interrupt` — interrupt the agent
- `user.custom_tool_result` — return result of custom tool
- `user.tool_confirmation` — approve/deny a tool call

## Built-in Tools (Server-side)

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands |
| `read_file` | Read file contents |
| `write_file` | Write/create files |
| `list_files` | List directory contents |

## Architecture

```
Client (SDK / CLI)                    CloudBase Agent (tcb agent)
     │                                       │
     ├─ POST /acp (session/new) ───────────►│ 创建 session 存 DB
     ├─ POST /acp (session/prompt) ───────►│ HunyuanAgent.run()
     │                                       ├─ cbAI.streamText() (Hunyuan)
     │                                       └─ 工具执行 (bash/文件)
     │◄─ NDJSON stream (session/update) ───│
     ├─ GET  /acp/sessions ──────────────►│ 列出 sessions
     └─ GET  /send-message (AG-UI SSE) ──►│ 备用单轮简单场景
```

### Agent 生命周期（`tcb agent` CLI）

```bash
# 创建
tcb agent create \
  --name my-agent \
  --code ./packages/agent-runtime \
  --env "AGENT_MODEL=hunyuan-2.0-instruct-20251111,AGENT_SYSTEM=You are a helpful assistant" \
  -e $ENV_ID

# 更新模型/配置
tcb agent update my-agent --env "AGENT_MODEL=deepseek-v3.2" -e $ENV_ID

# 删除
tcb agent delete my-agent --yes -e $ENV_ID
```

## License

MIT
