# 沙箱内 Agent — 架构参考

> 环境变量：[harness-env.md](./harness-env.md) · 上手：[harness-tutorial.md](./harness-tutorial.md) · 会话外置：[harness-agent-session-storage.md](./harness-agent-session-storage.md)

`runtime=harness`：思考循环在 **AGS 沙箱内 engine**（opencode / claude / codebuddy）跑 ACP；OMA Runtime 负责会话索引、sync、client tool 桥、MCP relay。

---

## 1. 入口

### 1.1 配置与 CLI

```yaml
runtime: harness
engine: opencode
```

```bash
# 先 magent login && tcb env use <envId>（-e 可省略）
magent agent:create -n MyAgent --runtime harness --engine opencode -f agent.yaml
magent agent:update -i "$AGENT_ID" --runtime harness --engine opencode -f agent.yaml
```

云上进程读 `AGENT_CONFIG` → `resolveRuntime()` → `runtime=harness`。支持 SCF、tcbr、scf-image。

### 1.2 代码路径

```text
index.ts → resolveRuntime(config)
  harness → managed-agents/managed-agents-endpoint.ts（/v1/* Managed Agents HTTP）
         → harness/acp-endpoint.ts → orchestrator / sync / 箱内 ACP
  managed → OAK handler

同一 agent-runtime 包；`agent.yaml` 的 `runtime` 字段切换行为。
```

Managed Agents 面详见 [managed-agents-http.md](./managed-agents-http.md)。

### 1.3 研发验收路由

```bash
cp .env.harness.example .env.harness
node scripts/harness/load-env.mjs --check
```

| 场景 | 命令 |
|------|------|
| 合入 / 日常 | `npm run test:full`（= `npm test` + `harness -- local`，**CloudBase AI**） |
| 云上（tcbr） | `npm run harness -- cloud-tcbr`（**opencode zen**） |
| 云上（SCF） | `npm run harness -- cloud-scf`（**自定义 LLM**，③ 段） |
| **完整一条龙** | 上三行全跑 → 平台 + zen + BYOK |

```bash
# 日常
npm run test:full
npm run harness -- cloud-tcbr

# 完整（发版 / 大改 runtime）
npm run test:full
npm run harness -- cloud-tcbr
npm run harness -- cloud-scf
```

| 命令 | 部署形态 | 范围 |
|------|----------|------|
| `harness -- local` | 本机进程 + 真 AGS | stub / full / matrix / COS |
| `harness -- cloud-tcbr` | **tcbr** 云托管 | deploy + gateway ACP smoke |
| `harness -- cloud-scf` | **SCF** 云函数 | 同上 smoke |

Pin：`.env.harness` 中 `HARNESS_CLOUD_AGENT_ID`（tcbr）、`HARNESS_CLOUD_SCF_AGENT_ID`（scf）。

---

## 2. 验收脚本

```bash
npm run test:full
npm run harness -- cloud-tcbr [--agent-id …] [--verify-only]
npm run harness -- cloud-scf [--agent-id …] [--verify-only]

node scripts/harness/load-env.mjs --check [--probe-llm]
node scripts/harness/ags-teardown.mjs
node scripts/harness/cos-probe.mjs
./scripts/harness/build-push-magent-public.sh
node tests/harness/hitl-opencode.test.mjs
node scripts/harness/acp-bridge.mjs [baseURL]
```

### 沙箱镜像

| 项 | 要求 |
|----|------|
| opencode | ≥ 1.16.2 |
| 箱内进程 | `opencode acp`（`ENABLE_AGENT_OPENCODE_SERVE` 时含 sync） |

```bash
cd ../tcb-remote-workspace && pnpm build:prod && ./scripts/build.sh --preset magent --load
cd ../open-managed-agent && ./scripts/harness/build-push-magent-public.sh
```

tool update 后约 **120s** 再 start。

### COS（可选 — 工作区跨沙箱）

**默认不启用**：对话连续性靠 `harness_sync_events`（opencode sync replay）；沙箱本地磁盘随 AGS 实例 TTL 清空，属设计预期。

**启用 COS**（`.env.harness` ⑥ 段）：AGS 挂载 COS 工作区，`session/delete` 时 `workspace/snapshot` → **跨沙箱 / re-acquire 保留文件现场**（与对话 replay 互补）。

`.env.harness` 中 `HARNESS_COS_ENABLED=1` 且填齐 `HARNESS_COS_*` → `harness -- local` 执行 cos-e2e / `cos-probe` 探针。

---

## 3. 数据与隔离

| 资源 | harness |
|------|---------|
| 会话索引 | `harness_sessions` |
| 对话 replay | `harness_sync_events` |
| healthz | `harnessStore` |

| 机制 | 说明 |
|------|------|
| `runtime=harness` | 开关 |
| Collection | `harness_*` |
| `HARNESS_*` / `.env.harness` | 研发 Harness 专用 env（单文件） |

代码：`packages/agent-runtime/src/harness/` · `scripts/harness/` · `tests/harness/`

---

## 4. 默认 LLM（平台）

| 条件 | 行为 |
|------|------|
| `TCB_API_KEY` + `CLOUDBASE_ENV_ID`，未配自定义 LLM | CloudBase AI `hy3-preview`（OpenAI / Anthropic 同一 gateway） |
| `model: zen`（仅 opencode） | 箱内内置 zen，不走 CloudBase AI |
| 自定义 `LLM_*` 或 ModelSpec | 第三方 provider |

