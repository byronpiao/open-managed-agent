# 沙箱 Agent — 凭证

只谈 **OMA 沙箱 Agent**（`runtime: harness`）。填好下面四样即可部署、起箱、`magent run`；**不用**去控制台创建 API Key。

---

## 必填

| 变量 | 说明 |
|------|------|
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID |
| `TCB_REGION` | 如 `ap-shanghai` |
| `TCB_SECRET_ID` | 腾讯云 CAM SecretId |
| `TCB_SECRET_KEY` | 腾讯云 CAM SecretKey |

推荐先执行 `magent login`，本机 CLI 会用登录态；未 login 时再 export 上表四列。

**鉴权怎么工作：**

1. **CloudBase 网关**（`X-Cloudbase-Authorization`）— Runtime 用 CAM **自动换取**短期 JWT，起箱、调 CloudBase AI；你**不用**手填 API Key。
2. **沙箱实例**（`X-Access-Token`，`sit_*`）— 起箱后 Runtime 调 `AcquireSandboxInstanceToken`，写入 `harness_sessions.instanceAccessToken`，打进网关 Header；**不用**你配置，也**不要**写进 `.env.harness`。

生产默认 `AuthMode: TOKEN`。你无需配置此项。

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
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai

magent agent:create --runtime harness --engine opencode ...
export CLOUDBASE_AGENT_ID=agent-...
magent run -a "$CLOUDBASE_AGENT_ID" -e "$CLOUDBASE_ENV_ID" -m "hello"
```

---

## 相关

- [使用指南](./harness-tutorial.md)
