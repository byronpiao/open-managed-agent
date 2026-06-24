import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SANDBOX_YAML_PATHS = ["agent.harness.yaml", "scripts/harness/scenarios/agent.opencode.yaml"];

function readFirstHarnessSandboxYaml(repoRoot) {
  for (const rel of SANDBOX_YAML_PATHS) {
    const p = resolve(repoRoot, rel);
    if (!existsSync(p)) continue;
    try {
      const cfg = parse(readFileSync(p, "utf8"));
      if (cfg?.sandbox && typeof cfg.sandbox === "object") return cfg.sandbox;
    } catch {
      /* ignore malformed yaml */
    }
  }
  return null;
}

/** Read `sandbox` block from local agent yaml (harness dev copy or scenario template). */
export function readHarnessSandboxFromYaml(repoRoot = defaultRepoRoot) {
  return readFirstHarnessSandboxYaml(repoRoot);
}

/** Read sandbox.image from local agent yaml. */
export function resolveSandboxImageFromYaml(repoRoot = defaultRepoRoot) {
  const sandbox = readFirstHarnessSandboxYaml(repoRoot);
  const img = sandbox?.image?.trim();
  return img || null;
}

/** Read sandbox.imageRegistryType (`personal` | `enterprise`). */
export function resolveSandboxImageRegistryTypeFromYaml(repoRoot = defaultRepoRoot) {
  const sandbox = readFirstHarnessSandboxYaml(repoRoot);
  const t = sandbox?.imageRegistryType?.trim();
  if (t === "personal" || t === "enterprise") return t;
  return "personal";
}

/** Operational image for sync-tool / preflight: yaml override, else built-in default constant. */
export async function resolveHarnessOperationalSandboxImage(repoRoot = defaultRepoRoot) {
  const fromYaml = resolveSandboxImageFromYaml(repoRoot);
  if (fromYaml) return fromYaml;
  const { HARNESS_PUBLIC_MAGENT_IMAGE } = await import("../packages/agent-runtime/dist/harness/harness-env.js");
  return HARNESS_PUBLIC_MAGENT_IMAGE;
}
