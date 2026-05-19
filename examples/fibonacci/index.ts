/**
 * CloudBase Managed Agent - Fibonacci Example
 *
 * Mirrors the Claude quickstart example, but uses CloudBase as the backend.
 * The agent writes a fibonacci function, tests it, and returns the result.
 *
 * Usage:
 *   CLOUDBASE_SERVER_URL=http://localhost:3000 tsx examples/fibonacci/index.ts
 */

import CloudbaseAgents from "@cloudbase/managed-agent";

const client = new CloudbaseAgents({
  baseURL: process.env.CLOUDBASE_SERVER_URL ?? "http://localhost:3000",
  envId: process.env.CLOUDBASE_ENV_ID,
});

async function main() {
  console.log("🚀 CloudBase Managed Agent - Fibonacci Example\n");

  // 1. Create an agent
  console.log("1. Creating agent...");
  const agent = await client.agents.create({
    name: "Coding Assistant",
    model: "hunyuan-2.0-instruct-20251111",
    system: "You are a helpful coding assistant. Write clean, well-documented code.",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  console.log(`   ✅ Agent created: ${agent.id} (${agent.name})\n`);

  // 2. Create an environment
  console.log("2. Creating environment...");
  const environment = await client.environments.create({
    name: "fibonacci-env",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  console.log(`   ✅ Environment created: ${environment.id}\n`);

  // 3. Create a session
  console.log("3. Creating session...");
  const session = await client.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    title: "Fibonacci Task",
  });
  console.log(`   ✅ Session created: ${session.id}\n`);

  // 4. Stream events first, then send the task
  console.log("4. Starting event stream...");
  const stream = client.sessions.events.stream(session.id);

  console.log("5. Sending task to agent...\n");
  await client.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: "Write a fibonacci function in Python. Then test it by computing fib(10) and fib(20). Show me the results.",
          },
        ],
      },
    ],
  });

  // 6. Consume and print events
  console.log("═".repeat(60));
  console.log("Agent Response:");
  console.log("═".repeat(60));

  for await (const event of stream) {
    switch (event.type) {
      case "agent.thinking":
        console.log(`\n💭 [Thinking] ${event.thinking}`);
        break;

      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            process.stdout.write(block.text ?? "");
          }
        }
        console.log();
        break;

      case "agent.tool_use":
        console.log(`\n🔧 [Tool Use] ${event.tool_name}`);
        console.log(`   Input: ${JSON.stringify(event.input, null, 2)}`);
        break;

      case "agent.tool_result":
        console.log(`\n📤 [Tool Result] ${event.is_error ? "❌ Error" : "✅ Success"}`);
        for (const block of event.content) {
          if (block.type === "text") {
            console.log(`   ${block.text}`);
          }
        }
        break;

      case "agent.custom_tool_use":
        console.log(`\n🔌 [Custom Tool] ${event.tool_name} — waiting for your handler...`);
        // In real usage, call your tool and send back user.custom_tool_result
        break;

      case "session.status_idle":
        console.log("\n" + "═".repeat(60));
        console.log("✅ Task complete!");
        break;

      case "session.status_terminated":
        console.log(`\n❌ Session terminated: ${event.reason ?? "unknown reason"}`);
        break;
    }
  }

  // 7. Cleanup
  console.log("\nCleaning up...");
  await client.sessions.delete(session.id);
  await client.environments.delete(environment.id);
  await client.agents.delete(agent.id);
  console.log("Done! ✨");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
