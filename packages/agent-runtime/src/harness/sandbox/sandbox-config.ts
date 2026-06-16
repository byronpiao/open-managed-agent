/**
 * agent.yaml `sandbox` block — internal draft; see docs/sandbox.md.
 * Parsed at load time with defaults; orchestrator consumes ResolvedSandboxConfig.
 */

import { normalizeSandboxEnv } from "./sandbox-env.js";

/** Mirrors HarnessEngine — kept local to avoid config ↔ sandbox-config cycle. */
export type SandboxEngine = "opencode" | "claude" | "codebuddy" | "hermes";

export interface SandboxConfigSource {
  sandbox?: SandboxConfig;
  engine?: SandboxEngine;
}

export type SandboxInfra = "serverless" | "durable";

/** AGS CustomConfiguration.ImageRegistryType — TCR namespace class. */
export type SandboxImageRegistryType = "personal" | "enterprise";

export interface SandboxResourcesInput {
  cpu?: string | number;
  memory?: string | number;
}

export type SandboxAuthMode = "token" | "none";

export interface SandboxConfig {
  /** `serverless` = AGS (default); `durable` = Talos long-lived VM (not wired yet). */
  infra?: SandboxInfra;
  /**
   * AGS instance auth. Default `token` (sit_* via X-Access-Token).
   * `none` — debug / local harness only; omit on production deploy.
   */
  auth?: SandboxAuthMode;
  resources?: SandboxResourcesInput;
  /** Overrides built-in default when yaml omits sandbox.image. */
  image?: string;
  /**
   * AGS ImageRegistryType when using custom `image` on enterprise TCR.
   * Default `personal` (personal-edition TCR). Omit for public CCR magent image.
   */
  imageRegistryType?: SandboxImageRegistryType;
  /**
   * serverless: AGS DefaultTimeout (e.g. `30m`).
   * durable: `0` or omitted = no TTL on Talos (future).
   */
  timeout?: string | number;
  /**
   * Passthrough env vars injected at instance start (TRW / box agents).
   * Cannot override OMA-managed keys — see docs/sandbox.md.
   */
  env?: Record<string, string>;
}

export interface SandboxResources {
  cpu: string;
  memory: string;
}

export interface ResolvedSandboxConfig {
  infra: SandboxInfra;
  auth: SandboxAuthMode;
  resources: SandboxResources;
  image?: string;
  imageRegistryType?: SandboxImageRegistryType;
  timeout?: string;
  env?: Record<string, string>;
}

export const DEFAULT_SANDBOX_IMAGE_REGISTRY_TYPE: SandboxImageRegistryType = "personal";

export const DEFAULT_SANDBOX_INFRA: SandboxInfra = "serverless";

/** Matches current AGS CreateSandboxTool defaults in orchestrator. */
export const DEFAULT_SANDBOX_RESOURCES: SandboxResources = {
  cpu: "2",
  memory: "2Gi",
};

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

const MEMORY_SUFFIX = /^(.*)(Gi|Mi|Ki)$/i;

function normalizeCpu(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  throw new SandboxConfigError(`sandbox.resources.cpu must be a string or number, got ${JSON.stringify(value)}`);
}

function normalizeMemory(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return `${value}Gi`;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (MEMORY_SUFFIX.test(trimmed)) return trimmed;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) return `${asNum}Gi`;
    return trimmed;
  }
  throw new SandboxConfigError(
    `sandbox.resources.memory must be a string (e.g. "4Gi") or number, got ${JSON.stringify(value)}`,
  );
}

function normalizeAuth(value: unknown): SandboxAuthMode {
  if (value === undefined || value === null || value === "") return "token";
  if (value === "token" || value === "none") return value;
  throw new SandboxConfigError(`sandbox.auth must be "token" or "none", got ${JSON.stringify(value)}`);
}

/** AGS API AuthMode from resolved sandbox config. */
export function resolveSandboxAgsAuthMode(sandbox: ResolvedSandboxConfig): "TOKEN" | "NONE" {
  return sandbox.auth === "none" ? "NONE" : "TOKEN";
}

function normalizeInfra(value: unknown): SandboxInfra {
  if (value === undefined || value === null || value === "") return DEFAULT_SANDBOX_INFRA;
  if (value === "serverless" || value === "durable") return value;
  throw new SandboxConfigError(`sandbox.infra must be "serverless" or "durable", got ${JSON.stringify(value)}`);
}

