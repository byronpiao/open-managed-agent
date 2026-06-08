# 沙箱内 Agent — 环境变量

> 模板：[`.env.harness.example`](../.env.harness.example) · [harness-tutorial.md](./harness-tutorial.md)

## 两个 env 文件（不要混）

| 文件 | 谁用 | 怎么建 |
|------|------|--------|
| **`.env.harness`** | Harness 验收（`npm run harness`） | `cp .env.harness.example .env.harness` |
| **`.env`** | 托管 Agent / SDK / integration | `cp .env.example .env` |

**Harness 只读 `.env.harness`，不读、不叠加 `.env`。**

```bash
node scripts/harness/load-env.mjs --check
node scripts/harness/load-env.mjs --check --probe-llm
```

`.env.harness.example` 按段编号 ①–⑥，与下表一致。

---

## ① 必填（`.env.harness`）

| 变量 | 说明 |
|------|------|
| `CLOUDBASE_ENV_ID` | 环境 ID |
| `TCB_REGION` | 如 `ap-shanghai` |
| `TCB_API_KEY` | AGS JWT |
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | 腾讯云密钥 |
| `CLOUDBASE_ACCESS_KEY` | 网关 API |

---

## ②–⑥ 可选（见 example 文件）

| 段 | 内容 |
|----|------|
| ② | `CLOUDBASE_AGENT_ID` |
| ③ | `LLM_*`（仅 `harness -- cloud-tcbr` / `cloud-scf` custom） |
| ④ | 沙箱镜像 / `HARNESS_TOOL_ID` |
| ⑤ | `HARNESS_CLOUD_AGENT_ID` / `HARNESS_CLOUD_SCF_AGENT_ID` |
| ⑥ | `HARNESS_COS_*`（工作区跨沙箱持久化，见下） |

### ⑥ COS — 工作区 vs 对话

| | 不启用 COS（默认） | 启用 `HARNESS_COS_ENABLED=1` |
|--|-------------------|------------------------------|
| **多轮对话** | `harness_sessions` + `harness_sync_events` replay | 同上 |
| **沙箱内文件**（代码、build 产物等） | AGS TTL / re-acquire 后丢失 | COS mount + snapshot，**跨沙箱保留工作区现场** |
| **验收** | `test:full` 不要求 COS | `harness -- local` 含 cos-e2e 硬门 |

创箱时按 session 隔离 COS subpath；`session/delete` 触发 TRW `workspace/snapshot`（见 [harness-architecture.md §4](./harness-architecture.md)）。

---

## 运行时三层（自动，勿手填进 example）

| 层 | 说明 |
|----|------|
| 宿主机 | `.env.harness` 你填的键 |
| OMA Runtime | `AGENT_CONFIG`、`PORT` 等 |
| TRW 沙箱 | OMA 起箱时注入 `OPENCODE_CONFIG_CONTENT`、`HARNESS_*` 等 |

### opencode LLM

| 宿主机 | 沙箱 |
|--------|------|
| 无 `LLM_*` | zen |
| 有 `LLM_*` | `OPENCODE_CONFIG_CONTENT` |

`agent.yaml` ModelSpec（对客部署）优先于 `LLM_*`。

---

## 相关

- [harness-tutorial.md](./harness-tutorial.md) — 对客部署（用 `agent.yaml`，不用 `.env.harness`）
- [harness-architecture.md](./harness-architecture.md)
- [`Harness一条龙.md`](../../Harness一条龙.md)
