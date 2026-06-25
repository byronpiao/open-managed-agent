/**
 * ACP dispatcher — routes POST /acp by agent.runtime (oak vs harness).
 *
 *   POST /acp                              Direct ACP entry
 *   POST /v1/aibot/bots/:botId/acp         Gateway path (deployment-only)
 *
 * Both routes get express.json mounted here; the chosen mode's mount function
 * then registers its own handlers and CORS.
 */

import type { Express } from "express";
import expressLib from "express";
import type { AgentConfig } from "./config.js";
import { resolveRuntime } from "./config.js";
import { mountHarnessAcpEndpoint } from "./harness/acp-endpoint.js";
import { mountManagedAcpEndpoint } from "./oak-runtime/acp-endpoint.js";

/** Routes POST /acp by agent.runtime (managed vs harness). */
export function mountAcpEndpoint(app: Express, agentConfig: AgentConfig) {
  app.use("/acp", expressLib.json({ limit: "10mb" }));
  app.use("/v1/aibot/bots", expressLib.json({ limit: "10mb" }));

  const { runtime, engine } = resolveRuntime(agentConfig);
  if (runtime === "harness") {
    mountHarnessAcpEndpoint(app, agentConfig);
    return;
  }
  console.log(`[ACP] runtime=managed (engine field ignored, yaml engine=${engine})`);
  mountManagedAcpEndpoint(app, agentConfig);
}
