# Harness scripts

验收入口：`npm run harness -- <cmd>`（实现：`index.mjs`）。

## 一条龙（场景矩阵见 `scenarios/README.md`）

| 场景 | 命令 | COS tool |
|------|------|----------|
| 对客冒烟 | `npm run harness:quickstart` | no-cos · **不需** `.env.harness`（login 后跑） |
| **合入 / 日常** | `npm run test:full` | ⑥ 开 → with-cos |
| **云上双后端** | `npm run harness:cloud` | **strip** no-cos |
| 云上 tcbr（单跑） | `npm run harness:cloud-tcbr` | **strip** no-cos |
| 云上 SCF（单跑） | `npm run harness:cloud-scf` | **strip** no-cos |
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
| `managed-agents-protocol.mjs` | MA HTTP 云上验收（`ma-protocol`） |
| `delivery.mjs` | 交付一条龙（quickstart + test:full + harness:cloud） |
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
| `build-push-magent-public.sh` | 构建并推送 magent 沙箱镜像（完整闭环） |

文档：`docs/harness-architecture.md` · `docs/harness-env.md` · 仓库根 `Harness一条龙.md`
