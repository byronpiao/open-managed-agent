# magent sync-image — 同步镜像到您的容器镜像服务

将预构建的 OpenManagedAgent 和 CloudBase 沙箱镜像一键同步到您的腾讯云容器镜像服务（TCR）。

## 使用

```bash
# 零配置（首次使用）
magent sync-image

# 已有访问凭证
magent sync-image -u 100047749993 -p <密码>

# 只同步指定镜像
magent sync-image -i sandbox
magent sync-image -i sandbox,tcbr
```

首次使用自动开通个人版共享实例，已注册用户提供控制台的访问凭证即可。

## 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-u, --uin` | 腾讯云 UIN | 自动检测 |
| `-p, --password` | 访问凭证密码 | 交互询问 |
| `-i, --images` | 镜像选择 | `all` |
| `-e, --env-id` | TCB 环境 ID | 自动检测 |
| `-n, --namespace` | 命名空间 | `tcb-<UIN>` |
| `--endpoint` | 仓库地址 | `ccr.ccs.tencentyun.com` |
| `--baseline-tag` | 固定版本 | `latest` |
| `--no-save` | 不保存到 .env | — |

镜像可选值：`sandbox`（CloudBase 沙箱）、`tcbr`（云托管）、`scf`（云函数）。

## 输出

成功后打印完整 TCR 镜像地址：

```
  CloudBase 沙箱：ccr.ccs.tencentyun.com/tcb-100xxx/tcb-sandbox:tcb-sandbox-001
  OMA 云托管：   ccr.ccs.tencentyun.com/tcb-100xxx/open-managed-agent:open-managed-agent-001
  OMA 云函数：   ccr.ccs.tencentyun.com/tcb-100xxx/open-managed-agent:scf-open-managed-agent-001
```

首次自动开通时打印 UIN 和密码，提醒前往控制台修改。

## 获取访问凭证

> 仅需在控制台设置过一次即可。未使用过则无需此步骤。

1. 访问 https://console.cloud.tencent.com/tcr
2. 左侧菜单 → 访问凭证
3. 登录名即您的腾讯云 UIN，密码为自行设置的值

## 失败排查

命令会打印每个构建步骤的状态和耗时。常见问题：

| 现象 | 解决 |
|------|------|
| 提示"账号已存在，未提供密码" | 添加 `-u <UIN> -p <密码>` 参数 |
| `docker login unauthorized` | 确认 UIN 和密码与控制台一致 |
