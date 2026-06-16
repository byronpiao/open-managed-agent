# 贡献指南（Open Managed Agent）

面向仓库贡献者与发版验收。

| 文档 | 读者 |
|------|------|
| [docs/harness-tutorial.md](docs/harness-tutorial.md) | 对客部署 |
| [../Harness一条龙.md](../Harness一条龙.md) | Agent / 研发：按步骤验收 + 排障 |
| [scripts/harness/scenarios/README.md](scripts/harness/scenarios/README.md) | 6 格 LLM / COS 矩阵 |
| [docs/harness-architecture.md](docs/harness-architecture.md) | 架构与日志 |

---

## 1. 两个轴：`--infra` × `--engine`

| 轴 | 含义 | 取值 |
|----|------|------|
| **`--infra`** | OMA **在哪跑** | `local` · `tcbr` · `scf` · `all`（三面**顺序**各跑） |
| **`--engine`** | 沙箱**内**跑什么 | `opencode` · `claude` · `all`（local 双引擎；`infra all` 时云面拆 opencode+claude） |

组合成 6 格矩阵（对应 `scenarios/.env.<scenario-id>`）：

| `--infra` | `--engine opencode` | `--engine claude` |
|-----------|---------------------|-------------------|
| `local` | `local-opencode` | `local-claude` |
| `tcbr` | `cloud-tcbr-opencode` | `cloud-tcbr-claude` |
| `scf` | `cloud-scf-opencode` | `cloud-scf-claude` |

```bash
npm run harness -- run --infra local --engine opencode
npm run harness -- run --infra tcbr --engine claude
npm run harness -- run --infra scf --engine opencode
npm run harness -- run --infra local --engine all          # 双引擎本地
npm run harness -- run --infra tcbr,scf --engine opencode  # 两云面并行
npm run harness -- run --infra all --engine opencode       # local → tcbr → scf
npm run harness -- run --infra all --engine all            # 6 格全开（顺序）
```

---

## 2. 我要干什么 → 跑什么

| 目标 | 命令 | 依赖云 |
|------|------|--------|
| 改代码零云 | `npm test` | 否 |
| 本地联调 / 冒烟 | `npm run dev:harness` | login + AGS 用时才要 |
| 合入门禁 | `npm run test:merge` | AGS API + hy3 preflight |
| 单格验收 | `harness -- run --infra … --engine …` | 看 infra |
| 发版前云上 | `harness -- release --profile cloud` | 全 |
| 对客冒烟 | `harness -- quickstart` | 全 |

FlexDB 紧：`OAK_USE_MEMORY_STORE=1` 前缀。

---

## 3. npm 脚本

| 脚本 | 作用 |
|------|------|
| `npm test` | L0 单测 + stub |
| `npm run test:merge` | `npm test` + `run --infra local --engine opencode` |
| `npm run dev:harness` | 本地 `:19090` ACP |
| `npm run harness -- <cmd>` | 验收主入口 |
| `npm run check:harness` | deploy preflight |

---

## 4. `harness` 子命令

### 4.1 `run`（主验收）

```bash
npm run harness -- run --infra local --engine opencode
npm run harness -- run --infra local --engine all [--db-pressure]
npm run harness -- run --infra tcbr --engine opencode [--verify-only] [--agent-id …]
npm run harness -- run --infra tcbr,scf --engine opencode
npm run harness -- run --infra all --engine opencode
npm run harness -- run --infra all --engine all
```

`local` 流程：stub e2e → LLM preflight → full e2e → matrix-parity →（`.env.harness` 文件里 `HARNESS_COS_ENABLED=1` 时）**cos-e2e**。

