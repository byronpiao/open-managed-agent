# 沙箱 Agent — 凭证

只谈 **沙箱内 Agent**（`runtime: harness`）。**不用**在 CloudBase 控制台单独创建 API Key 才能起步。

---

## 你需要做什么

| 步骤 | 命令 / 操作 |
|------|-------------|
| 登录 | `magent login` |
| 选择环境 | `tcb env use <环境 ID>` |
| 部署前检查（推荐） | `node scripts/check-harness-ready.mjs` 或 `npm run check:harness` |
| 首次在本环境使用沙箱时 | 按下方 [控制台逐步操作](#控制台逐步操作照填) 配置 `HARNESS_TOOL_ROLE_ARN` |
| 部署 | `magent agent:create --runtime harness ...`（见 [使用指南](./harness-tutorial.md)） |

登录后，环境 ID、地域、网关鉴权会由 CLI 与 Runtime **自动处理**；一般**不必**手填 `TCB_SECRET_*`。

---

## 部署前检查说明

```bash
magent login && tcb env use <环境 ID>
node scripts/check-harness-ready.mjs
```

输出为**表格**：✓ / ✗ / —，级别为 **必选**、**首次创工具**、**可选**。

| 级别 | 检查项 | 说明 |
|------|--------|------|
| 必选 | CloudBase 登录 | 已 `magent login` |
| 必选 | 环境 ID | 已 `tcb env use` |
| 必选 | 地域 | 通常自动解析 |
| 必选 | 沙箱工具 | 已有本环境专用工具则 ✓ |
| 首次创工具 | `HARNESS_TOOL_ROLE_ARN` | **仅**本环境第一次创建沙箱工具时需要 |
| 可选 | COS / 私有镜像 | 仅在你启用了 COS 或自定义镜像时出现 |

`magent agent:create --runtime harness` 未通过时打印**同一表格**并拒绝部署。

---

## 三种身份，别混

| 名称 | 用途 | 你要不要管 |
|------|------|------------|
| `magent login` 的账号凭证 | 调用 CloudBase、创建 Agent、部署 | **登录即可** |
| **沙箱工具角色**（`HARNESS_TOOL_ROLE_ARN`） | 让沙箱能拉取镜像、挂载对象存储 | **首次在本环境创工具时要** |
| 云函数运行角色 | 运行 Agent 后端代码 | 平台默认，**不用你配** |

控制台里若看到 **「Agent Runtime - 沙箱工具」** 一类的**服务相关角色**，那是平台自用，**不要**把它当作你要填的 `HARNESS_TOOL_ROLE_ARN`。

---

## 何时需要 `HARNESS_TOOL_ROLE_ARN`

| 情况 | 要做什么 |
|------|----------|
| 部署前检查显示沙箱工具已就绪 | **不用** RoleArn |
| 本环境**第一次**部署沙箱 Agent，且检查提示需要 RoleArn | 按 [控制台逐步操作](#控制台逐步操作照填) 创建角色并 `export` |
| 日常对话、换模型、更新 `agent.yaml` | **不需要**再碰 RoleArn |

---

## 控制台逐步操作（照填）

### 路径 A：新建角色（首次、无现成工具）

1. 打开 **[访问管理 → 角色](https://console.cloud.tencent.com/cam/role)** → **新建角色**。
2. 角色载体：**腾讯云产品服务** → 确定。
3. 搜索 **`Agent`**，勾选 **Agent Runtime**（控制台中的 Agent 沙箱产品）。
4. **使用案例**只选第一项：

   | 选项 | 选择 |
   |------|------|
   | **Agent Runtime** — 允许 Agent Runtime 访问您的腾讯云资源 | ✅ **选这个** |
   | **Agent Runtime - 沙箱工具**（服务相关角色） | ❌ **不要选** |

5. **配置策略**（按场景勾选）：

   | 场景 | 建议策略 |
   |------|----------|
   | 使用平台默认镜像（大多数用户） | `QcloudTCRReadOnlyAccess` |
   | 使用自有 TCR 私有镜像 | `QcloudTCRReadOnlyAccess`（必须） |
   | 启用 COS 工作区持久化 | 再加 COS 写权限（见下节） |

6. **角色名称**：如 `HarnessSandboxRole`（仅字母数字及 `+=,.@-_`）。
7. 复制角色 **ARN**，形如：
   ```text
   qcs::cam::uin/1234567890:roleName/HarnessSandboxRole
   ```
8. 在将要执行 `magent agent:create` 的终端：
   ```bash
   export HARNESS_TOOL_ROLE_ARN='qcs::cam::uin/1234567890:roleName/HarnessSandboxRole'
   node scripts/check-harness-ready.mjs
   ```

若列表中没有 Agent Runtime：请先在 [Agent 沙箱控制台](https://ags.cloud.tencent.com) 开通服务。

#### COS 工作区与快照：角色还要什么权限

启用 `HARNESS_COS_ENABLED=1` 时，**同一个** `HARNESS_TOOL_ROLE_ARN` 需要能向你的桶**写入**（保存工作区快照）。仅有 `QcloudTCRReadOnlyAccess` **不够**。

| 做法 | 说明 |
|------|------|
| **预设（省事）** | 再勾 **`QcloudCOSFullAccess`** |
| **自定义（生产）** | 桶级 `PutObject` / `GetObject` / `ListBucket` 等，限定你的桶与前缀 |

**不用 COS**（默认快速开始）：只勾 `QcloudTCRReadOnlyAccess` 即可。

### 路径 B：复用已有沙箱工具的角色

1. 打开 [Agent 沙箱 → 沙箱工具](https://ags.cloud.tencent.com)，或执行：
   ```bash
   tcb sandbox tool list --json
   ```
2. 复制任一已有工具的 **RoleArn**（同账号可复用）。
3. `export HARNESS_TOOL_ROLE_ARN='...'` 后重新运行部署前检查。

### 路径 C：先用 CLI 创建沙箱工具（可选）

熟悉 Agent 沙箱 CLI 的用户可自行创建工具；工具已存在后，Runtime 会复用，**不必**再配 RoleArn。一般用户走路径 A 即可。

---

## 可选环境变量

| 变量 | 何时需要 |
|------|----------|
| `CLOUDBASE_AGENT_ID` | 部署后记下 id，`magent run -a` 时可省略 |
| yaml `model`（含 id / apiKey / apiBaseUrl） | 使用自有 LLM 厂商；见 [选择模型](./harness-tutorial.md#选择模型) |
| `HARNESS_TOOL_ROLE_ARN` | 见上表 |
| `HARNESS_COS_*` | 启用 COS 工作区时整组必填 |
| `agent.harness.yaml` `sandbox.image` | 自定义 TCR 镜像地址 |

---

## CI 与无交互部署

无法在构建机上交互登录时，在 **deploy 前** export：

```bash
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai
export TCB_SECRET_ID=...
export TCB_SECRET_KEY=...
# 或使用：magent login --apiKeyId <id> --apiKey <key>
```

然后在同一 job 中执行 `magent agent:create` 等命令。若本环境首次使用沙箱，还需在流水线 secrets 中配置 `HARNESS_TOOL_ROLE_ARN`。

| 变量 | 说明 |
|------|------|
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | 代替 `magent login` 的交互登录 |
| `CLOUDBASE_ENV_ID` | 目标 CloudBase 环境 |
| `TCB_REGION` | 环境所在地域（如 `ap-shanghai`） |

---

## 应用里如何鉴权（SDK / HTTP）

`magent run` 会用你本机 `magent login` 的凭证**自动换**网关 Bearer，你无需手填。

应用或脚本调用网关 / Managed Agents HTTP 时，需要自行携带 **Bearer token**（SDK 里叫 `accessKey`）：

| 场景 | 做法 |
|------|------|
| **本机脚本**（已 `magent login`） | 与 CLI 相同：用环境 ID + 登录态下的 CAM 凭证换取 Bearer（与 `magent run` 同源） |
| **服务端 / CI** | 使用 [CI 与无交互部署](#ci-与无交互部署) 中的 `TCB_SECRET_ID` / `TCB_SECRET_KEY` 换取 Bearer |
| **控制台 API Key** | 在 CloudBase 控制台为环境创建 API Key，作为 `accessKey` / `CLOUDBASE_APIKEY` 传入 SDK |

SDK 连接沙箱 Agent 时务必设置 `runtime: "harness"`。示例见 [使用指南 · 第 5 步](./harness-tutorial.md#第-5-步在应用里调用可选) 与 [Managed Agents 使用指南](./managed-agents-guide.md)。

---

## 相关

- [使用指南](./harness-tutorial.md)
- [用户故事 · 选型](./harness-user-story.md)
