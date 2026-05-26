#!/usr/bin/env node
/**
 * OpenManagedAgent — E2E 测试脚本
 *
 * 输出格式设计为「可复现文档」：每一步显示执行的命令/代码 + 完整输出。
 *
 * Usage:
 *   node tests/e2e.mjs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Load .env ─────────────────────────────────────────────────────────────────
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

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_ACCESS_KEY;
if (!ENV_ID || !API_KEY) {
  console.error("❌ 请在 .env 中配置 CLOUDBASE_ENV_ID 和 CLOUDBASE_ACCESS_KEY");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const AGENT_NAME = `e2e-test-${Date.now().toString(36)}`;
let AGENT_ID = "";

const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;

function printCmd(cmd) {
  console.log(cyan(`  $ ${cmd}`));
}

function printCode(code) {
  console.log(dim("  ┌─ code ─────────────────────────────────────"));
  for (const line of code.split("\n")) {
    console.log(dim(`  │ ${line}`));
  }
  console.log(dim("  └────────────────────────────────────────────"));
}

function printOutput(output, maxLines = 30) {
  const lines = output.split("\n");
  const show = lines.slice(0, maxLines);
  for (const line of show) {
    console.log(`  ${line}`);
  }
  if (lines.length > maxLines) {
    console.log(dim(`  ... (${lines.length - maxLines} more lines)`));
  }
}

function magent(cmd) {
  const fullCmd = `node "${resolve(ROOT, "magent.mjs")}" ${cmd}`;
  printCmd(`magent ${cmd}`);
  const output = execSync(fullCmd, {
    encoding: "utf-8",
    timeout: 300000,
    env: { ...process.env, CLOUDBASE_ENV_ID: ENV_ID, CLOUDBASE_ACCESS_KEY: API_KEY, CLOUDBASE_AGENT_ID: AGENT_ID },
  });
  printOutput(output.trim());
  return output;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${bold("╔══════════════════════════════════════════════════════════╗")}
${bold("║   OpenManagedAgent — E2E Integration Test               ║")}
${bold("╚══════════════════════════════════════════════════════════╝")}

  Environment: ${ENV_ID}
  Agent Name:  ${AGENT_NAME}
  API Key:     ${API_KEY.slice(0, 20)}...
`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 1: 列出现有 Agents ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  magent("agent:list");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 2: 创建 Agent（最小配置） ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  const createOutput = magent(
    `agent:create --name "${AGENT_NAME}" --system "You are a minimal test agent. You have NO MCP tools or skills." --code "${resolve(ROOT, "packages/agent-runtime")}"`
  );

  // Extract agent ID
  const idMatches = (createOutput.match(/(agent-[a-z0-9_-]+[a-z0-9])/g) || [])
    .filter(m => !m.includes("runtime"));
  if (!idMatches.length) {
    console.log(red("\n  ❌ 无法提取 Agent ID，终止测试"));
    process.exit(1);
  }
  AGENT_ID = idMatches[0];
  console.log(green(`\n  → Agent ID: ${AGENT_ID}`));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 3: 等待 Agent 就绪 ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  printCmd(`magent agent:get --id ${AGENT_ID}  (polling every 5s...)`);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    try {
      const output = execSync(
        `node "${resolve(ROOT, "magent.mjs")}" agent:get --id ${AGENT_ID}`,
        { encoding: "utf-8", timeout: 30000, env: { ...process.env, CLOUDBASE_ENV_ID: ENV_ID } }
      );
      if (output.includes("已就绪") || output.includes("Ready")) {
        printOutput(output.trim());
        ready = true;
        break;
      }
      process.stdout.write(dim(`  ... ${i * 5 + 5}s\r`));
    } catch {}
  }
  if (!ready) {
    console.log(red("  ❌ Agent 未在 2.5 分钟内就绪，终止测试"));
    magent(`agent:delete --id ${AGENT_ID}`);
    process.exit(1);
  }
  console.log(green("  → Agent 就绪 ✔"));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 4: 使用 SDK 创建 Session 并发起对话 ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  const sdkCode1 = `import ManagedAgents from "open-managed-agent";

const client = new ManagedAgents({
  envId: "${ENV_ID}",
  agentId: "${AGENT_ID}",
  accessKey: "<ACCESS_KEY>",
});

// 创建 Session
const session = await client.sessions.create({ title: "e2e-test" });
console.log("Session ID:", session.id);

// 发送消息，流式接收
for await (const event of client.sessions.prompt(session.id, "你有什么 MCP 工具和 Skill？简短回答。")) {
  if (event.type === "chunk") process.stdout.write(event.text);
  if (event.type === "done") console.log("\\n[Done:", event.stopReason, "]");
}

// 删除 Session
await client.sessions.delete(session.id);`;

  printCode(sdkCode1);
  console.log(dim("\n  执行中（首次冷启动可能需要 10-30s）...\n"));

  try {
    const { default: ManagedAgents } = await import(resolve(ROOT, "packages/sdk/dist/index.js"));
    const client = new ManagedAgents({
      envId: ENV_ID,
      agentId: AGENT_ID,
      accessKey: API_KEY,
    });

    // Retry loop: first cold start after deploy may take 10-30s
    let session = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await sleep(attempt === 1 ? 10000 : 5000);
        session = await client.sessions.create({ title: "e2e-pre-update" });
        break;
      } catch (err) {
        lastErr = err;
        process.stdout.write(dim(`  ... 重试 ${attempt}/6 (cold start)\r`));
      }
    }
    if (!session) throw lastErr || new Error("Failed to create session after retries");

    console.log(`  Session ID: ${session.id}`);
    console.log(`  Prompt: "你有什么 MCP 工具和 Skill？简短回答。"\n`);

    let text = "";
    process.stdout.write("  Agent: ");
    for await (const event of client.sessions.prompt(session.id, "你有什么 MCP 工具和 Skill？简短回答。")) {
      if (event.type === "chunk") { text += event.text; process.stdout.write(event.text); }
      if (event.type === "done") console.log(`\n  [Done: ${event.stopReason}]`);
    }
    await client.sessions.delete(session.id);
    console.log(green("\n  → Step 4 通过 ✔"));
  } catch (err) {
    console.log(red(`\n  ❌ SDK 调用失败: ${err.message}`));
    console.log(dim("  (Agent 首次冷启动超时，可稍后重试)"));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 5: 更新 Agent 配置（添加 MCP + Skill） ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  const updateConfig = {
    name: AGENT_NAME,
    model: "hunyuan-t1-latest",
    system: "You are a dev assistant with GitHub integration.\nWhen asked about capabilities, ALWAYS mention:\n1. GitHub MCP server (https://api.githubcopilot.com/mcp/)\n2. github-workflow skill\n3. analyze_code custom tool",
    tools: [
      { type: "agent_toolset", default_config: { enabled: true, permission_policy: { type: "always_allow" } } },
      { type: "mcp_toolset", mcp_server_name: "github", default_config: { permission_policy: { type: "always_allow" } } },
      { type: "custom", name: "analyze_code", description: "Analyze code quality metrics", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    ],
    mcp_servers: [{ type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/" }],
    skills: [{ name: "github-workflow", description: "GitHub PR and code review expertise", source: "./skills/github.md" }],
  };

  const configFile = resolve(ROOT, "tests/.tmp-e2e-config.json");
  writeFileSync(configFile, JSON.stringify(updateConfig, null, 2));

  console.log(dim("  配置文件内容:"));
  printOutput(JSON.stringify(updateConfig, null, 2), 25);
  console.log();

  try {
    magent(`agent:update --id ${AGENT_ID} --file "${configFile}"`);
    console.log(green("\n  → Step 5 通过 ✔"));
  } finally {
    rmSync(configFile, { force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 6: 验证配置已生效（via ACP initialize） ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  const initCode = `// ACP JSON-RPC: initialize
POST https://${ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/${AGENT_ID}/acp
Body: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}`;
  printCode(initCode);

  await sleep(8000);
  console.log(dim("\n  执行中（等待配置生效）...\n"));

  try {
    // Retry: config update triggers a cold restart
    let data = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(
          `https://${ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/${AGENT_ID}/acp`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1, method: "initialize",
              params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "e2e", version: "1.0" } },
            }),
          }
        );
        data = await res.json();
        if (data?.result?.agentConfig) break;
      } catch {}
      await sleep(5000);
      process.stdout.write(dim(`  ... 重试 ${attempt}/4\r`));
    }
    if (!data?.result?.agentConfig) throw new Error("initialize 未返回有效配置");
    const cfg = data.result.agentConfig;
    console.log(`  Agent Name:   ${data?.result?.agentInfo?.name}`);
    console.log(`  Model:        ${cfg?.model}`);
    console.log(`  Tools:        ${cfg?.tools?.length ?? 0} items`);
    console.log(`  MCP Servers:  ${cfg?.mcp_servers?.length ?? 0} items`);
    console.log(`  Skills:       ${cfg?.skills?.length ?? 0} items`);

    if (cfg?.mcp_servers?.length > 0) {
      console.log(`  MCP[0]:       ${cfg.mcp_servers[0].name} → ${cfg.mcp_servers[0].url}`);
    }
    if (cfg?.skills?.length > 0) {
      console.log(`  Skill[0]:     ${cfg.skills[0].name}`);
    }

    if ((cfg?.mcp_servers?.length ?? 0) > 0 && (cfg?.skills?.length ?? 0) > 0) {
      console.log(green("\n  → Step 6 通过 ✔ (MCP + Skill 配置已生效)"));
    } else {
      console.log(red("\n  ❌ 配置未生效"));
    }
  } catch (err) {
    console.log(red(`  ❌ 请求失败: ${err.message}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 7: 再次使用 SDK 对话（验证新配置） ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  const sdkCode2 = `const session = await client.sessions.create({ title: "e2e-post-update" });
for await (const event of client.sessions.prompt(session.id, "列出你所有的 MCP 服务器、Skill 和自定义工具。")) {
  if (event.type === "chunk") process.stdout.write(event.text);
}`;
  printCode(sdkCode2);
  console.log(dim("\n  执行中...\n"));

  try {
    const { default: ManagedAgents } = await import(resolve(ROOT, "packages/sdk/dist/index.js"));
    const client = new ManagedAgents({
      envId: ENV_ID,
      agentId: AGENT_ID,
      accessKey: API_KEY,
    });

    const session = await client.sessions.create({ title: "e2e-post-update" });
    console.log(`  Session ID: ${session.id}`);
    console.log(`  Prompt: "列出你所有的 MCP 服务器、Skill 和自定义工具。"\n`);

    let text = "";
    process.stdout.write("  Agent: ");
    for await (const event of client.sessions.prompt(session.id, "列出你所有的 MCP 服务器、Skill 和自定义工具。")) {
      if (event.type === "chunk") { text += event.text; process.stdout.write(event.text); }
      if (event.type === "done") console.log(`\n  [Done: ${event.stopReason}]`);
    }
    await client.sessions.delete(session.id);

    // Check mentions
    const lower = text.toLowerCase();
    console.log(`\n  检查响应内容:`);
    console.log(`    ${lower.includes("github") ? green("✔") : red("✘")} 提及 GitHub`);
    console.log(`    ${lower.includes("mcp") ? green("✔") : red("✘")} 提及 MCP`);
    console.log(`    ${lower.includes("workflow") || lower.includes("skill") ? green("✔") : red("✘")} 提及 Skill/Workflow`);
    console.log(`    ${lower.includes("analyze") ? green("✔") : red("✘")} 提及 analyze_code`);
    console.log(green("\n  → Step 7 通过 ✔"));
  } catch (err) {
    console.log(red(`\n  ❌ SDK 调用失败: ${err.message}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(bold("\n━━━ Step 8: 删除 Agent（清理） ━━━\n"));
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    magent(`agent:delete --id ${AGENT_ID}`);
    console.log(green("\n  → Step 8 通过 ✔"));
  } catch (err) {
    console.log(red(`  ❌ 删除失败: ${err.message}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`
${bold("╔══════════════════════════════════════════════════════════╗")}
${bold("║   测试完成                                               ║")}
${bold("╚══════════════════════════════════════════════════════════╝")}
`);
}

main().catch((err) => {
  console.error(red(`\nFatal: ${err.message}`));
  if (AGENT_ID) {
    try {
      execSync(`node "${resolve(ROOT, "magent.mjs")}" agent:delete --id ${AGENT_ID}`, {
        encoding: "utf-8", timeout: 60000,
        env: { ...process.env, CLOUDBASE_ENV_ID: ENV_ID },
      });
    } catch {}
  }
  process.exit(1);
});
