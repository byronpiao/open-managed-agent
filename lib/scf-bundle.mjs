import { execSync } from "child_process";
import { join } from "path";

export const SCF_DEPLOY_IGNORE = ".git,node_modules,.DS_Store,.deploy,.deploy-cloudrun,logs";

// Plain production install, omitting optional (platform) deps. We do NOT
// pre-install the 256MB linux-x64 `claude` native binary — it makes the code
// package ~193MB (slow upload) and, as a regular dep, breaks the cloud
// BuildCodeViaSCF size limit. Instead, agent-runtime's scf_bootstrap downloads
// the real binary at runtime cold-start into /tmp and points the kernel at it
// via OAK_CLAUDE_CODE_EXECUTABLE_PATH (see
// packages/agent-runtime/scf_bootstrap and open-agent-kernel agent-builder.ts).
// --omit=optional also keeps the host (macOS) platform binary out of the
// linux-bound bundle.
const NPM_PROD_INSTALL = "npm install --production --omit=optional --no-audit --no-fund 2>&1 | tail -2";

/**
 * Install production deps into an SCF deploy directory. The linux-x64 native
 * `claude` binary is intentionally NOT installed here (see comment above) — it
 * is fetched at runtime by scf_bootstrap.
 */
export function installScfLinuxDeps(codeDir) {
  execSync(NPM_PROD_INSTALL, { cwd: codeDir, encoding: "utf-8", timeout: 180000 });
  try {
    execSync(`rm -f "${join(codeDir, "node_modules", ".package-lock.json")}"`, { encoding: "utf-8" });
  } catch { /* ignore */ }
}

export function scfAgentCodeUpdateArgs(envId, agentId, codeDir) {
  return [
    "agent",
    "update",
    agentId,
    "--code",
    codeDir,
    "--ignore",
    SCF_DEPLOY_IGNORE,
    "-e",
    envId,
    "--json",
  ];
}

/** Atomic SCF code + env replace (skill sync / managed deploy). */
export function scfAgentFullUpdateArgs(envId, agentId, codeDir, envStr) {
  return [
    "agent",
    "update",
    agentId,
    "--code",
    codeDir,
    "--ignore",
    SCF_DEPLOY_IGNORE,
    "--env",
    envStr,
    "-e",
    envId,
    "--json",
  ];
}
