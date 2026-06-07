# Harness runtime (`runtime=harness`)

箱内引擎（opencode / claude / codebuddy）在 AGS 沙箱跑 ACP；网关薄 runtime + NoSQL 会话。

## 本地一条龙验收

入口（OMA 本地 runtime + 真 CloudBase/AGS；控制面不上云）：

```bash
npm run test:full    # npm test → harness:e2e → harness:full
```

等价于分步：`npm test` → `npm run harness:e2e` → `npm run harness:full`。`harness:full` 内联 teardown / parity smoke / 真沙箱用例，不另起 `test:harness:*` 脚本。

### 0. 环境

```bash
cp .env.example .env
cp .env.harness.example .env.harness
```

完整分层、OMA→TRW LLM 翻译、已删项：**[docs/harness-env.md](../../../docs/harness-env.md)**。

### 1. 清配额（跑 full 前后都会自动跑，也可手動）

```bash
npm run build:runtime
npm run harness:teardown                  # Stop 本 env 下非 STOPPED 实例
npm run harness:teardown -- --dry-run     # 只列出不 Stop
```

AGS 配额：**RUNNING** 与 **PAUSED** 分开计数；一条龙用 **`StopSandboxInstance`**（`session/delete` → `handle.stop()`），不再只 Pause 堆积。

### 2. 测试档位

| 命令 | 内容 |
|------|------|
| `npm test` | OMA 单测 + `harness:unit` |
| `npm run harness:unit` | harness 单测（无网） |
| `npm run harness:e2e` | 本地 stub（无 AGS） |
| `npm run harness:full` | 真 AGS：pre/post teardown + parity + prompt + custom tool + **三引擎** |
| `npm run test:full` | `test` → `harness:e2e` → `harness:full` |

`harness:full` 顺序：teardown → parity → sandbox prompt → custom tool → Zed prompt → **opencode 必过**（claude/codebuddy 仅探测，失败 warn）→ teardown。

### 3. OpenCode 持久化（`engine=opencode`）

沙箱内 **opencode acp**（`ENABLE_AGENT_OPENCODE_SERVE` 时内嵌 HTTP :8765）提供 ACP 与 `/sync/*`；OMA 经 HTTP 调 `/sync/history` → `harness_sync_events`，新箱 `/sync/replay` 再 ACP 续聊。`session/delete` 时 export + 可选 COS snapshot。见 [docs/harness-env.md](../../../docs/harness-env.md)。

### 4. 起箱 Env vs workspace/init

- **StartSandboxInstance.Env**（OMA → TRW 沙箱）：引擎开关、`MCPORTER_CONFIG_CONTENT`、运行时注入的 `HARNESS_RUNTIME_CALLBACK_URL`（来自 `CLOUDBASE_SERVER_URL`）、`HARNESS_CLIENT_TOOLS_JSON`、`OPENCODE_CONFIG_CONTENT` / Anthropic 侧车等
- **`POST /api/workspace/init`**：CloudBase 四件套 + `INTEGRATION_IDE` + `WORKSPACE_FOLDER_PATHS` + `body.skills` → `.workspace-env.json` / `.agents/skills/`

见 TRW `docs/workspace-env.md`。`HARNESS_*` 透传键须 TRW 认可；勿在 OMA example 里堆沙箱内键让人手填。

### 5. magent 镜像（改 TRW 后）

沙箱内逻辑在 **TRW** `tcb-remote-workspace`（preset `magent`）。若改了 TRW 里会影响沙箱行为的代码（workspace API、skills 落盘、relay 等），跑 `harness:full` / parity 前需重建并 push：

```bash
bash scripts/build-push-magent-public.sh
```

会写 `.env.harness` 里的 `HARNESS_SANDBOX_IMAGE`；有 `HARNESS_TOOL_ID` 时还会 `sync-harness-tool`。

## 日志

顶层 `LOG_LEVEL=debug` 或 `DEBUG=1`（非 `HARNESS_LOG_*`）；service 固定 `oma-harness`。`lane`: acp | sandbox | mcp | client_tool

## ACP stdio bridge

`node scripts/harness-acp-bridge.mjs [baseURL]` — 默认 `http://127.0.0.1:9000`，无 env。
