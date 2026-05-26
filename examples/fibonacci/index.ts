/**
 * OpenManagedAgent - Fibonacci Example
 *
 * 客户端直连 Agent 云函数（无需 proxy server），
 * 通过 sessions.prompt() 流式获取结果。
 *
 * Usage:
 *   AGENT_URL=https://<env>.service.tcloudbase.com/v1/aibot/bots/<agentId> \
 *   tsx examples/fibonacci/index.ts
 */

import ManagedAgents from "open-managed-agent-sdk";

// 直连 Agent 云函数，无需经过 proxy server
const client = new ManagedAgents({
  baseURL: process.env.AGENT_URL
    ?? `https://${process.env.CLOUDBASE_ENV_ID}.service.tcloudbase.com/v1/aibot/bots/${process.env.AGENT_ID ?? "my-agent"}`,
});

async function main() {
  console.log("🚀 OpenManagedAgent - Fibonacci Example\n");

  // 1. 创建 session
  console.log("1. Creating session...");
  const session = await client.sessions.create({ title: "Fibonacci Task" });
  console.log(`   ✅ Session: ${session.id}\n`);

  // 2. 发送任务，流式获取结果
  console.log("2. Sending task...\n");
  console.log("═".repeat(60));

  for await (const event of client.sessions.prompt(
    session.id,
    "Write a fibonacci function in Python. Compute fib(10) and fib(20). Show results."
  )) {
    switch (event.type) {
      case "chunk":
        process.stdout.write(event.text);
        break;
      case "tool_call":
        if (event.status === "pending") {
          console.log(`\n🔧 Tool: ${event.name}`);
        } else if (event.status === "completed") {
          console.log(`   ✓ ${String(event.result ?? "").slice(0, 100)}`);
        }
        break;
      case "error":
        console.error(`\n❌ Error: ${event.message}`);
        break;
      case "done":
        console.log(`\n${"═".repeat(60)}`);
        console.log(`✅ Done (${event.stopReason})\n`);
        break;
    }
  }

  // 3. 多轮对话（上下文自动保留）
  console.log("3. Follow-up (context preserved)...\n");
  console.log("═".repeat(60));

  for await (const event of client.sessions.prompt(
    session.id,
    "Now add memoization to make it faster."
  )) {
    if (event.type === "chunk") process.stdout.write(event.text);
    if (event.type === "done")  console.log(`\n${"═".repeat(60)}\n`);
  }

  // 4. 查看历史
  const history = await client.sessions.history(session.id);
  console.log(`4. Session history: ${history.messages.length} messages total`);

  // 5. Cleanup
  await client.sessions.delete(session.id);
  console.log("✨ Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
