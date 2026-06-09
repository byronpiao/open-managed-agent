# 验收清单

## 前置

```bash
magent login
export CLOUDBASE_ENV_ID=...
export TCB_REGION=ap-shanghai
cp .env.harness.example .env.harness
node scripts/harness/load-env.mjs --check
```

---

## 主线 — harness 一条龙（含 Claude SessionStore）

`npm run test:delivery` = quickstart + `test:full` + cloud-tcbr + cloud-scf。

| 步骤 | 命令 | 覆盖 |
|------|------|------|
| 单元 + MA stub | `npm test` | runtime/SDK + managed-agents stub e2e |
| 本地真 AGS | `npm run test:full` | opencode 全链 + **claude SessionStore**（有凭证时） |
| 云 zen | `npm run harness -- cloud-tcbr` | 云托管 smoke |
| 云 BYOK | `npm run harness -- cloud-scf` | Anthropic 兼容 BYOK ③ 段 |

**Claude SessionStore**（`testClaudeSessionPersistence`，在 `test:full` 的 `--full` 段自动执行）：

- `harness_claude_session_entries` 有写入
- runtime 重启后 token 召回
- 无 `TCB_API_KEY` / BYOK 时该段 warn 跳过，不挡整条链

**仅更新 TRW、OMA 仍用 main：**

1. TRW 合入并 `pnpm build:prod` + 打 magent 镜像  
2. `cd open-managed-agent && git checkout master`  
3. `./scripts/harness/build-push-magent-public.sh`  
4. `npm run test:delivery`

---

## Managed Agents HTTP 协议（`runtime: harness`）

| 步骤 | 命令 |
|------|------|
| CI stub | `npm test` |
| 配置合并单测 | `tests/managed-agents/unit.test.mjs`（在 npm test 内） |
| 云上协议验收 | `npm run build && node scripts/harness/managed-agents-protocol.mjs` |

需已部署 harness Agent + `.env.harness` 中的 `CLOUDBASE_AGENT_ID`（或 `HARNESS_CLOUD_AGENT_ID`）。

---

## 文档

- [Managed Agents 使用指南](./managed-agents-guide.md)
- [Harness 场景矩阵](../scripts/harness/scenarios/README.md)
