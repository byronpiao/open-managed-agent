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
import { createRequire } from "module";
import { parse as parseYaml } from "yaml";

const nodeRequire = createRequire(import.meta.url);

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
  /** Model ID, e.g. 'hunyuan-t1-latest' / 'deepseek-v3.2' / 'gpt-5' */
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
export type HarnessEngine = "opencode" | "claude" | "codebuddy";

/** TRW route segment: POST /api/agents/{slug}/acp */
export type DataPlaneEngineSlug = "opencode" | "claudecode" | "codebuddy";

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
    config.engine === "claude" || config.engine === "codebuddy"
      ? config.engine
      : "opencode";
  return { runtime, engine };
}

export function engineToDataPlaneSlug(engine: HarnessEngine): DataPlaneEngineSlug {
  switch (engine) {
    case "claude":
      return "claudecode";
    case "codebuddy":
      return "codebuddy";
    default:
      return "opencode";
  }
}

export function harnessToolNameForEnv(envId: string): string {
  const slug = envId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48);
  return `harness-${slug || "default"}`;
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
  } else {
    push("ENABLE_AGENT_CODEBUDDY_ACP", "true");
  }

  push("SECRET_MASTER_KEY", process.env.SECRET_MASTER_KEY);
  push("INTEGRATION_IDE", engine === "codebuddy" ? "codebuddy" : engine === "claude" ? "claude" : "opencode");
  push("WORKSPACE_FOLDER_PATHS", "/home/user");

  return out;
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
      console.warn(`[Config] Skill '${skill.name}': failed to read ${srcPath}: ${(err as Error).message}`);
    }
  }

  if (blocks.length === 0) return config;

  const skillSection = `\n\n---\n\n## Skills\n\n${blocks.join("\n\n---\n\n")}`;
  return { ...config, system: config.system + skillSection };
}

// ── Mapping to kernel AgentConfig ─────────────────────────────────────────────

import {
  AgsStatefulSandbox,
  CloudBaseDbDriver,
  CloudBaseSessionStore,
  InMemoryDriver,
  InMemoryPermissionStore,
  type AgentConfig as KernelAgentConfig,
  type CloudBaseCredentials,
  type McpServerConfig as KernelMcpServerConfig,
  type RequireApprovalRule,
} from "@cloudbase/open-agent-kernel";

export interface ToKernelOptions {
  /** Override envId; default reads CLOUDBASE_ENV_ID env var */
  envId?: string;
  /** Use in-memory store instead of CloudBase DB (tests). Default: false */
  useInMemoryStore?: boolean;
  /** ToolDefinition[] built from AgentConfig.tools[type=custom], passed by kernel-adapter */
  customToolDefs?: import("@cloudbase/open-agent-kernel").ToolDefinition[];
}

/**
 * Resolve CloudBase credentials in this priority order:
 *   1. process.env.TCB_SECRET_ID / TCB_SECRET_KEY (production / SCF)
 *   2. process.env.TENCENTCLOUD_SECRETID / SECRETKEY (SCF auto-injected)
 *   3. ~/.config/.cloudbase/auth.json (`tcb login` cache, local dev)
 * Returns null if nothing is found — let the kernel raise its own error then.
 */
function resolveCloudBaseCredentials(envId: string): CloudBaseCredentials | null {
  const env = process.env;
  const secretId  = env.TCB_SECRET_ID  ?? env.TENCENTCLOUD_SECRETID;
  const secretKey = env.TCB_SECRET_KEY ?? env.TENCENTCLOUD_SECRETKEY;
  const sessionToken = env.TCB_TOKEN ?? env.TENCENTCLOUD_SESSIONTOKEN ?? env.TENCENTCLOUD_TOKEN;
  if (secretId && secretKey) {
    return { envId, secretId, secretKey, sessionToken };
  }
  // Fallback: tcb CLI login cache (local development convenience)
  try {
    const home = env.HOME ?? env.USERPROFILE;
    if (!home) return null;
    // ESM-safe sync FS access via createRequire is overkill; use fs module directly.
    // We import lazily to avoid pulling fs at module load time in environments
    // where it is unavailable (e.g. browser bundles).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = nodeRequire("fs") as typeof import("fs");
    const authPath = `${home}/.config/.cloudbase/auth.json`;
    if (!fs.existsSync(authPath)) return null;
    const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const c = raw?.credential;
    if (!c?.tmpSecretId || !c?.tmpSecretKey) return null;
    if (c.tmpExpired && Date.now() >= Number(c.tmpExpired)) {
      console.warn(
        "[Config] tcb login credentials in ~/.config/.cloudbase/auth.json have expired; run `tcb login` to refresh.",
      );
      return null;
    }
    return {
      envId,
      secretId: c.tmpSecretId,
      secretKey: c.tmpSecretKey,
      sessionToken: c.tmpToken,
    };
  } catch (err) {
    console.warn("[Config] Failed to read tcb login credentials:", (err as Error).message);
    return null;
  }
}

