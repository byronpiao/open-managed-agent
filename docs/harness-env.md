# 沙箱 Agent — 环境变量（研发与验收）

> **对客部署请读：** [使用指南](./harness-tutorial.md) · [凭证说明](./harness-credentials.md)  
> 日常只需 `magent login` + `tcb env use` + `agent.yaml`，**不必**创建本页所述的 `.env.harness`。

本文面向 **仓库内验收、镜像推送、场景矩阵**；与快速开始无关的内容请勿抄进对客材料。

---

## 两个 env 文件（研发）

| 文件 | 模板 | 用途 |
|------|------|------|
| **`agent.harness.yaml`** | `agent.harness.yaml.example` | magent 用户主配置；部署 → AGENT_CONFIG_B64 |
| **`.env.harness`** | `.env.harness.example` | OMA 研发 / `npm run harness` / `npm run dev:harness` |

```bash
cp agent.harness.yaml.example agent.harness.yaml
cp .env.harness.example .env.harness
node scripts/harness/load-env.mjs --check
```

验收场景矩阵：[scripts/harness/scenarios/README.md](../scripts/harness/scenarios/README.md) · 编排：[CONTRIBUTING.md](../CONTRIBUTING.md) · [Harness一条龙.md](../../Harness一条龙.md)

---

## ① CloudBase 基座（`.env.harness` 默认留空）

`magent login` + `tcb env use` 后，`magent agent:create` 会自动补齐环境 ID 与地域。

CI / 无交互部署的手填变量见 [凭证说明 · CI 与流水线](./harness-credentials.md#ci-与无交互部署)。

### 云上 tcbr vs SCF（研发）

| | tcbr 容器 | SCF 云函数 |
|--|-----------|------------|
| 操作者 `TCB_SECRET_*` | 写入容器 env | **仅宿主机**（deploy 时）；勿写入函数 env |
| 运行时临时密钥 | 容器内 STS | 执行角色注入 `TENCENTCLOUD_*` |

`agent:update`（SCF）整表替换函数 env，须与 `agent:create` 同一套变量；不重传代码包。

**`HARNESS_TOOL_ID`**：仅写在 `.env.harness`（固定沙箱工具 ID，验收用）。

<details>
<summary>研发：镜像 tag 三处对齐</summary>

`HARNESS_PUBLIC_MAGENT_IMAGE`（源码内置默认）= AGS 沙箱工具镜像字段（`sync-tool.mjs` 对齐）。自定义镜像写在 agent yaml 的 `sandbox.image`。`build-push-magent-public.sh` 更新内置 tag；`load-env.mjs --check` 校验。

</details>

---

## ②–⑥ 段（见 `.env.harness.example`）

| 段 | 内容 |
|----|------|
| ② | `CLOUDBASE_AGENT_ID` |
| ③ | 场景 LLM：`scenarios/.env.<scenario>`（**仅研发验收**，对客请写 yaml `model`） |
| ④ | 镜像 / `HARNESS_TOOL_ROLE_ARN` |
| ⑥ | `HARNESS_COS_*`（研发验收；见下） |

**⑥ COS（研发验收）**：可在 `.env.harness` 里写 `HARNESS_COS_ENABLED=1` 与 bucket 变量，但 `loadEnv()` **默认不把 COS 键注入** `process.env`。仅 **cos-e2e**（`run --infra local` 末尾）或 **cloud `--with-cos`** 会 `applyHarnessCosFromHarnessFile()`。local 矩阵 full e2e **不挂** COS。

**沙箱鉴权（研发）**：本地 harness 在 `agent.harness.yaml` 设 `sandbox.auth: none`；不用 `HARNESS_SANDBOX_AUTH_MODE` env。见 `agent.harness.yaml.example`。

**研发 pin**：`HARNESS_CLOUD_*_AGENT_ID`、`HARNESS_MA_PROTOCOL_AGENT_ID` 等 — 见 `scenarios/README.md`。

对客 COS 说明：[使用指南 · 工作区持久化](./harness-tutorial.md#工作区持久化-cos)。

---

## 相关（研发）

- [harness-architecture.md](./harness-architecture.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 验收选型、release 编排、工具箱
- [harness-ops-notes.md](./harness-ops-notes.md)
