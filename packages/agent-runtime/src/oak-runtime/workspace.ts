/**
 * OAK session cwd — kernel AgentConfig.cwd and skill materialize target.
 * Keep `scf_bootstrap` OAK_WORKSPACE_CWD in sync with {@link OAK_WORKSPACE_CWD}.
 */

import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

/** OAK kernel `cwd` + `.claude/skills/` materialize root (SCF + TCBR). */
export const OAK_WORKSPACE_CWD = "/tmp/workspace";

let cachedOakWorkspaceCwd: string | undefined;

/** Ensures writable session cwd exists; cached for process lifetime. */
export function resolveOakWorkspaceCwd(): string {
  if (cachedOakWorkspaceCwd) return cachedOakWorkspaceCwd;
  const dir = OAK_WORKSPACE_CWD;
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.oak-cwd-probe-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (err) {
    console.warn(
      `[OAK] Workspace cwd not writable (${dir}): ${(err as Error).message}`,
    );
  }
  cachedOakWorkspaceCwd = dir;
  return dir;
}
