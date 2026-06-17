/**
 * Preflight probe for OpenAI-compatible LLM (Mimo / shared keys).
 * Runs on the host before AGS acquire — catches 401 / quota without sandbox cost.
 */

import {
  assertHarnessAnthropicLlmEnv,
  assertHarnessLlmEnv,
  missingHarnessLlmEnv,
} from "./harness-env.js";
import {
  HARNESS_CLOUDBASE_DEFAULT_MODEL,
  buildAnthropicCompatFetchHeaders,
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
  /** CloudBase AI error code when present (e.g. EXCEED_TOKEN_QUOTA_LIMIT). */
  errorCode?: string;
}

export type PlatformProbeFailureKind =
  | "quota_exceeded"
  | "auth"
  | "timeout"
  | "missing_credentials"
  | "other";

function parseProbeErrorBody(raw: string): { message: string; code?: string } {
  try {
    const body = JSON.parse(raw) as {
      message?: string;
      code?: string;
      error?: { message?: string; code?: string };
    };
    const code = body.code ?? body.error?.code;
    const message =
      body.message ??
      body.error?.message ??
      (typeof body.error === "string" ? body.error : undefined);
    return { message: message ?? raw.slice(0, 300), code };
  } catch {
    return { message: raw.slice(0, 300) };
  }
}

/** Classify platform (hy3-preview) probe failure for actionable logs. */
export function classifyPlatformProbeFailure(
  result: HarnessLlmProbeResult,
): PlatformProbeFailureKind {
  if (result.error?.includes("missing CLOUDBASE_ENV_ID")) return "missing_credentials";
  if (result.error?.includes("timeout after")) return "timeout";
  const code = result.errorCode?.toUpperCase() ?? "";
  const err = (result.error ?? "").toLowerCase();
  if (
    result.httpStatus === 429 ||
    code.includes("EXCEED_TOKEN_QUOTA") ||
    err.includes("quota") ||
    err.includes("exceed_token")
  ) {
    return "quota_exceeded";
  }
  if (result.httpStatus === 401 || result.httpStatus === 403) return "auth";
  return "other";
}

export function isPlatformQuotaExceeded(result: HarnessLlmProbeResult): boolean {
  return classifyPlatformProbeFailure(result) === "quota_exceeded";
}

/** Multi-line operator guide — does not mutate probe behavior. */
export function formatPlatformProbeFailureGuide(result: HarnessLlmProbeResult): string {
  const kind = classifyPlatformProbeFailure(result);
  const status = result.httpStatus ? `HTTP ${result.httpStatus}` : "request failed";
  const lines = [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "Platform LLM preflight failed (harness local tier ①)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `  model:    ${result.model}`,
    `  status:   ${status}`,
    ...(result.errorCode ? [`  code:     ${result.errorCode}`] : []),
    `  detail:   ${result.error ?? "unknown"}`,
    ...(result.endpoint ? [`  endpoint: ${result.endpoint}`] : []),
    "",
  ];

  if (kind === "quota_exceeded") {
    lines.push(
      "What this means:",
      "  CloudBase AI free / experience quota for hy3-preview is exhausted.",
      "  test:merge intentionally probes hy3 BEFORE starting real AGS boxes (fail-fast).",
      "",
      "This is NOT a sandbox or CAM bug — gateway auth succeeded; the model billing gate refused.",
      "",
      "Options (pick one):",
      "  1. Console: enable hy3-preview + purchase Token pack / raise quota",
      "     https://docs.cloudbase.net/ai/model/openai-sdk-access",
      "  2. Skip platform path: npm run harness -- run --infra tcbr --engine opencode   (opencode zen, no hy3)",
      "  3. Product demo with zen: agent.yaml model: zen + magent run (see harness-tutorial)",
      "  4. npm run test:merge auto-falls back to opencode zen on 429 (logs a warning; hy3 not validated)",
      "",
    );
  } else if (kind === "missing_credentials") {
    lines.push(
      "Fix: set CLOUDBASE_ENV_ID + TCB_SECRET_* (or magent login), then:",
      "  node scripts/harness/load-env.mjs --check",
      "",
    );
  } else if (kind === "auth") {
    lines.push(
      "Fix: verify CAM / login can derive gateway token:",
      "  node scripts/harness/load-env.mjs --check",
      "  (expect: gateway token=ok (CAM-derived))",
      "",
    );
  } else {
    lines.push(
      "Check CloudBase AI console: hy3-preview enabled.",
      "  node scripts/harness/load-env.mjs --check",
      "",
    );
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "");
  return lines.join("\n");
}

