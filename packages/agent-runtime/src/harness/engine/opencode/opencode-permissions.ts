/**
 * Map agent.yaml permission_policy → opencode.json `permission` block.
 * @see https://opencode.ai/docs/permissions/
 */

import {
  getMcpToolsets,
  resolveBuiltinTools,
  type AgentConfig,
} from "../../../config.js";

/**
 * Built-in tool names (真实名) → opencode permission keys.
 * opencode 把 6 个工具合并成 4 个 permission key：write+edit→edit, glob+grep→glob。
 * @see https://opencode.ai/docs/permissions/
 */
const BUILTIN_TO_OPENCODE: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "edit",
  edit: "edit",
  glob: "glob",
  grep: "glob",
};

export type OpencodePermissionValue = string | Record<string, string>;

export function buildHarnessOpencodePermission(
  config: AgentConfig,
): Record<string, OpencodePermissionValue> {
  const permission: Record<string, OpencodePermissionValue> = {};

  for (const [name, policy] of resolveBuiltinTools(config)) {
    const opencodeKey = BUILTIN_TO_OPENCODE[name];
    if (
      opencodeKey &&
      policy.enabled &&
      policy.permissionPolicy.type === "always_ask"
    ) {
      permission[opencodeKey] = "ask";
    }
  }

  for (const toolset of getMcpToolsets(config)) {
    const server = toolset.mcp_server_name;
    if (!server) continue;
    if (toolset.default_config?.permission_policy?.type === "always_ask") {
      permission[`${server}_*`] = "ask";
    }
    for (const cfg of toolset.configs ?? []) {
      if (cfg.permission_policy?.type === "always_ask" && cfg.name) {
        permission[`${server}_${cfg.name}`] = "ask";
      }
    }
  }

  return permission;
}
