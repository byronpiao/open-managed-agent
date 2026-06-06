/**
 * Host-side LLM provider config (OMA). Maps to TRW-native env at sandbox start.
 *
 * OpenAI-compatible → opencode (OPENCODE_CONFIG_CONTENT) + codebuddy (CODEBUDDY_*)
 * Anthropic-compatible → claude ACP (ANTHROPIC_*)
 */

import type { AgentConfig } from "../config.js";

export interface CompatLlmProvider {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function modelId(config: AgentConfig): string | undefined {
  if (typeof config.model === "string") return config.model;
  return config.model?.id;
}

function fromModelSpec(config: AgentConfig): CompatLlmProvider | null {
  if (typeof config.model !== "object" || !config.model) return null;
  const { apiKey, apiBaseUrl, id } = config.model;
  if (!apiKey && !apiBaseUrl) return null;
  return {
    apiKey,
    baseUrl: apiBaseUrl,
    model: id,
  };
}

/** OpenAI Chat Completions–compatible (opencode). */
export function resolveOpenAiCompatProvider(config: AgentConfig): CompatLlmProvider | null {
  const spec = fromModelSpec(config);
  if (spec?.apiKey) return spec;

  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !baseUrl || !model) return null;
  return { apiKey, baseUrl, model };
}

/** Anthropic Messages–compatible (claude ACP). Base URL must not include trailing /v1. */
export function resolveAnthropicCompatProvider(config: AgentConfig): CompatLlmProvider | null {
  const spec = fromModelSpec(config);
  if (spec?.apiKey) {
    return {
      ...spec,
      baseUrl: spec.baseUrl ? stripOpenAiV1Suffix(spec.baseUrl) : spec.baseUrl,
    };
  }

  const apiKey = process.env.LLM_API_KEY?.trim();
  let baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !model) return null;
  if (baseUrl) baseUrl = stripOpenAiV1Suffix(baseUrl);
  return { apiKey, baseUrl, model };
}

/**
 * OpenAI-compatible for CodeBuddy ACP (`CODEBUDDY_BASE_URL`).
 * `OPENAI_BASE_URL` is optional — omit for TRW default China (`internal`) Copilot.
 */
export function resolveCodebuddyProvider(config: AgentConfig): CompatLlmProvider | null {
  const spec = fromModelSpec(config);
  if (spec?.apiKey) {
    return {
      apiKey: spec.apiKey,
      baseUrl: spec.baseUrl,
      model: spec.model ?? modelId(config),
    };
  }

  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !model) return null;
  return { apiKey, baseUrl, model };
}

export function stripOpenAiV1Suffix(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "") || url;
}

/** TRW claude ACP sidecar env (Anthropic protocol). */
export function anthropicCompatToTrwEnv(
  provider: CompatLlmProvider,
): Array<{ Name: string; Value: string }> {
  const out: Array<{ Name: string; Value: string }> = [];
  if (provider.apiKey) {
    out.push({ Name: "ANTHROPIC_API_KEY", Value: provider.apiKey });
    out.push({ Name: "ANTHROPIC_AUTH_TOKEN", Value: provider.apiKey });
  }
  if (provider.baseUrl) {
    out.push({ Name: "ANTHROPIC_BASE_URL", Value: provider.baseUrl });
  }
  if (provider.model) {
    out.push({ Name: "ANTHROPIC_MODEL", Value: provider.model });
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
