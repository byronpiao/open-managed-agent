import type { AgentConfig } from "../config.js";

let deploymentConfig: AgentConfig | null = null;

/** Set once at mountManagedAgentsEndpoint — deployment agent.yaml baseline. */
export function setManagedAgentsDeploymentConfig(config: AgentConfig): void {
  deploymentConfig = config;
}

export function getManagedAgentsDeploymentConfig(): AgentConfig {
  if (!deploymentConfig) {
    throw new Error("Managed Agents deployment config not initialized");
  }
  return deploymentConfig;
}

export function resetManagedAgentsDeploymentConfigForTests(): void {
  deploymentConfig = null;
}
