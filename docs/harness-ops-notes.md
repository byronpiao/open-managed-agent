# Harness 运维备忘（大白话）

## OpenCode 对话会不会丢？

- **每轮聊完**才会把 opencode 事件抄进 FlexDB（`harness_sync_events`）。
- **聊的过程中**箱子挂了（OOM、AGS 强杀），上一轮抄完之后的新内容**可能没了**。
- 要强一点用 **Claude 引擎**（边聊边写库）；OpenCode 目前没有「聊一半就存」。

详见 [harness-agent-session-storage.md](./harness-agent-session-storage.md)。

## 云托管开几个副本？

- 哪台机器握着沙箱、client tool 桥，记在**进程内存**里。
- **建议 tcbr 先单副本**；开多副本可能：首条 prompt 又要重新起箱、custom tool 偶尔接不上。
- 不是 bug，是现状；要多副本以后得改代码（bind 只信数据库）。

## FlexDB 压测怎么跑

只关心数据库行数/体积时，不必跑完整 `harness -- local`：

```bash
# 本地进程 + 真 AGS + 真 FlexDB（每轮 session 聊一句后统计行数/字节）
npm run build:runtime
npm run harness -- db-pressure --db-pressure-rounds 10

# 云上已有 agent（跳过 deploy，只 verify + 压测）
npm run harness -- cloud-tcbr-opencode --verify-only --db-pressure --db-pressure-rounds 10
```

输出里看 `round | collection rows | bytes~` 和末尾 `avg/round`。
