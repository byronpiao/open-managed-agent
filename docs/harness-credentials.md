# 沙箱 Agent — 凭证

只谈 **OMA 沙箱 Agent**（`runtime: harness`）。**不用**去控制台创建 API Key。

---

## 快速开始

```bash
magent login
tcb env use your-env-id
node scripts/check-harness-ready.mjs    # 部署前自检（见下文）
# 若提示缺 RoleArn，按「控制台逐步操作」创建后：
export HARNESS_TOOL_ROLE_ARN='qcs::cam::uin/<uin>:roleName/<name>'

magent agent:create --runtime harness --engine opencode ...
```

CAM、环境 ID、region 会由 CLI / deploy 自动解析；**不必**手填 `TCB_SECRET_*`（`magent login` 即可）。

| 你需要做的 | 自动获得什么 |
|------------|--------------|
| `magent login` | CAM 临时密钥 |
| `tcb env use <envId>` | 默认 `CLOUDBASE_ENV_ID`、`TCB_REGION` |
| `check-harness-ready.mjs` | 能否部署、是否缺 RoleArn（**不新增 magent 子命令**） |

**鉴权：**

1. **CloudBase 网关** — Runtime 用 CAM 换短期 JWT。
2. **沙箱实例**（`sit_*`）— 起箱后自动写入 session；不要写进 `.env`。

---

## 部署前能检查什么

运行（需已 `magent login` + `tcb env use`）：

```bash
node scripts/check-harness-ready.mjs
# 或 npm run check:harness
```

| 检查项 | 说明 |
|--------|------|
| 是否已登录 | `magent login` / `TCB_SECRET_*` |
| 环境 ID | `tcb env use` / `CLOUDBASE_ENV_ID` |
| `TCB_REGION` | 能否从 `tcb env detail` 解析 |
| AGS 沙箱工具 | 是否已有 `oma-harness-<envId>`（或 pin 的 `HARNESS_TOOL_ID`） |
| `HARNESS_TOOL_ROLE_ARN` | 工具不存在时是否已配置；格式是否正确 |
| CAM 角色载体 | 是否信任 `ags.cloud.tencent.com`（有权限时调 CAM API 验证） |
| COS / 私有镜像 | 提示需挂的策略（不能代替你在 CAM 里点选） |

**检查不了、要真跑才知道的：** `CreateSandboxTool` 是否成功、镜像能否拉取、AGS 配额/地域限制。

`magent agent:create --runtime harness` 会做**同一套**前置检查；未通过则**拒绝部署**（不会拖到第一次 `magent run` 才报错）。

---

## 三种身份，别混

| 名称 | 是什么 | 你要不要管 |
|------|--------|------------|
| `magent login` 的 CAM | 调 CloudBase / AGS **控制面** API | 登录即可 |
| **沙箱工具执行角色**（`HARNESS_TOOL_ROLE_ARN`） | 让 AGS **代你账号**拉 TCR 镜像、挂 COS | **首次创工具时要** |
| 服务相关角色 `AGS_QCSLinkedRoleInSandboxTool` | AGS 平台自用，载体 `sandboxtool.ags.cloud.tencent.com` | **不用你填**，和 `HARNESS_TOOL_ROLE_ARN` 不是一回事 |
| 云函数执行角色 | SCF 跑 Agent Runtime 代码 | 平台默认，**不是**沙箱工具角色 |

---

## 何时需要 `HARNESS_TOOL_ROLE_ARN`

| 情况 | 要做什么 |
|------|----------|
| `tcb sandbox tool list` 里已有 `oma-harness-<你的 envId>` | **不用** RoleArn |
| 账号里已有**其它**沙箱工具 | 可复制其 `RoleArn` 复用，或不管（Runtime 仍会新建 `oma-harness-*` 工具，但可用同一 RoleArn） |
| 本环境**第一次**用 harness，且没有上述工具 | **必须**先配 `HARNESS_TOOL_ROLE_ARN`，再 `agent:create` |

---

