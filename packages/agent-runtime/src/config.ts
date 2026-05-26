/**
 * Agent Configuration Loader
 *
 * Loads agent configuration from agent.yaml (or agent.yml).
 * Env vars AGENT_MODEL / AGENT_SYSTEM can override YAML values.
 * Falls back to pure env vars if no YAML file is found (backward compatible).
 *
 * Configuration schema mirrors Anthropic Managed Agents API:
 * https://platform.claude.com/docs/en/managed-agents/agent-setup
 */

import fs from "fs/promises";
import path from "path";
import { parse as parseYaml } from "yaml";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PermissionPolicy {
  type: "always_allow" | "always_ask";
}

export interface AgentToolConfig {
  name: string;
  enabled?: boolean;
  permission_policy?: PermissionPolicy;
}

export interface AgentToolset {
  type: "agent_toolset";
  default_config?: {
    enabled?: boolean;
    permission_policy?: PermissionPolicy;
  };
  configs?: AgentToolConfig[];
}

export interface CustomTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface McpToolset {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config?: {
    enabled?: boolean;
    permission_policy?: PermissionPolicy;
  };
  configs?: AgentToolConfig[];
}

export type AgentTool = AgentToolset | CustomTool | McpToolset;

export interface McpServer {
  type: "url";
  name: string;
  url: string;
}

export interface Skill {
  name: string;
  description?: string;
  source: string;
}

export interface AgentConfig {
  name: string;
  model: string;
  system: string;
  description?: string;
  tools?: AgentTool[];
  mcp_servers?: McpServer[];
  skills?: Skill[];
  metadata?: Record<string, string>;
  // Storage
  sessions_collection?: string; // NoSQL collection name for sessions, default: "acp_sessions"
}

// ── Built-in tool names ───────────────────────────────────────────────────────

export const BUILTIN_TOOL_NAMES = [
  "bash",
  "read_file",
  "write_file",
  "list_files",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

// ── Helper: resolve which built-in tools are enabled ──────────────────────────

export interface ResolvedToolPolicy {
  enabled: boolean;
  permissionPolicy: PermissionPolicy;
}

export function resolveBuiltinTools(config: AgentConfig): Map<string, ResolvedToolPolicy> {
  const result = new Map<string, ResolvedToolPolicy>();

  // Default: all built-in tools enabled with always_allow
  const defaultPolicy: PermissionPolicy = { type: "always_allow" };
  let defaultEnabled = true;

  // Find agent_toolset in tools config
  const toolset = config.tools?.find((t): t is AgentToolset => t.type === "agent_toolset");

  if (toolset?.default_config) {
    if (toolset.default_config.enabled !== undefined) {
      defaultEnabled = toolset.default_config.enabled;
    }
    if (toolset.default_config.permission_policy) {
      Object.assign(defaultPolicy, toolset.default_config.permission_policy);
    }
  }

  // Initialize all built-in tools with defaults
  for (const name of BUILTIN_TOOL_NAMES) {
    result.set(name, {
      enabled: defaultEnabled,
      permissionPolicy: { ...defaultPolicy },
    });
  }

  // Apply per-tool overrides
  if (toolset?.configs) {
    for (const cfg of toolset.configs) {
      const existing = result.get(cfg.name);
      if (existing) {
        if (cfg.enabled !== undefined) existing.enabled = cfg.enabled;
        if (cfg.permission_policy) existing.permissionPolicy = cfg.permission_policy;
      }
    }
  }

  return result;
}

// ── Helper: get custom tools ──────────────────────────────────────────────────

export function getCustomTools(config: AgentConfig): CustomTool[] {
  return (config.tools ?? []).filter((t): t is CustomTool => t.type === "custom");
}

// ── Helper: get MCP toolsets ──────────────────────────────────────────────────

export function getMcpToolsets(config: AgentConfig): McpToolset[] {
  return (config.tools ?? []).filter((t): t is McpToolset => t.type === "mcp_toolset");
}

// ── Loader ────────────────────────────────────────────────────────────────────
//
// Loading priority:
//   1. AGENT_CONFIG env var (full JSON) — highest priority, set by `magent agent:update`
//   2. agent.yaml / agent.yml file — bundled with code at deploy time
//   3. Individual env vars (AGENT_MODEL, AGENT_SYSTEM, AGENT_NAME) — backward compat fallback
//
// Within each level, individual env vars (AGENT_MODEL etc.) can still override scalar fields.

export async function loadAgentConfig(): Promise<AgentConfig> {
  // Priority 1: AGENT_CONFIG or AGENT_CONFIG_B64 env var (from `magent agent:update`)
  const rawConfig = process.env.AGENT_CONFIG
    ?? (process.env.AGENT_CONFIG_B64
      ? Buffer.from(process.env.AGENT_CONFIG_B64, "base64").toString("utf-8")
      : null);

  if (rawConfig) {
    try {
      const config = JSON.parse(rawConfig) as AgentConfig;
      console.log(`[Config] Loaded from AGENT_CONFIG env var`);
      // Individual env vars still override scalar fields
      if (process.env.AGENT_MODEL) config.model = process.env.AGENT_MODEL;
      if (process.env.AGENT_SYSTEM) config.system = decodeURIComponent(process.env.AGENT_SYSTEM);
      if (process.env.AGENT_NAME) config.name = process.env.AGENT_NAME;
      return config;
    } catch (err) {
      console.warn(`[Config] Failed to parse AGENT_CONFIG env var:`, err);
    }
  }

  // Priority 2: YAML file
  const searchPaths = [
    path.resolve("agent.yaml"),
    path.resolve("agent.yml"),
    "/var/user/agent.yaml",
    "/var/user/agent.yml",
  ];

  for (const p of searchPaths) {
    try {
      const content = await fs.readFile(p, "utf-8");
      const config = parseYaml(content) as AgentConfig;
      console.log(`[Config] Loaded agent config from: ${p}`);

      // Env vars override simple fields
      if (process.env.AGENT_MODEL) config.model = process.env.AGENT_MODEL;
      if (process.env.AGENT_SYSTEM) config.system = decodeURIComponent(process.env.AGENT_SYSTEM);
      if (process.env.AGENT_NAME) config.name = process.env.AGENT_NAME;

      return config;
    } catch {
      // File not found or parse error, try next
    }
  }

  // Priority 3: pure env vars (backward compatible)
  console.log("[Config] No agent.yaml found, using environment variables");
  return {
    name: process.env.AGENT_NAME ?? "open-managed-agent",
    model: process.env.AGENT_MODEL ?? "hunyuan-t1-latest",
    system: process.env.AGENT_SYSTEM
      ? decodeURIComponent(process.env.AGENT_SYSTEM)
      : "You are a helpful assistant.",
  };
}
