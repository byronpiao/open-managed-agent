# 沙箱内 Agent — OpenCode

在 [沙箱内 Agent 使用指南](./harness-tutorial.md) 基础上，使用箱内 **OpenCode** 引擎（`engine: opencode`）。

---

## 快速开始

### 1. 凭证

与通用沙箱 Agent 相同（见 [harness-tutorial](./harness-tutorial.md#第一步最小配置跑通一次对话)）：

```bash
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai
export TCB_SECRET_ID=your-secret-id
export TCB_SECRET_KEY=your-secret-key
export TCB_API_KEY=your-env-api-key
export CLOUDBASE_ACCESS_KEY=your-access-key
```

`TCB_API_KEY` 为云开发环境 API Key（控制台或 `tcb sandbox apikey create`）。沙箱 Agent 用它做两件事：**拉起 AGS 沙箱**，以及（未配置自定义 LLM 时）**调用默认 CloudBase AI `hy3-preview`**。

### 2. `agent.yaml`

```yaml
name: My Sandbox Agent
runtime: harness
engine: opencode
system: |
  You are a helpful coding assistant in a remote sandbox workspace.
```

无需填写模型 API Key。Runtime 在起沙箱时会使用环境的 **CloudBase AI 体验模型**（默认 `hy3-preview`）。

也可在 yaml 中写明模型 ID：

```yaml
runtime: harness
engine: opencode
model: hy3-preview
```

### 3. 部署与对话

```bash
magent agent:create \
  --name "my-sandbox-agent" \
  --runtime harness \
  --engine opencode \
  --file ./agent.sandbox.yaml \
  --code ./packages/agent-runtime \
  -e "$CLOUDBASE_ENV_ID"

magent run -a "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID" \
  -m "在沙箱里执行 uname -a，把输出原样返回。"
```

---

## 模型说明（循序渐进）

| 顺序 | 配置 | 说明 |
|------|------|------|
| 1 | 省略 `model` 或 `model: hy3-preview` | **默认起步**：CloudBase AI 体验模型（`TCB_API_KEY`） |
| 2 | `model: zen` | 箱内 **内置**模型，**不消耗** CloudBase AI 额度 |
| 3 | 自定义（见下） | **BYOK**：自有 OpenAI 兼容 Key（NVIDIA、Mimo 等） |

CloudBase AI 双协议：[OpenAI SDK 调用](https://docs.cloudbase.net/ai/model/openai-sdk-access)。

### 使用 zen

```yaml
runtime: harness
engine: opencode
model: zen
```

更新 Agent：`magent agent:update -f ./agent.sandbox.yaml -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"`。

---

## 自定义模型（BYOK，可选）

在 `magent agent:create` / `agent:update` 前配置 Runtime 环境变量。OpenAI 兼容示例（NVIDIA Integrate）：

```bash
export LLM_API_KEY=your-nvapi-key
export LLM_MODEL=moonshotai/kimi-k2.6
export OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
```

Mimo（Token Plan）等其它厂商同样使用 `LLM_API_KEY` + `LLM_MODEL` + `OPENAI_BASE_URL`。

或在 `agent.yaml` 使用 ModelSpec：

```yaml
runtime: harness
engine: opencode
model:
  id: your-model-id
  apiKey: your-api-key
  apiBaseUrl: https://your-openai-compatible-endpoint/v1
```

---

## 工具、MCP、Skills

与引擎无关的能力（bash、自定义工具、外部 MCP、Skills、审批）见 [harness-tutorial](./harness-tutorial.md)。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 首条消息超时 | 等待沙箱预热；重试 `magent run` |
| 模型 401 / 403 | 检查环境 API Key、AI 模型是否已在控制台启用 |
| 想用内置 zen | yaml 写 `model: zen` |
| 想用 Claude Code | 见 [harness-claude-code.md](./harness-claude-code.md) |

---

## 相关文档

- [沙箱内 Agent 使用指南](./harness-tutorial.md)
- [Claude Code 沙箱引擎](./harness-claude-code.md)
- [环境变量](./harness-env.md)（研发验收用 `.env.harness`）