对客说明：[harness-opencode.md](./harness-opencode.md) · [harness-claude-code.md](./harness-claude-code.md)

---

## 4a. OpenCode sync（`engine=opencode`）

```text
prompt 结束 → POST …/opencode/sync/history → harness_sync_events
新箱 acquire → replay → ACP session/load
session/delete → export + 可选 workspace/snapshot（COS）
```

`harness_sessions`：`acpSessionId` ↔ `engineSessionId`。对话记录在 `harness_sync_events`（event `id` 幂等）。

详见 [harness-agent-session-storage.md](./harness-agent-session-storage.md)。

---

## 4b. Claude SessionStore（`engine=claude`）

```text
SDK turn 内 append → SessionStore → harness_claude_session_entries（CloudBase）
AGS TTL / re-acquire → session/load（replay:false）从 CloudBase 恢复 SDK 会话
箱内进程：claude-acp-harness.js（HARNESS_CLAUDE_SESSION_STORE=1）
```

详见 [harness-agent-session-storage.md](./harness-agent-session-storage.md)。

| 项 | 说明 |
|----|------|
| SoR | CloudBase `harness_claude_*`（非 `/tmp/.claude`） |
| 箱内 config | `CLAUDE_CONFIG_DIR=/tmp/.claude`（ephemeral，仅 SDK 本地缓存） |
| LLM | 默认 `TCB_API_KEY` → CloudBase AI；自定义时宿主机 `LLM_*` → 箱内 `ANTHROPIC_*` |
| 镜像 | magent 须含 `dist/agents/claude-acp-harness.js` + `@cloudbase/open-agent-kernel`（见 TRW `vendor/`） |

OMA re-acquire 后 `claude-session-warm.ts` 调箱内 `session/load`（`replay:false`），与 opencode 的 `harness_sync_events` replay 互补。

---

## 5. 能力清单

| # | 能力 | 实现 | 验收 |
|---|------|------|------|
| 1 | 网关聊天、流式 | 箱内 engine ACP + 转发 | local e2e + cloud prompt |
| 2 | magent + agent.yaml | `runtime` / `engine` | cloud deploy |
| 3 | 远程工作区 | `AgsStatefulSandboxOrchestrator` | full e2e |
| 4 | 写文件、跑命令 | TRW tools | matrix |
| 5 | client custom tool | MCP `managed-agent-client` | e2e |
| 6 | session list/load/delete | `harness_sessions` + sync | e2e lifecycle |
| 7 | HITL / 审批 | engine → 网关透传 | stub e2e；真箱手动 |
| 8 | 外部 MCP | mcporter | matrix #8 |
| 9 | CloudBase 箱内 MCP | `workspace/init` | matrix #9 |
| 10 | Skills | `.agents/skills/` | matrix #10 |
| 11 | 模型与密钥 | `TCB_API_KEY` + 默认 `hy3-preview`；可选 zen / BYOK | local + cloud probe |

---

## 6. 排障

| 层 | 日志位置 | 关联字段 |
|----|----------|----------|
| OMA Runtime | tcbr/SCF **stdout**（`harnessLog` / evlog） | `requestId`, `acpSessionId`, `instanceId`, `lane`, `phase` |
| TRW | `/var/log/trw/*.ndjson` + stdout | `request_id`, `harness_acp_session_id`, `event=agent_acp` |
| opencode | stderr → TRW `agent_stderr` | `agent=opencode-acp` |

```bash
# OMA（SCF）
tcb fn log <agent-id> -e "$CLOUDBASE_ENV_ID" | rg 'phase|session\.new|orchestrator'

# TRW（进 AGS 实例）
sudo tail -n 200 /var/log/trw/*.ndjson | rg 'agent_acp|harness_acp_session_id'

# 本地
LOG_LEVEL=debug npm run harness -- local
curl -s localhost:9000/healthz | jq .sandbox   # cachedHandles, prewarmInFlight
```

云上 orchestrator **里程碑**（`milestone` → info）：`tool.ensure` / `cos.ensure_subpath` / `instance_start` / `token.acquire`。`session/new` 结束打 `instanceId` + `durationMs`。

| 现象 | 处理 |
|------|------|
| `/sync/history` 恒 `[]` | opencode ≥ 1.16.2 |
| create 后 `magent run` 404 | 等待 gateway 路由；cloud 脚本 poll ACP |
| cloud prompt 504 | prewarm / 网关限时 |
| custom LLM 401/429 | 检查 key 与区划 |
| SCF `cos.ensure_subpath` InvalidAccessKeyId | 角色 `TENCENTCLOUD_*` + SessionToken；函数 env 勿 forward `TCB_SECRET_*` |
| cloud-scf HTTP 435 | SCF 函数 Deleting；等 90s 或 pin `HARNESS_CLOUD_SCF_AGENT_ID` |
| tool/常量镜像 tag 不一致 | `load-env.mjs --check` → `sync-tool.mjs` |
| shell `export HARNESS_TOOL_ID` | 只写 `.env.harness`；`load-env` 清泄漏 |

OpenCode 箱内路径：`/home/user/.opencode` · `OPENCODE_CONFIG_CONTENT` · `~/.local/share/opencode/auth.json`

---

## 7. 文档

| 文档 | 内容 |
|------|------|
| [harness-tutorial.md](./harness-tutorial.md) | 对客上手 |
| [harness-env.md](./harness-env.md) | 环境变量 |
| [product-guide.md](./product-guide.md) | 托管 Agent |
