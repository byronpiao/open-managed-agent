/**
 * Harness deploy artifacts: mcporter (managed-agent-client + HTTP MCP) and instance env hints.
 */

import fs from "fs";
import path from "path";
import type { AgentConfig, CustomTool, HarnessEnvVar, HarnessEngine } from "../config.js";
import { buildHarnessInstanceEnv, getCustomTools } from "../config.js";
import {
  anthropicCompatToTrwEnv,
  codebuddyCompatToTrwEnv,
  hermesOpenAiCompatToTrwEnv,
  resolveAnthropicCompatProvider,
  resolveCloudBasePlatformLlm,
  resolveCodebuddyProvider,
  resolveOpenAiCompatProvider,
  openAiCompatBaseUrlForHarness,
  stripOpenAiV1Suffix,
} from "./llm-providers.js";
import { buildHarnessOpencodePermission } from "./engine/opencode/opencode-permissions.js";
import { mergeHarnessInstanceEnv, sandboxEnvToHarnessVars } from "./sandbox/sandbox-env.js";

export { buildHarnessOpencodePermission } from "./engine/opencode/opencode-permissions.js";

export const MANAGED_AGENT_CLIENT_MCP_SERVER = "managed-agent-client";

/** TRW in-sandbox relay when gateway callback is loopback-only (local dev + cloud AGS). */
export const SANDBOX_TRW_MCP_RELAY_PATH = "/api/harness/mcp-relay";
export const SANDBOX_TRW_MCP_POLL_PATH = "/api/harness/mcp-poll";
export const SANDBOX_TRW_MCP_COMPLETE_PATH = "/api/harness/mcp-complete";

const SANDBOX_TRW_LOCAL_BASE = "http://127.0.0.1:9000";

import { resolveHarnessInjectionCredentials } from "./harness-env.js";

export { HARNESS_PUBLIC_MAGENT_IMAGE, resolveHarnessSandboxImage } from "./harness-env.js";

const OPENCODE_PROVIDER_ID = "openai-compat";

/** Inline opencode.json: LLM_* + OPENAI_BASE_URL + agent.yaml permission → `permission`. */
export function buildHarnessOpencodeConfigContent(config: AgentConfig): string | null {
  const permission = buildHarnessOpencodePermission(config);
  const hasPermission = Object.keys(permission).length > 0;
  const provider = resolveOpenAiCompatProvider(config);
  const hasProvider = !!(provider?.apiKey && provider.baseUrl && provider.model);

  if (!hasPermission && !hasProvider) return null;

  const doc: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };
  if (hasPermission) doc.permission = permission;
  if (hasProvider && provider) {
    const model = provider.model!;
    doc.model = `${OPENCODE_PROVIDER_ID}/${model}`;
    doc.provider = {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenAI-compatible",
        options: {
          baseURL: openAiCompatBaseUrlForHarness(provider),
          apiKey: provider.apiKey,
        },
        models: { [model]: { name: model } },
      },
    };
    doc.enabled_providers = [OPENCODE_PROVIDER_ID];
  }
  return JSON.stringify(doc);
}

/** 箱内引擎 session/new 的工作目录（TRW 沙箱默认项目根）. */
export const DEFAULT_HARNESS_SANDBOX_CWD = "/home/user";

export interface McporterConfig {
  mcpServers: Record<
    string,
    { type: string; url?: string; command?: string; args?: string[] }
  >;
}

/** mcporter.json transport for in-sandbox HTTP MCP (opencode / mcp_user_define). */
export const MCPORTER_HTTP_MCP_TYPE = "streamable-http";

export function buildManagedAgentClientTools(config: AgentConfig): CustomTool[] {
  return getCustomTools(config);
}

