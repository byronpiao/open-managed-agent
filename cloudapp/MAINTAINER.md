# 平台维护 — 发布新版本

## 前置条件

首次使用需申请 GitHub Container Registry 推送权限：
https://github.com/realalexandreai/open-managed-agent/pkgs/container/oma-agent-runtime

在 Package Settings → Manage Actions access 添加仓库角色。

## 发布流程

```bash
# 一键构建 + 推送 TCBR 和 SCF 两个镜像
./cloudapp/publish.sh
# 自动生成 tag（YYMMDD-HHMM），TCBR 和 SCF 各一份
# SCF 版本 tag 自动加 scf- 前缀
```

## 镜像地址

发布时自动推送两个版本：
- TCBR（云托管）：`ghcr.io/realalexandreai/oma-agent-runtime:<tag>`
- SCF（云函数）：`ghcr.io/realalexandreai/oma-agent-runtime:scf-<tag>`

## Env 表（sync.sh 顶部常量）

| 常量 | 说明 | 发版时改 |
|------|------|:---:|
| `BASELINE_TAG` | TCBR 镜像 tag | ✅ |
| `BASELINE_GHCR` | GHCR 模板 | — |
| `BASELINE_SOURCE` | `ghcr` | — |
| `TCB_ENV_ID` | TCB 环境 ID | — |
| `TCR_REGISTRY` | `ccr.ccs.tencentyun.com` | — |

## 认证方式

- 首次用户：自动开通 CCR 账号 + 命名空间 `open-managed-agent`
- 已注册用户：.env 填账密
- 企业版：需 CAM 授权，填 tcr-xxx
