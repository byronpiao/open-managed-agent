// SCF deploy helpers — args + ignore list for cloud-side dependency install.
//
// All SCF code deploys use `--install-dep`: the cloud builds node_modules from
// package.json on a linux builder, so a locally (macOS-)installed node_modules
// never ships. The cloud build skips optional deps (the 256MB linux-x64 `claude`
// native binary is NOT installed); the runtime's scf_bootstrap downloads the
// real binary at cold start into /tmp and points the kernel at it via
// OAK_CLAUDE_CODE_EXECUTABLE_PATH (see packages/agent-runtime/scf_bootstrap).
export const SCF_DEPLOY_IGNORE = ".git,node_modules,.DS_Store,.deploy,.deploy-cloudrun,logs";

export function scfAgentCodeUpdateArgs(envId, agentId, codeDir) {
  return [
    "agent",
    "update",
    agentId,
    "--code",
    codeDir,
    "--ignore",
    SCF_DEPLOY_IGNORE,
    "--install-dep",
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
    "--install-dep",
    "--env",
    envStr,
    "-e",
    envId,
    "--json",
  ];
}
