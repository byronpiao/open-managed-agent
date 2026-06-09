/**
 * Preflight probe for OpenAI-compatible LLM (Mimo / shared keys).
 * Runs on the host before AGS acquire — catches 401 / quota without sandbox cost.
 */

import { assertHarnessLlmEnv, missingHarnessLlmEnv } from "./harness-env.js";
import {
  HARNESS_CLOUDBASE_DEFAULT_MODEL,
  cloudBaseAiGatewayBaseUrl,
} from "./llm-providers.js";

export interface HarnessLlmProbeResult {
  ok: boolean;
  httpStatus: number;
  model: string;
  /** Chat completions URL (no API key). */
  endpoint: string;
  latencyMs: number;
  replySnippet?: string;
  error?: string;
}

/** Normalize OPENAI_BASE_URL → `…/v1/chat/completions`. */
export function openAiChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function probeErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err?.message) return err.message;
  }
  return fallback;
}

/** One minimal chat/completions round-trip (default prompt: reply pong). */
export async function probeHarnessOpenAiLlm(options?: {
  timeoutMs?: number;
  maxTokens?: number;
  prompt?: string;
}): Promise<HarnessLlmProbeResult> {
  const missing = missingHarnessLlmEnv();
  if (missing.length) {
    return {
      ok: false,
      httpStatus: 0,
      model: process.env.LLM_MODEL?.trim() ?? "",
      endpoint: "",
      latencyMs: 0,
      error: `missing env: ${missing.join(", ")}`,
    };
  }

  const apiKey = process.env.LLM_API_KEY!.trim();
  const model = process.env.LLM_MODEL!.trim();
  const endpoint = openAiChatCompletionsUrl(process.env.OPENAI_BASE_URL!);
  const timeoutMs =
    options?.timeoutMs ??
    (Number(process.env.HARNESS_PLATFORM_PROBE_TIMEOUT_MS) || 30_000);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const attemptFetch = async (): Promise<HarnessLlmProbeResult> => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: options?.prompt ?? "Reply with exactly: pong",
          },
        ],
        max_tokens: options?.maxTokens ?? 16,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // keep raw text
    }

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        model,
        endpoint,
        latencyMs,
        error: probeErrorMessage(body, raw.slice(0, 240) || `HTTP ${res.status}`),
      };
    }

    const content =
      (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
        ?.content ?? "";
    return {
      ok: true,
      httpStatus: res.status,
      model,
      endpoint,
      latencyMs,
      replySnippet: String(content).trim().slice(0, 120),
    };
  };

  try {
    let result = await attemptFetch();
    if (!result.ok && result.httpStatus === 429) {
      await new Promise((r) => setTimeout(r, 8_000));
      result = await attemptFetch();
    }
    return result;
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      httpStatus: 0,
      model,
      endpoint,
      latencyMs: Date.now() - started,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** CloudBase AI gateway (TCB_API_KEY + envId) — local harness tier ①, ~30s fail-fast. */
export async function probeCloudBasePlatformLlm(options?: {
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<HarnessLlmProbeResult> {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim() || process.env.TCB_ENV_ID?.trim();
  const apiKey = process.env.TCB_API_KEY?.trim();
  // Tier ① platform probe — never use BYOK LLM_MODEL from .env.harness ③ 段.
  const model = HARNESS_CLOUDBASE_DEFAULT_MODEL;
  if (!envId || !apiKey) {
    return {
      ok: false,
      httpStatus: 0,
      model,
      endpoint: "",
      latencyMs: 0,
      error: "missing CLOUDBASE_ENV_ID or TCB_API_KEY",
    };
  }
  const endpoint = openAiChatCompletionsUrl(cloudBaseAiGatewayBaseUrl(envId));
  const timeoutMs =
    options?.timeoutMs ??
    (Number(process.env.HARNESS_PLATFORM_PROBE_TIMEOUT_MS) || 30_000);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        max_tokens: options?.maxTokens ?? 16,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const raw = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        model,
        endpoint,
        latencyMs,
        error: probeErrorMessage(body, raw.slice(0, 300)),
      };
    }
    const snippet =
      (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
        ?.content ?? "";
    return {
      ok: !!snippet.trim(),
      httpStatus: res.status,
      model,
      endpoint,
      latencyMs,
      replySnippet: snippet.slice(0, 80),
      error: snippet.trim() ? undefined : "empty reply from platform model",
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      httpStatus: 0,
      model,
      endpoint,
      latencyMs: Date.now() - started,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function assertHarnessPlatformLlmReachable(): Promise<HarnessLlmProbeResult> {
  const result = await probeCloudBasePlatformLlm();
  if (!result.ok) {
    const status = result.httpStatus ? `HTTP ${result.httpStatus}` : "request failed";
    throw new Error(
      `Platform LLM probe failed (${status}): ${result.error ?? "unknown"}. ` +
        `model=${result.model} endpoint=${result.endpoint || "(unset)"}. ` +
        `Check CloudBase AI console: hy3-preview enabled + quota. ` +
        `Preflight: node scripts/harness/load-env.mjs --check`,
    );
  }
  return result;
}

/** Hard gate — use before `harness -- local` full / hitl / LLM sync. */
export async function assertHarnessOpenAiLlmReachable(): Promise<HarnessLlmProbeResult> {
  assertHarnessLlmEnv();
  const result = await probeHarnessOpenAiLlm();
  if (!result.ok) {
    const status = result.httpStatus ? `HTTP ${result.httpStatus}` : "request failed";
    throw new Error(
      `LLM probe failed (${status}): ${result.error ?? "unknown"}. ` +
        `model=${result.model} endpoint=${result.endpoint || "(unset)"}. ` +
        `Shared Mimo keys often 401 when expired or over quota — update .env.harness. ` +
        `Preflight: node scripts/harness/load-env.mjs --check --probe-llm`,
    );
  }
  return result;
}
