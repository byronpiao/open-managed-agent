/**
 * Merge deployment agent.yaml (base) with MA Environment + Agent records
 * into an effective in-memory AgentConfig for harness orchestration.
 */
import {
  resolveRuntime,
  type AgentConfig,
  type HarnessEngine,
} from "../config.js";
import type {
  CmaAgentRecord,
  CmaEnvironmentRecord,
  CmaStore,
} from "./vendor/cma-store-types.js";

function metaString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseHarnessEngine(
  value: string | undefined,
  fallback: HarnessEngine,
): HarnessEngine {
  if (
    value === "opencode" ||
    value === "claude" ||
    value === "codebuddy" ||
    value === "hermes"
  ) {
    return value;
  }
  return fallback;
}

function metadataStrings(metadata: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Pure merge: base deployment config ← environment (infra) ← agent (cognitive). */
export function mergeManagedAgentsAgentConfig(
  base: AgentConfig,
  agent: CmaAgentRecord | null,
  environment: CmaEnvironmentRecord | null,
): AgentConfig {
  const { engine: baseEngine } = resolveRuntime(base);

  const engineFromMa =
    (environment ? metaString(environment.metadata, "engine") : undefined) ??
    (agent ? metaString(agent.metadata, "engine") : undefined);
  const engine = parseHarnessEngine(engineFromMa, baseEngine);

  const merged: AgentConfig = {
    ...base,
    runtime: "harness",
    engine,
    metadata: { ...(base.metadata ?? {}) },
  };

  if (environment) {
    const harnessToolId = metaString(environment.metadata, "harness_tool_id");
    const cosEnabled = metaString(environment.metadata, "cos_enabled");
    merged.metadata = {
      ...merged.metadata,
      ...metadataStrings(environment.metadata),
      managed_agents_environment_id: environment.id,
      ...(harnessToolId ? { harness_tool_id: harnessToolId } : {}),
      ...(cosEnabled ? { cos_enabled: cosEnabled } : {}),
    };
  }

  if (agent) {
    if (agent.name.trim()) merged.name = agent.name.trim();
    const model = metaString(agent.metadata, "model");
    if (model) merged.model = model;
    const system = metaString(agent.metadata, "system");
    if (system) merged.system = system;
    const description = metaString(agent.metadata, "description");
    if (description) merged.description = description;
    merged.metadata = {
      ...merged.metadata,
      ...metadataStrings(agent.metadata),
      managed_agents_agent_id: agent.id,
    };
  }

  return merged;
}

/** Load session bindings from store and merge into effective AgentConfig. */
export async function resolveManagedAgentsSessionConfig(
  base: AgentConfig,
  store: CmaStore,
  sessionId: string,
): Promise<AgentConfig> {
  const session = await store.getSession(sessionId);
  if (!session) {
    return { ...base, runtime: "harness" };
  }

  const [agent, environment] = await Promise.all([
    session.agentId ? store.getAgent(session.agentId) : Promise.resolve(null),
    session.environmentId ? store.getEnvironment(session.environmentId) : Promise.resolve(null),
  ]);

  return mergeManagedAgentsAgentConfig(base, agent, environment);
}

export async function resolveHarnessEngineForMaSession(
  base: AgentConfig,
  store: CmaStore,
  sessionId: string,
): Promise<HarnessEngine> {
  const merged = await resolveManagedAgentsSessionConfig(base, store, sessionId);
  return resolveRuntime(merged).engine;
}