function normalizeTimeout(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  throw new SandboxConfigError(`sandbox.timeout must be a string or number, got ${JSON.stringify(value)}`);
}

function normalizeImage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeImageRegistryType(value: unknown): SandboxImageRegistryType | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "personal" || value === "enterprise") return value;
  throw new SandboxConfigError(
    `sandbox.imageRegistryType must be "personal" or "enterprise", got ${JSON.stringify(value)}`,
  );
}

/** Merge YAML `sandbox` with defaults; does not throw on engine/infra mismatch (use assertSandboxAcquireAllowed). */
export function resolveSandboxConfig(
  source: SandboxConfigSource,
  engine?: SandboxEngine,
): ResolvedSandboxConfig {
  const raw = source.sandbox;
  void (engine ?? source.engine ?? "opencode");

  const infra = normalizeInfra(raw?.infra);
  const auth = normalizeAuth(raw?.auth);
  const resources: SandboxResources = {
    cpu: normalizeCpu(raw?.resources?.cpu, DEFAULT_SANDBOX_RESOURCES.cpu),
    memory: normalizeMemory(raw?.resources?.memory, DEFAULT_SANDBOX_RESOURCES.memory),
  };
  const image = normalizeImage(raw?.image);
  const imageRegistryType = normalizeImageRegistryType(raw?.imageRegistryType);
  const timeout = normalizeTimeout(raw?.timeout);
  const env = normalizeSandboxEnv(raw?.env as Record<string, unknown> | undefined);

  return {
    infra,
    auth,
    resources,
    ...(image ? { image } : {}),
    ...(imageRegistryType ? { imageRegistryType } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(env ? { env } : {}),
  };
}

/** AGS CustomConfiguration.Resources shape. */
export function buildAgsSandboxResources(resources: SandboxResources): { CPU: string; Memory: string } {
  return { CPU: resources.cpu, Memory: resources.memory };
}

export function resolveSandboxImageRegistryType(
  sandbox: ResolvedSandboxConfig,
  fallback: SandboxImageRegistryType = DEFAULT_SANDBOX_IMAGE_REGISTRY_TYPE,
): SandboxImageRegistryType {
  return sandbox.imageRegistryType ?? fallback;
}

export function resolveSandboxImage(sandbox: ResolvedSandboxConfig, fallbackImage: string): string {
  return sandbox.image?.trim() || fallbackImage;
}

export function resolveSandboxTimeout(sandbox: ResolvedSandboxConfig, fallbackTimeout: string): string {
  if (sandbox.timeout === undefined) return fallbackTimeout;
  if (sandbox.infra === "durable" && (sandbox.timeout === "0" || sandbox.timeout === "0m")) {
    return "0";
  }
  return sandbox.timeout;
}

/**
 * Gate sandbox acquire by infra + engine. Draft rules — see docs/sandbox.md.
 * Throws SandboxConfigError when the combination cannot run today.
 */
export function assertSandboxAcquireAllowed(
  sandbox: ResolvedSandboxConfig,
  engine: SandboxEngine,
): void {
  if (sandbox.infra === "durable") {
    throw new SandboxConfigError(
      "sandbox.infra=durable (Talos) is not wired in the orchestrator yet; use serverless for AGS or wait for Talos manage-node integration",
    );
  }

  if (sandbox.infra === "serverless" && engine === "hermes") {
    throw new SandboxConfigError(
      'engine=hermes requires sandbox.infra=durable (Talos Hermes preset); serverless AGS has no Hermes image',
    );
  }
}

/** Write resolved sandbox back onto config after YAML / AGENT_CONFIG load. */
export function applyResolvedSandboxToConfig<T extends SandboxConfigSource>(
  config: T,
  resolved: ResolvedSandboxConfig,
): T {
  return {
    ...config,
    sandbox: {
      infra: resolved.infra,
      auth: resolved.auth,
      resources: { ...resolved.resources },
      ...(resolved.image ? { image: resolved.image } : {}),
      ...(resolved.imageRegistryType ? { imageRegistryType: resolved.imageRegistryType } : {}),
      ...(resolved.timeout !== undefined ? { timeout: resolved.timeout } : {}),
      ...(resolved.env ? { env: { ...resolved.env } } : {}),
    },
  };
}
