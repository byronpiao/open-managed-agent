# Harness scripts

验收入口：`npm run harness -- <cmd>`（实现：`index.mjs`）。

## 一条龙

| 场景 | 命令 |
|------|------|
| 合入 / 日常 | `npm run test:full`（local → **CloudBase AI**） |
| 云上 tcbr | `npm run harness -- cloud-tcbr`（**zen**） |
| 云上 SCF | `npm run harness -- cloud-scf`（**LLM_*** 自定义） |
| **完整** | 上三行全跑 |

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
| `index.mjs` | 入口：`local` / `cloud-tcbr` / `cloud-scf` |
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
