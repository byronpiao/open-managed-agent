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
  resolveAnthropicCompatProvider,
  resolveCodebuddyProvider,
  resolveOpenAiCompatProvider,
} from "./llm-providers.js";

export const MANAGED_AGENT_CLIENT_MCP_SERVER = "managed-agent-client";

/** TRW in-sandbox relay when gateway callback is loopback-only (local dev + cloud AGS). */
export const SANDBOX_TRW_MCP_RELAY_PATH = "/api/harness/mcp-relay";
export const SANDBOX_TRW_MCP_POLL_PATH = "/api/harness/mcp-poll";
export const SANDBOX_TRW_MCP_COMPLETE_PATH = "/api/harness/mcp-complete";

const SANDBOX_TRW_LOCAL_BASE = "http://127.0.0.1:9000";

const FALLBACK_HARNESS_SANDBOX_IMAGE =
  "ccr.ccs.tencentyun.com/tcb-sandbox-public-cbe88d/tcb-sandbox-public-cbe88d:260526-1008-vibecoding";

/** Read at call time so scripts can loadEnv() before importing orchestrator. */
export function resolveHarnessSandboxImage(): string {
  return process.env.HARNESS_SANDBOX_IMAGE?.trim() || FALLBACK_HARNESS_SANDBOX_IMAGE;
}

/** @deprecated Use resolveHarnessSandboxImage() — kept for tests expecting a string constant. */
export const DEFAULT_HARNESS_SANDBOX_IMAGE = FALLBACK_HARNESS_SANDBOX_IMAGE;

const OPENCODE_PROVIDER_ID = "openai-compat";

/** Inline opencode.json from LLM_* + OPENAI_BASE_URL (or agent.yaml ModelSpec). */
export function buildHarnessOpencodeConfigContent(config: AgentConfig): string | null {
  const provider = resolveOpenAiCompatProvider(config);
  if (!provider?.apiKey || !provider.baseUrl || !provider.model) return null;

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE_PROVIDER_ID}/${provider.model}`,
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenAI-compatible",
        options: { baseURL: provider.baseUrl, apiKey: provider.apiKey },
        models: { [provider.model]: { name: provider.model } },
      },
    },
    enabled_providers: [OPENCODE_PROVIDER_ID],
  });
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
  push("CLOUDBASE_ENV_ID", process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID);
  push(
    "TENCENTCLOUD_SECRETID",
    process.env.TCB_SECRET_ID ?? process.env.TENCENTCLOUD_SECRETID,
  );
  push(
    "TENCENTCLOUD_SECRETKEY",
    process.env.TCB_SECRET_KEY ?? process.env.TENCENTCLOUD_SECRETKEY,
  );
  push(
    "TENCENTCLOUD_SESSIONTOKEN",
    process.env.TCB_TOKEN ?? process.env.TENCENTCLOUD_SESSIONTOKEN,
  );
  return out;
}

export function buildHarnessSandboxEnv(args: {
  config: AgentConfig;
  engine: HarnessEngine;
  clientToolCallbackBase: string;
  acpSessionId?: string;
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
  if (args.engine === "claude") {
    const anthropic = resolveAnthropicCompatProvider(args.config);
    if (anthropic) merged.push(...anthropicCompatToTrwEnv(anthropic));
  } else if (args.engine === "codebuddy") {
    const codebuddy = resolveCodebuddyProvider(args.config);
    if (codebuddy) merged.push(...codebuddyCompatToTrwEnv(codebuddy));
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
  }
  const customTools = buildManagedAgentClientTools(args.config);
  if (customTools.length) {
    merged.push({
      Name: "HARNESS_CLIENT_TOOLS_JSON",
      Value: JSON.stringify(customToolsToMcpToolSchemas(customTools)),
    });
  }
  if (args.extraEnv?.length) merged.push(...args.extraEnv);
  return merged;
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

/** CLI / magent: resolve runtime= from flags before deploy. */
export function agentLoopRuntimeFromArgs(
  args: Record<string, unknown> = {},
  config: Partial<AgentConfig> = {},
): "managed" | "harness" {
  const fromFlag = args["agent-runtime"];
  if (fromFlag === "harness" || fromFlag === "managed") return fromFlag;
  const r = args.runtime;
  if (r === "harness" || r === "managed") return r;
  return config.runtime ?? "managed";
}

/** CLI / magent: normalize agent.yaml + flags for harness vs managed deploy. */
export function normalizeAgentRuntime(
  config: AgentConfig,
  args: Record<string, unknown> = {},
): AgentConfig {
  const runtime = agentLoopRuntimeFromArgs(args, config);
  const engine = (args.engine as HarnessEngine | undefined) ?? config.engine ?? "opencode";
  if (runtime === "harness") {
    config.runtime = "harness";
    config.engine =
      engine === "claude" || engine === "codebuddy" ? engine : "opencode";
  } else {
    config.runtime = "managed";
    delete config.engine;
  }
  return config;
}

/** magent agent:create/update — merge harness env into SCF / CloudRun env map. */
export function applyHarnessRuntimeEnv(
  envMap: Record<string, string>,
  config: AgentConfig,
  opts: {
    sandboxImage?: string;
    harnessToolId?: string;
    clientToolCallbackBase?: string;
  } = {},
): Record<string, string> {
  if (config.runtime !== "harness") return envMap;
  delete envMap.OAK_DISABLE_SANDBOX;
  envMap.HARNESS_SANDBOX_IMAGE = opts.sandboxImage ?? resolveHarnessSandboxImage();
  if (opts.harnessToolId) envMap.HARNESS_TOOL_ID = opts.harnessToolId;
  const mcporter = buildMcporterConfig({
    config,
    clientToolCallbackBase: opts.clientToolCallbackBase ?? "",
  });
  if (Object.keys(mcporter.mcpServers).length) {
    envMap.MCPORTER_CONFIG_CONTENT = JSON.stringify(mcporter);
  }
  return envMap;
}
