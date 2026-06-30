# OMA 镜像分发 — 维护指南

OMA 通过 `magent sync-image` 将预构建镜像分发到用户的 TCR。

## 与 CloudBase 沙箱分发的差异

- OMA 同步 3 个镜像：sandbox（沙箱）、tcbr（云托管）、scf（云函数）
- 基线源仅 GHCR，不支持 COS
- CNB 脚本为 Node.js 内联模板，零额外依赖

## 发布新版本

```bash
./scripts/publish.sh [tag]
# 默认 tag：YYMMDD-HHMM
# 自动推送 :latest
```

镜像地址：
- `ghcr.io/realalexandreai/open-managed-agent:<tag>`
- `ghcr.io/realalexandreai/open-managed-agent-scf:<tag>`

## 用户文档

见 [docs/sync-image.md](sync-image.md)
