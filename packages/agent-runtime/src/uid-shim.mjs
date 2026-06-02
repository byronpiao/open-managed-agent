// uid-shim.mjs — loaded via --import before index.js in SCF.
//
// SCF functions run as uid=0 (root). Claude Code's claude binary refuses
// to run with --dangerously-skip-permissions when it detects uid==0:
//   "cannot be used with root/sudo privileges for security reasons"
//
// Fix: while still root, make key paths world-accessible, then drop to
// uid=1001 so child processes (including claude) pass the uid check.
// Must run before any module import.

import { execSync } from 'child_process';

if (process.getuid?.() === 0) {
  const UID = 1001;
  const GID = 1001;

  try {
    // Make /var/user itself traversable by uid=1001.
    try { execSync('chmod o+rx /var/user', { stdio: 'pipe' }); } catch {}
    // Make claude SDK binary and its parent dirs accessible.
    // More targeted than recursing all of node_modules.
    try { execSync('chmod o+rx /var/user/node_modules', { stdio: 'pipe' }); } catch {}
    try { execSync('chmod -R o+rx /var/user/node_modules/@anthropic-ai', { stdio: 'pipe' }); } catch {}
    try { execSync('chmod -R o+rx /var/user/node_modules/@cloudbase', { stdio: 'pipe' }); } catch {}
    // Give world read on the dist directory (index.js and friends).
    try { execSync('chmod o+rx /var/user/dist', { stdio: 'pipe' }); } catch {}

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
