/**
 * Host-side LLM provider config (OMA). Maps to TRW-native env at sandbox start.
 *
 * OpenAI-compatible → opencode (OPENCODE_CONFIG_CONTENT) + codebuddy (CODEBUDDY_*)
 * Anthropic-compatible → claude ACP (ANTHROPIC_*)
 *
 * Resolution order:
 * 1. opencode only: explicit `model: zen` → built-in zen (no host LLM injection)
 * 2. CloudBase platform AI (CLOUDBASE_APIKEY + envId, default hy3-preview)
 * 3. Custom provider (ModelSpec or explicit LLM_* / non-platform base URLs)
 */

import type { AgentConfig } from "../config.js";

export interface CompatLlmProvider {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** Default CloudBase AI model for harness landing (experience / resource pack). */
export const HARNESS_CLOUDBASE_DEFAULT_MODEL = "hy3-preview";

const CLOUDBASE_AI_PATH = "/v1/ai/cloudbase";

function modelId(config: AgentConfig): string | undefined {
  if (typeof config.model === "string") return config.model;
  return config.model?.id;
}

export function cloudBaseAiGatewayBaseUrl(envId: string): string {
  const id = envId.trim();
  return `https://${id}.api.tcloudbasegateway.com${CLOUDBASE_AI_PATH}`;
}

/** @ai-sdk/openai-compatible baseURL. CloudBase already includes `/v1` in `/v1/ai/cloudbase`. */
export function openAiCompatBaseUrlForHarness(provider: CompatLlmProvider): string {
  const base = provider.baseUrl?.trim().replace(/\/$/, "") ?? "";
  if (!base) return base;
  if (isCloudBaseAiGatewayUrl(base)) return base;
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function isCloudBaseAiGatewayUrl(url: string): boolean {
  const normalized = url.trim().replace(/\/$/, "");
  return normalized.includes(".api.tcloudbasegateway.com") && normalized.endsWith(CLOUDBASE_AI_PATH);
}

export function isHarnessZenModel(config: AgentConfig): boolean {
  return typeof config.model === "string" && config.model.trim() === "zen";
}

function hasCustomModelSpec(config: AgentConfig): boolean {
  if (!config.model || typeof config.model === "string") return false;
  return !!(config.model.apiKey?.trim() || config.model.apiBaseUrl?.trim());
}

function resolveCustomModelSpec(config: AgentConfig): CompatLlmProvider | null {
  if (!hasCustomModelSpec(config) || typeof config.model === "string") return null;
  const spec = config.model;
  const id = spec.id?.trim();
  if (!id) return null;
  return {
    apiKey: spec.apiKey?.trim(),
    baseUrl: spec.apiBaseUrl?.trim(),
    model: id,
  };
}

/** User explicitly configured a non-platform LLM via host env. */
export function hasExplicitCustomLlmEnv(): boolean {
  const openai = process.env.OPENAI_BASE_URL?.trim();
  const anthropic = process.env.ANTHROPIC_BASE_URL?.trim();
  if (openai && !isCloudBaseAiGatewayUrl(openai)) return true;
  if (anthropic && !isCloudBaseAiGatewayUrl(anthropic)) return true;
  const llmKey = process.env.LLM_API_KEY?.trim();
  const tcbKey = process.env.CLOUDBASE_APIKEY?.trim();
  if (llmKey && !tcbKey) return true;
  if (llmKey && tcbKey && llmKey !== tcbKey) return true;
  return false;
}

function resolveEnvId(): string | undefined {
  return process.env.CLOUDBASE_ENV_ID?.trim() || process.env.TCB_ENV_ID?.trim() || undefined;
}

function resolvePlatformApiKey(): string | undefined {
  return process.env.CLOUDBASE_APIKEY?.trim() || process.env.LLM_API_KEY?.trim() || undefined;
}

function resolvePlatformModelId(config: AgentConfig): string {
  const fromEnv = process.env.LLM_MODEL?.trim();
  if (fromEnv) return fromEnv;
  const fromYaml = modelId(config)?.trim();
  if (fromYaml && fromYaml !== "zen") return fromYaml;
  return HARNESS_CLOUDBASE_DEFAULT_MODEL;
}

/** CloudBase AI gateway (OpenAI + Anthropic compatible, same base URL). */
export function resolveCloudBasePlatformLlm(config: AgentConfig): CompatLlmProvider | null {
  if (isHarnessZenModel(config)) return null;
  if (hasCustomModelSpec(config) || hasExplicitCustomLlmEnv()) return null;

  const envId = resolveEnvId();
  const apiKey = resolvePlatformApiKey();
  if (!envId || !apiKey) return null;

  return {
    apiKey,
    baseUrl: cloudBaseAiGatewayBaseUrl(envId),
    model: resolvePlatformModelId(config),
  };
}

function resolveCustomOpenAiFromEnv(config: AgentConfig): CompatLlmProvider | null {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !baseUrl || !model) return null;
  return { apiKey, baseUrl: stripOpenAiV1Suffix(baseUrl), model };
}

function resolveCustomAnthropicFromEnv(config: AgentConfig): CompatLlmProvider | null {
  const apiKey = resolveAnthropicApiKeyFromEnv();
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !baseUrl || !model) return null;
  return { apiKey, baseUrl: stripOpenAiV1Suffix(baseUrl), model };
}

