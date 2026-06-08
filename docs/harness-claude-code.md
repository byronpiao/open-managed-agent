# 沙箱内 Agent — Claude Code

在 [沙箱内 Agent 使用指南](./harness-tutorial.md) 基础上，使用箱内 **Claude Code** 引擎（`engine: claude`）。

---

## 快速开始

### 1. 凭证

与通用沙箱 Agent 相同：

```bash
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai
export TCB_SECRET_ID=your-secret-id
export TCB_SECRET_KEY=your-secret-key
export TCB_API_KEY=your-env-api-key
export CLOUDBASE_ACCESS_KEY=your-access-key
```

### 2. `agent.yaml`

```yaml
name: My Claude Sandbox Agent
runtime: harness
engine: claude
system: |
  You are a helpful coding assistant in a remote sandbox workspace.
```

无需单独配置 Anthropic API Key。`TCB_API_KEY`（环境 API Key）在拉起沙箱之外，会作为 **CloudBase AI** 凭证（Anthropic Messages 兼容，默认 `hy3-preview`）。

可选写明模型：

```yaml
runtime: harness
engine: claude
model: hy3-preview
```

### 3. 部署与对话

```bash
magent agent:create \
  --name "my-claude-sandbox" \
  --runtime harness \
  --engine claude \
  --file ./agent.sandbox.yaml \
  --code ./packages/agent-runtime \
  -e "$CLOUDBASE_ENV_ID"

magent run -a "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID" \
  -m "列出当前工作目录下的文件。"
```

---

## 模型说明

| 配置 | 说明 |
|------|------|
| 省略 `model` 或 `model: hy3-preview` | **默认**：CloudBase AI 体验模型 |
| 自定义模型（见下） | 使用你自己的 Anthropic 兼容 endpoint 与 API Key |

协议与配置方式见：[Anthropic SDK 调用](https://docs.cloudbase.net/ai/model/anthropic-sdk-access)。

---

## 自定义模型（可选）

使用第三方 Anthropic 兼容服务（如 Mimo Token Plan）时，在创建 Agent 前配置：

```bash
export LLM_API_KEY=tp-xxxxxxxx
export LLM_MODEL=mimo-v2.5-pro
export ANTHROPIC_BASE_URL=https://token-plan-sgp.xiaomimimo.com/anthropic
```

```yaml
runtime: harness
engine: claude
model: mimo-v2.5-pro
system: |
  You are a helpful coding assistant in a remote sandbox workspace.
```

---

## 工具、MCP、Skills

与引擎无关的能力见 [harness-tutorial](./harness-tutorial.md)。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| `Authentication required` | 检查 `TCB_API_KEY`、控制台 AI 模型开关 |
| 想用 OpenCode | 见 [harness-opencode.md](./harness-opencode.md) |
| 沙箱无法启动 | 确认 AGS 已开通，见 [harness-tutorial](./harness-tutorial.md) |

---

## 相关文档

- [沙箱内 Agent 使用指南](./harness-tutorial.md)
- [OpenCode 沙箱引擎](./harness-opencode.md)
- [环境变量](./harness-env.md)
