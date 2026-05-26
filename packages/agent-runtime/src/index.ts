/**
 * OpenManagedAgent - Runtime Entry
 *
 * 部署方式：
 *   tcb agent create --name my-agent --code ./packages/agent-runtime -e $ENV_ID
 *
 * 配置方式：
 *   1. agent.yaml 文件（推荐）- 完整配置含 tools/mcp_servers/skills/permission_policy
 *   2. 环境变量（向后兼容）- AGENT_MODEL, AGENT_SYSTEM, AGENT_NAME
 *   3. 混合模式 - agent.yaml 为主，环境变量可覆盖 model/system/name
 *
 * 暴露端点：
 *   /send-message                       AG-UI SSE（简单单轮对话）
 *   /agui                               CopilotKit RPC
 *   /acp                                ACP JSON-RPC 2.0（完整会话管理）
 *   /v1/aibot/bots/:botId/acp           ACP via gateway proxy
 *   /acp/sessions                       REST 查询 session 列表
 *   /v1/aibot/bots/:botId/acp/sessions  REST via gateway proxy
 *   /healthz                            健康检查
 */

import { createExpressServer } from "@cloudbase/agent-server";
import { HunyuanAgent } from "./hunyuan-agent.js";
import { mountAcpEndpoint, ensureCollection } from "./acp-endpoint.js";
import { loadAgentConfig } from "./config.js";
import type { AgentConfig } from "./config.js";

const port = Number(process.env.PORT ?? 9000);

async function main() {
  const config = await loadAgentConfig();

  // Ensure DB collection exists (once at startup)
  await ensureCollection(config.sessions_collection);

  console.log(`[Agent] Name: ${config.name}`);
  console.log(`[Agent] Model: ${config.model}`);
  console.log(`[Agent] Tools: ${config.tools?.length ?? 0} configured`);
  console.log(`[Agent] MCP Servers: ${config.mcp_servers?.length ?? 0} configured`);
  console.log(`[Agent] Skills: ${config.skills?.length ?? 0} configured`);

  // AG-UI server (provides /send-message + /agui + /healthz)
  const app = createExpressServer({
    createAgent: (ctx: any) => {
      ctx?.logger?.info({ model: config.model }, "HunyuanAgent starting");
      const agent = new HunyuanAgent(config);
      return { agent: agent as any };
    },
    cors: true,
  });

  // ACP endpoint (provides /acp + /v1/aibot/bots/:botId/acp + REST sessions)
  mountAcpEndpoint(app, config);

  app.listen(port, () => {
    console.log(`OpenManagedAgent Runtime listening on :${port}`);
    console.log(`  AG-UI : POST /send-message`);
    console.log(`  ACP   : POST /acp, POST /v1/aibot/bots/:botId/acp`);
    console.log(`  Health: GET  /healthz`);
    console.log(`  Model : ${config.model}`);
  });
}

main().catch((err) => {
  console.error("[Fatal] Failed to start agent runtime:", err);
  process.exit(1);
});
