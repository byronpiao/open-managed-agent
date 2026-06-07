# Harness / OpenCode 可观测性

这次云上 504 排查难，根因之一是 **日志不在一个地方、CLS 默认搜不到**。本文说明各层日志在哪、怎么读。

## 三层别混

| 层 | 进程 | 典型日志去向 |
|----|------|----------------|
| **OMA harness runtime** | CloudRun `oma-harness-*` | 容器 **stdout**（evlog / `harnessLog`） |
| **TRW 网关** | AGS 沙箱内 `:9000` | **`/var/log/trw/`** NDJSON + stdout |
| **opencode** | 沙箱内 ACP 子进程 | **stderr → TRW `agent_stderr`**；配置/状态在 **`/home/user/.opencode`** |

`tcb logs search` 当前环境常 **0 条** — 不代表没打日志，是 **还没接入 CLS 采集 CloudRun/AGS stdout**。

---

## OpenCode 目录（默认）

TRW `agent-services-manager` 启动 opencode 时：

| 变量 / 路径 | 含义 |
|-------------|------|
| `OPENCODE_CONFIG_DIR` | 默认 **`<workspace>/.opencode`**，magent 工作区即 **`/home/user/.opencode`** |
| `OPENCODE_CONFIG_CONTENT` | 起箱时注入的内联 `opencode.json`（OMA 自定义 LLM 时写入） |
| `~/.local/share/opencode/auth.json` | `opencode auth login` 凭证（zen 或手动 login） |
| `<configDir>/.local/` | opencode 运行时本地状态（TRW 在 configDir 下建 `.gitignore` 忽略 `.local`） |

**配置根目录就是 `/home/user/.opencode`**（除非显式设 `OPENCODE_CONFIG_DIR`）。

箱内快速看：

```bash
ls -la /home/user/.opencode
ls -la /home/user/.local/share/opencode/ 2>/dev/null
opencode models    # zen/* 或 openai-compat/<LLM_MODEL>
```

---

## TRW 日志怎么读

| 来源 | 位置 / 方式 |
|------|-------------|
| 结构化 NDJSON | **`/var/log/trw/`**（镜像里 `LOG_DIR` 存在时写文件；magent 镜像一般有） |
| HTTP access / 工具 | evlog `event: access` 等，同上或 stdout |
| **opencode stderr** | TRW `logServiceEvent("warn", "agent_stderr", …)` → 进 TRW 日志流 |

箱内：

```bash
# 最近 TRW 日志（文件名随 evlog 轮转）
sudo tail -n 100 /var/log/trw/*.ndjson 2>/dev/null | tail -20

# 或经 TRW API（需箱内 token）
curl -s http://127.0.0.1:9000/health | jq .
```

Harness e2e / 手动：用 AGS 控制台进实例终端，或 orchestrator 拿到 `instanceId` 后走数据面（COS 探针见 `docs/harness-env.md` 进阶表）。

---

## OMA harness runtime 日志

| 字段 | 说明 |
|------|------|
| `LOG_LEVEL=debug` | 宿主机 / CloudRun 环境变量 |
| lanes | `acp`, `sandbox`, `orchestrator`, `opencode_sync`, `mcp` |
| `session/prompt` | 含 `sandboxWaitMs`, `sandboxForwardMs`, `totalMs`（便于区分开箱 vs 模型） |

CloudRun 控制台 → 服务 `oma-harness-*` → 日志，或后续接 CLS。

本地：

```bash
LOG_LEVEL=debug npm run harness -- local
```

---

## 自定义 LLM（Mimo）排障清单

1. **API 通不通**（宿主机，勿提交 key）：
   ```bash
   curl -s -X POST "$OPENAI_BASE_URL/chat/completions" \
     -H "Authorization: Bearer $LLM_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"mimo-v2.5-pro","messages":[{"role":"user","content":"pong"}],"max_tokens":8}'
   ```
2. **宿主机 `OPENAI_BASE_URL`** 必须是 Chat Completions 根（如 Mimo `…/v1`）；`ANTHROPIC_BASE_URL` 只给 claude，不进 opencode。
3. **模型名**：与提供商一致（如 `mimo-v2.5-pro`），写在 `LLM_MODEL`。
4. **对比 zen**：不配 `LLM_*` → 内置 zen；若 zen 快、Mimo 慢 → 提供商或网关限时，不是沙箱。

验证：

```bash
npm run harness -- cloud --verify-only
# 已有 agent：
npm run harness -- cloud --verify-only --agent-id agent-oma-harness-7ef1v611abd610
```

---

## 默认策略（一条龙）

- **日常 / 云上默认**：`agent.harness.cloud.yaml` → **`model: zen`**，不烧第三方 token。
- **要 Mimo**：`.env.harness` 里 `LLM_API_KEY` + `OPENAI_BASE_URL`（`/v1`）+ `LLM_MODEL=mimo-v2.5-pro`，再 `npm run harness -- cloud`。

详见 [harness-env.md](./harness-env.md)。
