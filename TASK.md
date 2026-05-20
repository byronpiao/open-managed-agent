# Task: CloudBase Managed Agent SDK

Build a TypeScript SDK that mirrors the Claude Managed Agents API interface, but backed by CloudBase instead of Anthropic.

## Target API Interface (mirroring Claude's `@anthropic-ai/sdk` beta.agents)

```typescript
// Agent lifecycle
const agent = await client.beta.agents.create({
  name: "Coding Assistant",
  model: "hunyuan-2.0-instruct-20251111", // CloudBase model
  system: "You are a helpful coding assistant.",
  tools: [{ type: "agent_toolset_20260401" }],
});

// Environment
const environment = await client.beta.environments.create({
  name: "my-env",
  config: { type: "cloud", networking: { type: "unrestricted" } },
});

// Session
const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: environment.id,
  title: "task title",
});

// Events - stream first, then send
const stream = await client.beta.sessions.events.stream(session.id);
await client.beta.sessions.events.send(session.id, {
  events: [{
    type: "user.message",
    content: [{ type: "text", text: "your task here" }],
  }],
});

// Consume events
for await (const event of stream) {
  if (event.type === "agent.message") { ... }
  if (event.type === "session.status_idle") break;
}
```

## Implementation Plan

Use CloudBase as the backend infrastructure:

1. **Agent** = stored config in CloudBase NoSQL DB (`managed_agents` collection)
   - Fields: id, name, model, system, tools, created_at, metadata

2. **Environment** = stored config in CloudBase NoSQL DB (`managed_environments` collection)  
   - Fields: id, name, config, created_at

3. **Session** = stored state in CloudBase NoSQL DB (`managed_sessions` collection)
   - Fields: id, agent_id, environment_id, title, status, events, created_at

4. **Events / Streaming** = SSE stream backed by CloudBase AI model (@cloudbase/node-sdk generateText/streamText)
   - The agent loop runs server-side (CloudRun service)
   - Client connects via SSE to receive events

## Project Structure

```
cloudbase-managed-agent/
├── packages/
│   ├── sdk/              # TypeScript client SDK (mirrors Claude's API)
│   │   ├── src/
│   │   │   ├── index.ts         # Main CloudbaseAgents client class
│   │   │   ├── types.ts         # All type definitions (mirrors Claude types)
│   │   │   ├── agents.ts        # client.beta.agents.*
│   │   │   ├── environments.ts  # client.beta.environments.*
│   │   │   ├── sessions.ts      # client.beta.sessions.*
│   │   │   └── events.ts        # event streaming (SSE client)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── server/           # CloudRun backend service
│       ├── src/
│       │   ├── index.ts         # Express server entry
│       │   ├── routes/
│       │   │   ├── agents.ts    # CRUD for agents
│       │   │   ├── environments.ts
│       │   │   └── sessions.ts  # + SSE streaming endpoint
│       │   ├── agent-loop.ts    # The core agent loop (calls CloudBase AI)
│       │   └── db.ts            # CloudBase DB helpers
│       ├── package.json
│       ├── tsconfig.json
│       └── Dockerfile
├── examples/
│   └── fibonacci/        # Example mirroring the Claude quickstart
│       └── index.ts
└── README.md
```

## Key Design Decisions

1. **SDK API surface** must be 1:1 compatible with `@anthropic-ai/sdk` beta.agents interface (drop-in replacement feel)
2. **Models**: default to `hunyuan-2.0-instruct-20251111` (CloudBase built-in)
3. **Agent loop**: server-side, implement tool calling loop that handles:
   - bash (via child_process exec in CloudRun container)
   - read/write/edit/glob/grep file ops
   - custom tools (via agent.custom_tool_use events)
4. **Storage**: CloudBase NoSQL (document DB) for agents/environments/sessions
5. **Streaming**: SSE (Server-Sent Events) for real-time event delivery
6. **Auth**: CLOUDBASE_ENV_ID + TENCENTCLOUD_SECRETID/KEY env vars

## Event Types to Implement

Agent output events:
- `agent.message` - text reply
- `agent.thinking` - internal reasoning
- `agent.tool_use` - built-in tool call
- `agent.tool_result` - tool execution result
- `agent.custom_tool_use` - custom tool request
- `session.status_idle` - task complete
- `session.status_terminated` - fatal error

User input events:
- `user.message` - send new message
- `user.interrupt` - interrupt execution
- `user.custom_tool_result` - return custom tool result
- `user.tool_confirmation` - approve/reject tool call

## Build Instructions

1. Create full TypeScript source for both packages
2. Add proper type declarations
3. Include a working fibonacci example
4. Write README with setup/usage guide
5. Make the SDK publishable as `@cloudbase/managed-agent`

Start now. Build the complete working implementation.
