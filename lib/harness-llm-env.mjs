/**
 * Harness LLM env — only standard keys (AGENT_MODEL, LLM_*, OPENAI/ANTHROPIC_BASE_URL).
 * No HARNESS_LLM_TIER / HARNESS_FORCE_ZEN: mode is derived from these + agent.yaml model.
 */

export const HARNESS_LLM_ENV_KEYS = [
  "AGENT_MODEL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
];

export function clearHarnessLlmEnv(target = process.env) {
  for (const k of HARNESS_LLM_ENV_KEYS) delete target[k];
}

/** opencode built-in zen — same as agent.yaml `model: zen` or AGENT_MODEL=zen */
export function applyZenLlmEnv(target = process.env) {
  clearHarnessLlmEnv(target);
  target.AGENT_MODEL = "zen";
}

/** CloudBase platform gateway (hy3-preview etc.) — no custom LLM env */
export function applyPlatformLlmEnv(target = process.env) {
  clearHarnessLlmEnv(target);
}

export function isZenModelFromEnv(env = process.env) {
  return env.AGENT_MODEL?.trim() === "zen";
}

export function hasOpenAiByokInEnv(env = process.env) {
  return !!(
    env.LLM_API_KEY?.trim() &&
    env.OPENAI_BASE_URL?.trim() &&
    env.LLM_MODEL?.trim()
  );
}

export function hasAnthropicByokInEnv(env = process.env) {
  return !!(
    env.LLM_API_KEY?.trim() &&
    env.ANTHROPIC_BASE_URL?.trim() &&
    env.LLM_MODEL?.trim()
  );
}

/** Human-readable label for logs — not an env var */
export function describeHarnessLlmMode(env = process.env) {
  if (isZenModelFromEnv(env)) return "zen";
  if (hasOpenAiByokInEnv(env)) return "byok-openai";
  if (hasAnthropicByokInEnv(env)) return "byok-anthropic";
  return "platform";
}

/** opencode tests: model field for AGENT_CONFIG */
export function resolveOpencodeModelFromEnv(env = process.env) {
  if (isZenModelFromEnv(env)) return "zen";
  if (hasOpenAiByokInEnv(env)) return env.LLM_MODEL.trim();
  return undefined;
}

export function captureHarnessLlmEnv(env = process.env) {
  const snap = {};
  for (const k of HARNESS_LLM_ENV_KEYS) {
    const v = env[k]?.trim();
    if (v) snap[k] = v;
  }
  return snap;
}

export function restoreHarnessLlmEnv(snap, target = process.env) {
  clearHarnessLlmEnv(target);
  Object.assign(target, snap);
}
