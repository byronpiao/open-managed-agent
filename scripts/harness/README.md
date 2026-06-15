# Harness scripts

验收入口：`npm run harness -- <cmd>`（实现：`index.mjs`）。编排：`npm run harness:run`。

> **研发向**：本文与 `docs/harness-env.md` 仅供仓库内验收，**不对客**。对客路径见 `docs/harness-tutorial.md`。

## npm 脚本（package.json）

| 脚本 | 说明 |
|------|------|
| `npm test` | L0 单测 + managed-agents harness e2e |
| `npm run test:full` | L1 opencode：`npm test` + `harness -- local` |
| `npm run harness -- <cmd>` | 分步：`local` / `cloud-*` / `db-pressure` / `product-acceptance` |
| `npm run harness:run` | 编排（默认 = `test:full`） |
| `npm run harness:smoke` | `harness:run -- --cloud` |
| `npm run test:delivery` | `harness:run -- --delivery` |
| `npm run harness:quickstart` | 对客 tutorial |
| `npm run harness:local-docker` | L0 Docker 存活 |
| `npm run check:harness` | preflight |
| `npm run ma-protocol` | MA HTTP 云上验收 |

## 本地验收分层（L0 / L1 / L2）

```text
L0  零云 API     stub + 单测 + Docker 存活（不起 AGS）
L1  本机 runtime  进程在笔记本；沙箱仍调 AGS API（要 magent login，一般不烧 FlexDB 读配额）
L2  云上 deploy   agent:create / quickstart / delivery（COS 上传 + FlexDB 持久化）
```

### L0 — 零云依赖

| 命令 | 验证什么 |
|------|----------|
| `npm test` | 单测 + managed-agents harness e2e（`OAK_USE_MEMORY_STORE=1`） |
| `node tests/harness/e2e.test.mjs` | stub 假沙箱：ACP 生命周期、HITL、client tool、Zed stdio |
| `OAK_USE_MEMORY_STORE=1 node tests/harness/e2e.test.mjs` | 同上；与 FlexDB 配额枯竭时语义一致 |
| `npm run harness:local-docker` | TCBR 形 Dockerfile 容器：`GET /healthz` + `POST /acp` initialize（`linux/amd64` 构建） |

**做不到**：真 `uname`、真 bash、COS 挂盘进箱。仅协议 / runtime 网关层。

### L1 — 本地研发主链（推荐日常门禁）

前置：`magent login` + `tcb env use <envId>`（换 `TCB_API_KEY` 调 AGS，**不是** FlexDB 读配额）。

```bash
cp .env.harness.example .env.harness   # 可选；COS / 镜像 pin 见 ⑥ 段
OAK_USE_MEMORY_STORE=1 npm run harness -- local
npm run harness -- local --engines all   # opencode + claude matrix
```

| 块 | 在哪跑 | 还依赖云？ |
|----|--------|------------|
| stub e2e | 本机 :19090 | 否 |
| 真 AGS `session/prompt`、custom tool、matrix | 本机进程 → AGS 实例 | **AGS API** |
| `cos-e2e`（`.env.harness` ⑥ `HARNESS_COS_ENABLED=1`） | 本机编排 | **真 COS 桶 + AGS 挂载**（`HARNESS_COS_MOUNT_DIR` 等） |
| opencode sync **跨 runtime 重启** | — | `OAK_USE_MEMORY_STORE=1` 时 **⊘ 跳过**（内存 store 不跨进程） |

**FlexDB 读配额枯竭时**：优先跑 L1 + `OAK_USE_MEMORY_STORE=1`；仍可做真箱与 COS e2e（烧 AGS / COS，不烧 FlexDB 读）。

**COS 说明**：当前 **无** 本地磁盘 / MinIO 模拟；`cos-e2e` = 真腾讯云桶 + 真 AGS 挂盘，验写 → snapshot → 停箱 → 同 SubPath 恢复。与 FlexDB 限额无关，但要桶权限与 RoleArn。

**已有 env（勿新增）**：`OAK_USE_MEMORY_STORE=1` — session/sync 落内存；e2e `--full` 自动跳过跨进程 FlexDB 用例并打印 `⊘`。

### L2 — 云上 deploy / 对客 tutorial 镜像

