/**
 * @deprecated Agent management is handled via `magent` CLI, not the SDK.
 * The runtime does not implement REST endpoints for /agents.
 */
import type {
  Agent,
  CreateAgentParams,
  ListResponse,
  ManagedAgentsConfig,
} from "./types.js";

const ERR = "Not supported: use `magent agent:*` CLI commands instead.";

export class AgentsResource {
  constructor(_config: ManagedAgentsConfig) {}

  /** @deprecated Use `magent agent:create` */
  async create(_params: CreateAgentParams): Promise<Agent> {
    throw new Error(`agents.create() — ${ERR}`);
  }

  /** @deprecated Use `magent agent:get` */
  async retrieve(_agentId: string): Promise<Agent> {
    throw new Error(`agents.retrieve() — ${ERR}`);
  }

  /** @deprecated Use `magent agent:list` */
  async list(): Promise<ListResponse<Agent>> {
    throw new Error(`agents.list() — ${ERR}`);
  }

  /** @deprecated Use `magent agent:delete` */
  async delete(_agentId: string): Promise<{ id: string; deleted: boolean }> {
    throw new Error(`agents.delete() — ${ERR}`);
  }
}
