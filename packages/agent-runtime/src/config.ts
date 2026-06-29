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
import {
  applyResolvedSandboxToConfig,
  resolveSandboxConfig,
} from "./harness/sandbox/sandbox-config.js";

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

export interface ModelSpec {
  /** Model ID, e.g. 'hy3-preview' / 'deepseek-v4-flash' / 'gpt-5' */
  id: string;
  /** Optional. When omitted, the runtime routes through CloudBase TokenHub
   *  (platform billing). When set, requests use this key directly. */
  apiKey?: string;
  /** Endpoint to use with `apiKey` (e.g. an Anthropic-compatible proxy). */
  apiBaseUrl?: string;
  /** Provider-specific options forwarded by the kernel. */
  options?: Record<string, unknown>;
}

/** Where the agent loop runs (`runtime`: local | harness | oak). */
export type AgentRuntimeMode = "managed" | "harness";

/** 箱内引擎（ACP 服务端）when runtime=harness; data-plane slug may differ (D5). */
export type HarnessEngine = "opencode" | "claude" | "codebuddy" | "hermes";

/** TRW route segment: POST /api/agents/{slug}/acp */
export type DataPlaneEngineSlug =
  | "opencode"
  | "claudecode"
  | "codebuddy"
  | "hermes";

/**
 * Sandbox configuration — shared by managed (OAK) and harness runtimes.
 *
 * OAK mode: `provider` selects the backend; `enabled` is legacy inference fallback.
 * Harness mode: `infra`/`resources`/`image`/`timeout`/`env` control AGS placement.
 */
export type SandboxProvider = "ags-stateful" | "local";

export interface SandboxConfig {
  /** OAK sandbox backend. Overrides `enabled`-based inference.
   *  - `ags-stateful`: remote AGS cloud sandbox (requires CLOUDBASE_APIKEY)
   *  - `local`: host process runs SDK built-in tools against cwd (no sandbox)
   *  Default when unset: `ags-stateful` if `enabled=true`, else `local`. */
  provider?: SandboxProvider;
  /** Legacy OAK toggle: `true` → ags-stateful, else → local. Ignored when `provider` is set.
   *  Harness: unused (harness uses `infra`). */
  enabled?: boolean;
  /**
   * Harness-only: sandbox placement (infra, resources, image, timeout, env).
   * Ignored when runtime=managed. Normalized with defaults on load.
   */
  infra?: import("./harness/sandbox/sandbox-config.js").SandboxInfra;
  resources?: import("./harness/sandbox/sandbox-config.js").SandboxResourcesInput;
  image?: string;
  timeout?: string | number;
  env?: Record<string, string>;
}

/**
 * Shared by managed (OAK loop on gateway) and harness (loop in AGS sandbox).
 * Fields like tools / mcp_servers / skills are interpreted per runtime in deploy.ts.
 */
export interface AgentConfig {
  name: string;
  /** Model can be a bare ID string (CloudBase-hosted model) or a ModelSpec
   *  object that brings its own key + endpoint. */
  model: string | ModelSpec;
  system: string;
  description?: string;
  /** `managed` = 托管运行时；`harness` = 沙箱 Agent（Harness 运行时）. */
  runtime?: AgentRuntimeMode;
  /** 箱内引擎（ACP 服务端）. Only when runtime=harness. Default `opencode`. */
  engine?: HarnessEngine;
  tools?: AgentTool[];
  mcp_servers?: McpServer[];
  skills?: Skill[];
  metadata?: Record<string, string>;
  /** Sandbox feature. Managed: `enabled` toggle. Harness: full placement config. */
  sandbox?: SandboxConfig;
  // Storage
  sessions_collection?: string; // NoSQL collection name for sessions, default: "acp_sessions"
}

export interface ResolvedRuntime {
  runtime: AgentRuntimeMode;
  engine: HarnessEngine;
}

export function resolveRuntime(config: AgentConfig): ResolvedRuntime {
  const runtime = config.runtime === "harness" ? "harness" : "managed";
  const engine =
    config.engine === "claude" ||
    config.engine === "codebuddy" ||
    config.engine === "hermes"
      ? config.engine
      : "opencode";
  return { runtime, engine };
}

export function engineToDataPlaneSlug(
  engine: HarnessEngine,
): DataPlaneEngineSlug {
  switch (engine) {
    case "claude":
      return "claudecode";
    case "codebuddy":
      return "codebuddy";
    case "hermes":
      return "hermes";
    default:
      return "opencode";
  }
}

/** Env slug for AGS sandbox tool names (`oma-harness-{slug}`). */
export function harnessEnvSlug(envId: string, maxLen = 40): string {
  return envId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, maxLen) || "default";
}

