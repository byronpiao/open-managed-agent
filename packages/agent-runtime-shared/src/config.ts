/**
 * Agent Configuration — shared schema + loader (runtime-agnostic).
 *
 * Used by BOTH runtimes (managed/oak-runtime and harness). Keep this file free
 * of runtime-specific imports so it can be built standalone.
 *
 * Runtime-specific config logic lives in each runtime's own `config.ts` shell:
 *   - harness  re-injects sandbox placement + `resolveSkills`
 *   - managed  uses the default no-op normalize here
 *
 * Loads agent configuration from AGENT_CONFIG (cloud) or agent.yaml (local).
 * Prefer agent.yaml (or AGENT_CONFIG_B64 on cloud) for name / model / system.
 * AGENT_NAME / AGENT_MODEL / AGENT_SYSTEM overlay those sources only when
 * AGENT_ENV_OVERRIDES=1 — debug / test only; do not use in product deploys.
 * Falls back to pure env vars if no YAML or AGENT_CONFIG is found.
 */

import fs from "fs/promises";
import path from "path";
import { parse as parseYaml } from "yaml";

// Last config file path that loadAgentConfig read (for resolving relative skill
// sources on the harness side). Tracked here so both runtimes share one source.
let configFilePath: string | undefined;

/** Last agent.yaml path loaded by `loadAgentConfig` (harness skill resolution). */
export function getConfigFilePath(): string | undefined {
  return configFilePath;
}

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

/**
 * Remote HTTP MCP server declared in agent.yaml.
 */
export interface McpServer {
  type: "url";
  name: string;
  url: string;
  [key: string]: unknown;
}

export interface Skill {
  /** Install-time source (magent). Runtime reads skills/<destName>/ in the deploy bundle. */
  source: string;
}

export interface ModelSpec {
  /** Model ID, e.g. 'hy3' / 'deepseek-v4-flash' / 'gpt-5' */
  id: string;
  /** Optional. When omitted, the runtime routes through CloudBase TokenHub
   *  (platform billing). When set, requests use this key directly. */
  apiKey?: string;
  /** Endpoint to use with `apiKey` (e.g. an Anthropic-compatible proxy). */
  apiBaseUrl?: string;
  /** Provider-specific options forwarded by the kernel. */
  options?: Record<string, unknown>;
}

/** Where the agent loop runs. */
export type AgentRuntimeMode = "managed" | "harness";

/** 箱内引擎（ACP 服务端）when runtime=harness; data-plane slug may differ (D5). */
export type HarnessEngine = "opencode" | "claude" | "codebuddy" | "hermes";

/** TRW route segment: POST /api/agents/{slug}/acp */
export type DataPlaneEngineSlug =
  | "opencode"
  | "claudecode"
  | "codebuddy"
  | "hermes";

/** Sandbox placement type — structural, shared by managed & harness configs. */
export type SandboxInfra = "serverless" | "durable";

/** AGS CustomConfiguration resources (cpu/memory). */
export interface SandboxResourcesInput {
  cpu?: string | number;
  memory?: string | number;
}

export type SandboxProvider = "ags-stateful" | "local";

/**
 * Sandbox configuration — shared by managed (OAK) and harness runtimes.
 *
 * OAK mode: `provider` selects the backend; `enabled` is legacy inference fallback.
 * Harness mode: `infra`/`resources`/`image`/`timeout`/`env` control AGS placement.
 */
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
  infra?: SandboxInfra;
  resources?: SandboxResourcesInput;
  image?: string;
  timeout?: string | number;
  env?: Record<string, string>;
}

/**
 * Shared by managed (OAK loop on gateway) and harness (loop in AGS sandbox).
 * Fields like tools / mcp_servers / skills are interpreted per runtime.
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

// ── Built-in tool names ───────────────────────────────────────────────────────

/**
 * 内置工具名 — 直接用真实工具名（和 remote sandbox 暴露的一致），
 * 不再有 read_file/write_file/list_files 抽象层。
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

// ── Normalize hook ────────────────────────────────────────────────────────────
//
// The loader runs a normalize pass after each source. Managed runtime uses the
// default no-op here; the harness runtime injects its own sandbox-placement
// normalizer via loadAgentConfig(normalize).

export type ConfigNormalizer = (config: AgentConfig) => AgentConfig;

export function normalizeAgentConfig(config: AgentConfig): AgentConfig {
  // Managed runtime: no sandbox placement resolution needed.
  return config;
}

/**
 * True when AGENT_ENV_OVERRIDES=1.
 * Debug / test only. Product config belongs in agent.yaml (or AGENT_CONFIG_B64).
 */
