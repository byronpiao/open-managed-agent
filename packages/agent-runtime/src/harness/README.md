# Harness runtime (`runtime=harness`)

箱内引擎（opencode / claude / codebuddy）在 **云上 AGS** 跑 ACP；本机 **薄 runtime** + CloudBase 会话 / sync。

## 一条龙（主文档）

**验收、回归、镜像、COS、故障排查 → 仓库内：**

**[`code_sandbox/Harness一条龙.md`](../../../../../Harness一条龙.md)**（与 `AGS一条龙.md` 并列）

可提交的环境分层：**[`docs/harness-env.md`](../../../docs/harness-env.md)**  
OpenCode / TRW 日志与排障：**[`docs/harness-opencode-observability.md`](../../../docs/harness-opencode-observability.md)**

### LLM（两路分流）

| 协议 | 宿主机 env | TRW 注入 |
|------|-----------|----------|
| OpenAI Chat Completions | `LLM_*` + `OPENAI_BASE_URL` | opencode `OPENCODE_CONFIG_CONTENT`、codebuddy `CODEBUDDY_*` |
| Anthropic Messages | `LLM_*` + `ANTHROPIC_BASE_URL` | claude `ANTHROPIC_*` |

默认不配 `LLM_*` → **`model: zen`**。实现：`llm-providers.ts`（只读 host env，不猜 `model.apiBaseUrl`）。

## `/healthz`（harness）

`runtime=harness` 时返回 **`harnessStore`**（`harness_sessions` driver），不是 managed 的 OAK `store`。

## 快速命令

```bash
cp .env.example .env && cp .env.harness.example .env.harness
node scripts/load-env.mjs --check
npm test                      # unit（含 harness 单测）
npm run test:full             # test + harness local
npm run harness -- local      # stub + 真 AGS（+ 可选 COS）
npm run harness -- cloud      # tcbr deploy + smoke
npm run harness -- --help
```

| 命令 | 说明 |
|------|------|
| `npm test` | unit + harness 单测 |
| `npm run harness -- local` | stub e2e + full AGS +（`HARNESS_COS_ENABLED` 时）cos |
| `npm run harness -- cloud` | 云上 deploy/update + ACP smoke |

COS / teardown / 镜像：见 `docs/harness-env.md` 进阶表。

## 代码布局

| 路径 | 职责 |
|------|------|
| `acp-endpoint.ts` | HTTP ACP 网关、session/load、export hooks |
| `sandbox/sandbox-prewarm.ts` | `session/new` 异步开沙箱；空闲 `HARNESS_SANDBOX_IDLE_PAUSE_MS`（默认 20min）后 pause |
| `opencode-sync.ts` | `/sync/history` ↔ CloudBase |
| `sync-event-store.ts` | `harness_sync_events` |
| `sandbox/orchestrator.ts` | AGS 创箱、数据面、teardown |
| `sandbox/session-store.ts` | `harness_sessions` |

## 日志

`LOG_LEVEL=debug`；service `oma-harness`。lanes：`acp` | `sandbox` | `orchestrator` | `mcp` | `client_tool` | `opencode_sync`

## ACP stdio bridge

`node scripts/harness-acp-bridge.mjs [baseURL]` — 默认 `http://127.0.0.1:9000`
