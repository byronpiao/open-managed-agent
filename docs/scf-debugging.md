# SCF Agent 部署调试交接文档

**状态**：SCF 部署路径大部分已通，卡在最后一个 bug：模型调用成功但 kernel 的 AsyncIterable 输出为空。

---

## 背景

本项目使用 `@cloudbase/open-agent-kernel`（简称 kernel）驱动 AI Agent。运行时 (`packages/agent-runtime`) 可以部署为：
- **TCBR 云托管**（已完全验证，生产可用）
- **SCF 云函数**（大部分通了，剩最后一个 kernel 级别的 bug）

---

## 已解决的问题（不需要再碰）

### 1. SCF 不能以 root 运行 claude binary
**症状**：`Claude Code process exited with code 1 — cannot use --dangerously-skip-permissions as root`  
**修复**：`src/uid-shim.mjs` + `scf_bootstrap`。SCF 启动时通过 `--import uid-shim.mjs` 在所有模块加载前调用 `process.setuid(1001)`，让 claude 子进程以非 root 身份运行。  
**验证**：日志可见 `uid=1001`，无 exit code 1 报错。

### 2. kernel package.json exports 指向 TypeScript 源码
**症状**：`TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`  
**根因**：`vendor/cloudbase-open-agent-kernel-0.1.0-alpha.0.tgz` 的 `package.json` 里 `exports['.'].import` 指向 `./src/index.ts`（TypeScript 源），而 Node ESM 下 `exports` 优先于 `main`。  
**修复**：在 `magent.mjs` 的部署打包阶段（`agent:create`）自动 patch 这个 field，改为 `./dist/index.js`。  
**代码**：`magent.mjs` 约 987 行，`kernelPkgPath` 相关逻辑。

### 3. SCF gateway 丢弃中间 SSE 事件
**症状**：`session/prompt` 的 SSE 响应只有最后一个 `data: {result}` + `data: [DONE]`，之间的 `session/update` 事件全丢了。  
**根因**：SCF web function gateway 只把 `res.end()` 的内容发给客户端，`res.write()` 的内容被 buffer 但最终只返回 `res.end()` 的部分。  
**修复**：`makeSseSink()` 改为把所有帧收集到 `frames[]` 数组，`sseDone()` 通过 `sse.getAll()` 一次性写入 `res.end()`。  
**代码**：`kernel-adapter.ts:makeSseSink()` 和 `acp-endpoint.ts:sseDone()`。

### 4. OAK_DISABLE_SANDBOX + 凭证未自动注入
**症状**：`AgsStatefulSandbox requires TCB_API_KEY`；`CloudBase credentials missing`  
**修复**：`magent.mjs` 的 `buildCloudRunEnvParam`（tcbr）和 `scfEnvMap`（scf）在无 `TCB_API_KEY` 时自动注入 `OAK_DISABLE_SANDBOX=1`，在无 `TCB_SECRET_*` 时自动从 tcb-login STS 取凭证。

### 5. agent:create 部署时 agent.yaml 污染 AGENT_CONFIG_B64
**根因**：`packages/agent-runtime/agent.yaml` 被意外提交，优先级高于 `AGENT_CONFIG_B64`，导致所有 SCF agent 加载了测试配置。  
**修复**：已从 git 删除，已加入 `.gitignore`。

---

## 剩余 Bug（本次交接的核心问题）

### 症状

```
[KernelAdapter] pumpEvents done: total=0
```

`session/prompt` 调用 `session.send(text)` 后，`for await (const e of events)` 循环**一次都没有迭代**，AsyncIterable 直接为空。结果是：SSE 响应只有 `{stopReason: "end_turn"}` 和 `[DONE]`，没有任何 `session/update` 事件（无文本输出）。

### 已确认的事实

1. **模型 API 可达**：在 SCF 内直接 fetch mimo endpoint 返回状态 200，streaming 模式有 `text_delta: 4~8` 个和 `thinking_delta: 50+ 个`。模型网络通。
2. **uid=1001**：setuid 成功，claude binary 不会因 uid==0 拒绝运行。
3. **模型 IS 被调用**：session/prompt invocation 耗时 4-6 秒，内存用量从 ~23MB 升至 ~135MB（claude binary 已加载并运行）。
4. **session 状态正常**：session/new 和 session/prompt 在同一进程（warm reuse），`sessionPool.get()` 命中缓存，session 对象有效。
5. **kernel exports 已修**：无 `.ts` 报错，kernel 以 dist/index.js 正确加载。
6. **`session.send(text)` 正常返回**：调用不报错，返回 AsyncIterable。
7. **但 `for await` 不迭代**：第一个事件（应该是 `message_delta` 或至少 `session_idle`）从未 yield 出来。

### 最有可能的原因

kernel 的 `session.send()` 是一个 async generator，内部等待 claude binary 的 stdout 数据。claude binary 调用 mimo API 产生了响应（我们确认了这一点），但数据没有通过 stdout pipe 传回 generator。

**假设路径**：

- **路径 A**：claude binary 的 stdout pipe 在 `process.setuid(1001)` 之后失效。已知：SCF 进程以 root 启动，uid-shim 在 `--import` 阶段 setuid。Pipe fd 由 kernel 在 `spawn()` 时创建，如果进程 uid 在 spawn 前后不一致可能有权限问题。但 setuid 在 `import 'index.js'` 之前运行，`spawn()` 在之后——理论上 spawn 继承 uid=1001，应该没问题。
  
