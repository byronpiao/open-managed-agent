// uid-shim.js — loaded via node --require before index.js in SCF.
//
// SCF functions run as uid=0 (root). Claude Code's claude binary refuses
// to run with --dangerously-skip-permissions when it detects uid==0:
//   "cannot be used with root/sudo privileges for security reasons"
//
// Fix: create uid 1001 if it doesn't exist, then drop root via
// process.setuid()/process.setgid(). These are real POSIX syscalls that
// affect child processes (including the claude binary).
//
// This file is loaded as ESM (the project uses "type":"module") so we
// use top-level await and dynamic import instead of require().

import { execSync } from 'child_process';

if (process.getuid?.() === 0) {
  const UID = 1001;
  const GID = 1001;

  try {
    try { execSync(`getent group agent || groupadd --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    try { execSync(`id agent || useradd --no-create-home --uid ${UID} --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    try { execSync('chown -R agent:agent /tmp 2>/dev/null || true', { stdio: 'pipe' }); } catch {}
    process.setgid(GID);
    process.setuid(UID);
  } catch (e) {
    process.stderr.write(`[uid-shim] Warning: could not drop root: ${e.message}\n`);
  }
}
