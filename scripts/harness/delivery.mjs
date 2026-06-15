#!/usr/bin/env node
/**
 * Full harness delivery pipeline — scenario-isolated env per step.
 *
 *   node scripts/harness/delivery.mjs
 *   node scripts/harness/delivery.mjs --skip-cloud
 *   node scripts/harness/delivery.mjs --skip-quickstart
 *
 * Steps:
 *   1. quickstart  — check-harness-ready + tutorial yaml + uname/pong (post-login)
 *   2. test:full    — local stub/e2e/matrix + optional COS from .env.harness ⑥
 *   3. harness:cloud-opencode — tcbr zen + scf OpenAI BYOK
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEnv,
  hydrateTcbApiKeyFromCam,
  assertHarnessCreds,
} from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

function hasFlag(name) {
  return process.argv.includes(name);
}

function runStep(label, cmd, args = []) {
  console.log(`\n${"=".repeat(72)}\n=== ${label} ===\n${"=".repeat(72)}\n`);
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status ?? 1})`);
  }
}

async function main() {
  loadEnv();
  assertHarnessCreds();
  await hydrateTcbApiKeyFromCam();

  console.log("Harness delivery — each step uses its own scenario (see scripts/harness/scenarios/README.md)\n");

  if (!hasFlag("--skip-quickstart")) {
    runStep("1/3 quickstart (tutorial yaml, no-cos)", process.execPath, [
      resolve(__dirname, "quickstart.mjs"),
      "--keep-agent",
    ]);
  } else {
    console.log("(skip quickstart — --skip-quickstart)\n");
  }

  runStep("2/3 test:full (local platform + optional COS)", "npm", ["run", "test:full"]);

  if (hasFlag("--skip-cloud")) {
    console.log("\n(skip cloud — --skip-cloud)\n✓ delivery (local only) done");
    return;
  }

  runStep("3/3 harness:cloud-opencode", "npm", ["run", "harness:cloud-opencode"]);

  console.log("\n✓ harness delivery pipeline complete");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
