/**
 * agent.yaml `sandbox.env` — explicit passthrough to TRW instance env at start.
 * See docs/sandbox.md § sandbox.env.
 */

import type { HarnessEnvVar } from "../../config.js";

function sandboxEnvError(message: string): Error {
  return Object.assign(new Error(message), { name: "SandboxConfigError" });
}

export const SANDBOX_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const SANDBOX_ENV_VALUE_MAX_LENGTH = 8192;

/** Keys owned by OMA at acquire time — must not be set via sandbox.env. */
export const SANDBOX_ENV_DENY_EXACT = new Set([
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
  "TCB_API_KEY",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
]);

const SANDBOX_ENV_DENY_PREFIXES = ["HARNESS_", "ENABLE_AGENT_"] as const;

export function assertSandboxEnvKeyAllowed(name: string): void {
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

export function assertSandboxEnvValueAllowed(name: string, value: string): void {
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

/** Validate and normalize sandbox.env from YAML (throws SandboxConfigError). */
export function normalizeSandboxEnv(
  raw: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw sandboxEnvError("sandbox.env must be a string map");
  }
  const out: Record<string, string> = {};
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

export function sandboxEnvToHarnessVars(
  env: Record<string, string> | undefined,
): HarnessEnvVar[] {
  if (!env) return [];
  return Object.entries(env).map(([Name, Value]) => ({ Name, Value }));
}

/** Merge yaml passthrough after computed instance env; yaml wins on key collision. */
export function mergeHarnessInstanceEnv(
  computed: HarnessEnvVar[],
  fromSandboxYaml: HarnessEnvVar[],
): HarnessEnvVar[] {
  if (!fromSandboxYaml.length) return computed;
  const byName = new Map(computed.map((e) => [e.Name, e]));
  for (const entry of fromSandboxYaml) {
    byName.set(entry.Name, entry);
  }
  return [...byName.values()];
}
