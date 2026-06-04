/**
 * @deprecated Environment management is handled via `magent` CLI, not the SDK.
 * The runtime does not implement REST endpoints for /environments.
 */
import type {
  Environment,
  CreateEnvironmentParams,
  ListResponse,
  ManagedAgentsConfig,
} from "./types.js";

const ERR = "Not supported: use `magent env:*` CLI commands instead.";

export class EnvironmentsResource {
  constructor(_config: ManagedAgentsConfig) {}

  /** @deprecated Use `magent env:create` */
  async create(_params: CreateEnvironmentParams): Promise<Environment> {
    throw new Error(`environments.create() — ${ERR}`);
  }

  /** @deprecated Use CloudBase console or tcb CLI */
  async retrieve(_envId: string): Promise<Environment> {
    throw new Error(`environments.retrieve() — ${ERR}`);
  }

  /** @deprecated Use `magent env:list` */
  async list(): Promise<ListResponse<Environment>> {
    throw new Error(`environments.list() — ${ERR}`);
  }

  /** @deprecated Use CloudBase console or tcb CLI */
  async delete(_envId: string): Promise<{ id: string; deleted: boolean }> {
    throw new Error(`environments.delete() — ${ERR}`);
  }
}
