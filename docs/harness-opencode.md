# 沙箱内 Agent — OpenCode

箱内 **OpenCode** 引擎（`engine: opencode`）。通用流程见 [使用指南](./harness-tutorial.md)。

---

## 快速开始

凭证与部署与 [使用指南 · 从零到第一次对话](./harness-tutorial.md#用户故事从零到第一次对话) 相同。`TCB_API_KEY` 在 [控制台 API Key 页](https://tcb.cloud.tencent.com/dev?envId=your-env-id#/env/apikey) 创建。

```yaml
name: My Sandbox Agent
runtime: harness
engine: opencode
system: |
  You are a helpful coding assistant in a remote sandbox workspace.
```

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

## 模型

| 顺序 | 配置 | 说明 |
|------|------|------|
| 1 | 省略 `model` 或 `hy3-preview` | CloudBase AI + 环境 API Key；额度不足时在控制台 [购买 Token](https://docs.cloudbase.net/ai/model/openai-sdk-access) |
| 2 | `model: zen` | 箱内内置，**不扣** CloudBase AI 额度 |
| 3 | 自定义（下节） | 自有 OpenAI 兼容厂商 Key（与 CloudBase Token **二选一**） |

协议与接入：[OpenAI SDK 访问](https://docs.cloudbase.net/ai/model/openai-sdk-access) · [模型接入总览](https://docs.cloudbase.net/ai/model/model-access)

### zen

```yaml
engine: opencode
model: zen
```

`magent agent:update -f ./agent.sandbox.yaml -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"`

---

## 自定义模型（OpenAI 兼容）

在 **`magent agent:create` 之前** export（会写入 Runtime 环境变量）：

```bash
export LLM_API_KEY=your-api-key
export LLM_MODEL=moonshotai/kimi-k2.6
export OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
```

或在 yaml 使用 ModelSpec：

```yaml
model:
  id: your-model-id
  apiKey: your-api-key
  apiBaseUrl: https://your-openai-compatible-endpoint/v1
```

更换 Key 或 endpoint 后，重新部署或在云开发控制台更新该 Agent 的环境变量。

---

## 其它能力

bash、自定义工具、MCP、Skills、COS、自定义镜像见 [使用指南](./harness-tutorial.md)。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 首条消息超时 | 等待沙箱预热 |
| 模型 401 / 403 | 检查 API Key 与控制台 AI 开关 |
| 想用 Claude Code | [harness-claude-code.md](./harness-claude-code.md) |

---

## 相关文档

- [使用指南](./harness-tutorial.md)
- [Claude Code](./harness-claude-code.md)
- [README](../README.md)
