# Harness 运维备忘（大白话）

![Harness test scenarios (internal)](./diagrams/harness-test-scenarios.svg)

## OpenCode 对话会不会丢？

- **每轮聊完**才会把 opencode 事件抄进 FlexDB（`harness_sync_events`）。
- **聊的过程中**箱子挂了（OOM、AGS 强杀），上一轮抄完之后的新内容**可能没了**。
- 要强一点用 **Claude 引擎**（边聊边写库）；OpenCode 目前没有「聊一半就存」。

**OpenCode（轮末 export）** — ![OpenCode flow](./diagrams/harness-opencode-export-flow.svg)

**Claude（turn 内 append）** — ![Claude flow](./diagrams/harness-claude-session-flow.svg)

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
