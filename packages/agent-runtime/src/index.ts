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
import { loadAgentConfig, resolveRuntime, resolveSkills } from "./config.js";
import { getKernelAgent, getStoreDiag } from "./kernel-adapter.js";

const port = Number(process.env.PORT ?? 9000);

async function main() {
  const rawConfig = await loadAgentConfig();
  const config = await resolveSkills(rawConfig);
  const { runtime, engine } = resolveRuntime(config);

  type HarnessRuntime = typeof import("./harness/index.js");
  let harnessRuntime: HarnessRuntime | undefined;

  if (runtime === "harness") {
    harnessRuntime = await import("./harness/index.js");
    harnessRuntime.initHarnessLogging();
    harnessRuntime.harnessLog({
      lane: "runtime",
      operation: "boot",
      name: config.name,
      engine,
      toolCount: config.tools?.length ?? 0,
      mcpServerCount: config.mcp_servers?.length ?? 0,
      skillCount: config.skills?.length ?? 0,
    }).emit({ status: "ok" });
  } else {
    console.log(`[Agent] Name: ${config.name}`);
    console.log(`[Agent] Runtime: ${runtime}`);
    console.log(`[Agent] Model: ${config.model}`);
    console.log(`[Agent] Tools: ${config.tools?.length ?? 0} configured`);
    console.log(`[Agent] MCP Servers: ${config.mcp_servers?.length ?? 0} configured`);
    console.log(`[Agent] Skills: ${config.skills?.length ?? 0} configured`);
  }

  // Eagerly build the kernel agent (managed only) so /healthz reflects store state.
  if (runtime === "managed") {
    try {
      getKernelAgent(config);
    } catch (e) {
      console.warn("[Agent] eager getKernelAgent failed:", (e as Error)?.message);
    }
  }

  const app = express();
  app.use(cors());
  app.get("/healthz", async (_req, res) => {
    const base = {
      ok: true,
      name: config.name,
      model: config.model,
      runtime,
      engine: runtime === "harness" ? engine : undefined,
      buildMarker: runtime === "harness" ? "oma-runtime-v1" : "syncRegisterSession-v3",
    };
    if (runtime === "harness") {
      const envId =
        process.env.CLOUDBASE_ENV_ID?.trim() ??
        process.env.TCB_ENV_ID?.trim() ??
        "default";
      const [
        { getHarnessStoreDiag },
        { getHarnessSandboxCacheStats },
        { getSandboxPrewarmStats },
      ] = await Promise.all([
        import("./harness/sandbox/session-store.js"),
        import("./harness/sandbox/orchestrator.js"),
        import("./harness/sandbox/sandbox-prewarm.js"),
      ]);
      const harnessStore = await getHarnessStoreDiag(envId);
      res.json({
        ...base,
        harnessStore,
        sandbox: {
          ...getHarnessSandboxCacheStats(),
          ...getSandboxPrewarmStats(),
        },
      });
      return;
    }
    res.json({ ...base, store: getStoreDiag() });
  });

  mountAcpEndpoint(app, config);
  if (runtime === "harness") {
    app.use("/internal/harness/mcp", express.json({ limit: "2mb" }));
    harnessRuntime ??= await import("./harness/index.js");
    harnessRuntime.mountHarnessMcpGateway(app, config);
  }

  app.listen(port, () => {
    if (runtime === "harness" && harnessRuntime) {
      harnessRuntime.harnessLog({ lane: "runtime", operation: "listen", port, runtime, engine }).emit({
        status: "ok",
      });
    } else {
      console.log(`OpenManagedAgent Runtime listening on :${port}`);
      console.log(`  ACP   : POST /acp, POST /v1/aibot/bots/:botId/acp`);
      console.log(`  Health: GET  /healthz`);
      console.log(`  Model : ${typeof config.model === "string" ? config.model : config.model?.id}`);
    }
  });
}

main().catch((err) => {
  console.error("[Fatal] Failed to start agent runtime:", err);
  process.exit(1);
});
