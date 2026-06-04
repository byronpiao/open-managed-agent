# SCF Agent 部署调试交接文档

**状态**(2026-06-03 最终):**TCBR 容器部署 ✅ 完整工作**，包括 MCP tool calling。
SCF zip 模式部署因 diag patch 导致 `pumpEvents done: total=0`，**推荐生产用 TCBR**。

> **更新**: diag patch 已移除（2026-06-03），SCF zip 模式理论上应恢复正常。

### 今日验证结果 (2026-06-03)

- ✅ **TCBR 容器部署**：事件流正常，模型响应正常转发
- ✅ **MCP 配置部署**：`mcp_servers` + `mcp_toolset` 通过 `agent.yaml` → `AGENT_CONFIG_B64` → `initialize` 全链路流通
- ✅ **MCP tool calling**：模型发现并调用 `mcp__test-mcp__get_time`，结果正确返回
- ⚠️ **SCF zip 模式**：diag patch 已移除，待重新验证
- ⚠️ **TCBR 流量切换**：`agent:update` 对 TCBR agent 的 `SubmitServerConfigChangeDiff` 提交成功，但 `waitForConfigLive` 超时（旧 pod 持续服务）

### Kernel vendored 修改

vendor tgz 相比 npm 版本有**一处功能性修改**（已同步到上游源码）：

```typescript
// 文件: src/public/create-agent.ts → aggregateHistory()
// npm 版本只检测 __OAK_INTERRUPT__
// vendor 版本额外检测 __OAK_CLIENT_TOOL__（client-side tool sentinel）
const isSentinel = msg.parts.some(
  (p) => p.type === 'tool_result' && typeof p.output === 'string' &&
    ((p.output as string).includes('__OAK_INTERRUPT__') ||
     (p.output as string).includes('__OAK_CLIENT_TOOL__')),
)
```

上游仓库 (`coding-agent-template/packages/open-agent-kernel`) 已包含此修复，但 npm 包未发新版。

## 推荐方案:SCF 镜像模式

```bash
# 一次性准备:在 mac arm64 上准备 amd64 docker (SCF 要求 linux/amd64)
brew install qemu lima-additional-guestagents
# Lima 安装后把 x86 guest agent 复制到 lima share 里:
cp /opt/homebrew/Cellar/lima-additional-guestagents/*/share/lima/lima-guestagent.Linux-x86_64* \
   /opt/homebrew/Cellar/lima/*/share/lima/
colima delete --force; colima start --arch x86_64 --cpu 4 --memory 4

# 一次性:登录 Tencent Container Registry
docker login ccr.ccs.tencentyun.com

# 部署
CCR_NAMESPACE=<your-ccr-namespace> \
./magent.mjs agent:create --type scf-image -n my-agent \
  -f /path/to/agent.yaml -e <envId>
```

`agent:create --type scf-image` 流程:
1. `docker build --platform linux/amd64 -f Dockerfile.scf -t <imageUri> .`
2. `docker push <imageUri>`(到 `ccr.ccs.tencentyun.com/<namespace>/<slug>:<ts>`)
3. `tcb fn deploy --httpFn --deployMode image`(SCF web fn,timeout 900s,memorySize 512MB)
4. `tcb service create -p /<fn> -f <fn>` 暴露 HTTPS 路径

部署完成后,函数监听 `https://<envId>.ap-shanghai.app.tcloudbase.com/<fn>/acp`,直接走
ACP JSON-RPC 协议(没经过 agent gateway,所以也不需要 SCF gateway 的 SSE buffer fix
那一套)。已验证 `What is 2+2?` 返回 `2 + 2 = **4**`。

镜像本身(`packages/agent-runtime/Dockerfile.scf`)在 build 阶段就解决三层问题:
- **Layer 1**:`npm install --os=linux --cpu=x64 --include=optional --force` 跑两遍,
  build 阶段 `RUN test -x .../claude-agent-sdk-linux-x64/claude` fail-fast 验证 binary
  确实下载了
