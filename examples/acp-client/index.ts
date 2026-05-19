/**
 * ACP Client 使用示例
 *
 * 演示完整的 ACP 会话流程：
 *   初始化 → 创建 session → 多轮对话 → 恢复历史 → 取消
 *
 * Usage:
 *   CLOUDBASE_SERVER_URL=http://localhost:3000 tsx examples/acp-client/index.ts
 */

import CloudbaseAgents from "@cloudbase/managed-agent";

const AGENT_ID  = process.env.AGENT_ID ?? "my-agent";
const BASE_URL  = process.env.CLOUDBASE_SERVER_URL ?? "http://localhost:3000";
// Agent 云函数直连（跳过 proxy server，直接访问 tcb agent 端点）
const AGENT_URL = process.env.AGENT_URL
  ?? `https://${process.env.CLOUDBASE_ENV_ID}.service.tcloudbase.com/v1/aibot/bots/${AGENT_ID}`;

// --- 方式 1：通过 AcpClient 直连 Agent 云函数 ---
// const { AcpClient } = await import("@cloudbase/managed-agent");
// const acp = new AcpClient({ baseURL: AGENT_URL });

// --- 方式 2：通过 CloudbaseAgents 主客户端（代理到 proxy server）---
const client = new CloudbaseAgents({ baseURL: BASE_URL });
const acp = client.acp;

async function main() {
  console.log("🤖 CloudBase ACP Client Demo\n");

  // ── 1. Initialize ─────────────────────────────────────────────────────────
  console.log("1. Initializing connection...");
  const initResult = await acp.initialize();
  console.log(`   Agent: ${initResult.agentInfo.name} v${initResult.agentInfo.version}`);
  console.log(`   Capabilities: loadSession=${acp.capabilities.loadSession}, sessionList=${acp.capabilities.sessionList}\n`);

  // ── 2. Create new session ─────────────────────────────────────────────────
  console.log("2. Creating session...");
  const { sessionId } = await acp.sessionNew("/workspace");
  console.log(`   Session: ${sessionId}\n`);

  // ── 3. First prompt turn ──────────────────────────────────────────────────
  console.log("3. First message:");
  process.stdout.write("   User: 用 Python 写一个快速排序，要有注释\n   Agent: ");

  for await (const event of acp.sessionPrompt(sessionId, "用 Python 写一个快速排序，要有注释")) {
    if (event.type === "chunk") {
      process.stdout.write(event.text);
    } else if (event.type === "tool_call") {
      console.log(`\n   [Tool: ${event.name} → ${event.status}]`);
    } else if (event.type === "done") {
      console.log(`\n   [stopReason: ${event.stopReason}]\n`);
    } else if (event.type === "error") {
      console.error(`\n   [Error: ${event.message}]\n`);
    }
  }

  // ── 4. Follow-up (context preserved) ────────────────────────────────────
  console.log("4. Follow-up message (context preserved):");
  process.stdout.write("   User: 现在加上单元测试\n   Agent: ");

  for await (const event of acp.sessionPrompt(sessionId, "现在加上单元测试")) {
    if (event.type === "chunk") process.stdout.write(event.text);
    if (event.type === "done")  console.log(`\n   [done]\n`);
  }

  // ── 5. List sessions ──────────────────────────────────────────────────────
  console.log("5. Session list:");
  const sessions = await acp.sessionList();
  for (const s of sessions) {
    console.log(`   ${s.sessionId}  messages=${s.messageCount}  updated=${new Date(s.updatedAt * 1000).toLocaleTimeString()}`);
  }
  console.log();

  // ── 6. Get full session detail (history) ─────────────────────────────────
  console.log("6. Session detail (last 2 messages):");
  const detail = await acp.getSession(sessionId);
  const recent = detail.messages.slice(-2);
  for (const msg of recent) {
    const preview = msg.content.slice(0, 80).replace(/\n/g, " ");
    console.log(`   [${msg.role}] ${preview}...`);
  }
  console.log();

  // ── 7. Simulate disconnect → resume session ───────────────────────────────
  console.log("7. Resuming session (simulating reconnect)...");
  const resumed = await acp.sessionResume(sessionId);
  console.log(`   Resumed: ${resumed.sessionId}\n`);

  // ── 8. Load with history replay ───────────────────────────────────────────
  console.log("8. Loading session with history replay:");
  process.stdout.write("   ");
  let replayCount = 0;
  for await (const event of acp.sessionLoad(sessionId)) {
    if (event.type === "chunk") {
      replayCount++;
      // Print summary instead of full replay
    } else if (event.type === "done") {
      console.log(`(replayed ${replayCount} chunks)\n`);
    }
  }

  // ── 9. Cancel demo ────────────────────────────────────────────────────────
  console.log("9. Cancel demo (send then immediately cancel):");
  const { sessionId: cancelSess } = await acp.sessionNew();
  setTimeout(() => {
    acp.sessionCancel(cancelSess).then(() => console.log("   Cancelled!\n"));
  }, 200);

  for await (const event of acp.sessionPrompt(cancelSess, "计算圆周率到1000位")) {
    if (event.type === "done") console.log(`   stop: ${event.stopReason}`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log("Cleaning up sessions...");
  await acp.deleteSession(sessionId);
  await acp.deleteSession(cancelSess);
  console.log("✅ Done!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
