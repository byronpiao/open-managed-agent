# 沙箱内 Agent — 环境变量

> 模板：[`.env.harness.example`](../.env.harness.example) · [harness-tutorial.md](./harness-tutorial.md)

## 两个 env 文件（不要混）

| 文件 | 谁用 | 怎么建 |
|------|------|--------|
| **`.env.harness`** | Harness 验收（`npm run harness`） | `cp .env.harness.example .env.harness` |
| **`.env`** | 托管 Agent / SDK / integration | `cp .env.example .env` |

**Harness 只读 `.env.harness`，不读、不叠加 `.env`。**

```bash
node scripts/harness/load-env.mjs --check
node scripts/harness/load-env.mjs --check --probe-llm
```

`.env.harness.example` 与 [harness-tutorial](./harness-tutorial.md) 快速开始一致：**① 默认留空**，`magent login` + `tcb env use` 即可。下文 ②–⑥ 为研发验收；CI / 手填见 [Advanced settings](#advanced-settings)。

### 验收场景（不要一个 env 跑全部）

| 步骤 | 场景 id | COS | 说明 |
|------|---------|-----|------|
| tutorial 冒烟 | `quickstart` | off | `npm run harness:quickstart` |
| `test:full` | `local` | 读 ⑥ 段 | 开 COS → `-with-cos` tool + cos-e2e |
| `cloud-tcbr` | `cloud-tcbr` | **strip** | zen，不用 ③ 段 |
| `cloud-scf` | `cloud-scf` | **strip** | ③ BYOK |

矩阵详表：[scripts/harness/scenarios/README.md](../scripts/harness/scenarios/README.md)。交付：`npm run test:delivery`（含 `harness:cloud` 并行云上验收）。

---

## ① CloudBase（`.env.harness` 基座 — 默认留空）

快速开始只需：

```bash
magent login && tcb env use <envId>
cp .env.harness.example .env.harness   # ① 段可全注释
node scripts/harness/load-env.mjs --check
```

`hydrateCloudEnvFromCli()`（`lib/env.mjs`）在 **harness load-env** 与 **`magent agent:create/update`** 部署前自动补齐未设置的 `CLOUDBASE_ENV_ID` / `TCB_REGION`；已写在文件或 shell 里的值**优先**。

对客凭证说明：[harness-credentials.md](./harness-credentials.md)。手填 / CI 见下文 [Advanced settings](#advanced-settings)。

### 云上 CAM：tcbr vs SCF

| | tcbr 容器 | SCF 云函数 |
|--|-----------|------------|
| 操作者 `TCB_SECRET_*` | `magent agent:create/update` 写入容器 env | **仅宿主机**（`tcb login` / shell）；**禁止**写入函数 env（`TENCENTCLOUD_*` 为平台预留） |
| 运行时临时密钥 | 容器内 `TCB_SECRET_*`（或 STS） | 执行角色自动注入 `TENCENTCLOUD_SECRETID` / `SECRETKEY` / `SESSIONTOKEN` |
| 参考 | [buildCloudRunEnvParam](../lib/cloudrun.mjs) | [腾讯云 SCF 环境变量](https://docs.cloudbase.net/cloud-function/function-configuration/env) |

Harness 运行时（`resolveCamControlPlaneCredentials`）：SCF 内优先 `TENCENTCLOUD_*`（角色注入），勿用误配的 `TCB_SECRET_*`；COS `putObject` 须带 `SessionToken`（含 `TENCENTCLOUD_TOKEN` fallback）。

`agent:update`（SCF）会**整表替换**函数 env，须与 `agent:create` 共用同一套 `buildScfDeployEnvMap`（含 `TCB_REGION`、`HARNESS_TOOL_ROLE_ARN`、COS 段等）。**`agent:update` 不重传 SCF 代码包** — 坏包须删函数重建或复用 ⑤ pin agent。

**`HARNESS_TOOL_ID`**：仅写在 `.env.harness`；`load-env.mjs` / `lib/harness-env-file.mjs` 会忽略 shell `export` 泄漏。未 pin 时 orchestrator 自动 `ensureHarnessTool`；镜像推送后用 `scripts/harness/sync-tool.mjs`（按 `oma-harness-{env}` 名解析 tool）。

**镜像 tag 三处对齐**：`HARNESS_PUBLIC_MAGENT_IMAGE`（源码常量）= `.env.harness` `HARNESS_SANDBOX_IMAGE` = AGS tool `Image`。`./scripts/harness/build-push-magent-public.sh` 一次更新前两处并 `sync-tool`；`load-env.mjs --check` 校验。

---

## ②–⑥ 可选（见 example 文件）

| 段 | 内容 |
|----|------|
| ② | `CLOUDBASE_AGENT_ID`（`magent run` / `ma-protocol`；与 `HARNESS_CLOUD_*` pin 无关） |
| ③ | **不在此文件** — 见 `scripts/harness/scenarios/.env.<scenario>`（模板 `.env.<scenario>.example`） |
| ④ | 沙箱镜像 / **`HARNESS_TOOL_ROLE_ARN`**（无 `HARNESS_TOOL_ID` 时创 AGS tool 必填）/ `HARNESS_TOOL_ID` |
| ⑥ | `HARNESS_COS_*`（仅 **local** 验收；cloud 步骤自动忽略，见上表） |

**研发 pin（勿写进对客 example）**：`HARNESS_CLOUD_{TCBR|SCF}_{OPENCODE|CLAUDE}_AGENT_ID`（或 legacy `HARNESS_CLOUD_AGENT_ID` / `HARNESS_CLOUD_SCF_AGENT_ID`）— 仅 `harness:cloud-*` 部署复用；**`ma-protocol` 只用 ② `CLOUDBASE_AGENT_ID`**。`HARNESS_TOOL_COS_NAME_SUFFIX=1`：同环境并行 no-cos/with-cos tool。

Tool 名（对客 / 生产）：`oma-harness-{env}`（COS 只影响 `StorageMounts`，不在名字里体现）。研发验收同一环境并行 no-cos / with-cos 时 `.env.harness` 设 `HARNESS_TOOL_COS_NAME_SUFFIX=1` → `oma-harness-{env}-no-cos` / `-with-cos`。

### ⑥ COS — 工作区 vs 对话

| | 不启用 COS（默认） | 启用 `HARNESS_COS_ENABLED=1` |
|--|-------------------|------------------------------|
| **多轮对话** | `harness_sessions` + `harness_sync_events` replay | 同上 |
| **沙箱内文件**（代码、build 产物等） | AGS TTL / re-acquire 后丢失 | COS mount + snapshot，**跨沙箱保留工作区现场** |
| **验收** | `test:full` 不要求 COS | `harness -- local` 含 cos-e2e 硬门 |

创箱时按 session 隔离 COS subpath；`session/delete` 触发 TRW `workspace/snapshot`（见 [harness-architecture.md §4](./harness-architecture.md)）。

---

## 运行时三层（自动，勿手填进 example）

| 层 | 说明 |
|----|------|
| 宿主机 | `.env.harness` 你填的键 |
| OMA Runtime | `AGENT_CONFIG`、`PORT` 等 |
| TRW 沙箱 | OMA 起箱时注入 `OPENCODE_CONFIG_CONTENT`、`HARNESS_*` 等 |

### 模型（对客默认）

有 `CLOUDBASE_ENV_ID` + CAM 且未配置自定义 LLM 时，Runtime 自动使用 CloudBase AI（`hy3-preview`）。详见 [harness-opencode.md](./harness-opencode.md) / [harness-claude-code.md](./harness-claude-code.md)。

### 自定义 LLM（`scenarios/.env.<scenario>`，研发 / BYOK）

| 变量 | 说明 |
|------|------|
| `LLM_API_KEY` | 第三方 API Key |
| `LLM_MODEL` | 模型 ID |
| `OPENAI_BASE_URL` | OpenCode / `cloud-scf-opencode` |
| `ANTHROPIC_BASE_URL` | Claude / `local-claude` fallback、`cloud-*-claude` |

矩阵与 `cp` 示例：[scenarios/README.md](../scripts/harness/scenarios/README.md)。

---

## Advanced settings

无 tcb 交互、CI、或需要 pin 固定 env/region 时使用。优先级：**shell export / `.env.harness` > tcb CLI 自动检测**。

### 手填四列（CI / 流水线）

```bash
export CLOUDBASE_ENV_ID=your-env-id
export TCB_REGION=ap-shanghai          # FlexDB SDK region；多数上海环境可固定此值
export TCB_SECRET_ID=...
export TCB_SECRET_KEY=...
# 或 magent login --apiKeyId ... --apiKey ...（代替 SecretId/Key）
```

GitHub Actions 等：把四列放进 secrets，在 job 里 export 后再 `npm run harness` / `magent agent:create`。

### 变量说明

| 变量 | 谁在读 | 省略条件 |
|------|--------|----------|
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | 网关换 token、tcbr 容器 DB | `magent login` 且本机有 `~/.config/.cloudbase/auth.json` |
| `CLOUDBASE_ENV_ID` | 全网关 Host、部署 env | `tcb env use` 或 `magent … -e` |
| `TCB_REGION` | **仅** `@cloudbase/node-sdk` 连 FlexDB（`harness_sessions` / `harness_sync_events`） | deploy / load-env 时 `tcb env detail` 可读则自动补齐 |

`TCB_REGION` **不**参与 `magent login`、网关 JWT、AGS 起沙箱。未进云函数 env 时，runtime 退回**内存** session store（对话不落 FlexDB）。

### 云上 agent：值从哪来

云函数 / 容器**运行时**没有 tcb CLI，只读 deploy 时写入的 env：

| 键 | deploy 时如何进入函数 env |
|----|---------------------------|
| `CLOUDBASE_ENV_ID` | `requireEnvId()` 解析后**总是**写入 |
| `TCB_REGION` | `applyHarnessRuntimeEnv` forward 宿主机 `process.env`（deploy 前已由 `hydrateCloudEnvFromCli` 补齐或手填） |

因此 CI 部署要在 **deploy 那一刻** 保证 `TCB_REGION` 已解析——手填 export，或 runner 上装好 tcb 且 `tcb env use` 可用。tcbr / SCF 的 CAM 差异见上文 [① CloudBase — 云上 CAM](#①-cloudbaseenvharness-基座--默认留空)。

---

## 相关

- [harness-tutorial.md](./harness-tutorial.md) — 对客部署（用 `agent.yaml`，不用 `.env.harness`）
- [harness-architecture.md](./harness-architecture.md)
- [`Harness一条龙.md`](../../Harness一条龙.md)