> **COS**：local 矩阵 full e2e **不挂** COS；`loadEnv()` 默认不注入 COS 键。详见 [scenarios/README.md](scripts/harness/scenarios/README.md#cos-三态)。

### 4.2 `release` 编排

```bash
npm run harness -- release --profile merge     # test + local opencode
npm run harness -- release --profile cloud     # 上者 + tcbr,scf opencode 并行
npm run harness -- release --profile delivery  # quickstart + merge + cloud
npm run harness -- release --profile full      # quickstart + test + run --infra all --engine all + ma-protocol
```

### 4.3 工具箱（偶尔手动，不进 CI）

| 命令 | 用途 |
|------|------|
| `quickstart [--keep-agent]` | 对客 create → uname → delete |
| `docker [--keep]` | 容器 healthz + ACP（无 AGS） |
| `ma-protocol [--engine claude]` | 已部署 agent 的 MA HTTP |
| `product-acceptance [--engine all]` | 产品向长验收 |
| `db-pressure [--engine all] [--db-pressure-rounds N]` | FlexDB 压测 |

直接调用：

```bash
node scripts/harness/ags-teardown.mjs
node scripts/harness/cos-probe.mjs
node scripts/harness/acp-bridge.mjs
node scripts/harness/load-env.mjs --check
```

---

## 5. 本地开发 / 本地冒烟 `dev:harness`

**默认**（零参数）：

```text
infra=local · engine=opencode · model=zen（AGENT_MODEL）· 不挂云 COS
```

- **zen**：`agent.harness.yaml` 同款的 `model: zen`，经 `AGENT_MODEL=zen` 注入 runtime（见 `config.ts` `applyDevEnvOverrides`）
- **不挂云 COS**：`devLocal` 模式忽略 `.env.harness` ⑥ 段；本地盘持久化以后走**临时目录**模拟（与云 bucket 无关）
- **不等价**于 `harness run`：后者走 platform preflight / 合入门禁

```bash
cp agent.harness.yaml.example agent.harness.yaml
magent login && tcb env use <envId>
npm run dev:harness
npm run dev:harness -- --engine claude
```

### COS：`--with-cos` / `--no-cos`（仅云上）

只影响 **cloud** 验收：deploy 是否带 COS 挂载（tool 名始终 `oma-harness-{env}`）。⑥ 段 bucket 变量仍在 `.env.harness` 配齐。

```bash
npm run harness -- run --infra tcbr --engine opencode              # 默认不挂 COS
npm run harness -- run --infra tcbr --engine opencode --with-cos   # 挂 COS tool
```

**local** 验收若要做真 COS e2e：在 `.env.harness` 设 `HARNESS_COS_ENABLED=1`（不用 CLI flag）。

---

## 6. 验收分层

```text
L0  npm test · harness docker
L1  run --infra local（仍调 AGS 真箱）
L2  run --infra tcbr|scf · quickstart · release
```

---

## 7. 场景 env 与脚本

- 格子 env：`scripts/harness/scenarios/.env.<scenario-id>`
- 基座：`cp .env.harness.example .env.harness`
- 轴 → 格子：`scenario-matrix.mjs` 的 `scenarioFromAxes(infra, engine)`
- **LLM 六格 + COS 三态**：[scenarios/README.md](scripts/harness/scenarios/README.md)

更多：`docs/harness-architecture.md` · `docs/harness-env.md`

---

## 8. 配额枯竭 / FlexDB

```bash
npm test
OAK_USE_MEMORY_STORE=1 npm run test:merge
OAK_USE_MEMORY_STORE=1 npm run harness -- run --infra local --engine all
```

`product-acceptance` 部分用例**故意**不用 memory store（跨进程重启）；FlexDB 读配额紧时会 `LimitExceeded` — 错峰或 `OAK_USE_MEMORY_STORE=1` 跑其它段。见 [harness-ops-notes.md](docs/harness-ops-notes.md)。

---

## 9. 排障（节选）

完整表：[Harness一条龙.md §8](../Harness一条龙.md) · [harness-architecture.md §6](docs/harness-architecture.md#6-排障)

| 现象 | 处理 |
|------|------|
| tool 镜像 tag 不一致 | `load-env.mjs --check` WARN → `node scripts/harness/sync-tool.mjs` → 等 ~120s |
| `StorageMount` / `MountOption` | local 矩阵不应挂 COS；cos-e2e 需 tool 带 mount（无则 orchestrator 重建 tool） |
| platform preflight 429 | local opencode 自动 zen；要验 hy3 需充额度 |
| shell `export HARNESS_TOOL_ID` | 只写 `.env.harness` |
| SCF 函数 env 带 `TCB_SECRET_*` | 勿 forward；靠 `TENCENTCLOUD_*` |
| AGS 实例配额 | `node scripts/harness/ags-teardown.mjs` |

**沙箱鉴权**：`agent.harness.yaml` → `sandbox.auth: none`（本地 harness）| 省略（默认 `token`）。不用 `HARNESS_SANDBOX_AUTH_MODE` env。

**AGS tool 名**：`oma-harness-{envSlug}`（无 COS 后缀）。
