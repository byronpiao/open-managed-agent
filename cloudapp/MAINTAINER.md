# 平台维护 — 发布新版本

## 发布流程

```bash
cd packages/agent-runtime

# 0. 构建
docker build --platform linux/amd64 -f Dockerfile -t oma-agent-runtime:latest .
# SCF 版本: docker build --platform linux/amd64 -f Dockerfile.scf -t oma-agent-runtime:scf .

# 1. 推送 GHCR
TAG=$(date +%y%m%d-%H%M)
docker tag oma-agent-runtime:latest "ghcr.io/realalexandreai/oma-agent-runtime:$TAG"
docker push "ghcr.io/realalexandreai/oma-agent-runtime:$TAG"
# SCF: docker tag ... "ghcr.io/realalexandreai/oma-agent-runtime:scf-$TAG" && docker push ...

# 2. 更新 cloudapp/sync.sh BASELINE_TAG
sed -i '' 's/^BASELINE_TAG=.*/BASELINE_TAG="'"$TAG"'"/' cloudapp/sync.sh
```

## Env 表（sync.sh 顶部常量）

| 常量 | 说明 | 发版时改 |
|------|------|:---:|
| `BASELINE_TAG` | 镜像 tag | ✅ |
| `BASELINE_GHCR` | GHCR 模板 | — |
| `BASELINE_SOURCE` | `ghcr` | — |
| `TCB_ENV_ID` | TCB 环境 ID | — |
| `TCR_REGISTRY` | `ccr.ccs.tencentyun.com` | — |

## 认证方式

- 首次用户：自动开通 CCR 账号 + 命名空间
- 已注册用户：.env 填账密
- 企业版：需 CAM 授权，填 tcr-xxx
