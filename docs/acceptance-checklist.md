# 验收清单（feat/cma-http）

三条验收线可独立执行；发版前建议按 **B → A → C** 顺序（先确认存量 harness，再专项）。

## 前置

```bash
magent login   # 或 export TCB_SECRET_ID / TCB_SECRET_KEY
export CLOUDBASE_ENV_ID=...
export TCB_REGION=ap-shanghai
cp .env.harness.example .env.harness   # 按需填写
node scripts/harness/load-env.mjs --check
```

---

## B — 存量 harness 一条龙

| 步骤 | 命令 | 预期 |
|------|------|------|
| 单元 + stub | `npm test` | 全绿（含 MA stub e2e） |
| 本地真 AGS | `npm run test:full` | opencode 主路径 + 可选 COS |
| 云 tcbr | `npm run harness -- cloud-tcbr` | 部署/网关 ACP smoke |
| 云 scf BYOK | `npm run harness -- cloud-scf` | 自定义 LLM ③ 段 |
| 交付串联 | `npm run test:delivery` | 上表 1–4 自动跑 |

**仅更新 TRW、OMA 仍用 main 时：**

```bash
# 在 tcb-remote-workspace 合入 TRW 分支并 build 镜像后
cd open-managed-agent   # git checkout main
./scripts/harness/build-push-magent-public.sh   # 使用新 TRW 镜像
npm run test:delivery
```

见 `scripts/harness/trw-only-verify.mjs`（说明脚本）。

---

## A — Claude Code SessionStore 外置 + BYOK

| 步骤 | 命令 | 预期 |
|------|------|------|
| SessionStore 本地 | `npm run harness -- local`（`engine=claude` 段） | `harness_claude_session_entries` 有数据；重启后 token 召回 |
| 平台 Anthropic 兼容 | 同上，默认 `TCB_API_KEY` + `hy3-preview` | prompt 有 LLM 文本 |
| BYOK | `npm run harness -- cloud-scf` 或 local + `LLM_*` + `ANTHROPIC_BASE_URL` | `sandbox-llm-diag.mjs byok` 或 scf smoke 通过 |
| 镜像 | TRW 含 `claude-acp-harness.js` + vendor kernel | `build-push-magent-public.sh` |

关键断言（`tests/harness/e2e.test.mjs` → `testClaudeSessionPersistence`）：

- `engineSessionId` 写入 `harness_sessions`
- FlexDB `harness_claude_session_entries` count > 0
- runtime 重启后 `session/load` + 追问能召回 token

---

## C — MA HTTP 用户故事（仅 `runtime: harness`）

| 步骤 | 命令 | 预期 |
|------|------|------|
| CI stub | `npm test` → `e2e-managed-agents-harness.test.mjs` | SDK + 全进程 + 网关/直连 + HITL |
| 配置合并 | `tests/managed-agents/unit.test.mjs` | env metadata.engine + agent metadata 合并进有效 config |
| 云上演收 | `node scripts/harness/ma-acceptance.mjs` | 对已部署 harness Agent 跑用户故事 |

**用户故事（验收脚本实现）：**

1. `createEnvironment`（metadata.engine 可选）
2. `createAgent`（metadata.model / system）
3. `createSession` → `streamSessionEvents` + `user.message`
4. （可选）HITL `tool_confirmation`
5. `deleteSession`
6. 直连与网关 URL 各一遍

**配置模型：** 部署 `agent.yaml` = 基线；MA Environment / Agent 记录 **合并** 为内存中的有效 `AgentConfig` 再下传 harness（见 `resolve-session-agent-config.ts`）。

---

## 相关文档

- [Managed Agents 使用指南](./managed-agents-guide.md)
- [Harness 场景矩阵](../scripts/harness/scenarios/README.md)
