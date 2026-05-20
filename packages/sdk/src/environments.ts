import type {
  Environment,
  CreateEnvironmentParams,
  ListResponse,
  CloudbaseAgentsConfig,
} from "./types.js";

export class EnvironmentsResource {
  constructor(private config: CloudbaseAgentsConfig) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.accessKey) h["Authorization"] = `Bearer ${this.config.accessKey}`;
    if (this.config.envId) h["X-CloudBase-Env-Id"] = this.config.envId;
    return h;
  }

  async create(params: CreateEnvironmentParams): Promise<Environment> {
    const res = await fetch(`${this.config.baseURL}/environments`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name: params.name,
        config: params.config ?? {
          type: "cloud",
          networking: { type: "unrestricted" },
        },
      }),
    });
    if (!res.ok) throw new Error(`Failed to create environment: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Environment>;
  }

  async retrieve(envId: string): Promise<Environment> {
    const res = await fetch(`${this.config.baseURL}/environments/${envId}`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to retrieve environment: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Environment>;
  }

  async list(): Promise<ListResponse<Environment>> {
    const res = await fetch(`${this.config.baseURL}/environments`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to list environments: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ListResponse<Environment>>;
  }

  async delete(envId: string): Promise<{ id: string; deleted: boolean }> {
    const res = await fetch(`${this.config.baseURL}/environments/${envId}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Failed to delete environment: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ id: string; deleted: boolean }>;
  }
}
