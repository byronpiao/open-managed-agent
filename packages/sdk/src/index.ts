import { AgentsResource } from "./agents.js";
import { EnvironmentsResource } from "./environments.js";
import { SessionsResource } from "./sessions.js";
import { AcpClient } from "./acp-client.js";
import type { ManagedAgentsConfig } from "./types.js";

export * from "./types.js";
export { AgentsResource } from "./agents.js";
export { EnvironmentsResource } from "./environments.js";
export { SessionsResource } from "./sessions.js";
export { EventsResource, EventStream } from "./events.js";
export { AcpClient } from "./acp-client.js";
export type { AcpSessionInfo, AcpSessionDetail, AcpStreamEvent, AcpCapabilities } from "./acp-client.js";
export {
  ManagedAgentsClient,
  createManagedAgentsClient,
  MANAGED_AGENTS_BETA_HEADER_NAME,
  MANAGED_AGENTS_BETA_HEADER_VALUE,
} from "./managed-agents-client.js";
export type {
  ManagedAgentsAgentRecord,
  ManagedAgentsEnvironmentRecord,
  ManagedAgentsSessionRecord,
  ManagedAgentsSessionEventRecord,
  ManagedAgentsInboundEvent,
} from "./managed-agents-client.js";

export class ManagedAgents {
  readonly agents: AgentsResource;
  readonly environments: EnvironmentsResource;
  readonly sessions: SessionsResource;

  constructor(config: ManagedAgentsConfig) {
    if (!config.envId) {
      throw new Error("ManagedAgents: envId is required");
    }
    if (!config.agentId) {
      throw new Error("ManagedAgents: agentId is required");
    }
    if (!config.baseURL) {
      config.baseURL = `https://${config.envId}.api.tcloudbasegateway.com/v1/aibot/bots/${config.agentId}`;
    }
    this.agents = new AgentsResource(config);
    this.environments = new EnvironmentsResource(config);
    this.sessions = new SessionsResource(config);
  }
}

/** @deprecated Use ManagedAgents */
export const CloudbaseAgents = ManagedAgents;

export default ManagedAgents;
