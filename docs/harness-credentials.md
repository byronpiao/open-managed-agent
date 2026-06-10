# 沙箱 Agent — 凭证

只谈 **OMA 沙箱 Agent**（`runtime: harness`）。**不用**去控制台创建 API Key。

---

## 快速开始（两条命令）

```bash
magent login
tcb env use your-env-id
```

然后直接 `magent agent:create ...` 或 `cp .env.harness.example .env.harness` 跑 harness 验收。  
CAM、环境 ID、region 会由 CLI / deploy 自动解析；**不必**先 export 四列变量。

| 你需要做的 | 自动获得什么 |
|------------|--------------|
| `magent login` | CAM 临时密钥（代替 `TCB_SECRET_*`） |
| `tcb env use <envId>` | 默认 `CLOUDBASE_ENV_ID` |
| （同上，deploy / load-env 时） | `TCB_REGION`（`tcb env detail`）写入进程 env，并 forward 进云上函数 |

**鉴权：**

1. **CloudBase 网关** — Runtime 用 CAM 自动换短期 JWT；不必手填 API Key。
2. **沙箱实例**（`sit_*`）— 起箱后自动写入 session；不要写进 `.env`。

---

## 可选

| 变量 | 何时需要 |
|------|----------|
| `CLOUDBASE_AGENT_ID` | 部署完成后，`magent run -a` 省写 agent id |
| `LLM_API_KEY` + `LLM_MODEL` + `OPENAI_BASE_URL` 或 `ANTHROPIC_BASE_URL` | 自有 LLM，不用 CloudBase AI |
| `HARNESS_TOOL_ROLE_ARN` | 本环境**第一次**自动创建沙箱工具时必填（见下节） |
| `HARNESS_TOOL_ID` | 工具已存在，固定 ToolId |
| `HARNESS_COS_*` | 工作区挂 COS（`HARNESS_COS_ENABLED=1` 时整组必填） |
| `HARNESS_SANDBOX_IMAGE` | 私有沙箱镜像 |

---

## 首次创沙箱工具：CAM 角色（`HARNESS_TOOL_ROLE_ARN`）

环境里还没有 AGS 沙箱工具时，Runtime 会自动 `CreateSandboxTool`，需要你先提供一个 **沙箱工具执行角色** ARN。

### 控制台创建（推荐）

1. [访问管理 → 角色](https://console.cloud.tencent.com/cam/role) → **新建角色** → **腾讯云产品服务**。
2. 产品选 **Agent 沙箱服务 (AGS)**，用例选 **Agent 沙箱服务**（角色载体为 `ags.cloud.tencent.com`，由控制台自动填写）。
3. 关联策略（按场景）：
   | 场景 | 预设策略名 |
   |------|------------|
   | 拉取自定义容器镜像（CCR/TCR） | `QcloudTCRReadOnlyAccess` |
   | 启用 COS 工作区挂载 | 再加 `QcloudCOSFullAccess`（或桶级自定义 COS 策略） |
4. 复制角色 ARN，形如 `qcs::cam::uin/<uin>:roleName/<name>`，写入 `HARNESS_TOOL_ROLE_ARN`。

> 腾讯云**没有**名为 `QcloudAGSFullAccess` 的通用预设策略；沙箱工具角色是「让 AGS **代你的账号**拉镜像 / 挂 COS」，不是替你调 AGS 控制面 API（控制面走你部署 Agent 用的 CAM）。

若控制台已有沙箱工具，可直接复制其 RoleArn，或设 `HARNESS_TOOL_ID` 跳过自动创建。

---

## 推荐路径

```bash
magent login
tcb env use your-env-id

magent agent:create --runtime harness --engine opencode ...
export CLOUDBASE_AGENT_ID=agent-...
magent run -a "$CLOUDBASE_AGENT_ID" -m "hello"
```

`magent run` 可省略 `-e`（沿用 `tcb env use` 或 `CLOUDBASE_ENV_ID`）。

---

## Advanced settings

CI、多环境 pin、无 tcb 交互机器：见 [harness-env.md — Advanced settings](./harness-env.md#advanced-settings)。

---

## 相关

- [使用指南](./harness-tutorial.md)