- **Layer 2**:`mkdir -p /tmp/.claude && chown agent:agent`,然后 `USER agent`,容器
  从启动那一刻就以 uid=1001 跑,不依赖任何 setuid 或运行时 chown
- **Layer 3**:镜像 ENV 设 `CLAUDE_CONFIG_DIR=/tmp/.claude OAK_SESSION_LOCAL_DIR=/tmp/.claude`,
  binary 直接拿到的就是可写路径

---

## zip-mode SCF 的三层 bug 链(已定位,部分已修)

(以下是历史调试记录,zip-mode 部署仍有 Layer 3 bug 未解)

### Layer 1 — linux-x64 native binary 没装上(✅ 已修)
`magent.mjs` 部署时 `npm install` 在 monorepo 内会看到 host-platform 的
`@anthropic-ai/claude-agent-sdk-darwin-arm64` 已 hoist,silent 跳过 linux-x64。SDK 在
SCF 上抛 `Native CLI binary for linux-x64 not found`,kernel async generator 在
**首次 yield 前** throw,被 generator 协议吞掉,客户端只看到空 SSE。

**修复**:`magent.mjs` 部署 staging 改到 `/tmp/magent-scf-...-${ts}`(脱离 monorepo
hoisting);跑两遍 `npm install` 中间删 `node_modules/.package-lock.json`,第二遍带
`--os=linux --cpu=x64 --include=optional --force` 让 npm 重 resolve missing optionals;
部署前 fail-fast 验证 `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`
存在。

### Layer 2 — `/tmp` 在 SCF 不可写,binary 无声 exit 0(✅ 已修)
SCF 容器的 `/tmp` 是 `root:root mode 0755` 而不是普通 Linux 的 `1777` sticky-bit。
uid-shim 的 `chown -R agent:agent /tmp` 不能 chown mount 根。kernel 的
`getSessionLocalDir()` 默认返回 `/tmp`,作为 `CLAUDE_CONFIG_DIR` 传给 binary;binary
启动后试图在 `/tmp/<session>.jsonl` 写 session-mirror 文件,**Permission denied,exit
code 0,no stdout**(SDK iterator 看到 stdout EOF + exit 0 → 直接 yield done,0 sdkMsg)。

**修复**:
1. `scf_bootstrap` 在 root 阶段创建 `/tmp/.claude` 等目录并 `chown -R 1001:1001`(SCF
   设计上 mount 根不能 chown,但子目录能);
2. `magent.mjs` 在 SCF env 注入 `OAK_SESSION_LOCAL_DIR=/tmp/.claude`,让 kernel 不再
   把默认 `/tmp` 传给 binary。

### Layer 3 — binary 完成 setup 后 hang 14 秒不响应(❌ 未解决)
`/tmp/.claude` 可写后,binary debug log 显示:
```
2026-06-03T06:32:04.786Z [DEBUG] MDM settings load completed
... 写 .claude.json 4 次 ...
2026-06-03T06:32:05.100Z [DEBUG] [ToolSearch:optimistic] disabled (proxy host)
2026-06-03T06:32:05.195Z [DEBUG] [STARTUP] Loading MCP configs...
2026-06-03T06:32:05.196Z [DEBUG] [STARTUP] Running setup()...
2026-06-03T06:32:05.899Z [DEBUG] Git remote URL: null
2026-06-03T06:32:05.899Z [DEBUG] No git remote URL found
                                  ↑ 这之后 14 秒不再写 debug log
```
然后 binary `exit 0`,**stdout 完全空**。SDK iterator 看到 stdout EOF + exit 0 →
yield done。15 秒 wallclock + 137MB memory 增量说明 binary 真的在做某件事(可能在等
Anthropic API 而 mimo 代理 endpoint 在 binary 内部某个握手不通),但 *不* 写 debug
log,*不* 写 stdout。

**已排除**:模型 API 不可达(我们直接 `fetch` mimo endpoint 拿到 stream,200);
binary 缺失(已修);CLAUDE_CONFIG_DIR 不可写(已修);uid 问题(uid=1001 OK);kernel
generator 路径(同样代码 TCBR 工作);SDK 没启动(stdin trace 显示 SDK 写了 230 字节
control_request initialize + user message 给 binary)。

