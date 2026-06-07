# Harness runtime (`runtime=harness`)

箱内引擎（opencode / claude / codebuddy）在 **云上 AGS** 跑 ACP；本机 **薄 runtime** + CloudBase 会话 / sync。

## 一条龙（主文档）

**验收、回归、镜像、COS、故障排查 → 仓库内：**

**[`.plan/harness-一条龙.md`](../../../../.plan/harness-一条龙.md)**（gitignore，本地 SoT）

可提交的环境分层：**[`docs/harness-env.md`](../../../docs/harness-env.md)**

## `/healthz`（harness）

`runtime=harness` 时返回 **`harnessStore`**（`harness_sessions` driver），不是 managed 的 OAK `store`。

## 快速命令

```bash
cp .env.example .env && cp .env.harness.example .env.harness
node scripts/load-env.mjs --check
npm test                  # unit（含 harness 单测）
npm run test:full         # test + harness all
npm run harness -- full   # 仅真 AGS
npm run harness -- --help
```

| 命令 | 说明 |
|------|------|
| `npm test` | unit + harness 单测 |
| `npm run harness -- e2e` | stub 沙箱 |
| `npm run harness -- full` | 真 AGS + sync + parity |
| `npm run harness -- cos` | COS 跨实例（`HARNESS_COS_ENABLED=1`） |
| `npm run harness -- probe` | COS 轻量探针 |
| `npm run harness -- teardown` | Stop 本 env 实例 |
| `npm run harness -- all` | e2e → full →（可选）cos |

## 代码布局

| 路径 | 职责 |
|------|------|
| `acp-endpoint.ts` | HTTP ACP 网关、session/load、export hooks |
| `opencode-sync.ts` | `/sync/history` ↔ CloudBase |
| `sync-event-store.ts` | `harness_sync_events` |
| `sandbox/orchestrator.ts` | AGS 创箱、数据面、teardown |
| `sandbox/session-store.ts` | `harness_sessions` |

## 日志

`LOG_LEVEL=debug`；service `oma-harness`。lanes：`acp` | `sandbox` | `orchestrator` | `mcp` | `client_tool` | `opencode_sync`

## ACP stdio bridge

`node scripts/harness-acp-bridge.mjs [baseURL]` — 默认 `http://127.0.0.1:9000`
