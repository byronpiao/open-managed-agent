# 沙箱内 Agent 使用指南

在远程沙箱里运行 **OpenCode** 或 **Claude Code**，用 `magent` 部署并与 Agent 对话。与默认「托管 Agent」的区别：编码、bash、读写文件在**沙箱内**完成，而不是在网关进程里。

| | 托管 Agent（默认） | 沙箱内 Agent（本文） |
|---|-------------------|---------------------|
| 适合 | 轻量对话、MCP | 远程 bash、改项目文件、完整编码环境 |
| 配置 | `agent.yaml` 省略 `runtime` | `runtime: harness` + `engine: opencode` 或 `claude` |

---

## 文档怎么读

按顺序即可；不必一次读完。

| 步骤 | 文档 | 何时读 |
|------|------|--------|
| 1 选型 | [用户故事](./harness-user-story.md) | 不确定用 CLI 还是 HTTP API |
| 2 动手（本文） | 下文 **快速开始** | 第一次部署 |
| 3 凭证 | [凭证说明](./harness-credentials.md) | 部署前自检失败、或首次在本环境使用沙箱 |
| 4 按引擎 | [OpenCode](./harness-opencode.md) · [Claude Code](./harness-claude-code.md) | 换引擎或换模型 |
| 5 HTTP 集成 | [Managed Agents 使用指南](./managed-agents-guide.md) | 应用后端走 REST + SSE |

---

## 开始之前

