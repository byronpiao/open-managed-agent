/**
 * OAK session cwd — kernel AgentConfig.cwd and skill materialize target.
 *
 * SCF / TCBR 目前共用 `/tmp/workspace`（历史上 toKernelAgentConfig 一直写死此路径）。
 * SCF `scf_bootstrap` 须与 {@link OAK_WORKSPACE_CWD} 保持同步。
 */

import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

/** OAK kernel `cwd` + `.claude/skills/` materialize root (SCF + TCBR). */
export const OAK_WORKSPACE_CWD = "/tmp/workspace";

/** @deprecated Use {@link OAK_WORKSPACE_CWD} */
export const OAK_WORKSPACE_CWD_SCF = OAK_WORKSPACE_CWD;

/**
 * @deprecated Prefer {@link resolveOakWorkspaceCwd}; kept for tests referencing the path.
 */
export const DEFAULT_WORKSPACE_CWD = OAK_WORKSPACE_CWD;

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
  } catch {
    // scf_bootstrap 通常会预建；仍返回约定路径
  }
  cachedOakWorkspaceCwd = dir;
  return dir;
}
