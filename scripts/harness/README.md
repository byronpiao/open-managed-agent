# Harness scripts

验收入口：`npm run harness -- <cmd>`（实现：`index.mjs`）。

## 一条龙

| 场景 | 命令 |
|------|------|
| 合入 / 日常 | `npm run test:full` |
| 云上 tcbr | `npm run harness -- cloud-tcbr` |
| 云上 SCF（完整一条龙） | `npm run harness -- cloud-scf` |

```bash
cp .env.harness.example .env.harness
node scripts/harness/load-env.mjs --check
```

只读 **`.env.harness`**（不与 `.env` 叠加）。

## 文件

| 脚本 | 用途 |
|------|------|
| `index.mjs` | 入口：`local` / `cloud-tcbr` / `cloud-scf` |
| `cloud.mjs` | 云上 deploy + gateway ACP smoke |
| `load-env.mjs` | 只读 `.env.harness`，`--check` |
| `cos-e2e.mjs` | COS 写→快照→恢复（`local` 在 `HARNESS_COS_ENABLED=1` 时调用） |
| `cos-probe.mjs` | COS 快照单次探针（手动） |
| `cos-lib.mjs` | COS 共享 helper |
| `ags-teardown.mjs` | 停止环境内活跃 AGS 实例 |
| `acp-bridge.mjs` | 本地 runtime → ACP stdio（Zed 等） |
| `sync-tool.mjs` | 更新 pin 的 `HARNESS_TOOL_ID` 镜像 |
| `build-push-magent-public.sh` | 构建并推送 magent 沙箱镜像 |

文档：`docs/harness-architecture.md` · `docs/harness-env.md`
