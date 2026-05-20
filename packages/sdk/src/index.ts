import { AgentsResource } from "./agents.js";
import { EnvironmentsResource } from "./environments.js";
import { SessionsResource } from "./sessions.js";
import { AcpClient } from "./acp-client.js";
import type { CloudbaseAgentsConfig } from "./types.js";

export * from "./types.js";
export { AgentsResource } from "./agents.js";
export { EnvironmentsResource } from "./environments.js";
export { SessionsResource } from "./sessions.js";
export { EventsResource, EventStream } from "./events.js";
export { AcpClient } from "./acp-client.js";
export type { AcpSessionInfo, AcpSessionDetail, AcpStreamEvent, AcpCapabilities } from "./acp-client.js";

export class CloudbaseAgents {
  readonly agents: AgentsResource;
  readonly environments: EnvironmentsResource;
  readonly sessions: SessionsResource;

  constructor(config: CloudbaseAgentsConfig) {
    if (!config.envId) {
      throw new Error("CloudbaseAgents: envId is required");
    }
    if (!config.agentId) {
      throw new Error("CloudbaseAgents: agentId is required");
    }
    // Auto-generate baseURL if not provided
    if (!config.baseURL) {
      config.baseURL = `https://${config.envId}.api.tcloudbasegateway.com/v1/aibot/bots/${config.agentId}`;
    }
    this.agents = new AgentsResource(config);
    this.environments = new EnvironmentsResource(config);
    this.sessions = new SessionsResource(config);
  }
}

export default CloudbaseAgents;
