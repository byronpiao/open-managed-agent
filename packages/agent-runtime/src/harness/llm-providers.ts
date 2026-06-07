/**
 * Host-side LLM provider config (OMA). Maps to TRW-native env at sandbox start.
 *
 * OpenAI-compatible → opencode (OPENCODE_CONFIG_CONTENT) + codebuddy (CODEBUDDY_*)
 * Anthropic-compatible → claude ACP (ANTHROPIC_*)
 *
 * Harness reads LLM from **host env only** (`.env.harness` → CloudRun EnvParam).
 * Do not infer OpenAI base URLs from agent.yaml `model.apiBaseUrl` (often Anthropic).
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

/** OpenAI Chat Completions → opencode + codebuddy. Requires OPENAI_BASE_URL. */
export function resolveOpenAiCompatProvider(config: AgentConfig): CompatLlmProvider | null {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !baseUrl || !model) return null;
  return { apiKey, baseUrl, model };
}

/** Anthropic Messages → claude ACP. Uses ANTHROPIC_BASE_URL (not OPENAI_BASE_URL). */
export function resolveAnthropicCompatProvider(config: AgentConfig): CompatLlmProvider | null {
  const apiKey = process.env.LLM_API_KEY?.trim();
  let baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? modelId(config);
  if (!apiKey || !model) return null;
  if (baseUrl) baseUrl = stripOpenAiV1Suffix(baseUrl);
  return { apiKey, baseUrl, model };
}

/**
 * CodeBuddy ACP — same OpenAI-compatible env as opencode (`CODEBUDDY_BASE_URL` ← OPENAI_BASE_URL).
 * BASE_URL optional: omit for TRW China Copilot (`internal`).
 */
export function resolveCodebuddyProvider(config: AgentConfig): CompatLlmProvider | null {
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