/** Normalize OPENAI_BASE_URL → `…/v1/chat/completions`. */
export function openAiChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function probeErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const top = body as { message?: string; code?: string; error?: { message?: string } };
    if (top.message) return top.message;
    if (top.error?.message) return top.error.message;
  }
  return fallback;
}

function probeErrorCode(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const top = body as { code?: string; error?: { code?: string } };
    return top.code ?? top.error?.code;
  }
  return undefined;
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
      const parsed = typeof body === "string" ? parseProbeErrorBody(raw) : null;
      return {
        ok: false,
        httpStatus: res.status,
        model,
        endpoint,
        latencyMs,
        error: parsed?.message ?? probeErrorMessage(body, raw.slice(0, 240) || `HTTP ${res.status}`),
        errorCode: parsed?.code ?? probeErrorCode(body),
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

/** CloudBase AI gateway (CLOUDBASE_APIKEY + envId) — local harness tier ①, ~30s fail-fast. */
export async function probeCloudBasePlatformLlm(options?: {
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<HarnessLlmProbeResult> {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim() || process.env.TCB_ENV_ID?.trim();
  const apiKey = process.env.CLOUDBASE_APIKEY?.trim();
  // Tier ① platform probe — never use BYOK LLM_MODEL from .env.harness ③ 段.
  const model = HARNESS_CLOUDBASE_DEFAULT_MODEL;
  if (!envId || !apiKey) {
    return {
      ok: false,
      httpStatus: 0,
      model,
      endpoint: "",
      latencyMs: 0,
      error: "missing CLOUDBASE_ENV_ID or gateway token (set TCB_SECRET_* or run magent login)",
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
      const parsed = parseProbeErrorBody(raw);
      return {
        ok: false,
        httpStatus: res.status,
        model,
        endpoint,
        latencyMs,
        error: parsed.message || probeErrorMessage(body, raw.slice(0, 300)),
        errorCode: parsed.code ?? probeErrorCode(body),
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
    const err = new Error(
      `Platform LLM probe failed: see formatted guide below (model=${result.model})`,
    ) as Error & { probeResult?: HarnessLlmProbeResult };
    err.probeResult = result;
    throw err;
  }
  return result;
}

/** CloudBase AI via Anthropic Messages（claude engine 平台路径，hy3-preview）。 */
export async function probeCloudBasePlatformAnthropicLlm(options?: {
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<HarnessLlmProbeResult> {
  const envId = process.env.CLOUDBASE_ENV_ID?.trim() || process.env.TCB_ENV_ID?.trim();
  const apiKey = process.env.CLOUDBASE_APIKEY?.trim();
  const model = HARNESS_CLOUDBASE_DEFAULT_MODEL;
  if (!envId || !apiKey) {
    return {
      ok: false,
      httpStatus: 0,
      model,
      endpoint: "",
      latencyMs: 0,
      error: "missing CLOUDBASE_ENV_ID or gateway token (set TCB_SECRET_* or run magent login)",
    };
  }
  const endpoint = anthropicMessagesUrl(cloudBaseAiGatewayBaseUrl(envId));
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
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: options?.maxTokens ?? 16,
        system: "Reply briefly.",
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
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
      const parsed = parseProbeErrorBody(raw);
      return {
        ok: false,
        httpStatus: res.status,
        model,
        endpoint,
        latencyMs,
        error: parsed.message || probeErrorMessage(body, raw.slice(0, 300)),
        errorCode: parsed.code ?? probeErrorCode(body),
      };
    }
    const content =
      (body as { content?: Array<{ type?: string; text?: string }> })?.content?.find(
        (c) => c.type === "text",
      )?.text ?? "";
    return {
      ok: !!content.trim(),
      httpStatus: res.status,
      model,
      endpoint,
      latencyMs,
      replySnippet: content.slice(0, 80),
      error: content.trim() ? undefined : "empty reply from platform model",
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

/** Claude Code 对客：无 zen fallback；额度/鉴权失败时提示检查 CloudBase AI。 */
export function formatClaudePlatformProbeFailureGuide(
  result: HarnessLlmProbeResult,
): string {
  const kind = classifyPlatformProbeFailure(result);
  const status = result.httpStatus ? `HTTP ${result.httpStatus}` : "request failed";
  const lines = [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "Claude platform LLM preflight failed (CloudBase AI / hy3-preview)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `  model:    ${result.model}`,
    `  status:   ${status}`,
    ...(result.errorCode ? [`  code:     ${result.errorCode}`] : []),
    `  detail:   ${result.error ?? "unknown"}`,
    ...(result.endpoint ? [`  endpoint: ${result.endpoint}`] : []),
    "",
    "Claude Code 无 zen 内置模型。对客运行时若平台 LLM 不通，应提示用户检查",
    "CloudBase AI 额度 / 模型开关，或配置自有 Anthropic 兼容 LLM（③ 段）。",
    "",
  ];
  if (kind === "quota_exceeded") {
    lines.push(
      "Harness 测试：若 scenarios/.env.local-claude 已填 ③，将自动 fallback 到 BYOK。",
      "Console: https://docs.cloudbase.net/ai/model/openai-sdk-access",
      "",
    );
  }
  return lines.join("\n");
}

/** Normalize ANTHROPIC_BASE_URL → `…/v1/messages`. */
export function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  if (trimmed.endsWith("/messages")) return trimmed;
  return `${trimmed}/v1/messages`;
}

/** Thinking-style gateways may burn budget before a `text` block; keep headroom. */
const SANDBOX_COMPAT_PROBE_MAX_TOKENS = 1024;

function extractAnthropicProbeReply(body: unknown): string {
  const blocks =
    (body as { content?: Array<{ type?: string; text?: string; thinking?: string }> })
      ?.content ?? [];
  const text = blocks.find((c) => c.type === "text")?.text ?? "";
  if (text.trim()) return text.trim();
  const thinking = blocks.find((c) => c.type === "thinking")?.thinking ?? "";
  return thinking.trim();
}

/**
 * Anthropic Messages — 含顶层 `system`（Claude Code / Anthropic SDK 标准形态）。
 * 用于在起 AGS 前探测 BYOK endpoint 是否可用。
 */

export async function probeHarnessAnthropicLlmSandboxCompat(options?: {
  timeoutMs?: number;
  maxTokens?: number;
  prompt?: string;
}): Promise<HarnessLlmProbeResult> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim();
  const base = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!apiKey || !model || !base) {
    return {
      ok: false,
      httpStatus: 0,
      model: model ?? "",
      endpoint: "",
      latencyMs: 0,
      error: "missing LLM_API_KEY / LLM_MODEL / ANTHROPIC_BASE_URL",
    };
  }

  const endpoint = anthropicMessagesUrl(base);
  const timeoutMs =
    options?.timeoutMs ??
    (Number(process.env.HARNESS_PLATFORM_PROBE_TIMEOUT_MS) || 30_000);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: buildAnthropicCompatFetchHeaders(apiKey, base),
      body: JSON.stringify({
        model,
        max_tokens: options?.maxTokens ?? SANDBOX_COMPAT_PROBE_MAX_TOKENS,
        system: "Reply with exactly one word. No explanation or reasoning.",
        messages: [
          { role: "user", content: options?.prompt ?? "Reply with exactly: pong" },
        ],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // keep raw
    }
    if (!res.ok) {
      const parsed = parseProbeErrorBody(raw);
      return {
        ok: false,
        httpStatus: res.status,
        model,
        endpoint,
        latencyMs,
        error: parsed?.message ?? probeErrorMessage(body, raw.slice(0, 240) || `HTTP ${res.status}`),
        errorCode: parsed?.code ?? probeErrorCode(body),
      };
    }
    const content = extractAnthropicProbeReply(body);
    return {
      ok: !!content,
      httpStatus: res.status,
      model,
      endpoint,
      latencyMs,
      replySnippet: content.slice(0, 120),
      error: content ? undefined : "empty reply (sandbox-compat probe)",
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 0,
      model,
      endpoint,
      latencyMs,
      error: message.includes("abort") ? `timeout after ${timeoutMs}ms` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One minimal Anthropic Messages round-trip (BYOK claude harness). */
export async function probeHarnessAnthropicLlm(options?: {
  timeoutMs?: number;
  maxTokens?: number;
  prompt?: string;
}): Promise<HarnessLlmProbeResult> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim();
  const base = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!apiKey || !model || !base) {
    return {
      ok: false,
      httpStatus: 0,
      model: model ?? "",
      endpoint: "",
      latencyMs: 0,
      error: "missing LLM_API_KEY / LLM_MODEL / ANTHROPIC_BASE_URL",
    };
  }

  const endpoint = anthropicMessagesUrl(base);
  const timeoutMs =
    options?.timeoutMs ??
    (Number(process.env.HARNESS_PLATFORM_PROBE_TIMEOUT_MS) || 30_000);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: buildAnthropicCompatFetchHeaders(apiKey, base),
      body: JSON.stringify({
        model,
        max_tokens: options?.maxTokens ?? 16,
        messages: [
          {
            role: "user",
            content: options?.prompt ?? "Reply with exactly: pong",
          },
        ],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // keep raw
    }
    if (!res.ok) {
      const parsed = typeof body === "string" ? parseProbeErrorBody(raw) : null;
      return {
        ok: false,
        httpStatus: res.status,
        model,
        endpoint,
        latencyMs,
        error: parsed?.message ?? probeErrorMessage(body, raw.slice(0, 240) || `HTTP ${res.status}`),
        errorCode: parsed?.code ?? probeErrorCode(body),
      };
    }
    const content =
      (body as { content?: Array<{ type?: string; text?: string }> })?.content?.find(
        (c) => c.type === "text",
      )?.text ?? "";
    return {
      ok: true,
      httpStatus: res.status,
      model,
      endpoint,
      latencyMs,
      replySnippet: String(content).trim().slice(0, 120),
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 0,
      model,
      endpoint,
      latencyMs,
      error: message.includes("abort") ? `timeout after ${timeoutMs}ms` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function assertHarnessAnthropicLlmReachable(): Promise<HarnessLlmProbeResult> {
  assertHarnessAnthropicLlmEnv();
  const result = await probeHarnessAnthropicLlmSandboxCompat();
  if (!result.ok) {
    const status = result.httpStatus ? `HTTP ${result.httpStatus}` : "request failed";
    throw new Error(
      `Anthropic LLM probe failed (${status}): ${result.error ?? "unknown"}. ` +
        `model=${result.model} endpoint=${result.endpoint || "(unset)"}. ` +
        `Probe uses Claude Code–style system message in messages[]. ` +
        `Check scenarios/.env.* ③ (LLM_API_KEY + LLM_MODEL + ANTHROPIC_BASE_URL).`,
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
        `Check LLM_API_KEY / endpoint / quota. ` +
        `Preflight: node scripts/harness/load-env.mjs --check --probe-llm`,
    );
  }
  return result;
}
