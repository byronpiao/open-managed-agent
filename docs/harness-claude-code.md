# 沙箱内 Agent — Claude Code

箱内 **Claude Code** 引擎（`engine: claude`）。通用流程见 [使用指南](./harness-tutorial.md)。

> Claude Code **没有** `zen` 内置模型；起步请用 CloudBase AI 默认模型或下方自定义配置。

---

## 快速开始

```yaml
name: My Claude Sandbox Agent
runtime: harness
engine: claude
system: |
  You are a helpful coding assistant in a remote sandbox workspace.
```

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

`TCB_API_KEY`（[控制台创建](https://tcb.cloud.tencent.com/dev?envId=your-env-id#/env/apikey)）同时用于：拉起沙箱、调用 **CloudBase AI**（Anthropic Messages [兼容网关](https://docs.cloudbase.net/ai/model/anthropic-sdk-access)，默认 `hy3-preview`）。**无需**单独的 Anthropic 官方 Key。

---

## 模型

| 配置 | 说明 |
|------|------|
| 省略 `model` 或 `hy3-preview` | **推荐起步**：CloudBase AI + 环境 API Key；可 [购买 Token 资源包](https://docs.cloudbase.net/ai/model/openai-sdk-access) |
| 自定义（下节） | 第三方 Anthropic 兼容 endpoint + 自有 Key（与 CloudBase Token **二选一**） |

---

## 自定义模型（Anthropic 兼容）

在 **`magent agent:create` 之前** export：

```bash
export LLM_API_KEY=your-api-key
export LLM_MODEL=your-model-id
export ANTHROPIC_BASE_URL=https://your-endpoint/anthropic
```

```yaml
runtime: harness
engine: claude
model: your-model-id
```

仍走 CloudBase AI（体验额度或已购 Token）时，**不要**配置 `LLM_*`，保持默认 `hy3-preview` 即可。

---

## 其它能力

工具、MCP、Skills、COS、镜像见 [使用指南](./harness-tutorial.md)。会话持久化说明见 [会话外置存储](./harness-agent-session-storage.md)（可选阅读）。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 鉴权失败 | 检查 `TCB_API_KEY`、控制台 AI 模型是否启用 |
| 想用 OpenCode / zen | [harness-opencode.md](./harness-opencode.md) |
| 沙箱无法启动 | [使用指南 · 首次起箱](./harness-tutorial.md#首次起箱沙箱工具与-rolearn) |

---

## 相关文档

- [使用指南](./harness-tutorial.md)
- [OpenCode](./harness-opencode.md)
- [README](../README.md)
