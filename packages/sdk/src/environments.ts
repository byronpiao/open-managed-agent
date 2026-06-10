import type {
  Environment,
  CreateEnvironmentParams,
  ListResponse,
  ManagedAgentsConfig,
} from "./types.js";
import { ManagedAgentsClient } from "./managed-agents-client.js";

function toEnvironment(record: {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
}): Environment {
  const config = record.config as unknown as Environment["config"];
  return {
    id: record.id,
    object: "environment",
    name: record.name,
    config: config?.type ? config : { type: "cloud" },
    created_at: Math.floor(Date.parse(record.createdAt) / 1000) || Math.floor(Date.now() / 1000),
  };
}

export class EnvironmentsResource {
  private client: ManagedAgentsClient;

  constructor(config: ManagedAgentsConfig) {
    this.client = new ManagedAgentsClient(config);
  }

  async create(params: CreateEnvironmentParams): Promise<Environment> {
    const record = await this.client.createEnvironment({
      name: params.name,
      config: params.config as Record<string, unknown> | undefined,
    });
    return toEnvironment(record);
  }

  async retrieve(envId: string): Promise<Environment> {
    return toEnvironment(await this.client.getEnvironment(envId));
  }

  async list(): Promise<ListResponse<Environment>> {
    const environments = await this.client.listEnvironments();
    return {
      object: "list",
      has_more: false,
      data: environments.map(toEnvironment),
    };
  }

  async delete(envId: string): Promise<{ id: string; deleted: boolean }> {
    throw new Error("environments.delete() is not supported; use archive via CMA HTTP");
  }
}
