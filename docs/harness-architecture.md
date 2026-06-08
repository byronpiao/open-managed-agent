# 沙箱内 Agent — 架构参考

> 环境变量：[harness-env.md](./harness-env.md) · 上手：[harness-tutorial.md](./harness-tutorial.md)

`runtime=harness`：思考循环在 **AGS 沙箱内 engine**（opencode / claude / codebuddy）跑 ACP；OMA Runtime 负责会话索引、sync、client tool 桥、MCP relay。

---

## 1. 入口

### 1.1 配置与 CLI

```yaml
runtime: harness
engine: opencode
```

```bash
magent agent:create -n MyAgent --runtime harness --engine opencode -f agent.yaml -e "$CLOUDBASE_ENV_ID"
magent agent:update -i "$AGENT_ID" --runtime harness --engine opencode -f agent.yaml -e "$CLOUDBASE_ENV_ID"
```

云上进程读 `AGENT_CONFIG` → `resolveRuntime()` → `runtime=harness`。支持 SCF、tcbr、scf-image。

### 1.2 代码路径

```text
index.ts → resolveRuntime(config)
  harness → harness/acp-endpoint.ts → orchestrator / sync / 箱内 ACP
  managed → OAK handler

同一 agent-runtime 包；`agent.yaml` 的 `runtime` 字段切换行为。
```

### 1.3 研发验收路由

```bash
cp .env.harness.example .env.harness
node scripts/harness/load-env.mjs --check
```

| 场景 | 命令 |
|------|------|
| 合入 / 日常 | `npm run test:full`（= `npm test` + `harness -- local`） |
| 云上（云托管） | `npm run harness -- cloud` |
| 云上（SCF） | `npm run harness -- cloud-scf` |
| **完整一条龙** | `test:full` + `cloud` + `cloud-scf` |

```bash
# 日常
npm run test:full
npm run harness -- cloud

# 完整（发版 / 大改 runtime）
npm run test:full
npm run harness -- cloud
npm run harness -- cloud-scf
```

| 命令 | 部署形态 | 范围 |
|------|----------|------|
| `harness -- local` | 本机进程 + 真 AGS | stub / full / matrix / COS |
| `harness -- cloud` | **tcbr** 云托管 | deploy + gateway ACP smoke |
| `harness -- cloud-scf` | **SCF** 云函数 | 同上 smoke |

Pin：`.env.harness` 中 `HARNESS_CLOUD_AGENT_ID`（tcbr）、`HARNESS_CLOUD_SCF_AGENT_ID`（scf）。

---

## 2. 验收脚本

```bash
npm run test:full
npm run harness -- cloud [--agent-id …] [--verify-only]
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

### COS 探针

`.env.harness` 中 `HARNESS_COS_ENABLED=1` 且填齐 `HARNESS_COS_*` → `harness -- local` 执行 snapshot 探针。

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

## 4. OpenCode sync（`engine=opencode`）

```text
prompt 结束 → POST …/opencode/sync/history → harness_sync_events
新箱 acquire → replay → ACP session/load
session/delete → export + 可选 workspace/snapshot（COS）
```

`harness_sessions`：`acpSessionId` ↔ `engineSessionId`。对话记录在 `harness_sync_events`（event `id` 幂等）。

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
| 11 | 模型与密钥 | agent.yaml + Start env | zen / cloud probe |

---

## 6. 排障

| 层 | 日志位置 |
|----|----------|
| OMA Runtime | 容器 stdout（`harnessLog`） |
| TRW | 沙箱 `/var/log/trw/` NDJSON |
| opencode | stderr → TRW；状态 `~/.opencode` |

```bash
sudo tail -n 100 /var/log/trw/*.ndjson 2>/dev/null | tail -20
LOG_LEVEL=debug npm run harness -- local
node scripts/harness/load-env.mjs --check --probe-llm
```

| 现象 | 处理 |
|------|------|
| `/sync/history` 恒 `[]` | opencode ≥ 1.16.2 |
| create 后 `magent run` 404 | 等待 gateway 路由；cloud 脚本 poll ACP |
| cloud prompt 504 | prewarm / 网关限时 |
| custom LLM 401/429 | 检查 key 与区划 |

OpenCode 箱内路径：`/home/user/.opencode` · `OPENCODE_CONFIG_CONTENT` · `~/.local/share/opencode/auth.json`

---

## 7. 文档

| 文档 | 内容 |
|------|------|
| [harness-tutorial.md](./harness-tutorial.md) | 对客上手 |
| [harness-env.md](./harness-env.md) | 环境变量 |
| [product-guide.md](./product-guide.md) | 托管 Agent |
