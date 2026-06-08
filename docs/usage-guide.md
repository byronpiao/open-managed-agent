# OpenManagedAgent 使用手册

> 类 Anthropic Managed Agent 体验，由 CloudBase 提供底层支撑

---

## 目录

1. [概念介绍](#1-概念介绍)
2. [快速上手](#2-快速上手)
3. [CLI 参考](#3-cli-参考)
4. [SDK 参考](#4-sdk-参考)
5. [完整工作流示例](#5-完整工作流示例)
6. [事件类型说明](#6-事件类型说明)
7. [部署到 CloudRun](#7-部署到-cloudrun)

---

## 1. 概念介绍

```
Agent（代理）
  │  定义 AI 的行为：名字、模型、系统提示、可用工具
  │
  ▼
Environment（运行环境）
  │  声明执行上下文：网络策略、资源限制
  │
  ▼
Session（会话）
  │  一次具体的对话/任务，绑定 Agent + Environment
  │
  ▼
Events（事件流）
     客户端发送 user.message → Agent 处理 → 流式返回 agent.message
```

### 与 Claude Managed Agent 的对应关系

| Claude (`@anthropic-ai/sdk`)       | OpenManagedAgent (`open-managed-agent`)    |
|------------------------------------|---------------------------------------------|
| `anthropic.beta.agents.create()`   | `client.agents.create()`                   |
| `anthropic.beta.environments.*`    | `client.environments.*`                    |
| `anthropic.beta.sessions.*`        | `client.sessions.*`                        |
| `anthropic.beta.sessions.events.*` | `client.sessions.events.*`                 |
| 模型：`claude-opus-4-5`            | 模型：`hunyuan-2.0-instruct-20251111`      |

---

## 2. 快速上手

### 2.1 启动服务端

```bash
cd packages/server
npm install
npm run build

export CLOUDBASE_ENV_ID=your-env-id
export TENCENTCLOUD_SECRETID=your-secret-id
export TENCENTCLOUD_SECRETKEY=your-secret-key
export PORT=3000

npm start
# ✅ OpenManagedAgent Runtime listening on port 3000
```

### 2.2 配置 CLI 环境变量

```bash
export CLOUDBASE_SERVER_URL=http://localhost:3000
export CLOUDBASE_ENV_ID=your-env-id
```

### 2.3 一分钟体验

```bash
# 创建一个 Agent
magent agent:create --name "助手" --system "你是一个乐于助人的 AI 助手"

# 复制输出的 agent-id，执行一次性任务
magent run --agent agent_xxx --message "用 Python 写一个冒泡排序"
```

---

## 3. CLI 参考

### 安装 / 调用方式

```bash
# 直接调用（推荐加入 PATH）
node /path/to/magent.mjs

# 或软链接
ln -s /path/to/magent.mjs /usr/local/bin/magent
```

---

### Agent 管理

#### 创建 Agent

```bash
magent agent:create \
  --name "代码助手" \
  --model "hunyuan-2.0-instruct-20251111" \
  --system "你是一名专业的 Python 工程师，代码简洁、有注释"
```

**参数：**

| 参数       | 必须 | 说明                                    |
|------------|------|-----------------------------------------|
| `--name`   | ✅   | Agent 名称                              |
| `--model`  | ❌   | 模型，默认 `hunyuan-2.0-instruct-20251111` |
| `--system` | ❌   | 系统提示词                              |

**输出示例：**
```
✅ Agent created:
  agent_1x2y3z
    name   : 代码助手
    model  : hunyuan-2.0-instruct-20251111
    system : 你是一名专业的 Python 工程师，代码简洁、有注释
    created: 2026/5/19 11:00:00
```

#### 列出所有 Agent

```bash
magent agent:list
```

#### 查看 Agent 详情

```bash
magent agent:get -a agent_xxx
```

#### 删除 Agent

```bash
magent agent:delete -a agent_xxx
```

---

### Environment 管理

#### 创建环境

```bash
magent env:create --name "生产环境"
```

#### 列出 / 删除

```bash
magent env:list
magent env:delete --id env_xxx
```

---

### Session 管理

#### 创建 Session

```bash
magent session:create \
  --agent agent_xxx \
  --title "代码审查任务" \
  --env env_xxx          # 可选
```

**参数：**

| 参数      | 必须 | 说明                 |
|-----------|------|----------------------|
| `--agent` | ✅   | Agent ID             |
| `--title` | ❌   | 会话标题             |
| `--env`   | ❌   | Environment ID       |

#### 列出 / 查看 / 删除

```bash
magent session:list   -a agent_xxx
magent session:get    -i sess_xxx -a agent_xxx
magent session:delete -i sess_xxx -a agent_xxx
```

---

### 发送消息 & 获取结果

#### `run` — 一次性任务（推荐）

自动创建 Session、发送消息、流式输出结果、清理 Session。

```bash
magent run \
  --agent agent_xxx \
  --message "帮我写一个斐波那契数列函数，并测试 fib(10)"
```

加 `--keep-session` 保留 Session ID（方便后续继续对话）：

```bash
magent run \
  --agent agent_xxx \
  --message "分析这段代码的复杂度" \
  --keep-session
# Session kept: sess_abc123
```

#### `chat` — 向已有 Session 发送消息

```bash
# 先创建 session
magent session:create --agent agent_xxx --title "持续对话"
# → sess_abc123

# 发送第一条消息
magent chat --session sess_abc123 --message "你好，介绍一下你自己"

# 继续对话（保留上下文）
magent chat --session sess_abc123 --message "现在帮我写个排序算法"
magent chat --session sess_abc123 --message "改成降序排列"
```

#### `repl` — 交互式对话

```bash
magent repl --agent agent_xxx
```

```
🤖 OpenManagedAgent REPL
Type your message, press Enter. Ctrl+C to exit.

Creating session... sess_xyz789

You: 你好
Agent: 你好！我是 AI 助手，有什么我可以帮你的吗？

You: 写一个快速排序
Agent: 好的，这是一个 Python 快速排序实现...

You: ^C
Cleaning up...
```

---

## 4. SDK 参考

### 初始化

```typescript
import ManagedAgents from "open-managed-agent-sdk";

const client = new ManagedAgents({
  baseURL: process.env.CLOUDBASE_SERVER_URL ?? "http://localhost:3000",
  envId:   process.env.CLOUDBASE_ENV_ID,
  apiKey:  process.env.CLOUDBASE_API_KEY, // 可选，用于鉴权
});
```

### Agent CRUD

```typescript
// 创建
const agent = await client.agents.create({
  name:   "Coding Assistant",
  model:  "hunyuan-2.0-instruct-20251111",
  system: "You are a helpful coding assistant.",
  tools:  [{ type: "agent_toolset_20260401" }],
});
console.log(agent.id); // agent_xxx

// 查询
const agent = await client.agents.retrieve("agent_xxx");
const { data } = await client.agents.list();

// 删除
await client.agents.delete("agent_xxx");
```

### Session + 消息流

```typescript
// 1. 创建 session
const session = await client.sessions.create({
  agent:          agent.id,
  environment_id: env.id,
  title:          "My Task",
});

// 2. 先建立流（避免丢失早期事件）
const stream = client.sessions.events.stream(session.id);

// 3. 发送消息
await client.sessions.events.send(session.id, {
  events: [{
    type:    "user.message",
    content: [{ type: "text", text: "Write a fibonacci function" }],
  }],
});

// 4. 消费事件流
for await (const event of stream) {
  switch (event.type) {
    case "agent.message":
      console.log(event.content[0]?.text);
      break;
    case "agent.tool_use":
      console.log(`Tool call: ${event.tool_name}`);
      break;
    case "agent.custom_tool_use":
      // 处理自定义工具调用
      const result = await myTool(event.tool_name, event.input);
      await client.sessions.events.send(session.id, {
        events: [{
          type:        "user.custom_tool_result",
          tool_use_id: event.tool_use_id,
          content:     [{ type: "text", text: result }],
        }],
      });
      break;
    case "session.status_idle":
      console.log("Done!");
      break; // 退出循环
  }
}
```

### 多轮对话

```typescript
// 复用同一个 session 保持上下文
const session = await client.sessions.create({ agent: agent.id });

async function chat(message: string) {
  const stream = client.sessions.events.stream(session.id);
  await client.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
  });
  let reply = "";
  for await (const event of stream) {
    if (event.type === "agent.message") reply += event.content[0]?.text ?? "";
    if (event.type === "session.status_idle") break;
  }
  return reply;
}

console.log(await chat("你好"));
console.log(await chat("帮我写个冒泡排序"));
console.log(await chat("现在改成用 TypeScript"));
```

---

## 5. 完整工作流示例

### 场景：代码生成 + 测试 + 修改

```bash
# Step 1: 创建专门的代码助手 Agent
magent agent:create \
  --name "CodeBot" \
  --system "你是资深工程师。写代码时必须附带测试用例，代码风格遵循 PEP8。"

# 输出: agent_code123

# Step 2: 创建持久 Session（方便多轮对话）
magent session:create \
  --agent agent_code123 \
  --title "斐波那契项目"

# 输出: sess_task456

# Step 3: 发送第一个任务
magent chat \
  --session sess_task456 \
  --message "写一个斐波那契函数，要求：支持迭代和递归两种实现，包含完整测试"

# Step 4: 继续优化（同一 session，保留上下文）
magent chat \
  --session sess_task456 \
  --message "迭代版本改为支持大数（超过64位），使用 Python 的 int"

# Step 5: 查看会话状态
magent session:get -i sess_task456 -a agent_code123

# Step 6: 清理
magent session:delete -i sess_task456 -a agent_code123
```

### 场景：批量处理（多 Agent 并行）

```bash
#!/bin/bash
AGENT_ID="agent_xxx"

tasks=(
  "总结《三体》第一章的主要情节"
  "分析《三体》中的科学概念"
  "列出《三体》的主要人物及其特点"
)

for task in "${tasks[@]}"; do
  magent run --agent "$AGENT_ID" --message "$task" &
done

wait
echo "All tasks done!"
```

### 场景：通过 SDK 实现自定义工具

```typescript
// agent 可以请求调用你的自定义工具（如查数据库、调 API 等）
for await (const event of stream) {
  if (event.type === "agent.custom_tool_use") {
    let result: string;

    // 根据工具名分发
    if (event.tool_name === "query_database") {
      const rows = await db.query(event.input.sql as string);
      result = JSON.stringify(rows);
    } else if (event.tool_name === "call_api") {
      const resp = await fetch(event.input.url as string);
      result = await resp.text();
    } else {
      result = `Unknown tool: ${event.tool_name}`;
    }

    // 把结果返回给 agent
    await client.sessions.events.send(session.id, {
      events: [{
        type:        "user.custom_tool_result",
        tool_use_id: event.tool_use_id,
        content:     [{ type: "text", text: result }],
      }],
    });
  }
}
```

---

## 6. 事件类型说明

### Agent → 客户端

| 事件类型                    | 说明                                     |
|-----------------------------|------------------------------------------|
| `agent.message`             | Agent 的文本回复（可能分多次发送）       |
| `agent.thinking`            | Agent 内部思考过程（CoT，调试用）        |
| `agent.tool_use`            | Agent 调用内置工具（bash、文件读写等）   |
| `agent.tool_result`         | 工具执行结果                             |
| `agent.custom_tool_use`     | Agent 请求调用**自定义工具**（需你处理） |
| `session.status_idle`       | 任务完成，Agent 空闲                     |
| `session.status_terminated` | 会话因错误终止                           |

### 客户端 → Agent

| 事件类型                  | 说明                              |
|---------------------------|-----------------------------------|
| `user.message`            | 发送新消息                        |
| `user.interrupt`          | 中断当前执行                      |
| `user.custom_tool_result` | 返回自定义工具的执行结果          |
| `user.tool_confirmation`  | 审批/拒绝一次工具调用             |

### 内置工具（server-side）

| 工具名       | 说明               | 主要参数               |
|--------------|--------------------|------------------------|
| `bash`       | 执行 Shell 命令    | `command`, `timeout`   |
| `read_file`  | 读取文件内容       | `path`                 |
| `write_file` | 写入/创建文件      | `path`, `content`      |
| `list_files` | 列出目录内容       | `path`                 |

---

## 7. 部署到 CloudRun

### 构建镜像

```bash
cd packages/server
npm install
npm run build
docker build -t open-managed-agent:latest .
```

### 通过 CloudBase 控制台部署

1. 进入 [CloudBase 控制台](https://console.cloud.tencent.com/tcb) → 云托管
2. 新建服务，上传镜像或连接代码仓库
3. 设置环境变量：

   | 变量名                  | 说明                  |
   |-------------------------|-----------------------|
   | `CLOUDBASE_ENV_ID`      | 云开发环境 ID         |
   | `TENCENTCLOUD_SECRETID` | API 密钥 SecretId     |
   | `TENCENTCLOUD_SECRETKEY`| API 密钥 SecretKey    |
   | `PORT`                  | 监听端口（默认 3000） |

4. 开放端口 3000，启用公网访问

### 更新 SDK 指向线上地址

```bash
export CLOUDBASE_SERVER_URL=https://your-service.ap-shanghai.run.tcloudbase.com
magent agent:list   # 验证连通性
```

---

## 附录：常用命令速查

```bash
# ── 环境配置 ──────────────────────────────────────────────
export CLOUDBASE_SERVER_URL=http://localhost:3000
export CLOUDBASE_ENV_ID=your-env-id

# ── Agent ─────────────────────────────────────────────────
magent agent:create  --name "Bot" --system "You are helpful"
magent agent:list
magent agent:delete  -a agent_xxx

# ── 一次性任务 ────────────────────────────────────────────
magent run --agent agent_xxx --message "做某件事"

# ── 多轮对话 ──────────────────────────────────────────────
magent session:create -a agent_xxx --title "My task"
magent chat -s sess_xxx -m "第一条消息"
magent chat -s sess_xxx -m "继续..."
magent session:delete -i sess_xxx -a agent_xxx

# ── 交互式 REPL ───────────────────────────────────────────
magent repl --agent agent_xxx
```
