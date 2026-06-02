// uid-shim.mjs — loaded via --import before index.js in SCF.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

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
    console.error('[uid-shim] Warning: could not drop root:', e.message);
  }
}

// Patch kernel to log stream events for diagnosis
const kernelPath = '/var/user/node_modules/@cloudbase/open-agent-kernel/dist/index.js';
try {
  console.error('[uid-shim] checking kernel at', kernelPath, 'exists=', existsSync(kernelPath));
  if (existsSync(kernelPath)) {
    let src = readFileSync(kernelPath, 'utf8');
    console.error('[uid-shim] kernel src length=', src.length, 'already-patched=', src.includes('__uid_shim_v2__'));
    if (!src.includes('__uid_shim_v2__')) {
      const marker = 'evt?.type === "content_block_delta" && evt.delta?.type === "text_delta"';
      if (src.includes(marker)) {
        src = src.replace(
          marker,
          `(console.error("[k] delta type=" + (evt?.delta?.type||"?") + " text=" + JSON.stringify((evt?.delta?.text||"").slice(0,20))), (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta"))`
        );
        src = src.replace(
          '"completed" }',
          '"completed" }, console.error("[k] session_idle:completed")'
        );
        src = '/* __uid_shim_v2__ */\n' + src;
        writeFileSync(kernelPath, src, 'utf8');
        console.error('[uid-shim] kernel patch v2 applied OK');
      } else {
        console.error('[uid-shim] marker not found, searching...');
        const idx = src.indexOf('content_block_delta');
        console.error('[uid-shim] content_block_delta at index:', idx, 'ctx:', src.slice(Math.max(0,idx-50), idx+100));
      }
    }
  }
} catch (e) {
  console.error('[uid-shim] patch error:', e.message);
}
