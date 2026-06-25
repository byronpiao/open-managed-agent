# OMA Agent Runtime — 同步到您的 TCR

无需任何配置即可使用。

## 使用

```bash
cd cloudapp

# 1. 查看环境 ID
tcb env list

# 2. 执行
tcb login && tcb env use <环境ID>
./sync.sh
```

约 3 分钟后打印镜像地址：
```
ccr.ccs.tencentyun.com/open-managed-agent/oma-agent-runtime:oma-agent-runtime-001
```

## 自定义

```bash
cp .env.example .env
```

| 字段 | 说明 |
|------|------|
| `TCR_NAMESPACE` | 留空则自动创建 `open-managed-agent` |
| `TCR_USERNAME` | 留空自动开通 |
| `TCR_PASSWORD` | 已注册用户填写 |
| `TCR_IMAGE_NAME` | 默认 `oma-agent-runtime` |

## 企业版（需要 CAM 授权）

```ini
TCR_MODE=enterprise
TCR_INSTANCE_ID=tcr-xxxxxxxx
TCR_REGION=ap-shanghai
```
