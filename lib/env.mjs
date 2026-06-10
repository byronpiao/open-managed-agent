// ── Environment ID resolution ─────────────────────────────────────────────────
// Auto-detects the current CloudBase environment ID via `tcb env use --json`.
// Falls back to -e flag or CLOUDBASE_ENV_ID env var.

import { runTcb } from "./tcb.mjs";
import { red, dim } from "./ui.mjs";

/** Try to detect the currently selected envId via tcb CLI. */
export function detectCurrentEnvId() {
  try {
    const raw = runTcb(["env", "use", "--json"], { allowFail: true, timeout: 10000 });
    const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return data?.data?.currentEnvId ?? "";
  } catch {
    return "";
  }
}

/** Region for the given env (or current `tcb env use` target). */
export function detectEnvRegion(envId) {
  const id = envId?.trim() || detectCurrentEnvId();
  if (!id) return "";
  try {
    const raw = runTcb(
      ["env", "detail", "-e", id, "--json", "--yes"],
      { allowFail: true, timeout: 15000 },
    );
    const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return data?.data?.region ?? "";
  } catch {
    return "";
  }
}

/**
 * Fill CLOUDBASE_ENV_ID / TCB_REGION from tcb CLI when unset.
 * Values already in process.env (file / shell) are left unchanged.
 */
export function hydrateCloudEnvFromCli({ envId } = {}) {
  const id = (envId?.trim() || process.env.CLOUDBASE_ENV_ID?.trim() || detectCurrentEnvId());
  if (id && !process.env.CLOUDBASE_ENV_ID?.trim()) {
    process.env.CLOUDBASE_ENV_ID = id;
  }
  const resolvedId = process.env.CLOUDBASE_ENV_ID?.trim() || id;
  if (!process.env.TCB_REGION?.trim() && resolvedId) {
    const region = detectEnvRegion(resolvedId);
    if (region) process.env.TCB_REGION = region;
  }
  return {
    envId: process.env.CLOUDBASE_ENV_ID?.trim() || "",
    region: process.env.TCB_REGION?.trim() || "",
  };
}

/** Resolve envId from args, env var, or tcb auto-detect. Exits on failure. */
export function requireEnvId(args) {
  let envId;
  // 1. CLI flag -e / --env
  if (args.env) envId = args.env;
  // 2. Environment variable
  else if (process.env.CLOUDBASE_ENV_ID) envId = process.env.CLOUDBASE_ENV_ID;
  // 3. tcb env use --json auto-detect
  else {
    const detected = detectCurrentEnvId();
    if (detected) envId = detected;
  }
  if (!envId) {
    console.error(red("Error: could not detect CloudBase environment."));
    console.error(dim("Run `tcb env use` to select one, or pass -e <envId>"));
    process.exit(1);
  }
  if (!process.env.CLOUDBASE_ENV_ID?.trim()) {
    process.env.CLOUDBASE_ENV_ID = envId;
  }
  hydrateCloudEnvFromCli({ envId });
  return envId;
}
