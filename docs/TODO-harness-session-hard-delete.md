# TODO: harness session 删除应级联清理 history（软删 → 硬删）

> Owner: harness 版本开发
> Status: OPEN
> Raised: 2026-06-18

## 背景

CLI 提供了两个级联删除入口：

- `magent session:delete -i <id>` → ACP `session/delete`
- `magent agent:delete -a <id>` → 先遍历 `session/list` 逐个调 `session/delete`，再删 agent 注册 + compute

需求：**删 session 必须删它的 history；删 agent 必须删它名下所有 session + history。**

## 当前现状

| 删除动作 | session 记录 | history / transcript | 实现 |
|---------|-------------|---------------------|------|
| 托管 `session/delete` | ✅ 硬删 | ✅ 硬删 | kernel `CloudBaseDbDriver.deleteSession()` 直接 `remove()` 四张表（sessions / session_entries / session_summaries / session_messages）—— `node_modules/@cloudbase/open-agent-kernel/dist/index.js:3837` |
| **harness `session/delete`** | ⚠️ **软删** | ❌ **不删** | 只 `store.clearInstanceBinding()` + `store.setStatus("ended")` —— `packages/agent-runtime/src/harness/acp-endpoint.ts:800-801` |

托管模式已经是硬删（符合 Anthropic `sessions delete` 的 "permanently remove session record, events, and sandbox" 语义）。

**harness 模式目前是软删**，决策：暂时保持软删不动，由 harness 开发后续统一处理为硬删。本文件记录待办。

## 软删遗留的孤儿数据（gap）

harness `handleSessionDelete`（`packages/agent-runtime/src/harness/acp-endpoint.ts:753`）执行后，以下 FlexDB 数据全部残留，不会被任何路径清理：

1. **`harness_sessions`** 行 —— 只被标记 `status="ended"`，行本身保留。
   - store 已有 `remove(acpSessionId)` 方法（`sandbox/session-store.ts:472`），但 `session/delete` 没调用它。

2. **`harness_claude_session_entries`** —— claude transcript entries。
   - 前缀常量：`PREFIX = "harness_claude_"`（`harness/claude-session-probe.ts:7`），完整名 `harness_claude_session_entries`。
   - 过滤键：`sessionKey = "${projectKey}|${engineSessionId}"`，`projectKey = envId`（见 `claude-session-probe.ts:43-44` 的 `encodeSessionKey`）。
   - 注意用的是 `row.engineSessionId`，不是 acpSessionId。

3. **`harness_claude_session_messages`** —— claude 消息记录。
   - 同上前缀，完整名 `harness_claude_session_messages`，同样按 `sessionKey` 过滤。

4. **`harness_sync_events`** —— opencode sync 事件日志（仅 opencode engine）。
   - 集合常量：`HARNESS_SYNC_EVENTS_COLLECTION = "harness_sync_events"`（`harness/sync-event-store.ts:8`）。
   - 过滤键：`{ projectKey: envId, aggregateId }`（见 `sync-event-store.ts:251`）。aggregateId 与 engineSessionId 的对应关系需开发确认。

## 待办（硬删方案，交给 harness 开发实现）

在 `packages/agent-runtime/src/harness/acp-endpoint.ts:753` 的 `handleSessionDelete` 中，把末尾的软删

```ts
await store.clearInstanceBinding(sessionId);
await store.setStatus(sessionId, "ended");
```

改为硬删，需要：

- [ ] **保留现有导出步骤**：删除前的 `persistOpencodeSyncForSession` + `snapshotWorkspaceIfAvailable`（753-798 行）保持不变 —— 删之前先把快照导出到 COS/外部，硬删只针对 FlexDB 里的 transcript。
- [ ] **删 `harness_sessions` 行**：调已有的 `store.remove(sessionId)` 替换 `setStatus("ended")`。
- [ ] **删 claude transcript**：新增一个清理函数（参考 `claude-session-probe.ts` 的 db init + `encodeSessionKey`），按 `sessionKey = envId|engineSessionId` 删除 `harness_claude_session_entries` 和 `harness_claude_session_messages`。注意 FlexDB `where().remove()` 可能有批量上限，需分页删。
- [ ] **删 sync events**：opencode engine 时，按 `{ projectKey: envId, aggregateId }` 删除 `harness_sync_events`。确认 aggregateId ↔ engineSessionId 映射。
- [ ] **幂等**：session 不存在（`row == null`）时仍应尝试清理可能残留的 transcript（按 sessionId/engineSessionId 兜底），返回 `deleted: false`。
- [ ] **凭据路径**：清理函数的 db init 要同时支持 CAM（secretId/secretKey）和 CLOUDBASE_APIKEY-only 两种路径，参考 `sandbox/session-store.ts:250 db()` 的 conditional init（probe 当前只支持 CAM，APIKEY 路径会返回空 —— 需补齐）。

## 决策记录

- harness 软删 → 硬删：**暂缓**，本 TODO 交 harness 开发统一处理。
- 托管模式：**无需改动**，kernel 已硬删。
- agent:delete 级联：**保持 CLI 循环**（`lib/commands/agent.mjs:331`）。harness `session/delete` 改成硬删后，agent:delete 的级联会自动连带清理 history，无需改 agent 删除逻辑。
