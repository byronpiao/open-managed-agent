/**
 * OAK runtime config — kernel AgentConfig mapping.
 *
 * Extracted from `src/config.ts` to keep the OAK-specific `toKernelAgentConfig`
 * (and its `@cloudbase/open-agent-kernel` type dependencies) physically
 * separate from the shared `AgentConfig` schema. Both modes (oak + harness)
 * still share `AgentConfig`, `getCustomTools`, `resolveBuiltinTools`,
 * `getMcpToolsets` from `../config.js`.
 */

import { createRequire } from "module";
import {
  type AgentConfig as KernelAgentConfig,
  type CloudBaseCredentials,
  type McpServerConfig as KernelMcpServerConfig,
  type RequireApprovalRule,
  type ToolDefinition,
} from "@cloudbase/open-agent-kernel";

import type { AgentConfig, ModelSpec } from "../config.js";
import { resolveBuiltinTools, getMcpToolsets } from "../config.js";

const nodeRequire = createRequire(import.meta.url);

export interface ToKernelOptions {
  /** Override envId; default reads CLOUDBASE_ENV_ID env var */
  envId?: string;
  /** ToolDefinition[] built from AgentConfig.tools[type=custom], passed by kernel-adapter */
  customToolDefs?: ToolDefinition[];
}

/**
 * Resolve CloudBase credentials in this priority order:
 *   1. process.env.TCB_SECRET_ID / TCB_SECRET_KEY (production / SCF)
 *   2. process.env.TENCENTCLOUD_SECRETID / SECRETKEY (SCF auto-injected)
 *   3. ~/.config/.cloudbase/auth.json (`tcb login` cache, local dev)
 * Returns null if nothing is found — let the kernel raise its own error then.
 */
