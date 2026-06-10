/**
 * Claude Managed Agents HTTP Host layer on OMA Runtime.
 * vendor/ = mosoo protocol projection (retains upstream Cma* identifiers).
 */

export {
  CmaUnsupportedFieldError,
  parseCmaInboundEvent,
  projectCmaInboundToDriverCommand,
  projectDriverEventToCma,
} from "./vendor/projections-cma.js";
export type {
  CmaInboundEvent,
  CmaOutboundEvent,
  CmaSessionStatus,
  CmaUserCustomToolResultEvent,
  CmaUserInterruptEvent,
  CmaUserMessageEvent,
  CmaUserToolConfirmationEvent,
} from "./vendor/projections-cma.js";

export {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  CMA_DEFAULT_BETA_HEADER_NAME as MANAGED_AGENTS_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE as MANAGED_AGENTS_BETA_HEADER_VALUE,
  createCmaHttpHandler,
} from "./vendor/cma-http.js";
export type {
  CmaHttpAuthorizationContext,
  CmaHttpAuthorizer,
  CmaHttpBetaHeaderRequirement,
  CmaHttpDriverCommandDispatchInput,
  CmaHttpDriverCommandDispatcher,
  CmaHttpHandler,
  CmaHttpHandlerOptions,
} from "./vendor/cma-http.js";

export {
  CmaStoreConflictError,
  CmaStoreNotFoundError,
} from "./vendor/cma-store-types.js";
export type {
  CmaAgentRecord,
  CmaAppendInboundEventInput,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentConfig,
  CmaEnvironmentRecord,
  CmaSessionEventRecord,
  CmaSessionRecord,
  CmaStore,
} from "./vendor/cma-store-types.js";

export { createCmaMemoryStore, CmaMemoryStore } from "./vendor/cma-memory-store.js";
export {
  getManagedAgentsStore,
  resetManagedAgentsStoreForTests,
} from "./store/managed-agents-store-factory.js";
export {
  mergeManagedAgentsAgentConfig,
  resolveManagedAgentsSessionConfig,
  resolveHarnessEngineForMaSession,
} from "./resolve-session-agent-config.js";
export {
  setManagedAgentsDeploymentConfig,
  resetManagedAgentsDeploymentConfigForTests,
} from "./deployment-config.js";
export { mountManagedAgentsEndpoint } from "./managed-agents-endpoint.js";
export { createHarnessManagedAgentsDispatcher } from "./dispatch/harness-dispatcher.js";
export { acpSessionUpdateToDriverEvents } from "./bridge/acp-to-driver-event.js";
export type { DriverEventInput } from "./vendor/driver-event-types.js";
export type { RuntimeCommand, RuntimeCommandResult } from "./vendor/runtime-command-types.js";