1. **Node.js ≥ 20**，已 [安装 `magent`](../README.md#1-安装-magent-cli)（**推荐 clone 本仓库** 后 `npm install && npm link`；下文命令均在**仓库根目录**执行）。
2. 已有 [CloudBase 环境](https://tcb.cloud.tencent.com)，并开通 **Agent 沙箱**、**CloudBase AI**（默认模型 `hy3-preview`）。
3. 本机执行一次：

```bash
magent login
tcb env use <你的环境 ID>
```

不必在控制台单独创建 API Key；也不必手填 `TCB_SECRET_*` 等变量（CI 例外见 [凭证说明](./harness-credentials.md#ci-与无交互部署)）。

---

## 快速开始

目标：用 **CloudBase AI 默认模型** 完成第一次对话，无需第三方 LLM Key，无需对象存储。

![Quickstart flow](./diagrams/harness-quickstart-flow.svg)

### 第 1 步：部署前检查（推荐）

```bash
node scripts/check-harness-ready.mjs
# 或：npm run check:harness
```

终端会打印**表格**：登录、环境、地域、沙箱工具是否就绪、是否需要配置角色 ARN。

- 全部 ✓ → 继续第 2 步  
- **首次创工具** 一行 ✗ → 按 [凭证说明 · 控制台逐步操作](./harness-credentials.md#控制台逐步操作照填) 创建 CAM 角色，然后：

```bash
export HARNESS_TOOL_ROLE_ARN='qcs::cam::uin/<账号>:roleName/<角色名>'
node scripts/check-harness-ready.mjs   # 再跑，应通过
```

> `magent agent:create --runtime harness` 会做**同一套检查**；未通过会直接拒绝部署，不会拖到第一次对话才报错。

同一环境只要创建过沙箱工具，**以后部署不必再配** `HARNESS_TOOL_ROLE_ARN`。

### 第 2 步：准备配置文件

```bash
cp agent.harness.yaml.example agent.harness.yaml
```

本地工作副本 `agent.harness.yaml` 已在 `.gitignore`，勿提交密钥。字段说明见 **`agent.harness.yaml.example`**。

### 第 3 步：构建并部署

```bash
npm run build
# 或仅构建运行时：npm run build --workspace=packages/agent-runtime

magent agent:create \
  --name "my-sandbox" \
  --runtime harness \
  --engine opencode \
  --file ./agent.harness.yaml \
  --code ./packages/agent-runtime
```

- 首次部署约 **1–2 分钟**；`magent agent:get -a <agent-id>` 显示 **Ready** 后再对话。  
- `--name` 宜短（过长可能导致别名失败）。  
- 生产环境建议云托管部署：`--type tcbr`（见 [product-guide](./product-guide.md)）。

记下输出的 Agent ID：

```bash
export CLOUDBASE_AGENT_ID=agent-xxxxxxxx
magent agent:get -a "$CLOUDBASE_AGENT_ID"
```

### 第 4 步：第一次对话

```bash
magent run -a "$CLOUDBASE_AGENT_ID" \
  -m "在沙箱里执行 uname -a，把输出原样返回。"
```

首次可能显示 **Warming sandbox...**，等待约 **1–3 分钟** 属正常。

### 第 4 步续：多轮对话（推荐）

单次 `magent run` 结束后会话会销毁。要继续在同一上下文里编码，用 **REPL**：

```bash
magent repl -a "$CLOUDBASE_AGENT_ID"
```

在提示符下连续输入任务即可；退出用 `exit` 或 Ctrl+D。

### 第 5 步：在应用里调用（可选）

若你的服务要按 [Managed Agents HTTP](./managed-agents-guide.md) 集成，在部署完成后配置 SDK。若只是试用，**第 4 步已足够**。

沙箱 Agent 的 SDK **必须**声明 `runtime: "harness"`（否则会误走 ACP 协议）。`accessKey` 为网关 Bearer，获取方式见 [凭证说明 · 应用鉴权](./harness-credentials.md#应用里如何鉴权-sdk--http)。

```typescript
import ManagedAgents from "open-managed-agent-sdk";

const client = new ManagedAgents({
  envId: "<env-id>",
  agentId: "<agent-id>",
  runtime: "harness",
  accessKey: "<gateway-bearer-token>",
});

const session = await client.sessions.create({ title: "demo" });
for await (const event of client.sessions.prompt(session.id, "列出当前目录下的文件。")) {
  if (event.type === "chunk") process.stdout.write(event.text);
}
```

完整 MA HTTP 流程（Environment、SSE、`user.message`）见 [managed-agents-guide.md](./managed-agents-guide.md)。

---

## 学完快速开始之后（渐进路线）

按顺序叠加即可；每一步都建立在「已能 `magent run` 或 REPL 对话」之上。

| 阶段 | 目标 | 做什么 | 详见 |
|------|------|--------|------|
| **0** | 第一次对话 | 快速开始 第 1–4 步 | 上文 |
| **1** | 多轮编码 | `magent repl -a <id>` | 第 4 步续 |
| **2** | 换模型 | 改 `agent.harness.yaml` 的 `model` → `agent:update` | [选择模型](#选择模型) · 引擎专篇 |
| **3** | 换引擎 | `engine: claude` 或 opencode + `zen` | [OpenCode](./harness-opencode.md) · [Claude](./harness-claude-code.md) |
| **4** | 工具与审批 | `agent_toolset`、bash `always_ask` | [能力进阶 · 沙箱工具](#沙箱工具bash-等) |
| **5** | 外部能力 | MCP、`skills` 文件 | [能力进阶 · MCP / Skills](#外部-mcp) |
| **6** | 长任务存盘 | COS 工作区（**须在首次 `agent:create` 前**配置） | [工作区持久化](#工作区持久化-cos) |
| **7** | 自定义环境 | 自有 TCR 镜像 | [沙箱镜像](#沙箱镜像) |
| **8** | 业务集成 | REST + SSE | [managed-agents-guide](./managed-agents-guide.md) |

> **COS / 自定义镜像**：环境变量在**创建沙箱工具**时写入平台；若你已按默认方式部署，要启用 COS 或换镜像，请**新建一个 harness Agent**（可复用同一 `HARNESS_TOOL_ROLE_ARN`），并在新的 `agent:create` 前 export 相应变量。

---

## 选择模型

在 `agent.harness.yaml` 配置 `model`。`engine` 决定 `apiBaseUrl` 须为 OpenAI 兼容还是 Anthropic 兼容，二者不可混用。

| 你想… | yaml 写法 | 适用 engine |
|--------|-----------|-------------|
| CloudBase 平台 AI（**推荐起步**） | 省略 `model` 或 `model: hy3-preview` | opencode、claude |
| 不扣 CloudBase AI 额度 | `model: zen` | **仅 opencode** |
| 自有 LLM 厂商（BYOK） | `model:` 对象含 `id` / `apiKey` / `apiBaseUrl` | opencode → OpenAI 兼容 URL；claude → Anthropic 兼容 URL |

修改后：

```bash
magent agent:update -f ./agent.harness.yaml -a "$CLOUDBASE_AGENT_ID"
```

**OpenCode + 第三方 OpenAI 兼容（yaml 示例）：**

```yaml
engine: opencode
model:
  id: <模型 ID>
  apiKey: <API Key>
  apiBaseUrl: https://<你的域名>/v1
```

**Claude Code + 第三方 Anthropic 兼容：**

```yaml
engine: claude
model:
  id: <模型 ID>
  apiKey: <API Key>
  apiBaseUrl: https://<你的域名>/anthropic
```

引擎专篇：[OpenCode 模型](./harness-opencode.md#模型) · [Claude Code 模型](./harness-claude-code.md#模型)

---

## 能力进阶

在能正常对话后，按需叠加（`magent agent:update -f ./agent.harness.yaml`）。建议按上文 [渐进路线](#学完快速开始之后渐进路线) 阶段 4–5 逐项尝试。

| 能力 | 配置要点 | 试一把 |
|------|----------|--------|
| bash、读写文件 | `agent_toolset` | 更新 yaml 后 `magent run -m "创建 hello.txt 并 cat"` |
| 客户端自定义工具 | `type: custom` + SDK 回调 | 见 [managed-agents-guide](./managed-agents-guide.md) HITL 事件 |
| 外部 MCP | `mcp_servers` + `mcp_toolset` | 更新后 `magent run -m "用 MCP 查当前时间"` |
| Skills | `skills` 列表 | 先 `mkdir -p skills` 并写好 md，再 `agent:update` |
| 工具需用户确认 | `permission_policy: always_ask` | REPL 里触发 bash，按提示确认 |

### 沙箱工具（bash 等）

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

### 自定义工具

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

由你的应用在客户端执行，协议与托管 Agent 相同。

### 外部 MCP

```yaml
mcp_servers:
  - type: url
    name: github
    url: https://api.githubcopilot.com/mcp/

tools:
  - type: mcp_toolset
    mcp_server_name: github
```

### Skills

先在本机准备技能文件，再写入 yaml：

```bash
mkdir -p skills
echo '# Code review checklist\n- Tests\n- Security' > skills/code-review.md
```

```yaml
skills:
  - name: code-review
    description: Code review checklist
    source: ./skills/code-review.md
```

`agent:update -f ./agent.harness.yaml` 后，在 REPL 里让 Agent「按 code-review skill 审查一段代码」验证是否加载。

### 工具审批

在 `agent_toolset` 里为具体工具设置 `permission_policy: always_ask`；SDK 事件流中会出现确认请求。

### CloudBase 能力（箱内）

已 `magent login` 时，沙箱启动后通常可使用 CloudBase 数据库、云函数等能力（通过箱内 MCP），一般无需在 yaml 里额外声明。

---

## 沙箱镜像

### 默认（推荐）

不配置 `sandbox.image` 时，平台使用内置 **magent** 规格镜像：远程工作区（:9000）+ 箱内 **OpenCode / Claude Code / CodeBuddy** 的 ACP 能力。快速开始**不必改镜像**。

### 自定义（可选）

仅在需要预装系统依赖、固定工具链版本或企业私有基础镜像时：

1. 构建的镜像须**保留箱内 Agent 与 ACP**（与 magent 规格同等能力）；仅 minimal「无 Agent」镜像无法用于 `runtime: harness`。  
2. 将镜像推到与沙箱**同地域**的 [腾讯云容器镜像服务 TCR](https://console.cloud.tencent.com/tcr)。  
3. 在 `agent.harness.yaml` 指定：

```yaml
sandbox:
  image: ccr.ccs.tencentyun.com/<命名空间>/<镜像>:<tag>
  imageRegistryType: enterprise   # 企业版 TCR；个人版可省略（默认 personal）
```

4. `magent agent:update -f ./agent.harness.yaml -a <agentId>`，**下次起沙箱**时生效。

**首次**在本环境创建沙箱工具时，`HARNESS_TOOL_ROLE_ARN` 须能拉取该 TCR 仓库（通常 `QcloudTCRReadOnlyAccess`），见 [凭证说明](./harness-credentials.md)。

若你已按默认方式部署、现在要换镜像，请**新建一个 harness Agent**（可复用同一 `HARNESS_TOOL_ROLE_ARN`），并在 `agent:create` 前写好 `sandbox.image`。

---

## 工作区持久化（COS）

**默认：** 多轮**对话**可由平台会话能力恢复；沙箱磁盘里的**项目文件**在实例回收后会丢失。

**启用 COS：** 将工作目录挂载到对象存储；会话结束时可把现场保存到桶里，下次起沙箱可恢复（适合长周期编码任务）。

在 `magent agent:create` **之前**配置（对客交付路径）：

```bash
export HARNESS_COS_ENABLED=1
export HARNESS_COS_BUCKET=your-bucket-appid
export HARNESS_COS_BUCKET_PATH=/your/prefix
export HARNESS_COS_ENDPOINT=your-bucket.cos.ap-shanghai.myqcloud.com
export HARNESS_COS_REGION=ap-shanghai
export HARNESS_COS_MOUNT_NAME=ags-cos-workspace
export HARNESS_COS_MOUNT_DIR=/mnt/workspace
```

同一 `HARNESS_TOOL_ROLE_ARN` 还须允许向该桶**写入**（快照需要上传对象）。预设可加 `QcloudCOSFullAccess`，或配置桶级策略 — 见 [凭证说明 · COS](./harness-credentials.md#cos-工作区与快照角色还要什么权限)。

---

## 导出与更新配置

```bash
magent agent:export -a "$CLOUDBASE_AGENT_ID" -o ./agent.harness.yaml
# 编辑后
magent agent:update -f ./agent.harness.yaml -a "$CLOUDBASE_AGENT_ID"
```

仅改 `agent.yaml` 约数十秒生效；**替换 Runtime 代码**需重新部署代码包（见 [README 部署](../README.md)）。

---

## 可观测性

默认：OMA Runtime **stdout** 结构化日志；向沙箱转发时透传 `traceparent`（或 `x-cloudbase-trace`）与 `X-Request-Id`，便于与 CloudBase [服务调用日志](https://docs.cloudbase.net/logger/tracelog) 对齐。

集成方在调用 Managed Agents / ACP 时建议带上 `traceparent` 与 `X-Request-Id`。可选 OpenTelemetry（Runtime 与沙箱实例 env 分开配置）。

详见 [可观测性](./harness-observability.md)。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 部署前检查未通过 | 按表格 ✗ 项处理；RoleArn 见 [凭证说明](./harness-credentials.md) |
| 首条消息很慢 | 等待沙箱预热；可稍后重试 `magent run` |
| 登录或凭证错误 | `magent login`；CI 见 [凭证 · CI](./harness-credentials.md#ci-与无交互部署) |
| 沙箱无法启动 | 确认已开通 Agent 沙箱；检查 RoleArn |
| 模型 401 / 额度 | 控制台检查 CloudBase AI 开关与 Token 包 |
| 不想用 CloudBase AI 额度 | opencode 可设 `model: zen` |
| 改了 yaml 不生效 | 执行 `magent agent:update -f ...` |
| ACP / 对话 404 | 确认未把沙箱镜像换成「无 Agent」规格；自定义镜像须含箱内 ACP |
| 换 COS 或镜像不生效 | 须**新建** harness Agent，在 `agent:create` 前 export / 写好配置 |

---

## 相关文档

- [README · 沙箱内 Agent](../README.md#沙箱内-agent)
- [用户故事 · 选型](./harness-user-story.md)
- [凭证说明](./harness-credentials.md)
- [可观测性](./harness-observability.md)
- [OpenCode](./harness-opencode.md) · [Claude Code](./harness-claude-code.md)
- [Managed Agents HTTP](./managed-agents-guide.md)
