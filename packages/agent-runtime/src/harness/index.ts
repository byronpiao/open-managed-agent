/**
 * 沙箱 Agent（Harness 运行时）— runtime=harness.
 * 箱内引擎（ACP 服务端）在远程沙箱内跑 agent loop；托管运行时（managed）在网关上跑 OAK。
 */

export {
  MANAGED_AGENT_CLIENT_MCP_SERVER,
  SANDBOX_TRW_MCP_RELAY_PATH,
  SANDBOX_TRW_MCP_POLL_PATH,
  SANDBOX_TRW_MCP_COMPLETE_PATH,
  HARNESS_PUBLIC_MAGENT_IMAGE,
  resolveHarnessSandboxImage,
  buildHarnessOpencodeConfigContent,
  buildHarnessOpencodePermission,
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
  harnessRequestId,
  harnessTraceId,
  harnessOutboundCorrelationHeaders,
  runWithHarnessRequestContext,
  resolveHarnessRequestId,
  resolveHarnessCorrelationFromHeaders,
  parseCloudbaseTraceHeader,
  parseTraceparent,
  buildSyntheticTraceparent,
  normalizeInboundRequestId,
  buildHarnessOutboundCorrelationHeaders,
  TRACEPARENT_HEADER,
} from "./logging.js";

export {
  recordHarnessAcquireDuration,
  recordHarnessPromptDuration,
  recordHarnessPermissionFrames,
  recordHarnessSyncExported,
  recordHarnessAcceptanceOutcome,
} from "./metrics.js";

export { getTelemetrySummary, getMetricsExportMode, getTracesExportMode } from "./telemetry-init.js";

export {
  HARNESS_SYNC_EVENTS_COLLECTION,
  getHarnessSyncEventStore,
  resetHarnessSyncEventStoreForTests,
} from "./sync-event-store.js";

export {
  assertHarnessAgsRuntimeEnv,
  assertHarnessCloudCreds,
  assertHarnessCosEnv,
  assertHarnessAnthropicLlmEnv,
  assertHarnessLlmEnv,
  assertHarnessLlmSuiteEnv,
  hasHarnessAnthropicLlmEnv,
  hasHarnessCustomLlmEnv,
  missingHarnessAnthropicLlmEnv,
  missingHarnessCosEnv,
  missingHarnessLlmEnv,
  resolveHarnessToolRoleArn,
  resolveTcbRegion,
} from "./harness-env.js";

export {
  anthropicMessagesUrl,
  assertHarnessAnthropicLlmReachable,
  assertHarnessOpenAiLlmReachable,
  assertHarnessPlatformLlmReachable,
  classifyPlatformProbeFailure,
  formatClaudePlatformProbeFailureGuide,
  formatPlatformProbeFailureGuide,
  isPlatformQuotaExceeded,
  openAiChatCompletionsUrl,
  probeCloudBasePlatformAnthropicLlm,
  probeCloudBasePlatformLlm,
  probeHarnessAnthropicLlm,
  probeHarnessAnthropicLlmSandboxCompat,
  probeHarnessOpenAiLlm,
  type HarnessLlmProbeResult,
  type PlatformProbeFailureKind,
} from "./llm-probe.js";

export {
  markClaudeWarmOutcome,
  probeClaudeSessionStoreAfterPrompt,
} from "./claude-session-health.js";
export { warmClaudeEngineSession } from "./claude-session-warm.js";
export {
  countHarnessClaudeSessionEntries,
  countHarnessClaudeSessionFootprint,
} from "./claude-session-probe.js";

export {
  OPENCODE_SYNC_DIRECTORY,
  ensureOpencodeSyncStarted,
  exportOpencodeSyncEvents,
  persistOpencodeSyncForSession,
  hydrateOpencodeSyncEvents,
  fetchOpencodeSyncHistory,
  replayOpencodeSyncEvents,
  snapshotWorkspaceIfAvailable,
} from "./opencode-sync.js";

export {
  resolveHarnessSandboxIdlePauseMs,
  resetSandboxPrewarmForTests,
} from "./sandbox/sandbox-prewarm.js";