| 命令 | 说明 |
|------|------|
| `npm run harness:quickstart` | 对客 tutorial 冒烟（preflight → create → uname+pong → 默认 delete） |
| `npm run test:delivery` | quickstart → test:full → cloud-opencode |
| `npm run harness:run -- --cloud` | test:full + cloud-opencode |
| `npm run harness -- cloud-opencode` | tcbr ∥ scf（见 `scenarios/README.md`） |
| `npm run ma-protocol` | MA HTTP 云上验收 |

需要 `agent:create`、FlexDB（未设 `OAK_USE_MEMORY_STORE` 时）、COS 代码包上传等；**账号配额不足时勿硬跑**。

### 配额枯竭时的推荐顺序

```bash
npm test
OAK_USE_MEMORY_STORE=1 npm run harness -- local    # 主链；开 COS 则含 cos-e2e
npm run harness:local-docker                       # 可选
# 配额恢复后再：
npm run harness:quickstart
npm run test:delivery
```

## 一条龙（场景矩阵见 `scenarios/README.md`）

| 场景 | 命令 | COS tool |
|------|------|----------|
| 对客冒烟 | `npm run harness:quickstart` | no-cos · **不需** `.env.harness`（login 后跑） |
| **本地无 FlexDB** | `OAK_USE_MEMORY_STORE=1 npm run harness -- local` | 跳过跨进程 sync/Claude 持久化；真箱 AGS 仍要 login |
| **Docker 存活冒烟** | `node scripts/harness/local-docker.mjs` | 容器内 runtime + `/healthz` + ACP init |
| **合入 / 日常** | `npm run test:full` | ⑥ 开 → with-cos |
| **云上双后端** | `npm run harness -- cloud-opencode` | **strip** no-cos |
| 云上 tcbr（单跑） | `npm run harness -- cloud-tcbr-opencode` | **strip** no-cos |
| 云上 SCF（单跑） | `npm run harness -- cloud-scf-opencode` | **strip** no-cos |
| **MA HTTP 协议** | `npm run ma-protocol` | `agent.ma-protocol.yaml` × `.env.ma-protocol` |
| **交付一条龙** | `npm run test:delivery` | quickstart → full → cloud |

```bash
cp .env.harness.example .env.harness
node scripts/harness/load-env.mjs --check
```

只读 **`.env.harness`**（不与 `.env` 叠加）。`HARNESS_TOOL_ID` 等 pin **禁止** shell `export` 后跑 cloud — 见 `lib/harness-env-file.mjs`。

## 镜像推送（TRW magent）

```bash
./scripts/harness/build-push-magent-public.sh
sleep 120
node scripts/harness/load-env.mjs --check
```

脚本自动：push CCR → 更新 `.env.harness` + `harness-env.ts` → `build:runtime` → `sync-tool.mjs`。

## 文件

| 脚本 | 用途 |
|------|------|
| `index.mjs` | 入口：`local` / `cloud`（并行）/ `cloud-tcbr` / `cloud-scf` |
| `run.mjs` | 编排 `harness:run`（`--cloud` / `--delivery` / `--engines`） |
| `managed-agents-protocol.mjs` | MA HTTP 云上验收（`ma-protocol`） |
| `quickstart.mjs` | 对客 tutorial 冒烟（preflight → create → uname+pong → delete） |
| `scenarios/README.md` | agent.yaml × env × tool |
| `cloud.mjs` | 云上 deploy + gateway ACP smoke |
| `load-env.mjs` | 只读 `.env.harness`，`--check`（tool 镜像对齐） |
| `cos-e2e.mjs` | COS 写→快照→恢复（`local` 在 `HARNESS_COS_ENABLED=1` 时调用） |
| `cos-probe.mjs` | COS 快照单次探针（手动） |
| `cos-lib.mjs` | COS 共享 helper |
| `ags-teardown.mjs` | 停止环境内活跃 AGS 实例 |
| `acp-bridge.mjs` | 本地 runtime → ACP stdio（Zed 等） |
| `sync-tool.mjs` | 更新 AGS tool 镜像（按 env 名或 pin id） |
| `local-docker.mjs` | L0 Docker 存活冒烟（`docker-compose.local.yml`） |
| `docker-compose.local.yml` | 本地 TCBR 形 runtime（`OAK_USE_MEMORY_STORE` + `AGENT_CONFIG`） |

| `build-push-magent-public.sh` | 构建并推送 magent 沙箱镜像（完整闭环） |

文档（研发）：`docs/harness-architecture.md` · `docs/harness-env.md` · 仓库根 `Harness一条龙.md`
