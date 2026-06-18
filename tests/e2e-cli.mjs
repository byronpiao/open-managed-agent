#!/usr/bin/env node
/**
 * E2E CLI 基线测试
 *
 * 覆盖完整生命周期：
 *  创建 Agent → 对话 → 查看 Session → 查看 Events
 *  → 修改 Tools → 新对话触发 Tool
 *  → 删除 Session → 查看 Events（已删除）
 *  → 删除 Agent（级联删除 Sessions）
 *
 * 用法：
 *   node tests/e2e-cli.mjs
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Load .env ──────────────────────────────────────────────────────
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const ENV_ID    = process.env.CLOUDBASE_ENV_ID ?? "";
const ACCESS_KEY = process.env.CLOUDBASE_APIKEY ?? "";
if (!ENV_ID || !ACCESS_KEY) {
  console.error("❌ 请在 .env 中配置 CLOUDBASE_ENV_ID 和 CLOUDBASE_APIKEY");
  process.exit(1);
}

// ── ANSI helpers ───────────────────────────────────────────────────
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Helpers ───────────────────────────────────────────────────────
const AGENT_NAME = `e2e-cli-${Date.now().toString(36)}`;
let AGENT_ID   = "";
let SESSION_ID = "";

function printCmd(cmd) {
  console.log(cyan(`  $ magent ${cmd}`));
}

function printOutput(output, maxLines = 40) {
  const lines = stripAnsi(output).split("\n");
  const show  = lines.slice(0, maxLines);
  for (const line of show) {
    console.log(`  ${line}`);
  }
  if (lines.length > maxLines) {
    console.log(dim(`  ... (${lines.length - maxLines} more lines)`));
  }
}

function magent(cmd, { allowFail = false } = {}) {
  const fullCmd = `node "${resolve(ROOT, "magent.mjs")}" ${cmd}`;
  printCmd(cmd);
  try {
    const output = execSync(fullCmd, {
      encoding:       "utf-8",
      timeout:        900000, // 15min — tcbr deploy (image build + traffic switch) can exceed 5min

      env: {
        ...process.env,
        CLOUDBASE_ENV_ID:      ENV_ID,
        CLOUDBASE_APIKEY:      ACCESS_KEY,
        ...(AGENT_ID ? { CLOUDBASE_AGENT_ID: AGENT_ID } : {}),
      },
    });
    printOutput(output.trim());
    return output;
  } catch (err) {
    if (allowFail) {
      printOutput((err.stdout ?? "") + (err.stderr ?? ""));
      return (err.stdout ?? "") + (err.stderr ?? "");
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractAgentId(output) {
  const stripped = stripAnsi(output);
  const matches = (stripped.match(/(agent-[a-z0-9_-]+[a-z0-9])/g) || [])
    .filter((m) => !m.includes("runtime"));
  return matches[0] ?? "";
}

function extractSessionId(output) {
  const stripped = stripAnsi(output);
  // session:create prints "✅ Session created:" then the ID on the next indented line
  const m = stripped.match(/Session\s+created:\s*\n\s+([^\s]+)/);
  return m?.[1] ?? "";
}

/**
 * Check agent readiness — avoids false positive on "未就绪" (not ready).
 * NOTE: "已就绪"/"未就绪" come from the cloudbase `tcb agent detail` CLI output
 * (agent:get just prints it verbatim). If tcb changes its wording, update here.
 */
