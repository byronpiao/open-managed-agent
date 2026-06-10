import type {
  Agent,
  CreateAgentParams,
  ListResponse,
  ManagedAgentsConfig,
} from "./types.js";
import { ManagedAgentsClient } from "./managed-agents-client.js";

function toAgent(record: {
  id: string;
  name: string;
  metadata: Record<string, string>;
  createdAt: string;
}): Agent {
  return {
    id: record.id,
    object: "agent",
    name: record.name,
    model: record.metadata.model ?? "",
    system: record.metadata.system,
    tools: [],
    metadata: record.metadata,
    created_at: Math.floor(Date.parse(record.createdAt) / 1000) || Math.floor(Date.now() / 1000),
  };
}

export class AgentsResource {
  private client: ManagedAgentsClient;

  constructor(config: ManagedAgentsConfig) {
    this.client = new ManagedAgentsClient(config);
  }

  async create(params: CreateAgentParams): Promise<Agent> {
    const record = await this.client.createAgent({
      name: params.name,
      metadata: {
        ...(params.model ? { model: params.model } : {}),
        ...(params.system ? { system: params.system } : {}),
        ...params.metadata,
      },
    });
    return toAgent(record);
  }

  async retrieve(agentId: string): Promise<Agent> {
    return toAgent(await this.client.getAgent(agentId));
  }

  async list(): Promise<ListResponse<Agent>> {
    const agents = await this.client.listAgents();
    return {
      object: "list",
      has_more: false,
      data: agents.map(toAgent),
    };
  }

  async delete(_agentId: string): Promise<{ id: string; deleted: boolean }> {
    throw new Error("agents.delete() is not supported by CMA HTTP");
  }
}
