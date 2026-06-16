/** Cross-process harness flags (argv, not env). */

export const HARNESS_PREFLIGHT_DONE_FLAG = "--harness-preflight-done";

export function harnessPreflightDoneFromArgv(argv = process.argv.slice(2)) {
  return argv.includes(HARNESS_PREFLIGHT_DONE_FLAG);
}

export function stripHarnessCliFlags(argv) {
  return argv.filter((a) => a !== HARNESS_PREFLIGHT_DONE_FLAG);
}
