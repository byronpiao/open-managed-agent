// uid-shim.mjs — loaded via --import before index.js in SCF.
//
// SCF functions run as uid=0 (root). Claude Code's claude binary refuses
// to run with --dangerously-skip-permissions when it detects uid==0:
//   "cannot be used with root/sudo privileges for security reasons"
//
// This shim drops the process to uid=1001 before the kernel loads,
// so the spawned claude binary also runs as uid=1001.

import { execSync } from 'child_process';

if (process.getuid?.() === 0) {
  const UID = 1001;
  const GID = 1001;

  try {
    // Create agent user if needed.
    try { execSync(`getent group agent 2>/dev/null || groupadd --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    try { execSync(`id agent 2>/dev/null || useradd --no-create-home --uid ${UID} --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    // Give agent user access to writable directories.
    try { execSync('chown -R agent:agent /tmp 2>/dev/null || true', { stdio: 'pipe' }); } catch {}
    // Drop root privileges.
    process.setgid(GID);
    process.setuid(UID);
  } catch (e) {
    process.stderr.write(`[uid-shim] Warning: could not drop root: ${e.message}\n`);
  }
}
