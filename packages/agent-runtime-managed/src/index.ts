/**
 * OpenManagedAgent — Managed runtime entry (standalone).
 *
 * Only the managed (OAK) kernel is loaded here — no harness code, no dispatcher.
 * Deployed as SCF / TCBR for `runtime: managed` agents.
 *
 * 部署方式：
 *   tcb agent create --name my-agent --code ./packages/agent-runtime-managed -e $ENV_ID
 *
 * 暴露端点：
 *   POST /acp                              ACP JSON-RPC 2.0
 *   POST /send-message                     ACP alias (compat path)
 *   POST /v1/aibot/bots/:botId/acp         ACP via gateway proxy
 *   POST /v1/aibot/bots/:botId/send-message  ACP alias via gateway proxy
 *   GET  /healthz                          Health check
 */

import express from "express";
import cors from "cors";
import { loadAgentConfig, resolveRuntime } from "./config.js";
import { materializeManagedSkills, resolveBundleSkillsDir, listBundledSkillNames } from "./managed/skills.js";
import { getKernelAgent, getStoreDiag } from "./oak-runtime/kernel-adapter.js";
import { mountManagedAcpEndpoint } from "./oak-runtime/acp-endpoint.js";

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

  const config = await loadAgentConfig();
  const { runtime, engine } = resolveRuntime(config);

  const { initManagedLogging } = await import("./managed/observability/logging.js");
  initManagedLogging();
  const bundleSkillsDir = await resolveBundleSkillsDir();
  const skillNames = listBundledSkillNames(bundleSkillsDir);
  if (skillNames.length > 0) {
    await materializeManagedSkills(skillNames, { bundleSkillsDir });
  }

  console.log(`[Agent] Name: ${config.name}`);
  console.log(`[Agent] Runtime: ${runtime}`);
  console.log(`[Agent] Model: ${config.model}`);
  console.log(`[Agent] Tools: ${config.tools?.length ?? 0} configured`);
  console.log(`[Agent] MCP Servers: ${config.mcp_servers?.length ?? 0} configured`);
  console.log(`[Agent] Skills: ${config.skills?.length ?? 0} configured`);

  // Eagerly build the kernel agent so /healthz reflects store state.
  try {
    getKernelAgent(config);
  } catch (e) {
    console.warn("[Agent] eager getKernelAgent failed:", (e as Error)?.message);
  }

  const app = express();
  // Reflect request Origin + allow credentials so browser ACP clients pass
  // OPTIONS preflight. Skip in SCF — tcloudbasegateway already sets CORS.
  if (!process.env.TENCENTCLOUD_RUNENV) {
    app.use(
      cors({
        origin: true,
        credentials: true,
      }),
    );
  }
  app.get("/healthz", async (_req, res) => {
    res.json({
      ok: true,
      name: config.name,
      model: config.model,
      runtime,
      engine: runtime === "harness" ? engine : undefined,
      buildMarker: "syncRegisterSession-v3",
      store: getStoreDiag(),
    });
  });

  mountManagedAcpEndpoint(app, config);

  app.listen(port, () => {
    console.log(`OpenManagedAgent Runtime listening on :${port}`);
    console.log(`  ACP   : POST /acp, POST /send-message (+ /v1/aibot/bots/:botId/{acp,send-message})`);
    console.log(`  Health: GET  /healthz`);
    console.log(`  Model : ${typeof config.model === "string" ? config.model : config.model?.id}`);
  });
}

main().catch((err) => {
  console.error("[Fatal] Failed to start agent runtime:", err);
  process.exit(1);
});