/** Resolve auto-created AGS tool name for env (`oma-harness-{slug}`; COS is mount config only). */
export function resolveHarnessToolName(
  envId: string,
  _cosEnabled = false,
): string {
  const slug = harnessEnvSlug(envId, 40);
  return `oma-harness-${slug}`;
}

export function harnessToolNameForEnv(envId: string): string {
  return resolveHarnessToolName(envId);
}

/** AGS StartSandboxInstance CustomConfiguration.Env entries (F4 / D1). */
export interface HarnessEnvVar {
  Name: string;
  Value: string;
}

export function buildHarnessInstanceEnv(
  config: AgentConfig,
  engine: HarnessEngine,
): HarnessEnvVar[] {
  const out: HarnessEnvVar[] = [];
  const push = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== "") {
      out.push({ Name: name, Value: value });
    }
  };

  if (engine === "opencode") {
    push("ENABLE_AGENT_OPENCODE", "true");
    push("ENABLE_AGENT_OPENCODE_ACP", "true");
    push("ENABLE_AGENT_OPENCODE_SERVE", "true");
  } else if (engine === "claude") {
    push("ENABLE_AGENT_CLAUDE_ACP", "true");
    push("HARNESS_CLAUDE_SESSION_STORE", "1");
    push("CLAUDE_CONFIG_DIR", "/tmp/.claude");
  } else if (engine === "codebuddy") {
    push("ENABLE_AGENT_CODEBUDDY_ACP", "true");
  } else if (engine === "hermes") {
    // Packer/Talos images only — both toggles match packer/presets/hermes.pkrvars.hcl.
    push("ENABLE_AGENT_HERMES_ACP", "true");
    push("ENABLE_AGENT_HERMES_WEB", "true");
  }

  // SECRET_MASTER_KEY: injected per harness session (harness_sessions.secretMasterKey), not from host env.
  push(
    "INTEGRATION_IDE",
    engine === "codebuddy"
      ? "codebuddy"
      : engine === "claude"
        ? "claude"
        : engine === "hermes"
          ? "hermes"
          : "opencode",
  );
  push("WORKSPACE_FOLDER_PATHS", "/home/user");

  return out;
}

// ── Built-in tool names ───────────────────────────────────────────────────────

/**
 * 内置工具名 — 直接用真实工具名（和 remote sandbox 暴露的一致），
 * 不再有 read_file/write_file/list_files 抽象层。
 *
 *   - local (claude_code preset)：SDK 用首字母大写（Bash/Read/...），
 *     oak-runtime/config.ts 派生审批名时做大小写转换
 *   - remote (ags-stateful)：mcp__sandbox__<name> 前缀，名字本身一致
 */
export const BUILTIN_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

// ── Helper: resolve which built-in tools are enabled ──────────────────────────

export interface ResolvedToolPolicy {
  enabled: boolean;
  permissionPolicy: PermissionPolicy;
}

export function resolveBuiltinTools(
  config: AgentConfig,
): Map<string, ResolvedToolPolicy> {
  const result = new Map<string, ResolvedToolPolicy>();

  // Default: all built-in tools enabled with always_allow
  const defaultPolicy: PermissionPolicy = { type: "always_allow" };
  let defaultEnabled = true;

  // Find agent_toolset in tools config
  const toolset = config.tools?.find(
    (t): t is AgentToolset => t.type === "agent_toolset",
  );

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
        if (cfg.permission_policy)
          existing.permissionPolicy = cfg.permission_policy;
      }
    }
  }

  return result;
}

// ── Helper: get custom tools ──────────────────────────────────────────────────

export function getCustomTools(config: AgentConfig): CustomTool[] {
  return (config.tools ?? []).filter(
    (t): t is CustomTool => t.type === "custom",
  );
}

// ── Helper: get MCP toolsets ──────────────────────────────────────────────────

export function getMcpToolsets(config: AgentConfig): McpToolset[] {
  return (config.tools ?? []).filter(
    (t): t is McpToolset => t.type === "mcp_toolset",
  );
}

// ── Helper: inject skills into system prompt ─────────────────────────────────
//
// Reads each skill's source file and appends its content to config.system.
// Call this after loadAgentConfig() before passing config to toKernelAgentConfig().
//
// Source paths are resolved relative to the agent.yaml location (cwd), or
// absolute if they start with '/'.

export async function resolveSkills(config: AgentConfig): Promise<AgentConfig> {
  const skills = config.skills;
  if (!skills || skills.length === 0) return config;

  const blocks: string[] = [];
  for (const skill of skills) {
    const srcPath = path.isAbsolute(skill.source)
      ? skill.source
      : path.resolve(skill.source);
    try {
      const content = await fs.readFile(srcPath, "utf-8");
      const header = skill.description
        ? `# Skill: ${skill.name}\n${skill.description}\n`
        : `# Skill: ${skill.name}\n`;
      blocks.push(`${header}\n${content.trim()}`);
    } catch (err) {
      console.warn(
        `[Config] Skill '${skill.name}': failed to read ${srcPath}: ${(err as Error).message}`,
      );
    }
  }

  if (blocks.length === 0) return config;

  const skillSection = `\n\n---\n\n## Skills\n\n${blocks.join("\n\n---\n\n")}`;
  return { ...config, system: config.system + skillSection };
}