## 控制台逐步操作（照填）

### 路径 A：从 CAM 新建角色（首次、无现成工具时）

1. 打开 **[访问管理 → 角色](https://console.cloud.tencent.com/cam/role)**，点 **新建角色**。
2. 角色载体选 **腾讯云产品服务** → 确定。
3. 在「选择产品」搜索框输入 **`沙箱`** 或 **`Agent`**，勾选 **Agent 沙箱服务 (AGS)**（英文名 Agent Sandbox Service）。
4. **使用案例** 选 **Agent 沙箱服务**（控制台会自动把角色载体写成 `ags.cloud.tencent.com`）。  
   - 若看不到该产品：说明账号未开通 AGS，先去 [Agent 沙箱控制台](https://ags.cloud.tencent.com) 按引导开通。
5. **配置策略**（下一步）按场景勾选预设策略：

   | 你的场景 | 勾选策略 |
   |----------|----------|
   | 用平台默认公开 CCR 镜像（一般客户） | `QcloudTCRReadOnlyAccess`（建议勾上） |
   | 用**个人/企业 TCR** 私有镜像 | **必须** `QcloudTCRReadOnlyAccess` |
   | `HARNESS_COS_ENABLED=1` 工作区挂 COS | 再加 `QcloudCOSFullAccess`，或桶级自定义 COS 策略 |

   > 没有名为 `QcloudAGSFullAccess` 的通用策略；此角色是「沙箱实例拉镜像/挂盘」，不是替你调 AGS OpenAPI。

6. **角色名称**（审阅页）：建议 `OMAHarnessSandbox` 或 `agent-sandbox`（仅字母数字及 `+=,.@-_`）。
7. 创建完成后进入该角色 **详情页**，复制 **角色 ARN**，形如：
   ```text
   qcs::cam::uin/1234567890:roleName/OMAHarnessSandbox
   ```
8. 在**执行 `magent agent:create` 的同一终端**：
   ```bash
   export HARNESS_TOOL_ROLE_ARN='qcs::cam::uin/1234567890:roleName/OMAHarnessSandbox'
   node scripts/check-harness-ready.mjs   # 应显示通过
   ```

### 路径 B：从已有沙箱工具复制（省事）

1. 打开 [Agent 沙箱 → 沙箱工具](https://ags.cloud.tencent.com)，或本地：
   ```bash
   tcb sandbox tool list --json
   ```
2. 任选一个已有工具的 **`RoleArn`** 字段（同账号可复用）。
3. `export HARNESS_TOOL_ROLE_ARN='...'` 后跑自检脚本。

### 路径 C：自己用 CLI 先创工具（可选）

```bash
tcb sandbox tool create oma-harness-<envId> -t custom --role-arn 'qcs::cam::...' \
  --network-mode PUBLIC --custom-configuration '{...}'
```

工具已存在后，Runtime 会复用，**不必**再配 RoleArn。自定义配置 JSON 与 OMA 默认不一致时，建议仍让 Runtime 自动创建 `oma-harness-*`。

---

## 可选环境变量

| 变量 | 何时需要 |
|------|----------|
| `CLOUDBASE_AGENT_ID` | 部署后 `magent run -a` 省写 id |
| `LLM_API_KEY` + `LLM_MODEL` + URL | 自有 LLM |
| `HARNESS_TOOL_ROLE_ARN` | 见上表 |
| `HARNESS_TOOL_ID` | pin 固定 ToolId（写在 `.env.harness`，勿只靠 shell export） |
| `HARNESS_COS_*` | COS 挂载（`HARNESS_COS_ENABLED=1` 时整组必填） |
| `HARNESS_SANDBOX_IMAGE` | 自定义 TCR 镜像 |

---

## Advanced settings

CI、多环境 pin：见 [harness-env.md — Advanced settings](./harness-env.md#advanced-settings)。

---

## 相关

- [使用指南](./harness-tutorial.md)
- [首次起箱](./harness-tutorial.md#首次起箱沙箱工具与-rolearn)