- **路径 B**：`OAK_DISABLE_SANDBOX=1` 改变了 kernel 的执行路径，导致 claude binary 的 stdout 协议不同。kernel 可能在 sandbox 模式和非 sandbox 模式下使用不同的 stdin/stdout 协议与 claude binary 通信。

- **路径 C**：在 SCF 的 linux/x64 环境中，`process.setuid(1001)` 后 `/var/user/node_modules` 对 uid=1001 不可读（权限 700），导致 claude binary spawn 成功但无法读取其依赖，静默失败。需要验证 `/var/user` 的实际权限。

- **路径 D**：kernel 内部有某个条件检查 sandbox 状态，在 `OAK_DISABLE_SANDBOX=1` 时走了一条早返回路径，在 generator 第一次 yield 前就退出了。

### 复现步骤

```bash
# 1. 准备配置
cat > /tmp/scf-debug.yaml << 'EOF'
name: scf-debug
model:
  id: mimo-v2.5-pro
  apiKey: tp-sk55ibh59r6h1gu2oubb8ybumhzw8tub3u2lvhjoacu7hgzi
  apiBaseUrl: https://token-plan-sgp.xiaomimimo.com/anthropic
system: You are a helpful assistant.
EOF

# 2. 部署
cd /Users/yang/git/open-managed-agent
./magent.mjs agent:create -n scf-debug --type scf -f /tmp/scf-debug.yaml -e test-6g2rfs50c69b7fb8

# 3. 等待就绪后测试
sleep 90
./magent.mjs run -a <agent-id> -e test-6g2rfs50c69b7fb8 -m "What is 2+2?"
# 期望: "2+2=4"
# 实际: 空（end_turn 但无文本）

# 4. 检查关键日志
tcb fn log <agent-id> -e test-6g2rfs50c69b7fb8 | grep "pumpEvents"
# 会看到: [KernelAdapter] pumpEvents done: total=0
```

### 建议的调试方向

**方向 1：验证 claude binary 的 stdout 是否有数据**

在 kernel-adapter.ts 的 `runClaudeQuery`（或等效位置）上游添加 raw bytes 监控：

```typescript
// 在 kernel 的 spawn 调用附近，拦截 stdout
const proc = spawn(claudeBin, args, { ...opts });
proc.stdout.on('data', (chunk) => {
  console.error('[raw-stdout]', chunk.toString('utf8').slice(0, 200));
});
```

如果没有 `[raw-stdout]` 输出，说明 claude binary 运行了但 stdout 为空。

**方向 2：用 `acceptEdits` 替换 `bypassPermissions`**

kernel hardcodes `permissionMode: "bypassPermissions"`，这导致 claude binary 被调用时带 `--dangerously-skip-permissions`，而该 flag 在 uid==0 时会被拒绝（uid-shim 绕过了这一点），但可能在 uid==1001 的 SCF 环境有其他影响。

把 kernel 的 `bypassPermissions` 替换成 `acceptEdits`（不传 `--dangerously-skip-permissions` flag）：

```bash
# 在 uid-shim.mjs 里，在 setuid 前修改 kernel dist：
const src = readFileSync(kernelPath, 'utf8');
const patched = src.replace(/"bypassPermissions"/g, '"acceptEdits"');
writeFileSync(kernelPath, patched);
```

注意：写文件必须在 `setuid(1001)` **之前**做（root 才能写 /var/user）。

**方向 3：直接用 claude SDK 的 `query()` 绕过 kernel**

在 kernel-adapter.ts 里，不走 `agent.startSession().send()`，而是直接调用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，验证底层 SDK 是否能正常工作：

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
for await (const msg of query({
  prompt: userText,
  options: { model: 'mimo-v2.5-pro', permissionMode: 'acceptEdits', ... }
})) {
  console.error('[sdk-query]', msg.type, JSON.stringify(msg).slice(0,100));
}
```

这个测试会绕过 kernel 的 session 机制，直接测 claude binary。

---

## 相关文件

```
packages/agent-runtime/
  src/
    uid-shim.mjs         # SCF 非 root 修复（成功）
    kernel-adapter.ts    # pumpEvents + makeSseSink（SSE buffer 修复已完成）
    acp-endpoint.ts      # sseDone() 一次性 res.end()（SSE buffer 修复已完成）
    config.ts            # ModelSpec support（已完成）
    index.ts             # 启动逻辑
  scf_bootstrap          # SCF 入口 (HOME=/tmp + --import uid-shim.mjs)
  vendor/
    cloudbase-open-agent-kernel-0.1.0-alpha.0.tgz  # kernel tarball

magent.mjs               # 部署工具（agent:create/update/delete）
```

## 测试账户信息

```
tcb env: test-6g2rfs50c69b7fb8
model endpoint: https://token-plan-sgp.xiaomimimo.com/anthropic
model: mimo-v2.5-pro
apiKey: tp-sk55ibh59r6h1gu2oubb8ybumhzw8tub3u2lvhjoacu7hgzi
```

## TCBR 云托管（已可用，可作参照）

TCBR 路径完全工作，可以用来对比：

```bash
./magent.mjs agent:create -n my-agent --type tcbr -f /tmp/scf-debug.yaml -e test-6g2rfs50c69b7fb8
./magent.mjs run -a <agent-id> -e test-6g2rfs50c69b7fb8 -m "What is 2+2?"
# 正常返回: "2+2=4"
```

TCBR 的关键区别是：容器从一开始就运行为 uid=1001（Dockerfile `USER agent`），不需要 uid-shim。如果 SCF 的 uid-shim 方案有问题，可以考虑在 TCBR 方案上加更多功能，彻底放弃 SCF。
