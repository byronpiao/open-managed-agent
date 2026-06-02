// uid-shim.mjs — loaded via --import before index.js in SCF.
//
// SCF functions run as uid=0 (root). Claude Code's claude binary refuses
// to run with --dangerously-skip-permissions when it detects uid==0:
//   "cannot be used with root/sudo privileges for security reasons"
//
// Two-strategy approach:
//   A) Drop to uid=1001 via process.setuid() — child processes (claude)
//      pass the uid check. chmod o+rx ensures uid=1001 can traverse
//      /var/user paths owned by root.
//   B) Patch the kernel's permissionMode from 'bypassPermissions' to
//      'acceptEdits' — 'acceptEdits' does NOT pass --dangerously-skip-
//      permissions, so there is no uid check at all. The process stays
//      as root but claude never refuses. This is the fallback if setuid
//      or traversal fails.
//
// We apply both: B first (patch kernel while still root), then A (setuid).

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

// Strategy B: patch kernel permissionMode before it loads.
// /var/user is writable by root even though it appears read-only to non-root.
try {
  const kernelPath = '/var/user/node_modules/@cloudbase/open-agent-kernel/dist/index.js';
  let src = readFileSync(kernelPath, 'utf8');
  if (src.includes('"bypassPermissions"')) {
    src = src.replace(/"bypassPermissions"/g, '"acceptEdits"');
    writeFileSync(kernelPath, src);
  }
} catch {}

if (process.getuid?.() === 0) {
  const UID = 1001;
  const GID = 1001;

  try {
    // Make /var/user paths accessible to uid=1001 before dropping root.
    try { execSync('chmod o+rx /var/user', { stdio: 'pipe' }); } catch {}
    try { execSync('chmod o+rx /var/user/node_modules', { stdio: 'pipe' }); } catch {}
    try { execSync('chmod -R o+rx /var/user/node_modules/@anthropic-ai', { stdio: 'pipe' }); } catch {}
    try { execSync('chmod -R o+rx /var/user/node_modules/@cloudbase', { stdio: 'pipe' }); } catch {}
    try { execSync('chmod o+rx /var/user/dist', { stdio: 'pipe' }); } catch {}

    // Strategy A: drop root privileges.
    try { execSync(`getent group agent 2>/dev/null || groupadd --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    try { execSync(`id agent 2>/dev/null || useradd --no-create-home --uid ${UID} --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    try { execSync('chown -R agent:agent /tmp 2>/dev/null || true', { stdio: 'pipe' }); } catch {}
    process.setgid(GID);
    process.setuid(UID);
  } catch (e) {
    process.stderr.write(`[uid-shim] setuid failed (${e.message}); relying on kernel acceptEdits patch.\n`);
  }
}
