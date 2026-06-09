#!/usr/bin/env node
/**
 * Verify TRW-only rollout against OMA main harness pipeline.
 *
 * Workflow:
 *   1. tcb-remote-workspace: merge feat/cma-http (or TRW branch), pnpm build:prod, build image
 *   2. open-managed-agent: stay on main (or tag without MA HTTP)
 *   3. ./scripts/harness/build-push-magent-public.sh
 *   4. node scripts/harness/trw-only-verify.mjs
 *
 * This script runs the same gates as test:delivery without MA-specific code on OMA.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("TRW-only verify — expects OMA without MA HTTP branch; new TRW image already pushed.\n");

run("npm", ["test"]);
run("npm", ["run", "test:full"]);

if (!process.argv.includes("--skip-cloud")) {
  run("npm", ["run", "harness", "--", "cloud-tcbr"]);
}

console.log("\n✓ TRW-only harness verify complete (OMA main + new TRW image)");