export function envOverridesEnabled(): boolean {
  return process.env.AGENT_ENV_OVERRIDES?.trim() === "1";
}

/**
 * Overlay name/model/system from env after agent.yaml or AGENT_CONFIG_B64.
 *
 * No-op unless AGENT_ENV_OVERRIDES=1. For local debugging and harness tests
 * (e.g. AGENT_MODEL=zen). Do not set this in product SCF/TCBR deploys — put
 * name, model, and system in agent.yaml instead.
 */
export function applyDevEnvOverrides(
  config: AgentConfig,
  normalize: ConfigNormalizer = normalizeAgentConfig,
): AgentConfig {
  if (!envOverridesEnabled()) return normalize(config);
  const next: AgentConfig = { ...config };
  const name = process.env.AGENT_NAME?.trim();
  const system = process.env.AGENT_SYSTEM?.trim();
  const model = process.env.AGENT_MODEL?.trim();
  const applied: string[] = [];
  if (name) {
    next.name = name;
    applied.push(`AGENT_NAME=${name}`);
  }
  if (system) {
    next.system = decodeURIComponent(system);
    applied.push("AGENT_SYSTEM");
  }
  if (model) {
    next.model = model;
    applied.push(`AGENT_MODEL=${model}`);
  }
  if (applied.length > 0) {
    console.warn(
      `[Config] AGENT_ENV_OVERRIDES=1: env overlays yaml (${applied.join(", ")})`,
    );
  } else {
    console.warn(
      `[Config] AGENT_ENV_OVERRIDES=1: on, but no AGENT_NAME/MODEL/SYSTEM set`,
    );
  }
  return normalize(next);
}

// ── Loader ────────────────────────────────────────────────────────────────────
//
//   1. AGENT_CONFIG / AGENT_CONFIG_B64（magent agent:update 写入，云上权威）
//   2. agent.yaml / agent.yml（本地研发 / 首次 bootstrap；对客改配置用这个）
//   3. AGENT_NAME / AGENT_MODEL / AGENT_SYSTEM（无文件时的配置源）
//   4. applyDevEnvOverrides — 仅 AGENT_ENV_OVERRIDES=1（调试/测试）时覆盖 1/2
//      对客不要用这些变量改模型或 prompt，写 agent.yaml

export async function loadAgentConfig(
  normalize: ConfigNormalizer = normalizeAgentConfig,
): Promise<AgentConfig> {
  // Priority 1: AGENT_CONFIG env (authoritative after magent agent:update on cloud)
  const rawConfig =
    process.env.AGENT_CONFIG ??
    (process.env.AGENT_CONFIG_B64
      ? Buffer.from(process.env.AGENT_CONFIG_B64, "base64").toString("utf-8")
      : null);

  if (rawConfig) {
    try {
      const config = applyDevEnvOverrides(
        normalize(JSON.parse(rawConfig) as AgentConfig),
        normalize,
      );
      console.log(`[Config] Loaded from AGENT_CONFIG env var`);
      return config;
    } catch (err) {
      console.warn(`[Config] Failed to parse AGENT_CONFIG env var:`, err);
    }
  }

  // Priority 2: YAML file (local dev bootstrap)
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
        normalize(parseYaml(content) as AgentConfig),
        normalize,
      );
      configFilePath = p;
      console.log(`[Config] Loaded agent config from: ${p}`);
      return config;
    } catch {
      // File not found or parse error, try next
    }
  }

  // Priority 3: pure env vars (backward compatible)
  console.log(
    "[Config] No agent.yaml or AGENT_CONFIG found, using environment variables",
  );
  return applyDevEnvOverrides(
    normalize({
      name: process.env.AGENT_NAME ?? "open-managed-agent",
      model: process.env.AGENT_MODEL ?? "hy3",
      system: process.env.AGENT_SYSTEM
        ? decodeURIComponent(process.env.AGENT_SYSTEM)
        : "You are a helpful assistant.",
    }),
    normalize,
  );
}
