# OMA Agent Runtime — 镜像分发

- [**USAGE.md**](USAGE.md) — 用户：将镜像同步到自己的 TCR
- [**MAINTAINER.md**](MAINTAINER.md) — 平台：发布新版本到公开仓库

## 架构

```
  用户              CloudApp               CNB 构建机              用户 TCR
  .env              sync.sh                bootstrap-docker
  零配置 ──→      ① zip 上传              pull-tcbr + push-tcbr ──→ oma-agent-runtime (云托管)
                   ② CreateCloudApp ──→   pull-scf  + push-scf  ──→ oma-agent-runtime (云函数)
                                          
  平台              ghcr.io/realalexandreai/oma-agent-runtime
  publish.sh ──→   :tag + :scf-tag (公开仓库，免鉴权)
```

## 文件

| 文件 | 谁用 | 作用 |
|------|:---:|------|
| `USAGE.md` | 用户 | 使用说明 |
| `.env.example` | 用户 | 配置模板 |
| `sync.sh` | 用户 | 一键同步 |
| `MAINTAINER.md` | 平台 | 发布说明 |
| `Dockerfile.bootstrap` | CNB | 激活 docker |
| `pull-baseline.sh` | CNB | GHCR 拉镜像 → tag |
| `tcr-sts-login.sh` | CNB | 登录 + push |
