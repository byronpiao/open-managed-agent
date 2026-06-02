// uid-shim.mjs — loaded via --import before index.js in SCF.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

if (process.getuid?.() === 0) {
  const UID = 1001;
  const GID = 1001;

  try {
    try { execSync(`getent group agent 2>/dev/null || groupadd --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    try { execSync(`id agent 2>/dev/null || useradd --no-create-home --uid ${UID} --gid ${GID} agent`, { stdio: 'pipe' }); } catch {}
    try { execSync('chown -R agent:agent /tmp 2>/dev/null || true', { stdio: 'pipe' }); } catch {}
    process.setgid(GID);
    process.setuid(UID);
  } catch (e) {
    process.stderr.write(`[uid-shim] Warning: could not drop root: ${e.message}\n`);
  }
}

// Patch kernel: log every text_delta and session_idle to stderr so we can
// see whether the model is emitting text events at all.
try {
  const kernelPath = '/var/user/node_modules/@cloudbase/open-agent-kernel/dist/index.js';
  let src = readFileSync(kernelPath, 'utf8');
  if (src.includes('text_delta') && !src.includes('__patched_by_uid_shim')) {
    src = '/* __patched_by_uid_shim */\n' + src;
    // Log each text_delta event before the condition check
    src = src.replace(
      /evt\.delta\.type === "text_delta"/g,
      `(process.stderr.write("[kernel-patch] got delta type=" + evt.delta.type + "\\n"), evt.delta.type === "text_delta")`
    );
    // Log session_idle
    src = src.replace(
      /"completed" \}/g,
      `"completed" }, process.stderr.write("[kernel-patch] session_idle:completed\\n")`
    );
    writeFileSync(kernelPath, src);
    process.stderr.write('[uid-shim] kernel event logging patch applied\n');
  }
} catch (e) {
  process.stderr.write(`[uid-shim] kernel patch failed: ${e.message}\n`);
}
