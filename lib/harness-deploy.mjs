/**
 * CLI harness deploy — thin layer over built agent-runtime.
 * Requires `npm run build:runtime` before magent harness deploy commands.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeAgentConfig,
  resolveRuntime,
  getCustomTools,
  resolveSandboxConfig,
  applyResolvedSandboxToConfig,
  normalizeSandboxEnv,
  SandboxConfigError,
} from "../packages/agent-runtime/dist/config.js";
import {
  buildMcporterConfig,
  buildManagedAgentClientTools,
  buildSandboxReachableClientMcpUrl,
  buildManagedAgentClientMcpUrl,
  isLoopbackHarnessCallback,
  MANAGED_AGENT_CLIENT_MCP_SERVER,
  MCPORTER_HTTP_MCP_TYPE,
} from "../packages/agent-runtime/dist/harness/deploy.js";
import {
  harnessGatewayBotBase,
  resolveHarnessClientToolCallbackBase,
} from "../packages/agent-runtime/dist/harness/callback-base.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
if (!existsSync(resolve(__dirname, "../packages/agent-runtime/dist/harness/index.js"))) {
  throw new Error("agent-runtime not built; run: npm run build:runtime");
}

const HARNESS_DEPLOY_ENV_KEYS = [
  "HARNESS_TOOL_ROLE_ARN",
  "TCB_REGION",
  "TCB_SECRET_ID",
  "TCB_SECRET_KEY",
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "HARNESS_COS_ENABLED",
  "HARNESS_COS_BUCKET",
  "HARNESS_COS_BUCKET_PATH",
  "HARNESS_COS_ENDPOINT",
  "HARNESS_COS_REGION",
  "HARNESS_COS_MOUNT_NAME",
  "HARNESS_COS_MOUNT_DIR",
  "CLOUDBASE_SERVER_URL",
];

function agentLoopRuntimeFromArgs(args = {}, config = {}) {
  const fromFlag = args["agent-runtime"];
  if (fromFlag === "harness" || fromFlag === "managed") return fromFlag;
  const r = args.runtime;
  if (r === "harness" || r === "managed") return r;
  return config.runtime ?? "managed";
}

function normalizeAgentRuntime(config, args = {}) {
  const runtime = agentLoopRuntimeFromArgs(args, config);
  const engine = args.engine ?? config.engine ?? "opencode";
  if (runtime === "harness") {
    config.runtime = "harness";
    config.engine =
      engine === "claude" || engine === "codebuddy" || engine === "hermes"
        ? engine
        : "opencode";
    return normalizeAgentConfig(config);
  }
  config.runtime = "managed";
  delete config.engine;
  return config;
}

function forwardHarnessDeployEnv(envMap) {
  for (const key of HARNESS_DEPLOY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) envMap[key] = value;
  }
}

function applyHarnessRuntimeEnv(envMap, config, opts = {}) {
  if (config.runtime !== "harness") return envMap;
  if (opts.harnessToolId) envMap.HARNESS_TOOL_ID = opts.harnessToolId;
  const agentId = opts.agentId?.trim();
  if (agentId) envMap.CLOUDBASE_AGENT_ID = agentId;
  const envId = opts.envId?.trim() ?? envMap.CLOUDBASE_ENV_ID?.trim();
  const callbackBase = resolveHarnessClientToolCallbackBase(envId, { agentId });
  const mcporter = buildMcporterConfig({
    config,
    clientToolCallbackBase: callbackBase,
  });
  if (Object.keys(mcporter.mcpServers).length) {
    envMap.MCPORTER_CONFIG_CONTENT = JSON.stringify(mcporter);
  }
  forwardHarnessDeployEnv(envMap);
  return envMap;
}

export {
  normalizeAgentConfig,
  resolveRuntime,
  getCustomTools,
  resolveSandboxConfig,
  applyResolvedSandboxToConfig,
  normalizeSandboxEnv,
  SandboxConfigError,
  buildMcporterConfig,
  buildManagedAgentClientTools,
  buildSandboxReachableClientMcpUrl,
  buildManagedAgentClientMcpUrl,
  isLoopbackHarnessCallback,
  MANAGED_AGENT_CLIENT_MCP_SERVER,
  MCPORTER_HTTP_MCP_TYPE,
  harnessGatewayBotBase,
  resolveHarnessClientToolCallbackBase,
  normalizeAgentRuntime,
  applyHarnessRuntimeEnv,
  agentLoopRuntimeFromArgs,
  HARNESS_DEPLOY_ENV_KEYS,
};