**下一步建议**:
- 在 binary 的 streaming-input 协议层下手:binary 收到 SDK 的
  `{"type":"control_request","subtype":"initialize",...}` 后应该回写一个
  `control_response` 在 stdout。它没回。可能 binary 的 control thread 在等什么 —
  比如 first model API call 完成才回 init ack。
- 在 SDK 层:试试 `sdkOptions.maxThinkingTokens=0` 关闭 thinking,或者试
  `permissionMode='acceptEdits'` 不传 `--dangerously-skip-permissions`(虽然 uid=1001
  本应不影响)。
- 比较 TCBR 容器和 SCF 容器的差异:Linux kernel 版本、CA cert path、proxy 配置、
  network DNS 解析、`/etc/resolv.conf`。binary 在 mimo 代理上能否实际握手 streaming
  连接。
- 如果 mimo 是 SSE/HTTP/2 streaming,binary 可能在 SCF 容器里因为 outbound HTTP/2
  不通走 fallback 路径而 hang。

## 已合入的修复(本次)

```
magent.mjs                           | 154 +++++++++++++++++++++++---
packages/agent-runtime/scf_bootstrap |  18 +++-
```

- `magent.mjs`:
  - `deployDir` 改 `/tmp/magent-scf-${name}-${ts}`(脱离 monorepo hoisting)
  - 两遍 `npm install` + 中间删 `.package-lock.json`,第二遍 `--os=linux --cpu=x64
    --include=optional --force` 让 missing optional 平台包真的装上
  - 部署前 fail-fast 验证 `claude-agent-sdk-linux-x64/claude` 文件存在
  - SCF env 注入 `OAK_SESSION_LOCAL_DIR=/tmp/.claude`(避开不可写的 `/tmp` 根)
- `packages/agent-runtime/scf_bootstrap`:`mkdir -p /tmp/.claude /tmp/workspace
  /tmp/claude-cache && chown -R 1001:1001 ...`(SCF 容器 `/tmp` 是
  `root:root 0755`,uid=1001 不能写;只能在 root 阶段创建子目录并 chown)



---

## 背景

本项目使用 `@cloudbase/open-agent-kernel`（简称 kernel）驱动 AI Agent。运行时 (`packages/agent-runtime`) 可以部署为：
- **TCBR 云托管**（已完全验证，生产可用）
- **SCF 云函数**（大部分通了，剩最后一个 kernel 级别的 bug）

---

## 已解决的问题（不需要再碰）

### 0. linux-x64 native binary 在 deploy 时被 silent 跳过(2026-06-03)
**症状**:SCF 调用模型时 kernel async generator 第一次 yield 之前 throw
`Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk
without --omit=optional, or set options.pathToClaudeCodeExecutable.`
错误被 generator 吞掉,只看到 `pumpEvents done: total=0` 和空响应。
**根因**:`magent.mjs` 的 deploy 逻辑里:
1. staging 目录 `${code}/.deploy` 在 monorepo 内,父级 `node_modules` 已 hoist 了
   host-platform 的 `claude-agent-sdk-darwin-arm64`,npm 看到 optionalDependencies 中
   "已经满足了一个" 就跳过其他 platform 包(包括 linux-x64)。
2. `npm install --no-save --force --silent @anthropic-ai/claude-agent-sdk-linux-x64@VER`
   不带 `--os=linux --cpu=x64`,在 macOS host 下 npm v11 直接 no-op (silent "up to date")。
3. 第一遍 `npm install` 走 lockfile fast-path,即便加 `--os/--cpu` 也不重 resolve。
**修复**(已合入,见 `magent.mjs:954-1005`):
- staging 目录改为 `/tmp/magent-scf-...-${ts}`(脱离 monorepo)
- 两遍 install:第一遍正常装,然后 `rm node_modules/.package-lock.json`,第二遍带
  `--os=linux --cpu=x64 --include=optional --force` 让 npm 重 resolve 漏掉的 optionals
