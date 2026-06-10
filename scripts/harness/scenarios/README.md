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
| local opencode | `test:full` · `harness:local` |
| local claude | `harness:local-claude` |
| 本地双引擎 | `harness:local-all` |
| 云 opencode 并行 | `harness:cloud-opencode` |
| 云 claude 并行 | `harness:cloud-claude` |
| 单格 | `harness:cloud-{tcbr\|scf}-{opencode\|claude}` |

别名：`local` → `local-opencode` · `cloud-tcbr` → `cloud-tcbr-opencode` · `cloud-scf` → `cloud-scf-opencode`

实现：`scenario-matrix.mjs` · `load-env.mjs`
