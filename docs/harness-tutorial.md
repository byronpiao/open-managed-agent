# 沙箱内 Agent 使用指南

在 README **托管 Agent** 流程基础上，部署并对话 **沙箱内 Agent**。

| | 托管 Agent（默认） | 沙箱内 Agent |
|---|-------------------|--------------|
| 思考与工具执行 | 网关 Runtime | **AGS 沙箱**内 engine |
| 典型场景 | 轻量对话、平台模型 | 远程工作区、命令与文件操作 |
| 配置 | 省略 `runtime` | `runtime: harness` + `engine: opencode` 或 `claude` |

> `runtime: harness` 即沙箱内 Agent。箱内引擎：**`opencode`**、**`claude`**（默认可用）；`codebuddy` 尚未开放。

**按引擎阅读：** [OpenCode](./harness-opencode.md) · [Claude Code](./harness-claude-code.md) · [架构参考](./harness-architecture.md) · [会话外置存储](./harness-agent-session-storage.md) · [环境变量](./harness-env.md)（研发验收）

---

## 前置条件

1. 已完成 [README 快速开始](../README.md#快速开始)（`magent login`、Node ≥ 20）。
2. CloudBase 环境已开通 **AGS 沙箱**。
3. 已创建环境 **API Key**（`TCB_API_KEY`），并在控制台启用 **CloudBase AI** 模型（默认体验模型 `hy3-preview`）。见 [接入大模型](https://docs.cloudbase.net/ai/model/model-access)。

部署沙箱内 Agent 用 **`agent.yaml` + `magent`**；凭证写在 shell 环境或 CloudBase 控制台，**不需要** `.env.harness`（该文件仅研发 Harness 验收用）。

---

## 第一步：最小配置，跑通一次对话

用箱内引擎 + **CloudBase AI** 默认模型（`hy3-preview`）完成首轮对话：只需环境 API Key（`TCB_API_KEY`），**无需**另填 `LLM_API_KEY` 或第三方 endpoint。无需 COS。

以下示例为 **OpenCode**（`engine: opencode`）。若要用 **Claude Code**，将示例换为 [agent.sandbox.claude.min.yaml](./examples/agent.sandbox.claude.min.yaml) 并设 `engine: claude`，详见 [harness-claude-code.md](./harness-claude-code.md)。

### 1. 凭证

在 shell 中 export（或写入你自己的密钥管理工具）：

```bash
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai
export TCB_SECRET_ID=your-secret-id
export TCB_SECRET_KEY=your-secret-key
export TCB_API_KEY=your-env-api-key
export CLOUDBASE_ACCESS_KEY=your-access-key
```

| 变量 | 用途 |
|------|------|
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | 会话持久化；`agent:create` 时注入 Runtime |
| `TCB_API_KEY` | 云开发环境 API Key：**AGS 沙箱** + **默认 CloudBase AI 模型**（无需另填 LLM Key） |
| `CLOUDBASE_ACCESS_KEY` | `magent run` / SDK 访问 Agent 网关 |

字段说明见 [harness-env.md](./harness-env.md) ① 段（与 [`.env.harness.example`](../.env.harness.example) 相同）。

### 2. 最小 `agent.yaml`

```bash
cp docs/examples/agent.sandbox.opencode.min.yaml ./agent.sandbox.yaml
```

```yaml
name: My Sandbox Agent
runtime: harness
engine: opencode
system: |
  You are a helpful coding assistant in a remote sandbox workspace.
```

（默认使用 CloudBase AI `hy3-preview`；也可显式写 `model: hy3-preview`。）

### 3. 构建并部署

```bash
npm run build

magent agent:create \
  --name "my-sandbox-agent" \
  --runtime harness \
  --engine opencode \
  --file ./agent.sandbox.yaml \
  --code ./packages/agent-runtime \
  -e "$CLOUDBASE_ENV_ID"
```

- 默认 **SCF 云函数**，约 60–90 秒就绪。
- 可选 `--type tcbr` 部署为云托管容器（约 3–5 分钟）；创建前需 export `TCB_SECRET_ID` / `TCB_SECRET_KEY`（见 [product-guide](./product-guide.md)）。
- yaml 已含 `runtime` / `engine` 时，CLI 可省略对应参数。

```bash
export CLOUDBASE_AGENT_ID=agent-my-sandbox-agent-xxxxxx
```

### 4. 等待就绪

```bash
magent agent:get -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"
```

### 5. 发第一条消息

```bash
magent run -a "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID" \
  -m "在沙箱里执行 uname -a，把输出原样返回。"
```

首次对话可能显示 `Warming sandbox...`，等待 1–3 分钟。

### 6. 用 SDK（可选）

```typescript
import ManagedAgents from "open-managed-agent-sdk";

const client = new ManagedAgents({
  envId: process.env.CLOUDBASE_ENV_ID!,
  agentId: process.env.CLOUDBASE_AGENT_ID!,
  accessKey: process.env.CLOUDBASE_ACCESS_KEY!,
});

const session = await client.sessions.create({ title: "sandbox-demo" });
for await (const event of client.sessions.prompt(session.id, "列出当前工作目录下的文件。")) {
  if (event.type === "chunk") process.stdout.write(event.text);
}
```

---

## 第二步：运行时结构

```text
客户端 (SDK / magent)
    │  HTTPS  ACP
    ▼
OMA Runtime（SCF / 云托管）  ← 会话、审批、MCP 桥接
    │  AGS
    ▼
远程沙箱（TRW + engine）     ← 命令、文件、LLM
```

| 字段 | 说明 |
|------|------|
| `runtime: harness` | 沙箱内 Agent |
| `engine: opencode` | 箱内 OpenCode — [专篇](./harness-opencode.md) |
| `engine: claude` | 箱内 Claude Code — [专篇](./harness-claude-code.md) |
| 省略 `model` | 默认 CloudBase AI `hy3-preview`（需环境 API Key） |

配置变更：`magent agent:update -f ./agent.sandbox.yaml -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"`（约数十秒；Runtime 代码变更需重新部署）。

---

## 第三步：沙箱工具（bash / 读写文件）

```yaml
tools:
  - type: agent_toolset
    default_config:
      enabled: true
      permission_policy:
        type: always_allow
    configs:
      - name: bash
        permission_policy:
          type: always_ask
```

```bash
magent agent:update -f ./agent.sandbox.yaml -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"
magent run -a "$CLOUDBASE_AGENT_ID" -m "创建 hello.txt 并写入 Hello sandbox."
```

---

## 第四步：自定义工具（客户端执行）

```yaml
tools:
  - type: custom
    name: query_database
    description: Run a read-only SQL query
    input_schema:
      type: object
      properties:
        sql: { type: string }
      required: [sql]
```

SDK 处理 custom tool 回调，协议与托管 Agent 相同。

---

## 第五步：外部 MCP

```yaml
mcp_servers:
  - type: url
    name: github
    url: https://api.githubcopilot.com/mcp/

tools:
  - type: mcp_toolset
    mcp_server_name: github
    default_config:
      permission_policy:
        type: always_allow
```

MCP 鉴权在服务商侧或你的部署环境中配置。

---

## 第六步：Skills

Skills 物化到沙箱工作区 `.agents/skills/`，供箱内 engine 读取。

```yaml
skills:
  - name: code-review
    description: Code review checklist
    source: ./skills/code-review.md
```

确保 `skills/` 随代码包或 `agent:update` 一并发布。

---

## 第七步：工具审批

```yaml
tools:
  - type: agent_toolset
    configs:
      - name: bash
        permission_policy:
          type: always_ask
```

SDK 流式事件中出现审批请求；客户端确认后继续 session。

---

## 第八步：CloudBase 箱内能力

创建 Agent 时 shell 已 export `TCB_SECRET_*` 的情况下，沙箱启动后自动初始化 **CloudBase MCP**（数据库、云函数等），yaml 中通常无需额外声明。

---

## 第九步：箱内引擎

| `engine` | 文档 |
|----------|------|
| `opencode` | [harness-opencode.md](./harness-opencode.md) |
| `claude` | [harness-claude-code.md](./harness-claude-code.md) |
| `codebuddy` | 尚未开放 |

默认模型与自定义 LLM 配置见各引擎专篇。

---

## 进阶

### 工作区快照（COS）

需单独开通 COS 并在 Runtime 环境配置相应变量。见 [harness-env.md](./harness-env.md)。

### 导出配置

```bash
magent agent:export -i "$CLOUDBASE_AGENT_ID" -o ./agent.sandbox.yaml
magent agent:update -f ./agent.sandbox.yaml -i "$CLOUDBASE_AGENT_ID"
```

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 首条消息超时 | 等待沙箱预热；重试 `magent run` |
| `MISSING_CREDENTIALS` | 创建/更新 Agent 前 export `TCB_SECRET_*` |
| 沙箱无法启动 | 检查 `TCB_API_KEY` 与 AGS 开通状态 |
| yaml 不生效 | `magent agent:update -f ...`；容器内 `agent.yaml` 优先于环境变量 |
| 模型 401 / 额度 | 检查控制台 AI 模型开关与 Token；默认走 `hy3-preview` |
| 第三方 LLM（Mimo 等） | 见 [harness-opencode.md](./harness-opencode.md) / [harness-claude-code.md](./harness-claude-code.md) 自定义一节 |
| OpenCode 内置 zen | yaml 写 `model: zen`（不扣 CloudBase AI），见 [harness-opencode.md](./harness-opencode.md) |

---

## 相关文档

- [harness-opencode.md](./harness-opencode.md)
- [harness-claude-code.md](./harness-claude-code.md)
- [README](../README.md)
- [product-guide.md](./product-guide.md)
- [harness-architecture.md](./harness-architecture.md)
- [harness-agent-session-storage.md](./harness-agent-session-storage.md)
- [harness-env.md](./harness-env.md)
