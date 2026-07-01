/**
 * CLI 侧 harness 部署配置（编码端）。
 *
 * 从 packages/agent-runtime/src/{config,harness/deploy,harness/sandbox/sandbox-config,harness/sandbox/sandbox-env}.ts
 * 提取的 CLI 部署逻辑。runtime 侧保留自己的"解码"版本；两边通过 env/yaml 交互，不共享代码。
 *
 * 无 kernel 运行时依赖（kernel 仅作为 TS 类型导入，编译时擦除）。
 */

// ── sandbox-env.ts ─────────────────────────────────────────────────────────

const SANDBOX_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SANDBOX_ENV_VALUE_MAX_LENGTH = 8192;

const SANDBOX_ENV_DENY_EXACT = new Set([
  "SECRET_MASTER_KEY",
  "MCPORTER_CONFIG_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "HARNESS_SKILLS_JSON",
  "HARNESS_CLIENT_TOOLS_JSON",
  "HARNESS_RUNTIME_CALLBACK_URL",
  "HARNESS_ACP_SESSION_ID",
  "CLOUDBASE_ENV_ID",
  "TENCENTCLOUD_SECRETID",
  "TENCENTCLOUD_SECRETKEY",
  "TENCENTCLOUD_SESSIONTOKEN",
  "CLOUDBASE_APIKEY",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
]);

const SANDBOX_ENV_DENY_PREFIXES = ["HARNESS_", "ENABLE_AGENT_"];

function sandboxEnvError(message) {
  return Object.assign(new Error(message), { name: "SandboxConfigError" });
}

function assertSandboxEnvKeyAllowed(name) {
  const key = name.trim();
  if (!SANDBOX_ENV_NAME_PATTERN.test(key)) {
    throw sandboxEnvError(
      `sandbox.env key "${name}" must match ${SANDBOX_ENV_NAME_PATTERN} (UPPER_SNAKE_CASE)`,
    );
  }
  if (SANDBOX_ENV_DENY_EXACT.has(key)) {
    throw sandboxEnvError(
      `sandbox.env cannot override platform-managed key "${key}" (see docs/sandbox.md)`,
    );
  }
  for (const prefix of SANDBOX_ENV_DENY_PREFIXES) {
    if (key.startsWith(prefix)) {
      throw sandboxEnvError(
        `sandbox.env cannot override platform-managed key "${key}" (prefix ${prefix})`,
      );
    }
  }
}

function assertSandboxEnvValueAllowed(name, value) {
  const v = value.trim();
  if (!v) {
    throw sandboxEnvError(`sandbox.env.${name} must be a non-empty string`);
  }
  if (v.length > SANDBOX_ENV_VALUE_MAX_LENGTH) {
    throw sandboxEnvError(
      `sandbox.env.${name} exceeds ${SANDBOX_ENV_VALUE_MAX_LENGTH} characters`,
    );
  }
}

function normalizeSandboxEnv(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw sandboxEnvError("sandbox.env must be a string map");
  }
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw sandboxEnvError(`sandbox.env.${name} must be a string (got ${typeof value})`);
    }
    const str = String(value).trim();
    assertSandboxEnvKeyAllowed(name);
    assertSandboxEnvValueAllowed(name, str);
    out[name.trim()] = str;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── sandbox-config.ts ──────────────────────────────────────────────────────

const DEFAULT_SANDBOX_INFRA = "serverless";
const DEFAULT_SANDBOX_RESOURCES = { cpu: "2", memory: "2Gi" };
const MEMORY_SUFFIX = /^(.*)(Gi|Mi|Ki)$/i;

class SandboxConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

function normalizeCpu(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  throw new SandboxConfigError(`sandbox.resources.cpu must be a string or number, got ${JSON.stringify(value)}`);
}

function normalizeMemory(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return `${value}Gi`;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (MEMORY_SUFFIX.test(trimmed)) return trimmed;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) return `${asNum}Gi`;
    return trimmed;
  }
  throw new SandboxConfigError(
    `sandbox.resources.memory must be a string (e.g. "4Gi") or number, got ${JSON.stringify(value)}`,
  );
}

function normalizeAuth(value) {
  if (value === undefined || value === null || value === "") return "token";
  if (value === "token" || value === "none") return value;
  throw new SandboxConfigError(`sandbox.auth must be "token" or "none", got ${JSON.stringify(value)}`);
}

