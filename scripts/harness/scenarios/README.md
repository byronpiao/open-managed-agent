# Harness scenarios

**6 格 = `--infra` × `--engine`**（见 [CONTRIBUTING.md](../../../CONTRIBUTING.md) · [Harness一条龙.md](../../../../Harness一条龙.md)）

```text
              │ engine opencode          │ engine claude
──────────────┼──────────────────────────┼─────────────────────────
infra local   │ .env.local-opencode      │ .env.local-claude
infra tcbr    │ .env.cloud-tcbr-opencode │ .env.cloud-tcbr-claude
infra scf     │ .env.cloud-scf-opencode  │ .env.cloud-scf-claude
```

YAML：`agent.opencode.yaml` / `agent.claude.yaml` — 决定沙箱内 ACP 路径。

---

## 准备

```bash
cp .env.harness.example .env.harness
cd scripts/harness/scenarios
cp .env.local-opencode.example .env.local-opencode   # 或空文件（platform）
# BYOK 格：cp 对应 .example 并填 LLM_*
```

探活：

```bash
node scripts/harness/load-env.mjs --check
node scripts/harness/load-env.mjs --check --probe-matrix
```

---

## LLM 矩阵（preflight）

| scenario-id | 期望 mode | 来源 | preflight 行为 |
|-------------|-----------|------|----------------|
| `local-opencode` | `platform` 或 `zen` | 无 scenario 或空 `.env` | hy3 OpenAI Chat；429 → `AGENT_MODEL=zen`（**仅测试**） |
| `local-claude` | `platform` 或 `byok-anthropic` | `.env.local-claude` ③ | hy3 Anthropic；失败 → scenario BYOK（**仅测试**） |
| `cloud-tcbr-opencode` | `zen` | scenario `AGENT_MODEL=zen` | 跳过 probe |
| `cloud-scf-opencode` | `byok-openai` | ③ `LLM_*` + `OPENAI_BASE_URL` | OpenAI Chat probe |
| `cloud-tcbr-claude` | `byok-anthropic` | ③ Anthropic 三键 | sandbox-compat probe |
| `cloud-scf-claude` | `byok-anthropic` | ③ Anthropic 三键 | sandbox-compat probe |

- 模式标签见 `lib/harness-llm-env.mjs` → `describeHarnessLlmMode()`
- **无** `HARNESS_LLM_TIER` / `HARNESS_FORCE_ZEN` env
- OpenAI / Anthropic Key 不同 → **分两轮**改对应 `.env.<格子>` 再跑

---

## COS 三态

| 场景 | COS 挂载 |
|------|----------|
| **local 矩阵**（stub + full e2e + matrix-parity） | **不挂**（即使 `.env.harness` 有 `HARNESS_COS_ENABLED=1`） |
| **local cos-e2e** | `.env.harness` ⑥ 段齐 → `run --infra local` **末尾** `cos-e2e.mjs` |
| **cloud `run`** | 默认不挂；加 **`--with-cos`** 时 deploy 带 COS（tool 名仍 `oma-harness-{env}`） |

`loadEnv()` 默认**不**把 COS 键写入 `process.env`；cos-e2e / `--with-cos` 才 `applyHarnessCosFromHarnessFile()`。

首次 cos-e2e 若 AGS tool 创建时无 `StorageMounts`，orchestrator 会 **删 tool 并按 COS 配置重建**（update API 不能补 mount）。

---

## npm 入口

| 格子 | 命令 |
|------|------|
| local opencode | `test:merge` · `run --infra local --engine opencode` |
| local claude | `run --infra local --engine claude` |
| local 双引擎 | `run --infra local --engine all` |
| 云 opencode 并行 | `run --infra tcbr,scf --engine opencode` |
| 三面顺序 | `run --infra all --engine opencode` |
| 6 格全开 | `run --infra all --engine all` |
| 单格 | `run --infra {local\|tcbr\|scf} --engine {opencode\|claude}` |
| 云 + COS | `run --infra tcbr --engine opencode --with-cos` |

实现：`scenario-matrix.mjs` · `load-env.mjs` · `llm-preflight.mjs`

---

## ma-protocol（旁路）

| 文件 | 说明 |
|------|------|
| `agent.ma-protocol.yaml` | 已部署 harness Runtime 模板（opencode） |
| `agent.ma-protocol-claude.yaml` | Claude 版 |
| `.env.ma-protocol` / `.env.ma-protocol-claude` | pin `HARNESS_MA_PROTOCOL_*_AGENT_ID` |

```bash
npm run harness -- ma-protocol
npm run harness -- ma-protocol --engine claude
```

需**先**云上 deploy OMA agent；不进 6 格矩阵。
