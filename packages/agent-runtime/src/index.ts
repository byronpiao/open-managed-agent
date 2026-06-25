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
 *   /v1/agents|environments|sessions       Claude Managed Agents HTTP (harness)
 */

import "./harness/telemetry-bootstrap.js";
import express from "express";
import cors from "cors";
import { mountAcpEndpoint } from "./acp-endpoint.js";
import { loadAgentConfig, resolveRuntime, resolveSkills } from "./config.js";
import { getKernelAgent, getStoreDiag } from "./oak-runtime/kernel-adapter.js";

const port = Number(process.env.PORT ?? 9000);

async function main() {
  // 以 root(euid=0)运行时告警:claude CLI 会拒绝 --dangerously-skip-permissions,
  // 导致 SDK 收不到任何 stream event。uid-shim 应已降权,这里只在万一没降权时提示。
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    // eslint-disable-next-line no-console
    console.error(
      "[runtime] WARNING: running as root (euid=0) — claude CLI will reject " +
        "--dangerously-skip-permissions, the agent will produce no output. " +
        "Ensure uid-shim drops privileges (start as root + --import uid-shim, no `USER` directive).",
    );
  }

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
  // Reflect request Origin + allow credentials so browser ACP clients (e.g. chat-playground
  // with fetch credentials: "include") pass OPTIONS preflight. Bare cors() answers * without
  // Allow-Credentials, which browsers reject before POST /acp runs route-level CORS.
  // Skip in SCF — tcloudbasegateway already sets CORS headers; duplicating causes
  // browsers to reject "multiple values".
  if (!process.env.TENCENTCLOUD_RUNENV) {
    app.use(
      cors({
        origin: true,
        credentials: true,
      }),
    );
  }
  app.get("/healthz", async (req, res) => {
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
      const payload: Record<string, unknown> = {
        ...base,
        sandbox: {
          ...getHarnessSandboxCacheStats(),
          ...getSandboxPrewarmStats(),
        },
      };
      const { getTelemetrySummary } = await import("./harness/telemetry-init.js");
      payload.telemetry = getTelemetrySummary();
      const wantDiag = req.query.diag === "1" || req.query.verbose === "1";
      if (wantDiag) {
        try {
          payload.harnessStore = await getHarnessStoreDiag(envId);
        } catch (e) {
          payload.harnessStore = { error: (e as Error).message };
        }
      }
      res.json(payload);
      return;
    }
    res.json({ ...base, store: getStoreDiag() });
  });

  mountAcpEndpoint(app, config);
  if (runtime === "harness") {
    const { mountManagedAgentsEndpoint } = await import("./harness/managed-agents/managed-agents-endpoint.js");
    mountManagedAgentsEndpoint(app, config);
  }
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