function normalizeInfra(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_SANDBOX_INFRA;
  if (value === "serverless" || value === "durable") return value;
  throw new SandboxConfigError(`sandbox.infra must be "serverless" or "durable", got ${JSON.stringify(value)}`);
}

function normalizeTimeout(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  throw new SandboxConfigError(`sandbox.timeout must be a string or number, got ${JSON.stringify(value)}`);
}

function normalizeImage(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeImageRegistryType(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "personal" || value === "enterprise") return value;
  throw new SandboxConfigError(
    `sandbox.imageRegistryType must be "personal" or "enterprise", got ${JSON.stringify(value)}`,
  );
}

function resolveSandboxConfig(source, engine) {
  const raw = source.sandbox;
  void (engine ?? source.engine ?? "opencode");

  const infra = normalizeInfra(raw?.infra);
  const auth = normalizeAuth(raw?.auth);
  const resources = {
    cpu: normalizeCpu(raw?.resources?.cpu, DEFAULT_SANDBOX_RESOURCES.cpu),
    memory: normalizeMemory(raw?.resources?.memory, DEFAULT_SANDBOX_RESOURCES.memory),
  };
  const image = normalizeImage(raw?.image);
  const imageRegistryType = normalizeImageRegistryType(raw?.imageRegistryType);
  const timeout = normalizeTimeout(raw?.timeout);
  const env = normalizeSandboxEnv(raw?.env);

  return {
    infra,
    auth,
    resources,
    ...(image ? { image } : {}),
    ...(imageRegistryType ? { imageRegistryType } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(env ? { env } : {}),
  };
}

function applyResolvedSandboxToConfig(config, resolved) {
  return {
    ...config,
    sandbox: {
      infra: resolved.infra,
      auth: resolved.auth,
      resources: { ...resolved.resources },
      ...(resolved.image ? { image: resolved.image } : {}),
      ...(resolved.imageRegistryType ? { imageRegistryType: resolved.imageRegistryType } : {}),
      ...(resolved.timeout !== undefined ? { timeout: resolved.timeout } : {}),
      ...(resolved.env ? { env: { ...resolved.env } } : {}),
    },
  };
}

// ── config.ts ──────────────────────────────────────────────────────────────

function resolveRuntime(config) {
  const runtime = config.runtime === "harness" ? "harness" : "managed";
  const engine =
    config.engine === "claude" ||
    config.engine === "codebuddy" ||
    config.engine === "hermes"
      ? config.engine
      : "opencode";
  return { runtime, engine };
}

function getCustomTools(config) {
  return (config.tools ?? []).filter((t) => t.type === "custom");
}

function normalizeAgentConfig(config) {
  const { runtime } = resolveRuntime(config);
  if (runtime === "harness") {
    const resolved = resolveSandboxConfig({
      sandbox: config.sandbox,
      engine: config.engine,
    });
    return applyResolvedSandboxToConfig(config, resolved);
  }
  return config;
}

// ── deploy.ts ──────────────────────────────────────────────────────────────

const MANAGED_AGENT_CLIENT_MCP_SERVER = "managed-agent-client";
const SANDBOX_TRW_MCP_RELAY_PATH = "/api/harness/mcp-relay";
const SANDBOX_TRW_LOCAL_BASE = "http://127.0.0.1:9000";
const MCPORTER_HTTP_MCP_TYPE = "streamable-http";

function buildManagedAgentClientTools(config) {
  return getCustomTools(config);
}

function isLoopbackHarnessCallback(callbackBase) {
  try {
    const host = new URL(callbackBase).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function buildManagedAgentClientMcpUrl(callbackBase, acpSessionId) {
  const base = callbackBase.replace(/\/$/, "");
  const url = new URL(`${base}/internal/harness/mcp`);
  if (acpSessionId) {
    url.searchParams.set("sessionId", acpSessionId);
  }
  return url.toString();
}

function buildSandboxReachableClientMcpUrl(callbackBase, acpSessionId) {
  if (isLoopbackHarnessCallback(callbackBase)) {
    const url = new URL(`${SANDBOX_TRW_LOCAL_BASE}${SANDBOX_TRW_MCP_RELAY_PATH}`);
    url.searchParams.set("sessionId", acpSessionId);
    return url.toString();
  }
  return buildManagedAgentClientMcpUrl(callbackBase, acpSessionId);
}

function buildMcporterConfig(args) {
  const servers = {};

  for (const s of args.config.mcp_servers ?? []) {
    if (s.type === "url") {
      servers[s.name] = { type: MCPORTER_HTTP_MCP_TYPE, url: s.url };
    }
  }

  const custom = buildManagedAgentClientTools(args.config);
  if (custom.length > 0 && args.acpSessionId) {
    servers[MANAGED_AGENT_CLIENT_MCP_SERVER] = {
      type: MCPORTER_HTTP_MCP_TYPE,
      url: buildSandboxReachableClientMcpUrl(
        args.clientToolCallbackBase,
        args.acpSessionId,
      ),
    };
  } else if (custom.length > 0) {
    servers[MANAGED_AGENT_CLIENT_MCP_SERVER] = {
      type: MCPORTER_HTTP_MCP_TYPE,
      url: buildManagedAgentClientMcpUrl(args.clientToolCallbackBase),
    };
  }

  return { mcpServers: servers };
}

function agentLoopRuntimeFromArgs(args = {}, config = {}) {
  const fromFlag = args["agent-runtime"];
  if (fromFlag === "harness" || fromFlag === "managed") return fromFlag;
  const r = args.runtime;
  if (r === "harness" || r === "managed") return r;
  return config.runtime ?? "managed";
}

function normalizeAgentRuntime(config, args = {}) {
  const runtime = agentLoopRuntimeFromArgs(args, config);
  const engine = args.engine ?? config.engine ?? "opencode";
  if (runtime === "harness") {
    config.runtime = "harness";
    config.engine =
      engine === "claude" || engine === "codebuddy" || engine === "hermes"
        ? engine
        : "opencode";
    return normalizeAgentConfig(config);
  }
  config.runtime = "managed";
  delete config.engine;
  return config;
}

const HARNESS_DEPLOY_ENV_KEYS = [
  "HARNESS_TOOL_ROLE_ARN",
  "TCB_REGION",
  "TCB_SECRET_ID",
  "TCB_SECRET_KEY",
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "HARNESS_COS_ENABLED",
  "HARNESS_COS_BUCKET",
  "HARNESS_COS_BUCKET_PATH",
  "HARNESS_COS_ENDPOINT",
  "HARNESS_COS_REGION",
  "HARNESS_COS_MOUNT_NAME",
  "HARNESS_COS_MOUNT_DIR",
  "CLOUDBASE_SERVER_URL",
];

/** Keep in sync with harness/callback-base.ts */
function harnessGatewayBotBase(envId, agentId) {
  return `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}`;
}

/** Deploy-time callback base for MCPORTER (mirrors runtime harnessCallbackBase). */
function resolveHarnessClientToolCallbackBase(envId, opts = {}) {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");
  const agentId = opts.agentId?.trim();
  const eid = envId?.trim();
  if (eid && agentId) return harnessGatewayBotBase(eid, agentId);
  return "";
}

function forwardHarnessDeployEnv(envMap) {
  for (const key of HARNESS_DEPLOY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) envMap[key] = value;
  }
}

function applyHarnessRuntimeEnv(envMap, config, opts = {}) {
  if (config.runtime !== "harness") return envMap;
  if (opts.harnessToolId) envMap.HARNESS_TOOL_ID = opts.harnessToolId;
  const agentId = opts.agentId?.trim();
  if (agentId) envMap.CLOUDBASE_AGENT_ID = agentId;
  const envId = opts.envId?.trim() ?? envMap.CLOUDBASE_ENV_ID?.trim();
  const callbackBase = resolveHarnessClientToolCallbackBase(envId, opts);
  const mcporter = buildMcporterConfig({
    config,
    clientToolCallbackBase: callbackBase,
  });
  if (Object.keys(mcporter.mcpServers).length) {
    envMap.MCPORTER_CONFIG_CONTENT = JSON.stringify(mcporter);
  }
  forwardHarnessDeployEnv(envMap);
  return envMap;
}

export {
  normalizeAgentRuntime,
  applyHarnessRuntimeEnv,
  resolveHarnessClientToolCallbackBase,
  harnessGatewayBotBase,
  agentLoopRuntimeFromArgs,
  normalizeAgentConfig,
  resolveRuntime,
  getCustomTools,
  buildMcporterConfig,
  buildManagedAgentClientTools,
  buildSandboxReachableClientMcpUrl,
  buildManagedAgentClientMcpUrl,
  isLoopbackHarnessCallback,
  resolveSandboxConfig,
  applyResolvedSandboxToConfig,
  normalizeSandboxEnv,
  MANAGED_AGENT_CLIENT_MCP_SERVER,
  MCPORTER_HTTP_MCP_TYPE,
  HARNESS_DEPLOY_ENV_KEYS,
};
