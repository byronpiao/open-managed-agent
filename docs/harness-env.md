# 沙箱 Agent — 环境变量（研发与验收）

> **对客部署请读：** [使用指南](./harness-tutorial.md) · [凭证说明](./harness-credentials.md)  
> 日常只需 `magent login` + `tcb env use` + `agent.yaml`，**不必**创建本页所述的 `.env.harness`。

本文面向 **仓库内验收、镜像推送、场景矩阵**；与快速开始无关的内容请勿抄进对客材料。

---

## 两个 env 文件（研发）

| 文件 | 用途 |
|------|------|
| **`.env.harness`** | `npm run harness` 验收矩阵 |
| **`.env`** | 托管 Agent / SDK 集成测试 |

```bash
cp .env.harness.example .env.harness
node scripts/harness/load-env.mjs --check
```

验收场景矩阵：[scripts/harness/scenarios/README.md](../scripts/harness/scenarios/README.md) · 编排：[scripts/harness/README.md](../scripts/harness/README.md)

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

`HARNESS_PUBLIC_MAGENT_IMAGE`（源码）= `.env.harness` `HARNESS_SANDBOX_IMAGE` = 沙箱工具镜像字段。`build-push-magent-public.sh` + `sync-tool.mjs`；`load-env.mjs --check` 校验。

</details>

---

## ②–⑥ 段（见 `.env.harness.example`）

| 段 | 内容 |
|----|------|
| ② | `CLOUDBASE_AGENT_ID` |
| ③ | 场景 LLM：`scenarios/.env.<scenario>` |
| ④ | 镜像 / `HARNESS_TOOL_ROLE_ARN` |
| ⑥ | `HARNESS_COS_*`（local 验收） |

**研发 pin**：`HARNESS_CLOUD_*_AGENT_ID`、`HARNESS_MA_PROTOCOL_AGENT_ID`、`HARNESS_TOOL_COS_NAME_SUFFIX` 等 — 见 `scenarios/README.md`。

对客 COS 说明：[使用指南 · 工作区持久化](./harness-tutorial.md#工作区持久化-cos)。

---

## 相关（研发）

- [harness-architecture.md](./harness-architecture.md)
- [Harness一条龙.md](../../Harness一条龙.md)
- [harness-ops-notes.md](./harness-ops-notes.md)
