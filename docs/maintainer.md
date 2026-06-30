# OpenManagedAgent 镜像分发 — 维护指南

`magent sync-image` 将预构建镜像分发到用户的 TCR。

## 镜像清单

| 镜像 | 标识 | GHCR 地址 |
|------|:---:|------|
| CloudBase 沙箱（沙箱镜像） | `sandbox` | `ghcr.io/realalexandreai/tcb-remote-workspace:latest` |
| OpenManagedAgent（云托管） | `tcbr` | `ghcr.io/realalexandreai/open-managed-agent:latest` |
| OpenManagedAgent（云函数） | `scf` | `ghcr.io/realalexandreai/open-managed-agent-scf:latest` |

## 发布新版本

### OpenManagedAgent 镜像（tcbr + scf）

```bash
./scripts/publish.sh [tag]
```

构建 `packages/agent-runtime` 的 Dockerfile + Dockerfile.scf，推送到 GHCR。默认 tag `YYMMDD-HHMM`，同时推送 `:latest`。

### 沙箱镜像（sandbox）

```bash
./scripts/build.sh --preset magent --load   # 构建 tcb-sandbox-ags:app-magent
./cloudapp/publish.sh [tag]                 # 推送 GHCR + AGS CCR
```

## 用户文档

见 [docs/sync-image.md](sync-image.md)
