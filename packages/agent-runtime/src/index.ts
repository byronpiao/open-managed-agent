/**
 * OpenManagedAgent — Harness runtime entry.
 *
 * Only the harness (sandbox) runtime is loaded here — no managed/OAK kernel.
 * Deployed as SCF / TCBR for `runtime: harness` agents.
 *
 * 部署方式：
 *   tcb agent create --name my-agent --code ./packages/agent-runtime -e $ENV_ID
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
import { loadAgentConfig, resolveRuntime, resolveSkills } from "./config.js";
import { mountHarnessAcpEndpoint } from "./harness/acp-endpoint.js";

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
  const { runtime, engine } = resolveRuntime(rawConfig);
  const config = await resolveSkills(rawConfig);

  type HarnessRuntime = typeof import("./harness/index.js");
  let harnessRuntime: HarnessRuntime | undefined;

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
  app.get("/healthz", async (req, res) => {
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
      ok: true,
      name: config.name,
      model: config.model,
      runtime,
      engine,
      buildMarker: "oma-runtime-v1",
      sandbox: {
        ...getHarnessSandboxCacheStats(),
        ...getSandboxPrewarmStats(),
      },
    };
    const { getTelemetrySummary } = await import("./harness/telemetry/telemetry-init.js");
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
  });

  // Body parsers for the ACP routes (mirrors the old dispatcher).
  app.use("/acp", express.json({ limit: "10mb" }));
  app.use("/v1/aibot/bots", express.json({ limit: "10mb" }));

  mountHarnessAcpEndpoint(app, config);

  const { mountManagedAgentsEndpoint } = await import("./harness/managed-agents-protocol/managed-agents-endpoint.js");
  mountManagedAgentsEndpoint(app, config);
  app.use("/internal/harness/mcp", express.json({ limit: "2mb" }));
  harnessRuntime ??= await import("./harness/index.js");
  harnessRuntime.mountHarnessMcpGateway(app, config);

  app.listen(port, () => {
    if (harnessRuntime) {
      harnessRuntime.harnessLog({ lane: "runtime", operation: "listen", port, runtime, engine }).emit({
        status: "ok",
      });
    }
  });
}

main().catch((err) => {
  console.error("[Fatal] Failed to start agent runtime:", err);
  process.exit(1);
});
