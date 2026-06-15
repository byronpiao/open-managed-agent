# Harness 场景矩阵

**3 部署面 × 2 engine = 6 格**。每格一对文件；agent 只按 **engine** 分两份（对称、好记）。

```
                 │ opencode                    │ claude
─────────────────┼─────────────────────────────┼──────────────────────────────
local            │ .env.local-opencode         │ .env.local-claude
                 │ agent.opencode.yaml         │ agent.claude.yaml
cloud-tcbr       │ .env.cloud-tcbr-opencode    │ .env.cloud-tcbr-claude
cloud-scf        │ .env.cloud-scf-opencode     │ .env.cloud-scf-claude
```

| 格子 | LLM tier | `.env.*` 内容 | preflight |
|------|----------|----------------|-----------|
| `local-opencode` | platform（429→zen） | 可为空 | OpenAI Chat |
| `local-claude` | 先 platform hy3；测试 fallback ③ | ③ 可选（fallback 用） | Anthropic Messages + sandbox-compat |
| `cloud-tcbr-opencode` | zen | 可为空 |
| `cloud-scf-opencode` | OpenAI BYOK ③ | `LLM_*` + `OPENAI_BASE_URL` |
| `cloud-tcbr-claude` | Anthropic ③ | `LLM_*` + `ANTHROPIC_BASE_URL` |
| `cloud-scf-claude` | Anthropic ③ | 同上 |

基座 **`/.env.harness`**：①④⑤⑥（镜像、COS、pin；① CloudBase 默认留空）。不含 ③。

**`sandbox`（内部草案）**：6 格 AGS 路径 = `sandbox.infra: serverless`（`agent.*.yaml` 已显式写；省略时解析默认同值）。`resources` 默认 `cpu: "2"` / `memory: "2Gi"`。详见 [`docs/sandbox.md`](../../docs/sandbox.md) — 不对客、Hermes 不进本矩阵。

```bash
magent login && tcb env use <envId>    # ① 段通常不必手填
cd scripts/harness/scenarios
cp .env.local-claude.example .env.local-claude      # 填入 LLM_API_KEY（gitignore，勿提交）
cp .env.cloud-scf-opencode.example .env.cloud-scf-opencode
# …其余格子同理；local-opencode / cloud-tcbr-opencode 可空文件
```

模板为 `.env.<scenario>.example`（可提交）；真实 ③ 写在 `.env.<scenario>`（被 `.gitignore` 忽略）。

`applyHarnessScenario(<格子 id>)` → 载入 `.env.<格子>` → 写入标准 `LLM_API_KEY` / `LLM_MODEL` / URL 键。

## npm 入口

| 格子 / 组 | npm |
|-----------|-----|
| local opencode | `npm run test:full` · `npm run harness -- local` |
| local claude | `npm run harness -- local --engines claude` |
| 本地双引擎 | `npm run harness -- local --engines all` |
| 云 opencode 并行 | `npm run harness -- cloud-opencode` |
| 云 claude 并行 | `npm run harness -- cloud-claude` |
| 单格 | `npm run harness -- cloud-{tcbr\|scf}-{opencode\|claude}` |

别名：`local` → `local-opencode` · `cloud-tcbr` → `cloud-tcbr-opencode` · `cloud-scf` → `cloud-scf-opencode`

实现：`scenario-matrix.mjs` · `load-env.mjs`

## ma-protocol（旁路 · MA HTTP）

| 文件 | 说明 |
|------|------|
| `agent.ma-protocol.yaml` | 已部署 **harness Runtime** 的 agent 配置模板（`runtime: harness`） |
| `.env.ma-protocol` | pin `HARNESS_MA_PROTOCOL_AGENT_ID`（`CLOUDBASE_AGENT_ID` 可作别名） |

```bash
cd scripts/harness/scenarios
cp .env.ma-protocol.example .env.ma-protocol
# 填入 magent agent:create / harness:cloud-* 产出的 agent id
npm run ma-protocol
```

与 6 格区别：**不部署 AGS 矩阵**，只打已上线 Runtime 的 `/v1/agents|environments|sessions` HTTP。`load-env.mjs --check` 在 sidecar 段显示就绪状态。

## Hermes（内部 · Talos，未接 manage node）

| 项 | 说明 |
|----|------|
| `agent.hermes.yaml` | `engine: hermes` → TRW `POST /api/agents/hermes/acp` |
| 箱 env | `ENABLE_AGENT_HERMES_ACP` + `ENABLE_AGENT_HERMES_WEB`（与 packer preset 对齐） |
| LLM 注入 | 主路径 **OpenAI-compatible**（`OPENAI_API_KEY` / `OPENAI_BASE_URL`）；可选叠加 Anthropic（`ANTHROPIC_*`） |
| 验收 | **阻塞**：Talos 未进 TCB CLI / manage node；无 AGS docker 镜像。联调前勿加 harness npm 格子。 |
