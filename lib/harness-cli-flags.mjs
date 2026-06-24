/** Cross-process harness flags (argv, not env). */

export const HARNESS_PREFLIGHT_DONE_FLAG = "--harness-preflight-done";

export function harnessPreflightDoneFromArgv(argv = process.argv.slice(2)) {
  return argv.includes(HARNESS_PREFLIGHT_DONE_FLAG);
}

export function stripHarnessCliFlags(argv) {
  return argv.filter((a) => a !== HARNESS_PREFLIGHT_DONE_FLAG);
}

/** Drop --infra / --engine from argv before spawning child harness runs. */
export function stripHarnessAxisArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--infra" || a === "--engine") {
      i++;
      continue;
    }
    if (typeof a === "string" && (a.startsWith("--infra=") || a.startsWith("--engine="))) {
      continue;
    }
    out.push(a);
  }
  return out;
}
