/**
 * OpenManagedAgent — Runtime entry.
 *
 * 部署方式：
 *   tcb agent create --name my-agent --code ./packages/agent-runtime -e $ENV_ID
 *
 * 配置方式：
 *   1. AGENT_CONFIG / AGENT_CONFIG_B64 环境变量（magent agent:update 写入）
 *   2. agent.yaml 文件（随代码部署）
 *   3. 单独环境变量 AGENT_MODEL / AGENT_SYSTEM / AGENT_NAME（向后兼容）
 *
 * 暴露端点：
 *   POST /acp                              ACP JSON-RPC 2.0
 *   POST /v1/aibot/bots/:botId/acp         ACP via gateway proxy
 *   GET  /healthz                          Health check
 */

import express from "express";
import cors from "cors";
import { mountAcpEndpoint } from "./acp-endpoint.js";
import { loadAgentConfig, resolveSkills } from "./config.js";

const port = Number(process.env.PORT ?? 9000);

async function main() {
  const rawConfig = await loadAgentConfig();
  const config = await resolveSkills(rawConfig);

  console.log(`[Agent] Name: ${config.name}`);
  console.log(`[Agent] Model: ${config.model}`);
  console.log(`[Agent] Tools: ${config.tools?.length ?? 0} configured`);
  console.log(`[Agent] MCP Servers: ${config.mcp_servers?.length ?? 0} configured`);
  console.log(`[Agent] Skills: ${config.skills?.length ?? 0} configured`);

  const app = express();
  app.use(cors());
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: config.name, model: config.model, uid: process.getuid?.() });
  });

  // Temporary connectivity probe: used to diagnose network access from
  // inside SCF. Remove after debugging.
  app.get("/debug/net", async (_req, res) => {
    const model = config.model;
    const apiBaseUrl = typeof model === "object" ? model.apiBaseUrl : undefined;
    const apiKey = typeof model === "object" ? model.apiKey : undefined;
    const results: Record<string, unknown> = { uid: process.getuid?.(), apiBaseUrl };
    if (apiBaseUrl && apiKey) {
      try {
        const r = await fetch(`${apiBaseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: typeof model === "object" ? model.id : model,
            max_tokens: 10,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        results.status = r.status;
        results.body = (await r.text()).slice(0, 500);
      } catch (e) {
        results.error = (e as Error).message;
      }
    }
    res.json(results);
  });

  mountAcpEndpoint(app, config);

  app.listen(port, () => {
    console.log(`OpenManagedAgent Runtime listening on :${port}`);
    console.log(`  ACP   : POST /acp, POST /v1/aibot/bots/:botId/acp`);
    console.log(`  Health: GET  /healthz`);
    console.log(`  Model : ${typeof config.model === "string" ? config.model : config.model?.id}`);
  });
}

main().catch((err) => {
  console.error("[Fatal] Failed to start agent runtime:", err);
  process.exit(1);
});
