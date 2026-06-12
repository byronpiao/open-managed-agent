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

自检输出为**表格**：每项标记 ✓ / ✗ / —，级别分 **必选**、**首次创工具**、**可选**。

| 级别 | 检查项 | 说明 |
|------|--------|------|
| 必选 | CloudBase 登录 | `magent login` |
| 必选 | 环境 ID | `tcb env use <envId>` |
| 必选 | `TCB_REGION` | 一般由 `tcb env detail` 自动解析 |
| 必选 | AGS 沙箱工具 | 已有 `oma-harness-<envId>` 则 ✓ |
| 首次创工具 | `HARNESS_TOOL_ROLE_ARN` | **仅**无沙箱工具时需要；已有工具显示 `— 不需要` |
| 可选 | COS / 私有镜像 | 仅在你 `export HARNESS_COS_*` 或私有镜像时出现 |

`magent agent:create --runtime harness` 未通过时打印**同一表格**并拒绝部署。

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
3. 在「选择产品」搜索 **`Agent`**，勾选 **Agent Runtime**（控制台产品名；即原 Agent 沙箱 / AGS）。
4. **可选择的使用案例** 会出现两个选项 — **只选第一个**：

   | 选项 | 要不要选 |
   |------|----------|
   | **Agent Runtime** —「允许 Agent Runtime 访问您的腾讯云其他云产品资源」 | ✅ **选这个**（`HARNESS_TOOL_ROLE_ARN` 要这种） |
   | **Agent Runtime - 沙箱工具** — 服务相关角色、AGS 访问 CFS/VPC… | ❌ **不要选**（平台自用的 `AGS_QCSLinkedRoleInSandboxTool`，载体 `sandboxtool.ags.cloud.tencent.com`） |

   选对后，角色载体应为 **`ags.cloud.tencent.com`**（在角色详情 → 信任策略里可核对）。  
   若列表里没有 Agent Runtime：先去 [Agent 沙箱控制台](https://ags.cloud.tencent.com) 开通。

5. **配置策略**（下一步）按场景勾选预设策略：

   | 你的场景 | 勾选策略 |
   |----------|----------|
   | 用平台默认公开 CCR 镜像（一般客户） | `QcloudTCRReadOnlyAccess`（建议勾上） |
   | 用**个人/企业 TCR** 私有镜像 | **必须** `QcloudTCRReadOnlyAccess` |
   | `HARNESS_COS_ENABLED=1`（工作区挂载 + **快照**） | **必须**再加 COS 写权限（见下节） |

   > 没有名为 `QcloudAGSFullAccess` 的通用策略；此角色是「沙箱实例拉镜像/读写 COS 挂载」，不是替你调 AGS 控制面 OpenAPI。

#### COS 工作区与快照：角色还要什么权限

启用 `HARNESS_COS_ENABLED=1` 时，**同一个** `HARNESS_TOOL_ROLE_ARN` 负责：创工具时挂 COS；会话结束时 TRW `workspace/snapshot` **写入**桶内对象。仅有 `QcloudTCRReadOnlyAccess` **不够**。

| 做法 | 说明 |
|------|------|
| **预设（省事）** | 再勾 **`QcloudCOSFullAccess`** |
| **自定义（生产）** | 桶级 `PutObject` / `GetObject` / `ListBucket` 等，限定你的桶与前缀 |

**不用 COS**（默认快速开始）：只勾 `QcloudTCRReadOnlyAccess`。

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
| `HARNESS_COS_*` | COS 挂载 + 快照（`HARNESS_COS_ENABLED=1` 时整组必填；Role 须含 COS 写权限，见上节） |
| `HARNESS_SANDBOX_IMAGE` | 自定义 TCR 镜像 |

---

## Advanced settings

CI、多环境 pin：见 [harness-env.md — Advanced settings](./harness-env.md#advanced-settings)。

---

## 相关

- [使用指南](./harness-tutorial.md)
- [首次起箱](./harness-tutorial.md#首次起箱沙箱工具与-rolearn)
