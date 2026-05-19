/**
 * CloudBase Managed Agent - Runtime Entry
 *
 * 部署方式：
 *   tcb agent create --name my-agent --code ./packages/agent-runtime -e $ENV_ID
 *
 * 暴露端点：
 *   /send-message        AG-UI SSE（简单单轮对话）
 *   /agui                CopilotKit RPC
 *   /acp                 ACP JSON-RPC 2.0（完整会话管理）
 *   /acp/sessions        REST 查询 session 列表
 *   /acp/sessions/:id    REST 查询单个 session
 *   /healthz             健康检查
 */

import { createExpressServer } from "@cloudbase/agent-server";
import { HunyuanAgent } from "./hunyuan-agent.js";
import { mountAcpEndpoint } from "./acp-endpoint.js";

const model  = process.env.AGENT_MODEL  ?? "hunyuan-2.0-instruct-20251111";
const system = process.env.AGENT_SYSTEM
  ? decodeURIComponent(process.env.AGENT_SYSTEM)
  : "You are a helpful assistant.";
const port   = Number(process.env.PORT ?? 9000);

const agentConfig = { model, system };

// AG-UI server (provides /send-message + /agui + /healthz)
const app = createExpressServer({
  createAgent: (ctx) => {
    ctx.logger?.info({ model }, "HunyuanAgent starting");
    return { agent: new HunyuanAgent(agentConfig) };
  },
  cors: true,
});

// ACP endpoint (provides /acp + /acp/sessions)
mountAcpEndpoint(app, agentConfig);

app.listen(port, () => {
  console.log(`CloudBase Managed Agent Runtime listening on :${port}`);
  console.log(`  AG-UI : POST /send-message`);
  console.log(`  ACP   : POST /acp`);
  console.log(`  ACP   : GET  /acp/sessions`);
  console.log(`  Health: GET  /healthz`);
  console.log(`  Model : ${model}`);
});
