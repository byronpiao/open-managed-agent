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

/** Resolve envId from args, env var, or tcb auto-detect. Exits on failure. */
export function requireEnvId(args) {
  // 1. CLI flag -e / --env
  if (args.env) return args.env;
  // 2. Environment variable
  if (process.env.CLOUDBASE_ENV_ID) return process.env.CLOUDBASE_ENV_ID;
  // 3. tcb env use --json auto-detect
  const detected = detectCurrentEnvId();
  if (detected) {
    // Propagate so downstream code (tcb subprocess, HTTP headers) picks it up
    process.env.CLOUDBASE_ENV_ID = detected;
    return detected;
  }
  // 4. All failed
  console.error(red("Error: could not detect CloudBase environment."));
  console.error(dim("Run `tcb env use` to select one, or pass -e <envId>"));
  process.exit(1);
}
