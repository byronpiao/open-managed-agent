import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, join } from "path";

export const SCF_DEPLOY_IGNORE = ".git,node_modules,.DS_Store,.deploy,.deploy-cloudrun,logs";

const NPM_LINUX_INSTALL =
  "npm install --production --os=linux --cpu=x64 --include=optional --force --no-audit --no-fund 2>&1 | tail -2";

/** Install linux/x64 production deps into an SCF deploy directory. */
export function installScfLinuxDeps(codeDir) {
  execSync(NPM_LINUX_INSTALL, { cwd: codeDir, encoding: "utf-8", timeout: 180000 });
  try {
    execSync(`rm -f "${join(codeDir, "node_modules", ".package-lock.json")}"`, { encoding: "utf-8" });
  } catch { /* ignore */ }
  execSync(NPM_LINUX_INSTALL, { cwd: codeDir, encoding: "utf-8", timeout: 180000 });

  const linuxPkg = resolve(
    codeDir,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk-linux-x64",
    "claude",
  );
  if (!existsSync(linuxPkg)) {
    const anthropicDir = resolve(codeDir, "node_modules", "@anthropic-ai");
    const present = existsSync(anthropicDir)
      ? execSync("ls node_modules/@anthropic-ai/", { cwd: codeDir, encoding: "utf-8" }).trim()
      : "(no @anthropic-ai dir)";
    throw new Error(`linux-x64 binary missing at ${linuxPkg}; @anthropic-ai contains: ${present}`);
  }
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
