# Harness 运维备忘（大白话）

![Harness test scenarios (internal)](./diagrams/harness-test-scenarios.svg)

## OpenCode 对话会不会丢？

- **每轮聊完**才会把 opencode 事件抄进 FlexDB（`harness_sync_events`）。
- **聊的过程中**箱子挂了（OOM、AGS 强杀），上一轮抄完之后的新内容**可能没了**。
- 要强一点用 **Claude 引擎**（边聊边写库）；OpenCode 目前没有「聊一半就存」。

**OpenCode（轮末 export）** — ![OpenCode flow](./diagrams/harness-opencode-export-flow.svg)

**Claude（turn 内 append）** — ![Claude flow](./diagrams/harness-claude-session-flow.svg)

**运维字段（`harness_sessions`）**

| 引擎 | 字段 | 含义 |
|------|------|------|
| OpenCode | `syncExportFailedAt` | 轮末 export 连续失败 |
| Claude | `claudeWarmFailedAt` | re-acquire warm 失败 |
| Claude | `claudeStoreEmptyAt` | 轮末仍无 `harness_claude_session_entries` |

详见 [harness-agent-session-storage.md](./harness-agent-session-storage.md)。

## 云托管开几个副本？

- 哪台机器握着沙箱、client tool 桥，记在**进程内存**里。
- **建议 tcbr 先单副本**；开多副本可能：首条 prompt 又要重新起箱、custom tool 偶尔接不上。
- 不是 bug，是现状；要多副本以后得改代码（bind 只信数据库）。

## FlexDB 压测怎么跑

只关心数据库行数/体积时，不必跑完整 `harness -- local`：

```bash
npm run build:runtime
npm run harness -- db-pressure --engines opencode --db-pressure-rounds 10
npm run harness -- db-pressure --engines claude   --db-pressure-rounds 10   # 要 .env.local-claude
npm run harness -- db-pressure --engines all      --db-pressure-rounds 10

# 云上（跳过 deploy）
npm run harness -- cloud-tcbr-opencode --verify-only --db-pressure --db-pressure-rounds 10
npm run harness -- cloud-tcbr-claude   --verify-only --db-pressure --db-pressure-rounds 10
```

OpenCode 看 `harness_sync_events`；Claude 看 `harness_claude_session_entries`（不是同一张表）。详见 [harness-agent-session-storage.md §10](./harness-agent-session-storage.md#10-flexdb-压测实测db-pressure)。

## product-acceptance（产品向，不合入 smoke）

比 `harness:smoke` 多验：同会话多轮开发、Skill 模型遵守、agent 经 bash 调 mcporter（CloudBase / 外部 MCP）、真箱 HITL、`session/load` 重连、可选 Claude 引擎。约 5–15 分钟，LLM 脆，**独立命令**：

```bash
npm run harness -- product-acceptance
npm run harness -- product-acceptance --engines all   # 含 Claude
```

入口与 `harness -- local` 相同：`.env.harness`、preflight tier、端口 19090。

## 日志关联（OMA ↔ TRW）

| 字段 | OMA | TRW | 用途 |
|------|-----|-----|------|
| `traceId` / `trace_id` | `harnessLog` | access / tool_call | CloudBase 服务调用日志 |
| `requestId` / `request_id` | `harnessLog` | Hono access | 单次 HTTP |
| `acpSessionId` / `harness_acp_session_id` | scope + 已有 env | 已有 env | harness 会话 |

链路可从 OMA 或直连 TRW 开始；无入站 id 时各自生成 `requestId`。产品验收结束会打一行 `product_acceptance_summary` JSON（含 `sessionId`）。
