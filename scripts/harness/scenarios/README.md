# Harness 验收场景矩阵

每条验收路径 = **agent.yaml 形态** + **env 场景** + **AGS tool 变体**。不要用一个「全开」的 `.env.harness` 跑所有步骤。

`load-env.mjs` 的 `applyHarnessScenario()` 在运行时裁剪 env；COS ⑥ 段可以写在文件里，但 **cloud 步骤会自动 strip**，避免 `MountOption` 指向无 `StorageMounts` 的 tool。

| 步骤 | 命令 | agent yaml | env 场景 | AGS tool | LLM |
|------|------|------------|----------|----------|-----|
| 对客快速开始 | `node scripts/harness/quickstart.mjs` | `docs/examples/agent.sandbox.opencode.min.yaml` | `quickstart` | `{env}-no-cos` | CloudBase AI |
| 合入 / local | `npm run test:full` | （本机 orchestrator） | `local` | ⑥ 开 → `-with-cos`，否则 `-no-cos` | hy3（429→zen） |
| 云托管 | `npm run harness -- cloud-tcbr` | `agent.harness.cloud.yaml` → zen | `cloud-tcbr` | **强制** `-no-cos` | opencode zen |
| 云函数 BYOK | `npm run harness -- cloud-scf` | `agent.harness.cloud.yaml` → ③ 段 | `cloud-scf` | **强制** `-no-cos` | 自定义 OpenAI-compat |
| **交付一条龙** | `npm run test:delivery` | 上表顺序全跑 | 每步自动切换 | 见上 | 三条路径 |

## `.env.harness` 建议写法

- **① 必填** + **④ 镜像/RoleArn**：所有步骤共用。
- **③ BYOK**：只给 `cloud-scf`；`load-env` 在其它场景会删掉 `LLM_*`。
- **⑥ COS**：只影响 `test:full` / `harness -- local`；云上验收**不读**（即使文件里写了 `HARNESS_COS_ENABLED=1`）。
- **⑤ pin**：交付前清空 `HARNESS_TOOL_ID` / `HARNESS_CLOUD_*`。

## 本地工作文件（勿 commit）

| 文件 | 来源 |
|------|------|
| `agent.sandbox.yaml` | `cp docs/examples/agent.sandbox.opencode.min.yaml`（quickstart 会自动写） |
| `packages/agent-runtime/agent.harness.yaml` | `cloud.mjs` 生成 |

## 研发并行 tool

`.env.harness` 未写 `HARNESS_TOOL_COS_NAME_SUFFIX` 时，`load-env` 默认 `=1` → `-no-cos` / `-with-cos` 两个 tool 可并存同一环境。
