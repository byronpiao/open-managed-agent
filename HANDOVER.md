# Skill 同步功能交接文档

---

**进展摘要**

- Managed agent skill 全链路：`agent:create` 部署时安装、`agent:sync-skills` 独立命令
- SCF 与 TCBR 双通路：拉取线上包 → 本地安装 skills → 重部署 → 包 hash 校验 → initialize 冷启动确认
- Git 整库 bundle：扫描多 skill 安装，`.install-manifest.json` 跟踪 bundle 与子 skill 映射
- 内容 hash 变更检测：`__skillHashes` / `__deployedAt` 元数据；YAML 列表变化与 hash 不一致均触发 sync
- evlog 结构化日志：`lib/managed-logging.mjs` + runtime `managed/observability/logging.ts`，覆盖 sync 编排
- 单测：8 种 source 场景、`skillsNeedSync` bundle hash、`waitForSkillPackageLive`
- 网络 E2E：`npm run test:skills-e2e`（`/tmp` 自包含 fixture，无 `~/.skills-manager-plus` 依赖）
- 云上 E2E：`npm run test:skills-cloud-e2e`（SCF + TCBR 全 schema，8 source 条目 + bundle 子 skill 校验，默认 env `lowcode-8gtybv2a87db84a3`）
- 对客文档：`docs/examples/agent.skills-sources.example.yaml`（8 种写法注释示例）、README「Skills 同步」节
- Bugbot 修复项与 evlog 埋点在工作区待提交

---

## 功能概述

实现了 `magent agent:create` 和 `agent:update` 的 skill 自动同步功能。

### 核心流程

1. **CREATE** (`agent:create -n <name> -f config.yaml`)
   - 读取 YAML 配置（包含 skills）
   - 将 `agent.yaml`（含 skills 配置）写入部署包
   - 复制 `skills/` 目录到部署包
   - 部署 SCF 函数

2. **UPDATE** (`agent:update -a <agentId> -f config.yaml`)
   - 检测 skill 变化（配置变化或文件内容变化）
   - 从线上拉取当前部署代码
   - 更新 `skills/` 目录
   - 重新部署函数代码
   - 更新环境变量

## 修改的文件

### 1. `packages/agent-runtime/src/config.ts`
- 更新 `Skill` 接口：`source` 改为可选，移除 `description`
- 重构 `resolveSkills()`：从 `skills/<name>.md` 读取（不再依赖 `source` 路径）
- 添加 `configFilePath` 跟踪，用于正确解析 skill 文件路径

### 2. `packages/agent-runtime/src/harness/deploy.ts`
- 更新 `buildSkillsManifestEnv()`：从 `skills/<name>.md` 读取

### 3. `lib/commands/agent.mjs`
- `handleAgentCreate()`：部署时写入 `agent.yaml`，复制 skills
- `handleAgentUpdate()`：检测 skill 变化，触发自动同步
- `redeployScfWithSkills()`：重新部署 SCF 函数（修复 tcb CLI 交互提示）

### 4. `lib/skills-sync.mjs`
- `syncSkillsInDir()`：处理新 `source` 语义（git:, skillhub:, 或无 source）
- `downloadDeployedCode()`：从线上拉取部署代码

### 5. `lib/tcb.mjs`
- 修复 `require()` 用法（ES modules 不支持）
- 修复 `tcb fn code download` 参数（`--force` 不支持）

### 6. `packages/agent-runtime/agent.yaml.example`
- 更新 skill 配置示例

## Skill 配置格式

```yaml
skills:
  - name: code-review
    # source 可选：git:<url> | skillhub:<name> | 省略（默认 skill add <name>）
    # source 表示安装来源，不是安装后的路径
```

## 测试状态

### ✅ 验证通过
- CREATE 流程正确部署 skills
- UPDATE 流程检测到 skill 变化
- `tcb fn code update` 交互提示问题已修复

### ⚠️ 已知问题
- Agent 更新后可能需要等待冷启动（~30s）才能使用新 skill
- 部署验证显示 skill 文件版本不匹配（可能是 SCF 代码缓存问题）

## 下一步

1. 完善 `skill add <name>` 默认安装逻辑
2. 支持 `git:` 和 `skillhub:` source 类型
3. 修复 agent 更新后运行失败的问题
4. 添加 skill 同步的集成测试

## 运行测试

```bash
# 创建带 skill 的 agent
node magent.mjs agent:create -n test-agent -f /tmp/test-agent.yaml

# 修改 skill 后更新
echo "Version 2.0" > /tmp/skills/hello-skill.md
node magent.mjs agent:update -a <agentId> -f /tmp/test-agent.yaml

# 验证部署代码
tcb fn code download -e <envId> <agentId> /tmp/verify
cat /tmp/verify/skills/hello-skill.md
```
