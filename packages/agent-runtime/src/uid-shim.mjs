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
    process.stderr.write(`[uid-shim] Warning: could not drop root: ${e.message}\n`);
  }
}

// Monkey-patch the kernel's event generator by wrapping the module.
// Since we can't easily intercept the internal generator, we log all
// stream events by patching the kernel dist file before it loads.
const kernelPath = '/var/user/node_modules/@cloudbase/open-agent-kernel/dist/index.js';
try {
  if (existsSync(kernelPath)) {
    let src = readFileSync(kernelPath, 'utf8');
    // Check if already patched
    if (!src.includes('__uid_shim_patched__')) {
      // Add a global log for every stream event type
      // Find the "stream_event" case and add logging before the text_delta check
      const marker = 'evt?.type === "content_block_delta" && evt.delta?.type === "text_delta"';
      if (src.includes(marker)) {
        src = src.replace(
          marker,
          `(process.stderr.write("[k] cblock_delta type=" + (evt?.delta?.type||"?") + " text=" + JSON.stringify((evt?.delta?.text||"").slice(0,20)) + "\\n"), (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta"))`
        );
        // Also log the result event
        src = src.replace(
          '"completed" }',
          '"completed" }, process.stderr.write("[k] result:completed\\n")'
        );
        src = '/* __uid_shim_patched__ */\n' + src;
        writeFileSync(kernelPath, src, 'utf8');
        process.stderr.write('[uid-shim] kernel patch applied\n');
      } else {
        process.stderr.write('[uid-shim] marker not found in kernel, src length=' + src.length + '\n');
      }
    } else {
      process.stderr.write('[uid-shim] kernel already patched\n');
    }
  } else {
    process.stderr.write('[uid-shim] kernel not found at ' + kernelPath + '\n');
  }
} catch (e) {
  process.stderr.write('[uid-shim] patch error: ' + e.message + '\n');
}
