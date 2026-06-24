# Harness scripts

## 先分清两类

| 谁 | 要做什么 | 跑什么 |
|----|----------|--------|
| **用户 / 集成方** | 部署沙箱 Agent、对话、接 MA HTTP | `magent` CLI · [使用指南](../../docs/harness-tutorial.md) · `npm run check:harness` |
| **仓库维护者** | 验收矩阵、发版镜像、对齐 AGS tool | 下文「维护者脚本」· [CONTRIBUTING.md](../../CONTRIBUTING.md) |

**常见误解**：看到 `build-push-magent-public.sh` 以为必须自己 build 镜像。  
**实际**：用户用平台**内置默认 magent 镜像**即可；该脚本只是维护者把新 tag **写进源码**并推到公共 CCR 的发版链。

---

## 用户会碰到的

```bash
node scripts/check-harness-ready.mjs   # 或 npm run check:harness
```

部署与配置见 [harness-tutorial.md](../../docs/harness-tutorial.md)，**不必**读本目录其它脚本。

---

## 维护者：验收入口

```bash
npm test
npm run test:merge
npm run dev:harness
npm run harness -- run --infra local --engine opencode
npm run harness -- run --infra tcbr,scf --engine opencode
node scripts/harness/load-env.mjs --check --probe-matrix
```

| 文档 | 内容 |
|------|------|
| [CONTRIBUTING.md](../../CONTRIBUTING.md) | 验收两轴 · release |
| [harness-architecture.md](../../docs/harness-architecture.md) | 架构 · 排障 |
| [scenarios/README.md](./scenarios/README.md) | infra × engine 矩阵 |

---

## 维护者：发版镜像（可选，低频）

| 脚本 | 何时跑 |
|------|--------|
| `build-push-magent-public.sh` | magent 镜像有变更，要 bump `HARNESS_PUBLIC_MAGENT_IMAGE` 并推公共 CCR |
| `sync-tool.mjs` | 内置 tag 或 yaml `sandbox.image` 与 AGS 沙箱工具不一致 |
| `ags-teardown.mjs` | 本地/CI AGS 实例配额满 |

发版后：`sleep 120`（AGS 拉镜像）→ `load-env.mjs --check` → 云上验收。

**为何放在库里**：发版步骤可复现、可 code review；产物是源码里的 `HARNESS_PUBLIC_MAGENT_IMAGE` 常量，不是让用户执行的命令。
