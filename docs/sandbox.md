# agent.yaml `sandbox`（内部草案）

> **状态：草案** — 字段语义、默认值、校验规则随时可能调整。  
> **不对客开放**：文档与解析占位供 OMA / TRW 内部联调；托管控制台与公开 API **不识别** 此块。  
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
  # image: ...            # 高级：覆盖 HARNESS_SANDBOX_IMAGE / 部署模板
  # timeout: 30m          # serverless：AGS DefaultTimeout；durable：0 = 长驻（Talos，未接线）
```

Hermes（Talos only）内部示例见 `scripts/harness/scenarios/agent.hermes.yaml`：

```yaml
runtime: harness
engine: hermes
sandbox:
  infra: durable
  resources:
    cpu: "2"
    memory: "4Gi"
```

## 默认值（解析入口 `normalizeAgentConfig`）

在 `loadAgentConfig()` / `AGENT_CONFIG` 解析后，当 `runtime=harness` 或 YAML 已写 `sandbox:` 时合并：

| 字段 | 默认 |
|------|------|
| `sandbox.infra` | `serverless` |
| `sandbox.resources.cpu` | `"2"` |
| `sandbox.resources.memory` | `"2Gi"` |
| `sandbox.image` | 未设置 → 走 `HARNESS_SANDBOX_IMAGE` / 部署模板 |
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
| `packages/agent-runtime/src/harness/deploy.ts` | `normalizeAgentRuntime` 合并 sandbox；`applyHarnessRuntimeEnv` 转发 `sandbox.image` |

## 相关文档

- [harness-env.md](./harness-env.md) — 沙箱镜像与 LLM 环境变量
- [harness-architecture.md](./harness-architecture.md) — Harness 总览
- TRW Talos runbook：`tcb-remote-workspace/docs/infra/talos-runbook.md`
