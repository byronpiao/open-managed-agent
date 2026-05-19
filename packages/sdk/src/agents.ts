import type {
  Agent,
  CreateAgentParams,
  ListResponse,
  CloudbaseAgentsConfig,
} from "./types.js";

export class AgentsResource {
  constructor(private config: CloudbaseAgentsConfig) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    if (this.config.envId) h["X-CloudBase-Env-Id"] = this.config.envId;
    return h;
  }

  async create(params: CreateAgentParams): Promise<Agent> {
    const res = await fetch(`${this.config.baseURL}/agents`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name: params.name,
        model: params.model ?? "hunyuan-2.0-instruct-20251111",
        system: params.system,
        tools: params.tools ?? [{ type: "agent_toolset_20260401" }],
        metadata: params.metadata,
      }),
    });
    if (!res.ok) throw new Error(`Failed to create agent: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Agent>;
  }

  async retrieve(agentId: string): Promise<Agent> {
    const res = await fetch(`${this.config.baseURL}/agents/${agentId}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to retrieve agent: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Agent>;
  }

  async list(): Promise<ListResponse<Agent>> {
    const res = await fetch(`${this.config.baseURL}/agents`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to list agents: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ListResponse<Agent>>;
  }

  async delete(agentId: string): Promise<{ id: string; deleted: boolean }> {
    const res = await fetch(`${this.config.baseURL}/agents/${agentId}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to delete agent: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ id: string; deleted: boolean }>;
  }
}
