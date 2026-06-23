# agent.yaml `sandbox`（维护者草案）

> **状态：内部字段** — 托管控制台与公开用户文档**不承诺**此块；用户换镜像见 [使用指南 · 沙箱镜像](./harness-tutorial.md#沙箱镜像)。  
> 字段语义、默认值可能调整；仅 OMA / TRW 联调与研发验收使用。  
> **实现进度**：`serverless`（AGS）路径已接线 CPU/Mem/timeout/image；`durable`（Talos）在 orchestrator 层 **显式拒绝**，待 manage-node 落地。

## 与 `runtime` / `engine` 的分工

| 字段 | 含义 |
|------|------|
| `runtime: harness` | Agent 循环在沙箱内跑（相对 `managed` 在网关/OAK） |
| `engine` | 箱内 ACP 服务端（opencode / claude / codebuddy / hermes） |
| `sandbox` | **沙箱放哪、多大** — 基础设施与资源，不是认知配置 |

## YAML 形状（示例）

```yaml
runtime: harness
engine: opencode

sandbox:
  infra: serverless       # serverless | durable（默认 serverless）
  resources:              # 可选；省略则用默认值
    cpu: "2"
    memory: "2Gi"
  # image: ...            # 高级：覆盖内置 HARNESS_PUBLIC_MAGENT_IMAGE
  # imageRegistryType: enterprise   # 企业版 TCR（默认 personal）
  # timeout: 30m          # serverless：AGS DefaultTimeout；durable：0 = 长驻（Talos，未接线）
  env:                    # 可选：起箱时注入 TRW 实例 env（显式白名单式 passthrough）
    MY_FEATURE_FLAG: "on"
    WORKSPACE_FOLDER_PATHS: "/custom"   # 可覆盖 OMA 默认值（非 deny 键）
```

### `sandbox.env`（方案 A — 显式 passthrough）

在 `StartSandboxInstance` 时与 OMA 编译的 env **合并**；YAML 中同名键**覆盖** OMA 计算值（用于调参，如 `WORKSPACE_FOLDER_PATHS`）。

| 规则 | 说明 |
|------|------|
| 键名 | `UPPER_SNAKE_CASE`，最长 128 字符 |
| 值 | 非空字符串，最长 8192 字符 |
| **禁止** | `SECRET_MASTER_KEY`、`MCPORTER_CONFIG_CONTENT`、`OPENCODE_CONFIG_CONTENT`、云凭证、`CLOUDBASE_APIKEY` / `LLM_API_KEY` / `OPENAI_*` / `ANTHROPIC_*`，以及任意 `HARNESS_*`、`ENABLE_AGENT_*` 前缀 |

解析入口：`normalizeSandboxEnv`（`sandbox-config.ts` → `resolveSandboxConfig`）；注入：`buildHarnessSandboxEnv`（`deploy.ts`）。

与 TRW **workspace API** 运行时 env 白名单（`tcb-remote-workspace/docs/workspace-env.md`）无关 — `sandbox.env` 只管**起箱**一刻的实例 env。

Hermes（**内部草案，未对客**）：Talos `durable` 尚未接线；LLM 配置按 **OpenAI 兼容** `model` ModelSpec 预留（与 opencode 相同形状），见 `scripts/harness/scenarios/agent.hermes.yaml`。

## 默认值（解析入口 `normalizeAgentConfig`）

在 `loadAgentConfig()` / `AGENT_CONFIG` 解析后，当 `runtime=harness` 或 YAML 已写 `sandbox:` 时合并：

| 字段 | 默认 |
|------|------|
| `sandbox.infra` | `serverless` |
| `sandbox.resources.cpu` | `"2"` |
| `sandbox.resources.memory` | `"2Gi"` |
| `sandbox.image` | 未设置 → 内置 `HARNESS_PUBLIC_MAGENT_IMAGE` |
| `sandbox.imageRegistryType` | 未设置 → `personal`（AGS ImageRegistryType） |
| `sandbox.timeout` | 未设置 → orchestrator 内 `30m`（AGS DefaultTimeout） |

`memory` 可写 `"4Gi"` 或裸数字 `4`（解析为 `4Gi`）。

## 基础设施映射

| `sandbox.infra` | 后端 | 今日行为 |
|-----------------|------|----------|
| `serverless` | AGS（CreateSandboxTool / StartSandboxInstance） | **已接线**：Resources、DefaultTimeout、Image |
| `durable` | Talos VM + TRW Hermes preset 等 | **未接线**：`acquire` 抛 `SandboxConfigError` |

## 引擎 × infra 校验（`assertSandboxAcquireAllowed`）

| 组合 | 结果 |
|------|------|
| `serverless` + opencode/claude/codebuddy | 允许 |
| `serverless` + hermes | **拒绝**（无 AGS Hermes 镜像） |
| `durable` + hermes | 解析允许；**acquire 仍拒绝**（Talos 未接） |
| `durable` + 其他 engine | 解析允许；acquire 拒绝（同上） |

## 代码入口

| 模块 | 职责 |
|------|------|
| `packages/agent-runtime/src/harness/sandbox/sandbox-config.ts` | 类型、默认值、`resolveSandboxConfig`、`assertSandboxAcquireAllowed` |
| `packages/agent-runtime/src/config.ts` | `AgentConfig.sandbox`、`normalizeAgentConfig`、`loadAgentConfig` |
| `packages/agent-runtime/src/harness/sandbox/orchestrator.ts` | AGS Create/UpdateSandboxTool 使用 `resources` / `timeout` / `image` |
| `packages/agent-runtime/src/harness/deploy.ts` | `normalizeAgentRuntime` 合并 sandbox；`applyHarnessRuntimeEnv` 转发 `sandbox.image`；`buildHarnessSandboxEnv` 合并 `sandbox.env` |
| `packages/agent-runtime/src/harness/sandbox/sandbox-env.ts` | `sandbox.env` 校验、denylist、`mergeHarnessInstanceEnv` |

## 相关文档

- [harness-env.md](./harness-env.md) — 沙箱镜像与 LLM 环境变量
- [harness-architecture.md](./harness-architecture.md) — Harness 总览
- TRW Talos runbook：`tcb-remote-workspace/docs/infra/talos-runbook.md`
