// ── tcb script resolver ──────────────────────────────────────────────────────
// Resolves the @cloudbase/cli entry script using Node.js module resolution —
// completely PATH-independent. We then spawn it as:
//   spawnSync(process.execPath, [tcbScript, ...args])
// using the absolute node binary path (process.execPath).
//
// Resolution order:
//   1. Local node_modules (present after `npm install`) — preferred
//   2. Global nvm install beside process.execPath — always available when
//      magent itself was installed via the same nvm node

import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

const TCB_SCRIPT_REL = ["@cloudbase", "cli", "dist", "standalone", "cli.js"].join("/");

// ── Runtime detection ────────────────────────────────────────────────────────
// Bun compiled binaries: process.versions.bun is set, process.versions.v8 is not.
// process.execPath points to the compiled binary itself — NOT a node/bun interpreter.
// We must find a node or bun interpreter separately to run @cloudbase/cli scripts.

export const IS_BUN_COMPILED =
  typeof Bun !== "undefined" && !!process.versions?.bun && !process.versions?.v8;

let _nodeExec = null;

/** Return the Node.js / Bun executable to use when spawning @cloudbase/cli.
 *
 *  - Normal Node.js script:  process.execPath  (absolute, no PATH needed)
 *  - Bun script (not compiled): process.execPath  (absolute bun binary)
 *  - Compiled Bun binary: process.execPath IS the compiled app — search PATH
 *    for `node` or `bun` instead.
 */
export function getNodeExecutable() {
  if (_nodeExec) return _nodeExec;
  if (!IS_BUN_COMPILED) return (_nodeExec = process.execPath);

  // Compiled Bun binary: find node or bun in PATH
  const sep     = process.platform === "win32" ? ";" : ":";
  const exts    = process.platform === "win32" ? [".exe", ""] : [""];
  const dirs    = (process.env.PATH ?? "").split(sep).filter(Boolean);

  for (const candidate of ["node", "bun"]) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = resolve(dir, candidate + ext);
        if (existsSync(full)) return (_nodeExec = full);
      }
    }
  }
  throw new Error(
    "node or bun not found in PATH.\n" +
    "Install Node.js (https://nodejs.org) and run: npm install -g @cloudbase/cli"
  );
}

let _tcbScript = null;
export function getTcbScript() {
  if (_tcbScript) return _tcbScript;
  // 1. Local install — require.resolve uses Node module resolution (no PATH)
  try {
    return (_tcbScript = _require.resolve(TCB_SCRIPT_REL));
  } catch {}
  // 2. Global install relative to process.execPath (nvm: <execPath>/../../lib/node_modules/...)
  const execRelScript = resolve(
    process.execPath, "..", "..",
    "lib", "node_modules", "@cloudbase", "cli", "dist", "standalone", "cli.js"
  );
  if (existsSync(execRelScript)) return (_tcbScript = execRelScript);
  // 3. Compiled Bun binary: try relative to the node/bun interpreter found in PATH
  if (IS_BUN_COMPILED) {
    try {
      const nodeExec = getNodeExecutable();
      const nodeRelScript = resolve(
        nodeExec, "..", "..",
        "lib", "node_modules", "@cloudbase", "cli", "dist", "standalone", "cli.js"
      );
      if (existsSync(nodeRelScript)) return (_tcbScript = nodeRelScript);
    } catch {}
  }
  throw new Error(
    "@cloudbase/cli not found. Run `npm install` in the magent project, " +
    "or install globally: npm install -g @cloudbase/cli"
  );
}

// ── runTcb — invoke @cloudbase/cli programmatically ─────────────────────────
// Spawns:  <node> <tcbScript> <args>
// Both paths are absolute — no PATH dependency at runtime.

export function runTcb(args, opts = {}) {
  const { input, allowFail, ...rest } = opts;
  const result = spawnSync(getNodeExecutable(), [getTcbScript(), ...args], {
    encoding: "utf-8",
    env:      process.env,
    stdio:    input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input,
    ...rest,
  });
  if (result.error) throw result.error;
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  if (!allowFail && result.status !== 0) {
    throw new Error(out.trim() || `tcb ${args[0]} exited with code ${result.status}`);
  }
  return result.stdout ?? "";
}