export function isLoopbackHarnessCallback(callbackBase: string): boolean {
  try {
    const host = new URL(callbackBase).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** HTTP MCP URL for managed-agent-client on the OMA gateway. */
export function buildManagedAgentClientMcpUrl(
  callbackBase: string,
  acpSessionId?: string,
): string {
  const base = callbackBase.replace(/\/$/, "");
  const url = new URL(`${base}/internal/harness/mcp`);
  if (acpSessionId) {
    url.searchParams.set("sessionId", acpSessionId);
  }
  return url.toString();
}

/**
 * URL reachable from inside the AGS sandbox (opencode → TRW relay → gateway pump).
 * Public gateway callbacks use the direct gateway MCP URL instead.
 */
export function buildSandboxReachableClientMcpUrl(
  callbackBase: string,
  acpSessionId: string,
): string {
  if (isLoopbackHarnessCallback(callbackBase)) {
    const url = new URL(`${SANDBOX_TRW_LOCAL_BASE}${SANDBOX_TRW_MCP_RELAY_PATH}`);
    url.searchParams.set("sessionId", acpSessionId);
    return url.toString();
  }
  return buildManagedAgentClientMcpUrl(callbackBase, acpSessionId);
}

/** ACP session/new mcpServers[] entries for custom client tools. */
export function buildHarnessAcpMcpServers(args: {
  config: AgentConfig;
  clientToolCallbackBase: string;
  acpSessionId: string;
}): Array<{ type: "http"; name: string; url: string; headers: [] }> {
  const custom = buildManagedAgentClientTools(args.config);
  if (!custom.length) return [];
  return [
    {
      type: "http",
      name: MANAGED_AGENT_CLIENT_MCP_SERVER,
      url: buildSandboxReachableClientMcpUrl(
        args.clientToolCallbackBase,
        args.acpSessionId,
      ),
      headers: [],
    },
  ];
}

export function buildMcporterConfig(args: {
  config: AgentConfig;
  clientToolCallbackBase: string;
  acpSessionId?: string;
}): McporterConfig {
  const servers: McporterConfig["mcpServers"] = {};

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

export function mcporterConfigToEnvVar(
  mcporter: McporterConfig,
): HarnessEnvVar | null {
  if (!Object.keys(mcporter.mcpServers).length) return null;
  return {
    Name: "MCPORTER_CONFIG_CONTENT",
    Value: JSON.stringify(mcporter),
  };
}

/** CloudBase creds for TRW POST /api/workspace/init (A9). */
export function buildSkillsManifestEnv(
  config: AgentConfig,
  baseDir = process.cwd(),
): HarnessEnvVar | null {
  const skills = config.skills;
  if (!skills?.length) return null;
  const packed: Array<{ name: string; description: string; content: string }> = [];
  for (const skill of skills) {
    const srcPath = path.isAbsolute(skill.source)
      ? skill.source
      : path.resolve(baseDir, skill.source);
    if (!fs.existsSync(srcPath)) continue;
    try {
      packed.push({
        name: skill.name,
        description: skill.description ?? "",
        content: fs.readFileSync(srcPath, "utf-8").trim(),
      });
    } catch {
      // skip
    }
  }
  if (!packed.length) return null;
  return { Name: "HARNESS_SKILLS_JSON", Value: JSON.stringify(packed) };
}

export function buildHarnessInitCredEnv(): HarnessEnvVar[] {
  const out: HarnessEnvVar[] = [];
  const push = (name: string, value: string | undefined) => {
    if (value) out.push({ Name: name, Value: value });
  };
  const creds = resolveHarnessInjectionCredentials();
  push("CLOUDBASE_ENV_ID", process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID);
  push("TENCENTCLOUD_SECRETID", creds.secretId);
  push("TENCENTCLOUD_SECRETKEY", creds.secretKey);
  push("TENCENTCLOUD_SESSIONTOKEN", creds.sessionToken);
  push("TCB_SECRET_ID", process.env.TCB_SECRET_ID?.trim());
  push("TCB_SECRET_KEY", process.env.TCB_SECRET_KEY?.trim());
  push("TCB_TOKEN", process.env.TCB_TOKEN?.trim());
  push("TCB_REGION", process.env.TCB_REGION);
  return out;
}

export function buildHarnessSandboxEnv(args: {
  config: AgentConfig;
  engine: HarnessEngine;
  clientToolCallbackBase: string;
  acpSessionId?: string;
  /** From harness_sessions — TRW secrets vault for this ACP session. */
  secretMasterKey?: string;
  extraEnv?: HarnessEnvVar[];
}): HarnessEnvVar[] {
  const mcporter = buildMcporterConfig({
    config: args.config,
    clientToolCallbackBase: args.clientToolCallbackBase,
    acpSessionId: args.acpSessionId,
  });
  const base = buildHarnessInstanceEnv(args.config, args.engine);
  const mcporterEnv = mcporterConfigToEnvVar(mcporter);
  const merged = [...base, ...buildHarnessInitCredEnv()];
  if (args.secretMasterKey) {
    merged.push({ Name: "SECRET_MASTER_KEY", Value: args.secretMasterKey });
  }
  if (args.engine === "claude") {
    const anthropic = resolveAnthropicCompatProvider(args.config);
    if (anthropic) merged.push(...anthropicCompatToTrwEnv(anthropic));
  } else if (args.engine === "codebuddy") {
    const codebuddy = resolveCodebuddyProvider(args.config);
    if (codebuddy) merged.push(...codebuddyCompatToTrwEnv(codebuddy));
  } else if (args.engine === "hermes") {
    const openai = resolveOpenAiCompatProvider(args.config);
    if (openai) merged.push(...hermesOpenAiCompatToTrwEnv(openai));
    const anthropic = resolveAnthropicCompatProvider(args.config);
    if (anthropic) merged.push(...anthropicCompatToTrwEnv(anthropic));
  }
  const callback = args.clientToolCallbackBase.replace(/\/$/, "");
  if (callback) {
    merged.push({ Name: "HARNESS_RUNTIME_CALLBACK_URL", Value: callback });
  }
  if (args.acpSessionId) {
    merged.push({ Name: "HARNESS_ACP_SESSION_ID", Value: args.acpSessionId });
  }
  const skillsEnv = buildSkillsManifestEnv(args.config);
  if (skillsEnv) merged.push(skillsEnv);
  if (mcporterEnv) merged.push(mcporterEnv);
  if (args.engine === "opencode") {
    if (!merged.some((e) => e.Name === "OPENCODE_CONFIG_CONTENT")) {
      const opencodeCfg = buildHarnessOpencodeConfigContent(args.config);
      if (opencodeCfg) {
        merged.push({ Name: "OPENCODE_CONFIG_CONTENT", Value: opencodeCfg });
      }
    }
    const platform = resolveCloudBasePlatformLlm(args.config);
    if (platform?.apiKey && !merged.some((e) => e.Name === "CLOUDBASE_APIKEY")) {
      merged.push({ Name: "CLOUDBASE_APIKEY", Value: platform.apiKey });
    }
    const byokKey = process.env.LLM_API_KEY?.trim();
    if (
      byokKey &&
      !platform &&
      !merged.some((e) => e.Name === "LLM_API_KEY")
    ) {
      merged.push({ Name: "LLM_API_KEY", Value: byokKey });
    }
  }
  if (args.engine === "hermes") {
    if (!merged.some((e) => e.Name === "OPENAI_API_KEY")) {
      const platform = resolveCloudBasePlatformLlm(args.config);
      if (platform?.apiKey) {
        merged.push({ Name: "OPENAI_API_KEY", Value: platform.apiKey });
        if (platform.baseUrl) {
          merged.push({ Name: "OPENAI_BASE_URL", Value: platform.baseUrl });
        }
      }
      const byokKey = process.env.LLM_API_KEY?.trim();
      if (byokKey && !platform) {
        merged.push({ Name: "OPENAI_API_KEY", Value: byokKey });
        const byokUrl = process.env.OPENAI_BASE_URL?.trim();
        if (byokUrl) {
          merged.push({
            Name: "OPENAI_BASE_URL",
            Value: stripOpenAiV1Suffix(byokUrl),
          });
        }
      }
    }
  }
  const customTools = buildManagedAgentClientTools(args.config);
  if (customTools.length) {
    merged.push({
      Name: "HARNESS_CLIENT_TOOLS_JSON",
      Value: JSON.stringify(customToolsToMcpToolSchemas(customTools)),
    });
  }
  const relayTimeout = process.env.HARNESS_OPENCODE_ACP_TIMEOUT_MS?.trim();
  if (relayTimeout) {
    merged.push({ Name: "HARNESS_OPENCODE_ACP_TIMEOUT_MS", Value: relayTimeout });
  }
  const withExtra = args.extraEnv?.length ? [...merged, ...args.extraEnv] : merged;
  const yamlEnv = sandboxEnvToHarnessVars(args.config.sandbox?.env);
  return mergeHarnessInstanceEnv(withExtra, yamlEnv);
}

export function customToolsToMcpToolSchemas(
  tools: CustomTool[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));
}

