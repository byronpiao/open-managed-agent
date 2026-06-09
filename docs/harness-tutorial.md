# 沙箱内 Agent 使用指南

在 [README 快速开始](../README.md) 基础上，部署并在 **远程沙箱**里运行 OpenCode 或 Claude Code（`runtime: harness`）。

| | 托管 Agent（默认） | 沙箱内 Agent |
|---|-------------------|--------------|
| 执行位置 | 网关 Runtime | 远程沙箱内的 engine |
| 适合 | 轻量对话、MCP | bash、改文件、完整编码环境 |
| 配置 | 省略 `runtime` | `runtime: harness` + `engine: opencode` 或 `claude` |

**按引擎阅读：** [OpenCode](./harness-opencode.md) · [Claude Code](./harness-claude-code.md)

---

## 开始之前

1. 完成 [README](../README.md) 中的 `magent login`、Node ≥ 20。
2. 环境已开通 **AGS 沙箱**。
3. 在控制台创建 [环境 API Key](https://tcb.cloud.tencent.com/dev?envId=your-env-id#/env/apikey)，并开通 [CloudBase AI](https://docs.cloudbase.net/ai/model/model-access)（默认模型 `hy3-preview`）。

部署使用 **`agent.yaml` + `magent`**，在 shell 或云函数/云托管环境变量里配置凭证即可。

---

## 用户故事：从零到第一次对话

目标：用 **CloudBase AI 默认模型** 跑通一条命令，**无需**第三方 LLM Key，**无需** COS。

### 1. 准备凭证

```bash
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai
export TCB_SECRET_ID=your-secret-id
export TCB_SECRET_KEY=your-secret-key
export TCB_API_KEY=your-env-api-key          # 见上方 API Key 链接
export CLOUDBASE_ACCESS_KEY=your-access-key  # 可与 TCB_API_KEY 相同
```

| 变量 | 作用 |
|------|------|
| `TCB_SECRET_*` | 部署 Agent、会话持久化 |
| `TCB_API_KEY` | 拉起沙箱 + 调用 CloudBase AI（默认 `hy3-preview`） |
| `CLOUDBASE_ACCESS_KEY` | `magent run` / SDK 访问网关 |

### 2. 编写 `agent.yaml`

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

使用 **Claude Code** 时：换 [agent.sandbox.claude.min.yaml](./examples/agent.sandbox.claude.min.yaml)，`engine: claude`，见 [harness-claude-code.md](./harness-claude-code.md)。

### 3. 部署

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

- 默认云函数，约 1–2 分钟就绪；生产推荐 `--type tcbr`（见 [product-guide](./product-guide.md)）。
- 若报错与 **RoleArn / 沙箱工具** 有关，见下文 [首次起箱](#首次起箱沙箱工具与-rolearn)。

```bash
export CLOUDBASE_AGENT_ID=agent-my-sandbox-agent-xxxxxx
magent agent:get -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"
```

### 4. 对话

```bash
magent run -a "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID" \
  -m "在沙箱里执行 uname -a，把输出原样返回。"
```

首次可能显示 `Warming sandbox...`，等待 1–3 分钟。

### 5. 用 SDK（可选）

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

## 用户故事：选择模型

同一套部署方式，按需求调整模型即可。

| 你想… | 做法 | 适用引擎 |
|--------|------|----------|
| 用 CloudBase 模型（推荐起步） | 省略 `model` 或写 `hy3-preview` + 环境 API Key；体验额度用完后可在控制台 [购买 Token 资源包](https://docs.cloudbase.net/ai/model/openai-sdk-access) | opencode、claude |
| 不消耗 CloudBase AI 额度 | `model: zen` | **仅 opencode** |
| 用自己的 LLM 厂商 Key | 部署前 export `LLM_*`，或 yaml 里写 ModelSpec（与上表 CloudBase Token **二选一**） | 见下方与引擎专篇 |

改完后：

```bash
magent agent:update -f ./agent.sandbox.yaml -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"
```

**OpenCode — 第三方 OpenAI 兼容（如 NVIDIA）：**

```bash
export LLM_API_KEY=your-api-key
export LLM_MODEL=moonshotai/kimi-k2.6
export OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
magent agent:create ...   # 已部署的 Agent 改 Key：重新 create 或在控制台改该函数的环境变量
```

**Claude Code — 默认仍走 CloudBase AI**（[Anthropic 协议兼容](https://docs.cloudbase.net/ai/model/anthropic-sdk-access)，同一 `TCB_API_KEY`）。第三方 Anthropic 兼容服务：

```bash
export LLM_API_KEY=your-api-key
export LLM_MODEL=your-model-id
export ANTHROPIC_BASE_URL=https://your-endpoint/anthropic
```

细节：[harness-opencode.md](./harness-opencode.md) · [harness-claude-code.md](./harness-claude-code.md)

---

## 用户故事：能力进阶

在能对话之后，按需叠加（`magent agent:update -f ./agent.sandbox.yaml`）。

| 步骤 | 能力 | 说明 |
|------|------|------|
| [工具](#沙箱工具) | bash、读写文件 | `agent_toolset` |
| [自定义工具](#自定义工具) | 客户端执行逻辑 | `type: custom` + SDK 回调 |
| [MCP](#外部-mcp) | 接 GitHub 等远程 MCP | `mcp_servers` + `mcp_toolset` |
| [Skills](#skills) | 领域知识文件 | 物化到沙箱 `.agents/skills/` |
| [审批](#工具审批) | bash 等需用户确认 | `permission_policy: always_ask` |

---

## 首次起箱：沙箱工具与 RoleArn

**什么时候会遇到：** 本 CloudBase 环境**从未**创建过 AGS 沙箱工具，第一次 `magent agent:create --runtime harness` 时。

**不需要 RoleArn 的情况：** 控制台 **AGS → 沙箱工具** 里已有工具，或团队已用 `tcb sandbox tool create` 创建过。

**需要 RoleArn 的情况：** 希望由 Runtime **自动创建**沙箱工具。在 `agent:create` **之前**执行：

```bash
export HARNESS_TOOL_ROLE_ARN=qcs::cam::uin/<你的UIN>:roleName/<角色名>
```

角色从哪来：

1. **推荐**：复制环境里**已有沙箱工具**详情页上的 RoleArn（`tcb sandbox tool list` 亦可查看）。
2. 由运维在 CAM 新建角色并授权：至少能拉取沙箱使用的 **容器镜像**；若启用 COS 工作区，还需对应 **COS** 权限。
3. 自行 `tcb sandbox tool create ... --role-arn ...` 创建工具后，再部署 Agent（此后不必再配 RoleArn）。

`HARNESS_TOOL_ROLE_ARN` 是**沙箱实例**在云上运行的身份，**不是**云函数执行角色，也**不是** API Key。

自动创建的工具在控制台显示为 **`oma-harness-<你的环境 ID>`**（与是否启用 COS 无关；COS 只影响挂载配置，不会出现在工具名称里）。

---

## 进阶

### 自定义沙箱镜像

默认使用平台提供的公开 **magent** 沙箱镜像，**一般不用改**。

若你方构建了私有镜像，在 **部署 Agent 之前**指定：

```bash
export HARNESS_SANDBOX_IMAGE=ccr.ccs.tencentyun.com/<命名空间>/<镜像>:<tag>
magent agent:create --runtime harness ...
```

镜像需为 magent 预设（含 TRW + OpenCode/Claude Code）。自建镜像流程请联系交付或参考团队内部构建文档。

### 工作区持久化（COS）

**默认：** 多轮对话靠平台会话与同步能力恢复；沙箱里写的文件会随实例回收而丢失。

**启用 COS：** 把项目目录挂到对象存储，会话结束时可快照，下次起箱恢复现场（适合长周期编码任务）。

在 `magent agent:create` 前配置（会写入 Runtime 环境变量）：

```bash
export HARNESS_COS_ENABLED=1
export HARNESS_COS_BUCKET=your-bucket-appid
export HARNESS_COS_BUCKET_PATH=/your/prefix
export HARNESS_COS_ENDPOINT=your-bucket.cos.ap-shanghai.myqcloud.com
export HARNESS_COS_REGION=ap-shanghai
export HARNESS_COS_MOUNT_NAME=ags-cos-workspace    # 与 AGS 工具挂载名一致
export HARNESS_COS_MOUNT_DIR=/mnt/workspace
```

需已在 AGS 沙箱工具上配置好同名 **StorageMount**。首次启用建议与运维确认桶路径与 CAM 权限。

### 导出与回写配置

```bash
magent agent:export -i "$CLOUDBASE_AGENT_ID" -o ./agent.sandbox.yaml
# 编辑后
magent agent:update -f ./agent.sandbox.yaml -i "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID"
```

---

## 运行时结构

```text
客户端 (SDK / magent) → OMA Runtime → AGS 远程沙箱 → OpenCode / Claude Code
```

`magent agent:update` 改配置约数十秒；**Runtime 代码**变更需重新 `agent:create` 或按 [README](../README.md) 部署章节更新代码包。

---

## 沙箱工具

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

---

## 自定义工具

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

由 SDK 在客户端执行，协议与托管 Agent 相同。

---

## 外部 MCP

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

---

## Skills

```yaml
skills:
  - name: code-review
    description: Code review checklist
    source: ./skills/code-review.md
```

随 `agent:update` 或代码包发布。

---

## 工具审批

```yaml
tools:
  - type: agent_toolset
    configs:
      - name: bash
        permission_policy:
          type: always_ask
```

SDK 流式事件中出现审批请求，确认后继续。

---

## CloudBase 箱内能力

创建 Agent 时已 export `TCB_SECRET_*` 时，沙箱启动后会初始化 **CloudBase MCP**（数据库、云函数等），yaml 通常无需额外声明。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 首条消息超时 | 等待沙箱预热；重试 `magent run` |
| `MISSING_CREDENTIALS` | 部署前 export `TCB_SECRET_*` |
| 沙箱无法启动 | 检查 `TCB_API_KEY`、AGS 是否开通 |
| 模型 401 / 额度 | 控制台检查 AI 模型开关与 Token 包 |
| 不想用 CloudBase AI 额度 | opencode：`model: zen` |
| 第三方 LLM | 见 [选择模型](#用户故事选择模型) |
| 起箱报 RoleArn / 工具错误 | 见 [首次起箱](#首次起箱沙箱工具与-rolearn) |
| yaml 改了不生效 | `magent agent:update -f ...` |

---

## 相关文档

- [README](../README.md)
- [harness-opencode.md](./harness-opencode.md)
- [harness-claude-code.md](./harness-claude-code.md)
- [product-guide.md](./product-guide.md)
- [架构参考](./harness-architecture.md)（可选阅读）