export type {
  SandboxInfra,
  SandboxConfig as HarnessSandboxConfig,
  SandboxResources,
  ResolvedSandboxConfig,
} from "./harness/sandbox/sandbox-config.js";
export {
  SandboxConfigError,
  DEFAULT_SANDBOX_INFRA,
  DEFAULT_SANDBOX_RESOURCES,
  resolveSandboxConfig,
  resolveSandboxImageRegistryType,
  assertSandboxAcquireAllowed,
  buildAgsSandboxResources,
  applyResolvedSandboxToConfig,
} from "./harness/sandbox/sandbox-config.js";

export {
  normalizeSandboxEnv,
  mergeHarnessInstanceEnv,
  sandboxEnvToHarnessVars,
  SANDBOX_ENV_DENY_EXACT,
} from "./harness/sandbox/sandbox-env.js";

/** Apply sandbox defaults after YAML / AGENT_CONFIG parse (harness or explicit sandbox block). */
export function normalizeAgentConfig(config: AgentConfig): AgentConfig {
  const { runtime } = resolveRuntime(config);
  // For harness: resolve full sandbox placement (infra/resources/image) with defaults.
  // For managed: sandbox.enabled is used as-is; no placement resolution needed.
  if (runtime === "harness") {
    const resolved = resolveSandboxConfig({
      sandbox: config.sandbox,
      engine: config.engine,
    });
    return applyResolvedSandboxToConfig(config, resolved);
  }
  return config;
}

/**
 * Local `.env` / `.env.harness` overrides (dev only). Applied after agent.yaml or AGENT_CONFIG_B64.
 */
export function applyDevEnvOverrides(config: AgentConfig): AgentConfig {
  const next: AgentConfig = { ...config };
  const name = process.env.AGENT_NAME?.trim();
  const system = process.env.AGENT_SYSTEM?.trim();
  const model = process.env.AGENT_MODEL?.trim();
  if (name) next.name = name;
  if (system) next.system = decodeURIComponent(system);
  if (model) next.model = model;
  return normalizeAgentConfig(next);
}

// ── Loader ────────────────────────────────────────────────────────────────────
//
//   1. agent.yaml / agent.yml
//   2. AGENT_CONFIG / AGENT_CONFIG_B64（magent 云上部署）
//   3. AGENT_NAME / AGENT_MODEL / AGENT_SYSTEM
//   4. applyDevEnvOverrides — `.env` / `.env.harness` 与 yaml 重叠项（研发本地）

export async function loadAgentConfig(): Promise<AgentConfig> {
  // Priority 1: YAML file (highest — explicit, version-controlled config)
  const searchPaths = [
    path.resolve("agent.yaml"),
    path.resolve("agent.yml"),
    "/var/user/agent.yaml",
    "/var/user/agent.yml",
  ];

  for (const p of searchPaths) {
    try {
      const content = await fs.readFile(p, "utf-8");
      const config = applyDevEnvOverrides(
        normalizeAgentConfig(parseYaml(content) as AgentConfig),
      );
      console.log(`[Config] Loaded agent config from: ${p}`);
      return config;
    } catch {
      // File not found or parse error, try next
    }
  }

  // Priority 2: AGENT_CONFIG or AGENT_CONFIG_B64 env var (from `magent agent:update`)
  const rawConfig =
    process.env.AGENT_CONFIG ??
    (process.env.AGENT_CONFIG_B64
      ? Buffer.from(process.env.AGENT_CONFIG_B64, "base64").toString("utf-8")
      : null);

  if (rawConfig) {
    try {
      const config = applyDevEnvOverrides(
        normalizeAgentConfig(JSON.parse(rawConfig) as AgentConfig),
      );
      console.log(`[Config] Loaded from AGENT_CONFIG env var`);
      return config;
    } catch (err) {
      console.warn(`[Config] Failed to parse AGENT_CONFIG env var:`, err);
    }
  }

  // Priority 3: pure env vars (backward compatible)
  console.log(
    "[Config] No agent.yaml or AGENT_CONFIG found, using environment variables",
  );
  return applyDevEnvOverrides(
    normalizeAgentConfig({
      name: process.env.AGENT_NAME ?? "open-managed-agent",
      model: process.env.AGENT_MODEL ?? "hy3-preview",
      system: process.env.AGENT_SYSTEM
        ? decodeURIComponent(process.env.AGENT_SYSTEM)
        : "You are a helpful assistant.",
    }),
  );
}
