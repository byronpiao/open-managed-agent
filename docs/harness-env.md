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

`.env.harness.example` 按段编号 ①–⑥，与下表一致。

---

## ① 必填（`.env.harness`）

| 变量 | 说明 |
|------|------|
| `CLOUDBASE_ENV_ID` | 环境 ID |
| `TCB_REGION` | 如 `ap-shanghai` |
| `TCB_API_KEY` | AGS JWT |
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | 本地 CLI、**tcbr deploy**；**SCF 函数 env 不要 forward**（见下） |
| `CLOUDBASE_ACCESS_KEY` | 网关 API |

### 云上 CAM：tcbr vs SCF

| | tcbr 容器 | SCF 云函数 |
|--|-----------|------------|
| 操作者 `TCB_SECRET_*` | `magent agent:create/update` 写入容器 env | **仅宿主机**（`tcb login` / shell）；**禁止**写入函数 env（`TENCENTCLOUD_*` 为平台预留） |
| 运行时临时密钥 | 容器内 `TCB_SECRET_*`（或 STS） | 执行角色自动注入 `TENCENTCLOUD_SECRETID` / `SECRETKEY` / `SESSIONTOKEN` |
| 参考 | [buildCloudRunEnvParam](../lib/cloudrun.mjs) | [腾讯云 SCF 环境变量](https://docs.cloudbase.net/cloud-function/function-configuration/env) |

Harness 运行时（`resolveCamControlPlaneCredentials`）：SCF 内优先 `TENCENTCLOUD_*`（角色注入），勿用误配的 `TCB_SECRET_*`；COS `putObject` 须带 `SessionToken`（含 `TENCENTCLOUD_TOKEN` fallback）。

`agent:update`（SCF）会**整表替换**函数 env，须与 `agent:create` 共用同一套 `buildScfDeployEnvMap`（含 `TCB_REGION`、`HARNESS_TOOL_ROLE_ARN`、COS 段等）。**`agent:update` 不重传 SCF 代码包** — 坏包须删函数重建或复用 ⑤ pin agent。

**`HARNESS_TOOL_ID`**：仅写在 `.env.harness`；`load-env.mjs` / `lib/harness-env-file.mjs` 会忽略 shell `export` 泄漏。未 pin 时 orchestrator 自动 `ensureHarnessTool`；镜像推送后用 `scripts/harness/sync-tool.mjs`（按 `oma-harness-{env}-*` 名解析 tool）。

**镜像 tag 三处对齐**：`HARNESS_PUBLIC_MAGENT_IMAGE`（源码常量）= `.env.harness` `HARNESS_SANDBOX_IMAGE` = AGS tool `Image`。`./scripts/harness/build-push-magent-public.sh` 一次更新前两处并 `sync-tool`；`load-env.mjs --check` 校验。

---

## ②–⑥ 可选（见 example 文件）

| 段 | 内容 |
|----|------|
| ② | `CLOUDBASE_AGENT_ID` |
| ③ | `LLM_*`（仅 `harness -- cloud-tcbr` / `cloud-scf` custom） |
| ④ | 沙箱镜像 / **`HARNESS_TOOL_ROLE_ARN`**（无 `HARNESS_TOOL_ID` 时创 AGS tool 必填）/ `HARNESS_TOOL_ID` |
| ⑤ | `HARNESS_CLOUD_AGENT_ID` / `HARNESS_CLOUD_SCF_AGENT_ID` |
| ⑥ | `HARNESS_COS_*`（工作区跨沙箱持久化，见下） |

Tool 名：`oma-harness-{env}-no-cos`；`HARNESS_COS_ENABLED=1` 时用 `oma-harness-{env}-with-cos`（独立 tool + `StorageMounts`）。

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

### opencode LLM

| 宿主机 | 沙箱 |
|--------|------|
| 无 `LLM_*` | zen |
| 有 `LLM_*` | `OPENCODE_CONFIG_CONTENT` |

`agent.yaml` ModelSpec（对客部署）优先于 `LLM_*`。

### claude LLM（`engine=claude`）

| 变量 | 说明 |
|------|------|
| `LLM_API_KEY` | API Key（如 Mimo `tp-*`） |
| `LLM_MODEL` | 模型 ID |
| `ANTHROPIC_BASE_URL` | Anthropic Messages 兼容端点（Mimo 示例：`https://token-plan-sgp.xiaomimimo.com/anthropic`） |

---

## 相关

- [harness-tutorial.md](./harness-tutorial.md) — 对客部署（用 `agent.yaml`，不用 `.env.harness`）
- [harness-architecture.md](./harness-architecture.md)
- [`Harness一条龙.md`](../../Harness一条龙.md)
