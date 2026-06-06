#!/usr/bin/env node
/**
 * Stop all non-terminal AGS sandbox instances for CLOUDBASE_ENV_ID (frees RUNNING + PAUSED quota).
 *
 *   node scripts/harness-ags-teardown.mjs
 *   node scripts/harness-ags-teardown.mjs --dry-run
 */

import { loadEnv, assertHarnessCreds } from "./load-env.mjs";

const dryRun = process.argv.includes("--dry-run");

export async function teardownHarnessSandboxes() {
  loadEnv();
  assertHarnessCreds();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const { getSandboxOrchestrator } = await import(
    "../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const orch = getSandboxOrchestrator();
  const rows = await orch.listInstances(envId);
  const active = rows.filter((r) => {
    const s = r.status.toUpperCase();
    return s !== "STOPPED" && s !== "STOPPING";
  });
  if (!active.length) {
    console.log(`teardown: no active instances (${rows.length} already stopped)`);
    return [];
  }
  console.log(`teardown: ${active.length} instance(s) to stop (env ${envId})`);
  for (const row of active) {
    console.log(`  - ${row.instanceId} ${row.status}${row.toolId ? ` tool=${row.toolId}` : ""}`);
  }
  if (dryRun) return [];
  const stopped = await orch.stopAllInstances(envId);
  console.log(`teardown: stopped ${stopped.length} instance(s)`);
  return stopped;
}

if (process.argv[1]?.endsWith("harness-ags-teardown.mjs")) {
  teardownHarnessSandboxes().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
