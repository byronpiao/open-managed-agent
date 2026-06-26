# OMA Agent Runtime — 同步到您的 TCR

## 使用

```bash
cd cloudapp
tcb env list
tcb login && tcb env use <ID>
./sync.sh
```

约 3 分钟后打印 TCBR 和 SCF 两个镜像地址。

## 我已用过 CCR

如果在 [容器镜像服务控制台](https://console.cloud.tencent.com/tcr) 个人版设置过"访问凭证"：

```bash
cp .env.example .env
```

填写：
```ini
TCR_UIN=100047749993         # 你的腾讯云账号 UIN
TCR_PASSWORD=                # CCR 访问凭证密码
```

> CNB 构建运行时用的是 TCB 环境归属的主账号身份。用哪个 UIN 在 CCR 登录，就填哪个。

## 我从未用过 CCR

留空即可，系统自动开通。

## 失败排查

| 错误 | 原因 | 解决 |
|------|------|------|
| `CCR 账号已存在，未提供密码` | 用过 CCR 但没填 `.env` | 创建 `.env`，填入 UIN + 密码 |
| `docker login…unauthorized` | 密码错或 UIN 不对 | 确认 `.env` 中信息正确 |

## 企业版

需 CAM 授权。填 `TCR_MODE=enterprise` + `TCR_INSTANCE_ID=tcr-xxx` + `TCR_REGION=ap-shanghai`。