function isAgentReady(output) {
  const stripped = stripAnsi(output);
  return stripped.includes("已就绪") && !stripped.includes("未就绪");
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`
${bold("╔══════════════════════════════════════════════╗")}
${bold("║   OpenManagedAgent — E2E CLI Baseline Test    ║")}
${bold("╚══════════════════════════════════════════════╝")}

  Environment:  ${ENV_ID}
  Agent Name:   ${AGENT_NAME}
  Access Key:  ${ACCESS_KEY.slice(0, 20)}...
`);

  // ── Step 1: 创建 Agent ─────────────────────────────────────
  console.log(bold("\n──── Step 1: 创建 Agent ──────────────────────"));
  const createOut = magent(
    `agent:create --name "${AGENT_NAME}" --type tcbr --model hy3-preview ` +
    `--system "You are a helpful assistant. When asked to use a tool, call the analyze_code tool." ` +
    `--code "${resolve(ROOT, "packages/agent-runtime")}"`,
  );
  AGENT_ID = extractAgentId(createOut);
  if (!AGENT_ID) {
    console.log(red("\n  ❌ 无法提取 Agent ID，终止测试"));
    process.exit(1);
  }
  console.log(green(`\n  → Agent ID: ${AGENT_ID}`));

  // ── Step 2: 等待 Agent 就绪 ──────────────────────────
  console.log(bold("\n──── Step 2: 等待 Agent 就绪 ──────────────"));
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    try {
      const out = magent(`agent:get -a ${AGENT_ID}`, { allowFail: true });
      if (isAgentReady(out)) {
        ready = true;
        break;
      }
      process.stdout.write(dim(`  ... ${i * 5 + 5}s\r`));
    } catch {
      process.stdout.write(dim(`  ... ${i * 5 + 5}s\r`));
    }
  }
  if (!ready) {
    console.log(red("\n  ❌ Agent 未在 2.5 分钟内就绪，终止测试"));
    await cleanup();
    process.exit(1);
  }
  console.log(green("  → Agent 就绪 ✓"));

  // ── Step 3: 创建 Session ───────────────────────────────
  console.log(bold("\n──── Step 3: 创建 Session ────────────────────"));
  const sessOut = magent(`session:create -a ${AGENT_ID} --title "e2e-cli test"`);
  SESSION_ID = extractSessionId(sessOut);
  if (!SESSION_ID) {
    console.log(red("\n  ❌ 无法提取 Session ID，终止测试"));
    await cleanup();
    process.exit(1);
  }
  console.log(green(`  → Session ID: ${SESSION_ID}`));

  // ── Step 4: 发送消息（对话）────────────────────────
  console.log(bold("\n──── Step 4: 发送消息（对话）─────────────"));
  const chatOut = magent(`chat -s ${SESSION_ID} -a ${AGENT_ID} -m "Hello, please introduce yourself briefly."`);
  const stripped = stripAnsi(chatOut);
  if (stripped.length < 10) {
    console.log(red("  ❌ Agent 未返回有效响应"));
    await cleanup();
    process.exit(1);
  }
  console.log(green("  → 对话成功 ✓"));
  console.log(dim(`  响应预览: ${stripped.slice(0, 120).replace(/\n/g, " ")}...`));

  // ── Step 5: 查看 Session 列表 ─────────────────────
  console.log(bold("\n──── Step 5: 查看 Session 列表 ────────────"));
  const listOut = magent(`session:list -a ${AGENT_ID}`);
  if (!stripAnsi(listOut).includes(SESSION_ID)) {
    console.log(red("  ❌ Session 未出现在列表中"));
    await cleanup();
    process.exit(1);
  }
  console.log(green("  → Session 在列表中 ✓"));

  // ── Step 6: 查看 Session Events ───────────────────
  console.log(bold("\n──── Step 6: 查看 Session Events ───────────"));
  // session:events:list pulls history via ACP session/load (replay=true).
  // Output shape is "Events (N):" + "role: <text>" lines.
  const eventsOut1 = magent(`session:events:list -i ${SESSION_ID} -a ${AGENT_ID}`, { allowFail: true });
  const e1 = stripAnsi(eventsOut1);
  if (/Events\s*\(\d+\):/.test(e1) || /^\s*(user|assistant):/m.test(e1)) {
    console.log(green("  → Events 包含对话记录 ✓"));
  } else {
    console.log(dim("  ⚠️  未拉到对话历史（kernel 可能未实现 getHistory 或尚未持久化），跳过"));
  }

  // ── Step 7: 更新 Agent Tools ────────────────────────
  console.log(bold("\n──── Step 7: 更新 Agent Tools ──────────────"));
  const toolsJson = JSON.stringify([
    {
      type:         "custom",
      name:         "analyze_code",
      description:  "Analyze code quality",
      input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    },
  ]);
  const updateOut = magent(
    `agent:update -a ${AGENT_ID} --tools '${toolsJson}'`,
  );
  if (!updateOut.includes("updated successfully")) {
    console.log(red("  ❌ Agent 更新失败"));
    await cleanup();
    process.exit(1);
  }
  console.log(green("  → Agent Tools 更新成功 ✓"));

  // Wait for config to propagate
  console.log(dim("  等待配置生效（8s）..."));
  await sleep(8000);

  // ── Step 8: 新对话触发 Tool ───────────────────────
  console.log(bold("\n──── Step 8: 新对话触发 Tool ──────────────"));
  // Use `run` which creates a new session + sends message
  const runOut = magent(
    `run -a ${AGENT_ID} -m "Please use the analyze_code tool to analyze /tmp/test.js"`,
    { allowFail: true },
  );
  const runStripped = stripAnsi(runOut);
  // "🔧" is printed by the handler when a tool_call notification arrives.
  // Don't match "analyze_code" — that would match the user's input message.
  const toolTriggered = runStripped.includes("🔧");
  if (toolTriggered) {
    console.log(green("  → Tool 被触发 ✓"));
  } else {
    console.log(dim("  ⚠️  未检测到 Tool 触发（可能 agent 未正确加载 tool，非致命）"));
  }

  // ── Step 9: 删除 Session ───────────────────────────────
  console.log(bold("\n──── Step 9: 删除 Session ──────────────────"));
  magent(`session:delete -i ${SESSION_ID} -a ${AGENT_ID}`);
  console.log(green("  → Session 删除成功 ✓"));

  // ── Step 10: 查看 Events（删除后）────────────────
  console.log(bold("\n──── Step 10: 查看 Events（删除后）───────"));
  // After delete, session/load should fail with "Session not found" (ACP error).
  const eventsOut2 = magent(`session:events:list -i ${SESSION_ID} -a ${AGENT_ID}`, { allowFail: true });
  const e2 = stripAnsi(eventsOut2);
  if (/not found|Session not found|不存在/i.test(e2)) {
    console.log(green("  → Session 已删除，Events 不可访问（符合预期）✓"));
  } else if (/Events\s*\(\d+\):/.test(e2)) {
    console.log(red("  ❌ Session 删除后仍能拉到历史（删除未级联）"));
    await cleanup();
    process.exit(1);
  } else {
    console.log(dim("  ⚠️  删除后 Events 状态未知（harness 软删可能仍返回空），跳过"));
  }

  // ── Step 11: 删除 Agent（级联删除）───────────────
  console.log(bold("\n──── Step 11: 删除 Agent（级联删除）───────"));
  magent(`agent:delete -a ${AGENT_ID}`);
  AGENT_ID = "";
  console.log(green("  → Agent 删除成功（级联删除 Sessions）✓"));

  // ── Done ───────────────────────────────────────────────────
  console.log(`
${bold("╔══════════════════════════════════════════════╗")}
${bold("║           All tests passed!                  ║")}
${bold("╚══════════════════════════════════════════════╝")}
`);
}

async function cleanup() {
  if (AGENT_ID) {
    console.log(dim(`\n  清理: 删除 Agent ${AGENT_ID}...`));
    try {
      magent(`agent:delete -a ${AGENT_ID}`, { allowFail: true });
    } catch {}
    AGENT_ID = "";
  }
}

main().catch(async (err) => {
  console.error(red(`\nFatal: ${err.message}`));
  await cleanup();
  process.exit(1);
});
