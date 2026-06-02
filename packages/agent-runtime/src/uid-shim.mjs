// uid-shim.mjs — loaded via --import before index.js in SCF.
//
// SCF functions run as uid=0 (root). Claude Code's claude binary refuses
// to run with --dangerously-skip-permissions when it detects uid==0:
//   "cannot be used with root/sudo privileges for security reasons"
//
// Fix: while still root, ensure the claude binary is world-executable,
// then drop to uid=1001 so child processes (including claude) pass the
// uid check. This must run before any module import.

import { execSync } from 'child_process';

if (process.getuid?.() === 0) {
  const UID = 1001;
  const GID = 1001;

  try {
    // Ensure claude binary is readable+executable by non-root users.
    // /var/user is read-only but chmod the binary (which is on the FS layer)
    // should work from root before dropping privileges.
    try {
      execSync('find /var/user/node_modules/@anthropic-ai -name claude -type f -exec chmod 755 {} \\;', { stdio: 'pipe' });
    } catch {}

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