/**
 * Translate the YAML-shaped `AgentConfig` into a kernel `AgentConfig`.
 *
 * - `system` → `systemPrompt`
 * - `model` → forwarded as ModelInput (string form)
 * - `mcp_servers[]` → kernel `mcpServers` map (HTTP transport)
 * - tools with `permission_policy.type === 'always_ask'` → `permissions.requireApproval`
 *   (string-array rule). MCP tool names are namespaced as `mcp__<server>__<tool>`.
 * - Sandbox: AGS stateful sandbox with `scope: 'session'`, cloudbaseTools off (one-shot).
 * - Session store: CloudBaseSessionStore + CloudBaseDbDriver (`oak_*` collections),
 *   `projectKey = envId` for multi-tenant isolation.
 */
export function toKernelAgentConfig(
  config: AgentConfig,
  opts: ToKernelOptions = {},
): KernelAgentConfig {
  const envId = opts.envId ?? process.env.CLOUDBASE_ENV_ID ?? "";
  if (!envId) {
    throw new Error("toKernelAgentConfig: envId is required (set CLOUDBASE_ENV_ID)");
  }

  // ── MCP servers ─────────────────────────────────────────────────────────
  const mcpServers: Record<string, KernelMcpServerConfig> = {};
  for (const s of config.mcp_servers ?? []) {
    if (s.type === "url") {
      mcpServers[s.name] = { type: "http", url: s.url } as KernelMcpServerConfig;
    }
  }

  // ── requireApproval rule ────────────────────────────────────────────────
  const approvalNames: string[] = [];
  // Built-in tools (sandbox provides them; tool names follow `mcp__sandbox__*` convention)
  const builtinPolicies = resolveBuiltinTools(config);
  for (const [name, policy] of builtinPolicies) {
    if (policy.enabled && policy.permissionPolicy.type === "always_ask") {
      approvalNames.push(`mcp__sandbox__${name}`);
    }
  }
  // MCP toolset overrides
  for (const t of getMcpToolsets(config)) {
    const defaultAsk = t.default_config?.permission_policy?.type === "always_ask";
    if (defaultAsk) approvalNames.push(`mcp__${t.mcp_server_name}__*`);
    for (const cfg of t.configs ?? []) {
      if (cfg.permission_policy?.type === "always_ask") {
        approvalNames.push(`mcp__${t.mcp_server_name}__${cfg.name}`);
      }
    }
  }
  const requireApproval: RequireApprovalRule | undefined =
    approvalNames.length > 0 ? approvalNames : undefined;

  // ── Session store ───────────────────────────────────────────────────────
  // OAK_USE_MEMORY_STORE=1 → all session/transcript persistence in-memory.
  // Useful for local dev when CloudBase DB credentials are unavailable.
  const useMemoryStore = opts.useInMemoryStore || process.env.OAK_USE_MEMORY_STORE === "1";
  let sessionStore: unknown;
  if (useMemoryStore) {
    sessionStore = new CloudBaseSessionStore({
      driver: new InMemoryDriver(),
      projectKey: envId,
    });
  } else {
    const credentials = resolveCloudBaseCredentials(envId);
    sessionStore = new CloudBaseSessionStore({
      driver: new CloudBaseDbDriver(credentials ? { credentials } : undefined),
      projectKey: envId,
    });
  }

  // ── Model spec ──────────────────────────────────────────────────────────
  // Canonical config form is ModelSpec ({id, apiKey, apiBaseUrl, options}) in
  // agent.yaml. A bare string in `model` is auto-promoted to {id: <string>}
  // and routed through CloudBase TokenHub.
  const baseModel: ModelSpec = typeof config.model === "string"
    ? { id: config.model }
    : { ...config.model };
  // Pass the bare ID through if no key/url is set — the kernel can still
  // recognize a hosted model by name and route it through TokenHub.
  const model: string | ModelSpec = baseModel.apiKey || baseModel.apiBaseUrl || baseModel.options
    ? baseModel
    : baseModel.id;

  // ── Sandbox capabilities ─────────────────────────────────────────────────
  // Map agent_toolset enabled flags → SandboxCapabilities.
  //   bash         → shell
  //   read_file / write_file / list_files → filesystem
  // If no agent_toolset is configured, default is all enabled.
  const builtinPoliciesForCaps = resolveBuiltinTools(config);
  const shellEnabled = builtinPoliciesForCaps.get("bash")?.enabled ?? true;
  const fsEnabled =
    (builtinPoliciesForCaps.get("read_file")?.enabled ?? true) ||
    (builtinPoliciesForCaps.get("write_file")?.enabled ?? true) ||
    (builtinPoliciesForCaps.get("list_files")?.enabled ?? true);
  const sandboxCapabilities = (!shellEnabled || !fsEnabled)
    ? { shell: shellEnabled, filesystem: fsEnabled }
    : undefined; // omit when all enabled — kernel defaults to all-on

  // ── Sandbox ─────────────────────────────────────────────────────────────
  // AGS sandbox needs TCB_API_KEY (data plane) + TCB_SECRET_* (control plane).
  // Set OAK_DISABLE_SANDBOX=1 for local dev where those aren't available.
  const disableSandbox = process.env.OAK_DISABLE_SANDBOX === "1";

  return {
    envId,
    name: config.name,
    description: config.description,
    metadata: config.metadata,
    model,
    systemPrompt: config.system,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    sandbox: disableSandbox
      ? undefined
      : {
          runtime: new AgsStatefulSandbox(),
          scope: "session",
          cloudbaseTools: false,
          ...(sandboxCapabilities ? { capabilities: sandboxCapabilities } : {}),
        },
    permissions: requireApproval
      ? {
          requireApproval,
          store: new InMemoryPermissionStore(),
        }
      : undefined,
    session: {
      store: sessionStore,
      projectKey: envId,
    },
    tools: opts.customToolDefs && opts.customToolDefs.length > 0
      ? opts.customToolDefs
      : undefined,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────
//
// Loading priority:
//   1. agent.yaml / agent.yml file — highest priority; present only when the
//      user explicitly created one (e.g. cp agent.yaml.example agent.yaml).
//      The template ships as agent.yaml.example so the default deploy carries
//      no yaml, letting AGENT_CONFIG_B64 drive config in the cloud.
//   2. AGENT_CONFIG / AGENT_CONFIG_B64 env var — written by `magent agent:update`
//      (the normal cloud path when no yaml file is present)
//   3. Individual env vars (AGENT_MODEL, AGENT_SYSTEM, AGENT_NAME) — backward compat fallback
//
// Rationale: a user-placed agent.yaml is an intentional, version-controlled
// override that should always win. Without it, the cloud operator controls
// the config via env vars — no yaml means no accidental bundled config freeze.

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
      const config = parseYaml(content) as AgentConfig;
      console.log(`[Config] Loaded agent config from: ${p}`);
      return config;
    } catch {
      // File not found or parse error, try next
    }
  }

  // Priority 2: AGENT_CONFIG or AGENT_CONFIG_B64 env var (from `magent agent:update`)
  const rawConfig = process.env.AGENT_CONFIG
    ?? (process.env.AGENT_CONFIG_B64
      ? Buffer.from(process.env.AGENT_CONFIG_B64, "base64").toString("utf-8")
      : null);

  if (rawConfig) {
    try {
      const config = JSON.parse(rawConfig) as AgentConfig;
      console.log(`[Config] Loaded from AGENT_CONFIG env var`);
      return config;
    } catch (err) {
      console.warn(`[Config] Failed to parse AGENT_CONFIG env var:`, err);
    }
  }

  // Priority 3: pure env vars (backward compatible)
  console.log("[Config] No agent.yaml or AGENT_CONFIG found, using environment variables");
  return {
    name: process.env.AGENT_NAME ?? "open-managed-agent",
    model: process.env.AGENT_MODEL ?? "hunyuan-t1-latest",
    system: process.env.AGENT_SYSTEM
      ? decodeURIComponent(process.env.AGENT_SYSTEM)
      : "You are a helpful assistant.",
  };
}
