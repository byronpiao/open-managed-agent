/**
 * 沙箱 Agent（Harness 运行时）— runtime=harness.
 * 箱内引擎（ACP 服务端）在远程沙箱内跑 agent loop；托管运行时（managed）在网关上跑 OAK。
 */

export {
  MANAGED_AGENT_CLIENT_MCP_SERVER,
  SANDBOX_TRW_MCP_RELAY_PATH,
  SANDBOX_TRW_MCP_POLL_PATH,
  SANDBOX_TRW_MCP_COMPLETE_PATH,
  DEFAULT_HARNESS_SANDBOX_IMAGE,
  resolveHarnessSandboxImage,
  buildHarnessOpencodeConfigContent,
  buildManagedAgentClientTools,
  buildManagedAgentClientMcpUrl,
  buildSandboxReachableClientMcpUrl,
  buildHarnessAcpMcpServers,
  isLoopbackHarnessCallback,
  buildMcporterConfig,
  buildHarnessSandboxEnv,
  buildSkillsManifestEnv,
  buildHarnessInitCredEnv,
  customToolsToMcpToolSchemas,
  agentLoopRuntimeFromArgs,
  normalizeAgentRuntime,
  applyHarnessRuntimeEnv,
} from "./deploy.js";

export { mountHarnessAcpEndpoint } from "./acp-endpoint.js";
export { mountHarnessMcpGateway } from "./mcp-gateway.js";
export { startSandboxMcpPump, shouldRunSandboxMcpPump } from "./mcp-pump.js";

export {
  deliverClientToolResult,
  invokeClientToolFromSandbox,
  registerActivePrompt,
  unregisterActivePrompt,
  resetClientToolBridgeForTests,
} from "./client-tool-bridge.js";

export {
  initHarnessLogging,
  harnessLog,
  harnessTrace,
  isHarnessLogDebug,
} from "./logging.js";
