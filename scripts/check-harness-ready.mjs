#!/usr/bin/env node
/**
 * Customer harness deploy preflight.
 *
 *   magent login && tcb env use <envId>
 *   export HARNESS_TOOL_ROLE_ARN=...   # only when check shows ✗ on RoleArn
 *   node scripts/check-harness-ready.mjs
 */
import {
  formatHarnessPreflightReport,
  runHarnessDeployPreflight,
} from "../lib/harness-preflight.mjs";

const json = process.argv.includes("--json");

const result = await runHarnessDeployPreflight();

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatHarnessPreflightReport(result));
}

process.exit(result.ok ? 0 : 1);
