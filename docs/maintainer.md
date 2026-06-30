# OMA 维护指南

OMA (Open Managed Agent) 将预构建镜像通过 CloudApp 分发到用户的 TCR。架构与 TRW 项目 ([tcb-remote-workspace](../../tcb-remote-workspace)) 共享，有以下差异。

## 与 TRW cloudapp 的差异

| 特性 | TRW | OMA |
|------|:---:|:---:|
| 镜像数量 | 1 个（sandbox） | 3 个（sandbox / tcbr / scf） |
| COS 源 | ✅ 支持 | ❌ 仅 GHCR |
| 用户入口 | `node sync.mjs` | `magent sync-image` |
| CNB 脚本 | 独立 .mjs 文件放在 cloudapp/ | 内联在 `lib/commands/sync-image.mjs` |
| 发布 | cloudapp/publish.sh | scripts/publish.sh |

## 发布新版本

```bash
# 构建 + 推送 TCBR 和 SCF 两个镜像到 GHCR
./scripts/publish.sh [tag]

# 默认 tag 格式：YYMMDD-HHMM
# 自动推送 latest 标签
```

镜像地址：
- TCBR：`ghcr.io/realalexandreai/open-managed-agent:<tag>` / `:latest`
- SCF：`ghcr.io/realalexandreai/open-managed-agent-scf:<tag>` / `:latest`

发布后，用户执行 `magent sync-image` 即可拉取最新版本。

## 用户入口

```bash
# 交互模式（零配置自动开通个人版共享实例）
magent sync-image

# 参数模式
magent sync-image -u <UIN> -p <密码> -i sandbox,tcbr,scf
```

文档：[docs/sync-image.md](sync-image.md)

## 架构

```
 magent sync-image         CloudApp API              CNB 构建机               用户 TCR
 ┌──────────────┐         ┌──────────────┐          ┌────────────────────┐   ┌──────────┐
 │ ①②③ inline  │         │ DescribeCloud│          │ bootstrap-docker   │   │          │
 │   .mjs → zip │──上传→ │ AppCosInfo   │          │ pull-baseline.mjs  │   │          │
 │              │         │              │──提交→  │   (GHCR → tag)     │──→│ 镜像就位 │
 │              │         │ CreateCloud  │         │ tcr-sts-login.mjs  │   │          │
 │              │         │ App          │         │   (login + push)   │   │          │
 └──────────────┘         └──────────────┘         └────────────────────┘   └──────────┘
```

- CNB 脚本为 Node.js，零依赖（Node 20 built-in crypto / fetch / child_process）
- API 调用通过 `callTcbCloudApi`（SDK 封装），不走 `tcb api` CLI

## 镜像定义

在 `lib/commands/sync-image.mjs` 的 `IMAGES` 对象中配置：

```javascript
const IMAGES = {
  sandbox: {
    imageName: "tcb-sandbox",
    baseline: "ghcr.io/realalexandreai/tcb-remote-workspace:latest",
  },
  tcbr: {
    imageName: "open-managed-agent",
    baseline: "ghcr.io/realalexandreai/open-managed-agent:latest",
  },
  scf: {
    imageName: "open-managed-agent",
    baseline: "ghcr.io/realalexandreai/open-managed-agent-scf:latest",
    scf: true,
  },
};
```

基线 tag 由 `--baseline-tag` 覆盖，或 publish.sh 更新。