- 部署后用 `existsSync(node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude)`
  做 fail-fast 验证

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

## SCF zip 模式的 pumpEvents total=0 问题（根因已定位）

### 症状

```
[KernelAdapter] pumpEvents done: total=0
```

`session/prompt` 调用 `session.send(text)` 后，`for await (const e of events)` 循环**一次都没有迭代**，AsyncIterable 直接为空。结果是：SSE 响应只有 `{stopReason: "end_turn"}` 和 `[DONE]`，没有任何 `session/update` 事件（无文本输出）。

### 根因（2026-06-03 定位）

`magent.mjs` 的 SCF 代码包部署路径会打两处 diag patch：

1. **kernel dist patch**：在 `claudeQuery()` 调用前后注入诊断日志，修改了 `for await` 循环结构
2. **claude binary wrapper**：用 preflight wrapper 替换了实际的 claude binary

这些 patch 破坏了 SDK 的事件流管道。TCBR 容器部署走 Dockerfile 构建，**不经过这些 patch**，事件流完全正常。

**解决方案**：diag patch 已移除（2026-06-03），SCF zip 模式理论上应恢复正常，待重新验证。

### 已确认的事实

1. **模型 API 可达**：在 SCF 内直接 fetch mimo endpoint 返回状态 200，streaming 模式有 `text_delta: 4~8` 个和 `thinking_delta: 50+ 个`。模型网络通。
2. **uid=1001**：setuid 成功，claude binary 不会因 uid==0 拒绝运行。
3. **模型 IS 被调用**：session/prompt invocation 耗时 4-6 秒，内存用量从 ~23MB 升至 ~135MB（claude binary 已加载并运行）。
4. **session 状态正常**：session/new 和 session/prompt 在同一进程（warm reuse），`sessionPool.get()` 命中缓存，session 对象有效。
5. **kernel exports 已修**：无 `.ts` 报错，kernel 以 dist/index.js 正确加载。
6. **`session.send(text)` 正常返回**：调用不报错，返回 AsyncIterable。
7. **但 `for await` 不迭代**：第一个事件（应该是 `message_delta` 或至少 `session_idle`）从未 yield 出来。
8. **TCBR 容器部署正常**：同样的 kernel + agent 代码，走 Dockerfile 构建（不打 diag patch），事件流完全正常。
9. **diag patch 是根因**：SCF 部署路径的 `[diag] kernel dist patched` + `[diag] claude binary replaced with preflight wrapper` 破坏了事件流管道。

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

### 下一步

**短期**：使用 TCBR 容器部署（`--type tcbr`），绕开 SCF zip 模式的所有问题。

**中期**：移除 `magent.mjs` 中 SCF 部署路径的 diag patch（`__SCF_DIAG_PATCHED__` 代码块），恢复正常的 kernel dist 和 claude binary。移除后 SCF zip 模式应该也能正常工作。

**长期**：考虑统一到 TCBR 容器部署，彻底放弃 SCF zip 模式。TCBR 的优势：
- 容器从启动就以 uid=1001 运行（Dockerfile `USER agent`），不需要 uid-shim
- 不经过 diag patch，事件流完全正常
- MCP tool calling 已验证通过
- 支持自定义系统依赖

---

## 相关文件

```
packages/agent-runtime/
  src/
    uid-shim.mjs         # SCF 非 root 修复
    kernel-adapter.ts    # pumpEvents + makeSseSink
    acp-endpoint.ts      # ACP JSON-RPC 处理
    config.ts            # 配置加载（agent.yaml > AGENT_CONFIG_B64 > env vars）
    index.ts             # 启动逻辑
  scf_bootstrap          # SCF 入口 (HOME=/tmp + --import uid-shim.mjs)
  Dockerfile             # TCBR 容器构建
  agent.yaml.example     # 配置模板
  vendor/
    cloudbase-open-agent-kernel-0.1.0-alpha.0.tgz  # kernel tarball（含 aggregateHistory sentinel fix）

magent.mjs               # 部署工具（agent:create/update/delete）
```