function resolveCloudBaseCredentials(
  envId: string,
): CloudBaseCredentials | null {
  const env = process.env;
  const secretId = env.TCB_SECRET_ID ?? env.TENCENTCLOUD_SECRETID;
  const secretKey = env.TCB_SECRET_KEY ?? env.TENCENTCLOUD_SECRETKEY;
  const sessionToken =
    env.TCB_TOKEN ?? env.TENCENTCLOUD_SESSIONTOKEN ?? env.TENCENTCLOUD_TOKEN;
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
    console.warn(
      "[Config] Failed to read tcb login credentials:",
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Translate the YAML-shaped `AgentConfig` into a kernel `AgentConfig`.
 *
 * Kernel beta now handles most defaults declaratively:
 *   - `credentials` → auto-creates CloudBaseDbDriver for session/permission store
 *   - `sandbox: { enabled: true }` → auto-creates AgsStatefulSandbox
 *   - `session: { enabled: true }` → auto-creates CloudBaseSessionStore + driver
 *
 * We no longer manually instantiate CloudBaseDbDriver / CloudBaseSessionStore /
 * AgsStatefulSandbox / InMemoryPermissionStore.
 */
export function toKernelAgentConfig(
  config: AgentConfig,
  opts: ToKernelOptions = {},
): KernelAgentConfig {
  const envId = opts.envId ?? process.env.CLOUDBASE_ENV_ID ?? "";
  if (!envId) {
    throw new Error(
      "toKernelAgentConfig: envId is required (set CLOUDBASE_ENV_ID)",
    );
  }

  // ── MCP servers ─────────────────────────────────────────────────────────
  const mcpServers: Record<string, KernelMcpServerConfig> = {};
  for (const s of config.mcp_servers ?? []) {
    if (s.type === "url") {
      mcpServers[s.name] = {
        type: "http",
        url: s.url,
      } as KernelMcpServerConfig;
    }
  }

  // ── requireApproval rule ────────────────────────────────────────────────
  const approvalNames: string[] = [];
  const builtinPolicies = resolveBuiltinTools(config);
  for (const [name, policy] of builtinPolicies) {
    if (policy.enabled && policy.permissionPolicy.type === "always_ask") {
      approvalNames.push(`mcp__sandbox__${name}`);
    }
  }
  for (const t of getMcpToolsets(config)) {
    const defaultAsk =
      t.default_config?.permission_policy?.type === "always_ask";
    if (defaultAsk) approvalNames.push(`mcp__${t.mcp_server_name}__*`);
    for (const cfg of t.configs ?? []) {
      if (cfg.permission_policy?.type === "always_ask") {
        approvalNames.push(`mcp__${t.mcp_server_name}__${cfg.name}`);
      }
    }
  }
  const requireApproval: RequireApprovalRule | undefined =
    approvalNames.length > 0 ? approvalNames : undefined;

  // ── Credentials ─────────────────────────────────────────────────────────
  // Resolve from env vars or tcb login cache; pass to kernel declaratively.
  // Kernel auto-creates CloudBaseDbDriver / CloudBaseSessionStore / permission store
  // when credentials are provided. Without credentials, kernel falls back to
  // in-memory stores (no persistence, but safe for local dev).
  //
  // When no CAM credentials (secretId/secretKey) are available but CLOUDBASE_APIKEY
  // is set, we still enable the session store. The @cloudbase/node-sdk picks up
  // CLOUDBASE_APIKEY from the env and uses it for Bearer auth to FlexDB — no
  // CAM signing needed. We pass a minimal credentials object with just envId so
  // the kernel creates CloudBaseSessionStore, and the SDK's normalizeConfig()
  // falls through to the CLOUDBASE_APIKEY env var when secretId/secretKey are
  // empty.
  const credentials = resolveCloudBaseCredentials(envId);
  const hasApiKey = !!process.env.CLOUDBASE_APIKEY;
  // When no CAM credentials but CLOUDBASE_APIKEY is available, pass minimal
  // credentials (empty secretId/secretKey) so the kernel creates
  // CloudBaseSessionStore. The @cloudbase/node-sdk picks up CLOUDBASE_APIKEY
  // from the env when secretId/secretKey are not passed to init().
  const effectiveCredentials =
    credentials ??
    (hasApiKey
      ? ({ envId, secretId: "", secretKey: "" } as CloudBaseCredentials)
      : null);

  // ── Model spec ──────────────────────────────────────────────────────────
  const baseModel: ModelSpec =
    typeof config.model === "string"
      ? { id: config.model }
      : { ...config.model };
  const model: string | ModelSpec =
    baseModel.apiKey || baseModel.apiBaseUrl || baseModel.options
      ? baseModel
      : baseModel.id;

  // ── Sandbox capabilities ─────────────────────────────────────────────────
  const builtinPoliciesForCaps = resolveBuiltinTools(config);
  const shellEnabled = builtinPoliciesForCaps.get("bash")?.enabled ?? true;
  const fsEnabled =
    (builtinPoliciesForCaps.get("read_file")?.enabled ?? true) ||
    (builtinPoliciesForCaps.get("write_file")?.enabled ?? true) ||
    (builtinPoliciesForCaps.get("list_files")?.enabled ?? true);
  const sandboxCapabilities =
    !shellEnabled || !fsEnabled
      ? { shell: shellEnabled, filesystem: fsEnabled }
      : undefined;

  // ── Sandbox ─────────────────────────────────────────────────────────────
  // agent-runtime 部署形态下 sandbox 永远启用,provider 由 yaml sandbox.provider 决定
  // (向后兼容:未设时从 sandbox.enabled 推断):
  //   - provider: 'ags-stateful' 或 sandbox.enabled=true → AGS 远程沙箱 + TRW HTTP 数据面
  //   - provider: 'local' 或 sandbox.enabled 未设        → 宿主进程本地 FS + SDK 内置工具
  //
  // local provider 模式下,kernel 自动:
  //   - 开放 SDK 内置工具(Bash/Read/Write/Edit/Glob/Grep,直接操作 cwd)
  //   - 在 send 边界做 cwd tar.gz 单包持久化到 COS(send-start pull / send-end push)
  // 不再需要 localTools / workspacePersist 顶层 flag —— 都由 provider 语义驱动。
  //
  // 注:本地 cwd 持久化的 COS 操作走 CAM 签名,需要 TCB_SECRET_ID/KEY;
  // 只有 CLOUDBASE_APIKEY 时 kernel 会 graceful degrade(不持久,但不报错)。
  // ags-stateful 路径仍需 CLOUDBASE_APIKEY —— oak 会在缺 key 时抛 InvalidConfigError。
  const sandboxProvider = config.sandbox?.provider
    ?? (config.sandbox?.enabled === true ? "ags-stateful" : "local");

  return {
    envId,
    name: config.name,
    description: config.description,
    metadata: config.metadata,
    model,
    systemPrompt: config.system,
    // session 工作目录(claude CLI 的 cwd)。必须是对运行 uid(1001)可写的目录 ——
    // claude 在 cwd 里做 git 检测/写临时文件,不可写会让子进程在 init 阶段静默
    // TCBR=/workspace/session,均已 chown 给运行 uid);未设时退 /tmp/workspace。
    // 不用 .oak 下的目录:那是 kernel 自管的配置区,cwd 是 session 级、可清理的工作区,
    // 二者作用域不同(见 kernel path-derivation 布局)。
    cwd: "/tmp/workspace",
    credentials: effectiveCredentials ?? undefined,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    sandbox: {
      enabled: true,
      // @ts-expect-error oak beta.7 types only accept 'ags-stateful'; beta.8 will add 'local' provider
      provider: sandboxProvider,
      scope: "session" as const,
      cloudbaseTools: false,
      ...(sandboxCapabilities ? { capabilities: sandboxCapabilities } : {}),
    },
    // 流式输出:显式开启(includePartialMessages)。kernel 把 SDK 增量 stream_event
    // 翻译成 message_delta(逐字 chunk),pumpEvents 转成 agent_message_chunk SSE frame。
    // 注:SCF web-function 网关全缓冲到 res.end(),前端要等整轮才收到(非实时)。
    stream: true,
    permissions: requireApproval ? { requireApproval } : undefined,
    // Session isolation key (projectKey). envId only selects WHICH FlexDB to
    // connect to (via credentials); it must NOT be the isolation key, otherwise
    // every agent in the same env shares one session pool. We scope by the
    // agent's own name so each agent only sees its own sessions.
    // Trade-offs (accepted): name is not guaranteed unique within an env, so
    // same-named agents share sessions; renaming an agent orphans old sessions;
    // existing sessions stored under projectKey=envId become invisible.
    session: effectiveCredentials
      ? { enabled: true, projectKey: config.name }
      : undefined,
    tools:
      opts.customToolDefs && opts.customToolDefs.length > 0
        ? opts.customToolDefs
        : undefined,
  // TODO: remove `as any` when @cloudbase/open-agent-kernel publishes a version
  // (>=0.1.0-beta.7) that includes `stream` in its AgentConfig type.
  // The field is already accepted by the kernel at runtime (npm link tested locally),
  // only the published type definition is lagging.
  } as any;
}
