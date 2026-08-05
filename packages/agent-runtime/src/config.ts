/**
 * Harness runtime config — shared schema + harness-only extras.
 *
 * Re-exports the runtime-agnostic schema/loader from
 * open-managed-agent-runtime-shared, then layers on harness-specific config:
 *   - `normalizeAgentConfig` resolves full sandbox placement (infra/resources/image)
 *   - `resolveSkills` injects harness file: skills into the system prompt
 *   - AGS env/tool-name helpers (buildHarnessInstanceEnv, harnessEnvSlug, ...)
 *
 * Kept as `src/config.ts` so the harness tree's relative `../config.js` imports
 * keep resolving unchanged. Schema logic lives ONLY in the shared package.
 */
import fs from "fs/promises";
import path from "path";
import {
  loadAgentConfig as sharedLoadAgentConfig,
  getConfigFilePath as sharedGetConfigFilePath,
  resolveRuntime as sharedResolveRuntime,
  type AgentConfig as SharedAgentConfig,
  type HarnessEngine as SharedHarnessEngine,
  type DataPlaneEngineSlug as SharedDataPlaneEngineSlug,
} from "open-managed-agent-runtime-shared/config.js";
import {
  applyResolvedSandboxToConfig,
  resolveSandboxConfig,
} from "./harness/sandbox/sandbox-config.js";
import { resolveHarnessSkillDoc } from "./harness/file-skill.js";

export * from "open-managed-agent-runtime-shared/config.js";

// ── Harness sandbox helpers (kept re-exported here for lib/tests compat) ─────

export type {
  SandboxConfig as HarnessSandboxConfig,
  SandboxResources,
  ResolvedSandboxConfig,
} from "./harness/sandbox/sandbox-config.js";
export {
  SandboxConfigError,
  DEFAULT_SANDBOX_INFRA,
  DEFAULT_SANDBOX_RESOURCES,
  resolveSandboxConfig,
  resolveSandboxImageRegistryType,
  assertSandboxAcquireAllowed,
  buildAgsSandboxResources,
  applyResolvedSandboxToConfig,
} from "./harness/sandbox/sandbox-config.js";
export {
  normalizeSandboxEnv,
  mergeHarnessInstanceEnv,
  sandboxEnvToHarnessVars,
  SANDBOX_ENV_DENY_EXACT,
} from "./harness/sandbox/sandbox-env.js";

// ── Harness sandbox placement ────────────────────────────────────────────────

/** Apply sandbox defaults after YAML / AGENT_CONFIG parse (harness runtime). */
export function normalizeAgentConfig(config: SharedAgentConfig): SharedAgentConfig {
  const { runtime } = sharedResolveRuntime(config);
  if (runtime === "harness") {
    const resolved = resolveSandboxConfig({
      sandbox: config.sandbox,
      engine: config.engine,
    });
    return applyResolvedSandboxToConfig(config, resolved);
  }
  return config;
}

/** Harness loader: shared pipeline + harness sandbox normalizer. */
export async function loadAgentConfig(): Promise<SharedAgentConfig> {
  return sharedLoadAgentConfig(normalizeAgentConfig);
}

// ── Harness-only helpers ─────────────────────────────────────────────────────

export function engineToDataPlaneSlug(
  engine: SharedHarnessEngine,
): SharedDataPlaneEngineSlug {
  switch (engine) {
    case "claude":
      return "claudecode";
    case "codebuddy":
      return "codebuddy";
    case "hermes":
      return "hermes";
    default:
      return "opencode";
  }
}

/** Env slug for AGS sandbox tool names (`oma-harness-{slug}`). */
export function harnessEnvSlug(envId: string, maxLen = 40): string {
  return envId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, maxLen) || "default";
}

/** Resolve auto-created AGS tool name for env (`oma-harness-{slug}`; COS is mount config only). */
export function resolveHarnessToolName(
  envId: string,
  _cosEnabled = false,
): string {
  const slug = harnessEnvSlug(envId, 40);
  return `oma-harness-${slug}`;
}

export function harnessToolNameForEnv(envId: string): string {
  return resolveHarnessToolName(envId);
}

/** AGS StartSandboxInstance CustomConfiguration.Env entries (F4 / D1). */
export interface HarnessEnvVar {
  Name: string;
  Value: string;
}

export function buildHarnessInstanceEnv(
  config: SharedAgentConfig,
  engine: SharedHarnessEngine,
): HarnessEnvVar[] {
  const out: HarnessEnvVar[] = [];
  const push = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== "") {
      out.push({ Name: name, Value: value });
    }
  };

  if (engine === "opencode") {
    push("ENABLE_AGENT_OPENCODE", "true");
    push("ENABLE_AGENT_OPENCODE_ACP", "true");
    push("ENABLE_AGENT_OPENCODE_SERVE", "true");
  } else if (engine === "claude") {
    push("ENABLE_AGENT_CLAUDE_ACP", "true");
    push("HARNESS_CLAUDE_SESSION_STORE", "1");
    push("CLAUDE_CONFIG_DIR", "/tmp/.claude");
  } else if (engine === "codebuddy") {
    push("ENABLE_AGENT_CODEBUDDY_ACP", "true");
  } else if (engine === "hermes") {
    // Packer/Talos images only — both toggles match packer/presets/hermes.pkrvars.hcl.
    push("ENABLE_AGENT_HERMES_ACP", "true");
    push("ENABLE_AGENT_HERMES_WEB", "true");
  }

  // SECRET_MASTER_KEY: injected per harness session (harness_sessions.secretMasterKey), not from host env.
  push(
    "INTEGRATION_IDE",
    engine === "codebuddy"
      ? "codebuddy"
      : engine === "claude"
        ? "claude"
        : engine === "hermes"
          ? "hermes"
          : "opencode",
  );
  push("WORKSPACE_FOLDER_PATHS", "/home/user");

  return out;
}

/**
 * Inject skills into system prompt — harness runtime only.
 * Managed agents use OAK native skills (see managed/skills.ts in the managed package).
 */
export async function resolveSkills(config: SharedAgentConfig): Promise<SharedAgentConfig> {
  const { runtime } = sharedResolveRuntime(config);
  if (runtime !== "harness") {
    return config;
  }

  const skills = config.skills;
  if (!skills || skills.length === 0) {
    return config;
  }

  console.warn(`[Config] Resolving ${skills.length} harness skill(s) for system prompt...`);
  const blocks: string[] = [];
  const configDir = sharedGetConfigFilePath()
    ? path.dirname(sharedGetConfigFilePath()!)
    : process.cwd();

  for (const skill of skills) {
    const src = skill.source?.trim();
    if (!src?.startsWith("file:")) {
      console.warn(`[Config] Harness skill skipped — file: required: ${src ?? "(missing)"}`);
      continue;
    }

    const resolved = await resolveHarnessSkillDoc(configDir, src);
    if (!resolved) {
      console.warn(`[Config] Skill (${src}): not found under ${configDir}`);
      continue;
    }

    const { label, srcPath } = resolved;
    try {
      const content = await fs.readFile(srcPath, "utf-8");
      const header = `# Skill: ${label}\n`;
      blocks.push(`${header}\n${content.trim()}`);
    } catch (err) {
      console.warn(
        `[Config] Skill '${label}': failed to read ${srcPath}: ${(err as Error).message}`,
      );
    }
  }

  if (blocks.length === 0) return config;

  const skillSection = `\n\n---\n\n## Skills\n\n${blocks.join("\n\n---\n\n")}`;
  return { ...config, system: config.system + skillSection };
}
