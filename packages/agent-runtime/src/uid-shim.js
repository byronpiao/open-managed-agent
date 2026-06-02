// uid-shim.js — loaded via node --require before index.js in SCF.
//
// SCF functions run as uid=0 (root). Claude Code's claude binary refuses
// to run with --dangerously-skip-permissions when it detects uid==0:
//   "cannot be used with root/sudo privileges for security reasons"
//
// Fix: create uid 1001 if it doesn't exist, then drop root via
// process.setuid()/process.setgid(). These are real syscalls that affect
// child processes (including the claude binary) — unlike patching the JS
// process.getuid function, which only affects the current JS context.
//
// process.setuid() requires the uid to exist in /etc/passwd. We use
// 'useradd' or fall back to writing /etc/passwd directly.
//
// This must run before index.js (and any import of open-agent-kernel)
// so that the uid is already dropped by the time the kernel spawns claude.
if (process.getuid?.() === 0) {
  const { execSync } = require('child_process');
  const UID = 1001;
  const GID = 1001;

  try {
    // Create group + user if they don't exist. --no-create-home avoids
    // /home writes; home is /tmp/agent-home set by scf_bootstrap.
    try {
      execSync(`getent group agent || groupadd --gid ${GID} agent`, { stdio: 'pipe' });
    } catch {}
    try {
      execSync(`id agent || useradd --no-create-home --uid ${UID} --gid ${GID} agent`, { stdio: 'pipe' });
    } catch {}

    // Give the agent user write access to the working dirs.
    try {
      execSync('chown -R agent:agent /tmp 2>/dev/null || true', { stdio: 'pipe' });
    } catch {}

    process.setgid(GID);
    process.setuid(UID);
  } catch (e) {
    process.stderr.write(`[uid-shim] Warning: could not drop root: ${e.message}\n`);
  }
}