/** OpenAI Chat Completions → opencode + codebuddy. */
export function resolveOpenAiCompatProvider(config: AgentConfig): CompatLlmProvider | null {
  if (isHarnessZenModel(config)) return null;

  const fromSpec = resolveCustomModelSpec(config);
  if (fromSpec?.apiKey && fromSpec.baseUrl && fromSpec.model) return fromSpec;

  if (hasExplicitCustomLlmEnv()) {
    const custom = resolveCustomOpenAiFromEnv(config);
    if (custom) return custom;
  }

  return resolveCloudBasePlatformLlm(config);
}

/** Anthropic / Mimo tp-* key (Messages API). */
export function resolveAnthropicApiKeyFromEnv(): string | undefined {
  return (
    process.env.LLM_API_KEY?.trim() ||
    process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim() ||
    process.env.CLAUDE_API_KEY?.trim() ||
    undefined
  );
}

/** Anthropic Messages → claude ACP. */
export function resolveAnthropicCompatProvider(config: AgentConfig): CompatLlmProvider | null {
  const fromSpec = resolveCustomModelSpec(config);
  if (fromSpec?.apiKey && fromSpec.baseUrl && fromSpec.model) return fromSpec;

  if (hasExplicitCustomLlmEnv()) {
    const custom = resolveCustomAnthropicFromEnv(config);
    if (custom) return custom;
  }

  return resolveCloudBasePlatformLlm(config);
}

/**
 * CodeBuddy ACP — same OpenAI-compatible env as opencode (`CODEBUDDY_BASE_URL` ← OPENAI_BASE_URL).
 * BASE_URL optional: omit for TRW China Copilot (`internal`).
 */
export function resolveCodebuddyProvider(config: AgentConfig): CompatLlmProvider | null {
  if (isHarnessZenModel(config)) return null;
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !model) return null;
  return { apiKey, baseUrl, model };
}

export function stripOpenAiV1Suffix(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "") || url;
}

/**
 * Host-side Anthropic probe headers — send both auth shapes; gateways pick what they accept.
 * (Claude Code in sandbox only emits one credential; see `anthropicCompatToTrwEnv`.)
 */
export function buildAnthropicCompatFetchHeaders(
  apiKey: string,
  _baseUrl?: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
}

/** TRW claude ACP sidecar env (Anthropic protocol). */
export function anthropicCompatToTrwEnv(
  provider: CompatLlmProvider,
): Array<{ Name: string; Value: string }> {
  const out: Array<{ Name: string; Value: string }> = [];
  if (provider.apiKey) {
    // Claude Code precedence: AUTH_TOKEN (Bearer) before API_KEY (x-api-key).
    out.push({ Name: "ANTHROPIC_AUTH_TOKEN", Value: provider.apiKey });
    out.push({ Name: "ANTHROPIC_API_KEY", Value: provider.apiKey });
  }
  if (provider.baseUrl) {
    out.push({ Name: "ANTHROPIC_BASE_URL", Value: provider.baseUrl });
  }
  if (provider.model) {
    const model = provider.model;
    out.push({ Name: "ANTHROPIC_MODEL", Value: model });
    // Third-party Anthropic gateways: pin Claude Code aliases to the served model id.
    out.push({ Name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", Value: model });
    out.push({ Name: "ANTHROPIC_DEFAULT_SONNET_MODEL", Value: model });
    out.push({ Name: "ANTHROPIC_DEFAULT_OPUS_MODEL", Value: model });
  }
  return out;
}

/**
 * TRW hermes-acp / hermes dashboard — OpenAI-compatible direct API (`openai-api` provider).
 * Official Hermes path for CloudBase zen / Mimo / custom gateways. Model lives in
 * ~/.hermes/config.yaml (not LLM_MODEL env).
 */
export function hermesOpenAiCompatToTrwEnv(
  provider: CompatLlmProvider,
): Array<{ Name: string; Value: string }> {
  const out: Array<{ Name: string; Value: string }> = [];
  if (provider.apiKey) {
    out.push({ Name: "OPENAI_API_KEY", Value: provider.apiKey });
  }
  if (provider.baseUrl) {
    out.push({ Name: "OPENAI_BASE_URL", Value: provider.baseUrl });
  }
  return out;
}

/** TRW codebuddy --acp sidecar env (OpenAI-compatible when BASE_URL set). */
export function codebuddyCompatToTrwEnv(
  provider: CompatLlmProvider,
): Array<{ Name: string; Value: string }> {
  const out: Array<{ Name: string; Value: string }> = [];
  if (provider.apiKey) {
    out.push({ Name: "CODEBUDDY_API_KEY", Value: provider.apiKey });
  }
  if (provider.baseUrl) {
    out.push({ Name: "CODEBUDDY_BASE_URL", Value: provider.baseUrl });
  }
  if (provider.model) {
    out.push({ Name: "CODEBUDDY_MODEL", Value: provider.model });
  }
  return out;
}
