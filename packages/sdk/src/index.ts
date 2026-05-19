import { AgentsResource } from "./agents.js";
import { EnvironmentsResource } from "./environments.js";
import { SessionsResource } from "./sessions.js";
import type { CloudbaseAgentsConfig } from "./types.js";

export * from "./types.js";
export { AgentsResource } from "./agents.js";
export { EnvironmentsResource } from "./environments.js";
export { SessionsResource } from "./sessions.js";
export { EventsResource, EventStream } from "./events.js";

export class CloudbaseAgents {
  readonly agents: AgentsResource;
  readonly environments: EnvironmentsResource;
  readonly sessions: SessionsResource;

  constructor(config: CloudbaseAgentsConfig) {
    if (!config.baseURL) {
      throw new Error("CloudbaseAgents: baseURL is required");
    }
    this.agents = new AgentsResource(config);
    this.environments = new EnvironmentsResource(config);
    this.sessions = new SessionsResource(config);
  }
}

export default CloudbaseAgents;
