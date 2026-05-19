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
│   ├── sdk/              # TypeScript client SDK (@cloudbase/managed-agent)
│   ├── server/           # Proxy server - Agent lifecycle + request routing
│   └── agent-runtime/    # Agent 云函数代码 (部署到 tcb agent)
├── examples/fibonacci/   # Quick start example
├── cbagent.mjs           # CLI tool
└── docs/usage-guide.md
```

## Quick Start

### 1. Start the Server

```bash
cd packages/server
npm install
npm run build

# Set environment variables
export CLOUDBASE_ENV_ID=your-env-id
export TENCENTCLOUD_SECRETID=your-secret-id
export TENCENTCLOUD_SECRETKEY=your-secret-key

npm start
# Server running on http://localhost:3000
```

### 2. Use the SDK

```typescript
import CloudbaseAgents from "@cloudbase/managed-agent";

const client = new CloudbaseAgents({
  baseURL: "http://localhost:3000",
  envId: process.env.CLOUDBASE_ENV_ID,
});

// Create an agent
const agent = await client.agents.create({
  name: "Coding Assistant",
  model: "hunyuan-2.0-instruct-20251111",
  system: "You are a helpful coding assistant.",
  tools: [{ type: "agent_toolset_20260401" }],
});

// Create a session
const session = await client.sessions.create({
  agent: agent.id,
  title: "my task",
});

// Stream events
const stream = client.sessions.events.stream(session.id);

// Send a message
await client.sessions.events.send(session.id, {
  events: [{
    type: "user.message",
    content: [{ type: "text", text: "Write a hello world in Python" }],
  }],
});

// Consume events
for await (const event of stream) {
  if (event.type === "agent.message") {
    console.log(event.content[0]?.text);
  }
  if (event.type === "session.status_idle") break;
}
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
Client (SDK / CLI)     Proxy Server              CloudBase Agent (tcb agent)
     │                      │                           │
     ├─ POST /agents ──────►│                           │
     │                      ├─ tcb agent create ───────►│ (upload agent-runtime)
     │                      │                           │ [Nodejs20, 7200s timeout]
     │                      │                           │
     ├─ POST /sessions ────►│                           │
     │                      ├─ save session to DB ──────►│ (CloudBase NoSQL)
     │                      │                           │
     ├─ POST /events ──────►│                           │
     │                      ├─ forward ────────────────►│ POST /send-message (AG-UI)
     │                      │                           ├─ HunyuanAgent.run()
     │                      │                           │   ├─ cbAI.streamText()
     │                      │                           │   └─ tool execution
     │◄─ SSE stream ────────│◄─ translate AG-UI→events ─│ AG-UI SSE
```

### Agent 生命周期（`tcb agent`）

```bash
# 创建：上传 agent-runtime 代码到云函数
tcb agent create --name my-agent --code ./packages/agent-runtime -e $ENV_ID

# 更新模型/配置
tcb agent update my-agent --env "AGENT_MODEL=deepseek-v3.2" -e $ENV_ID

# 删除
tcb agent delete my-agent --yes -e $ENV_ID
```

## Deployment (CloudRun)

```bash
cd packages/server
npm run build
docker build -t cloudbase-managed-agent-server .

# Deploy to CloudRun via CloudBase console or CLI
# Set env vars: CLOUDBASE_ENV_ID, TENCENTCLOUD_SECRETID, TENCENTCLOUD_SECRETKEY
```

## License

MIT
