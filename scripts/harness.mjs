#!/usr/bin/env node
/**
 * Harness 验收统一入口（关停分散的 harness:* npm script）。
 *
 *   npm run harness -- e2e|full|cos|probe|teardown|all
 *   npm run test:full   # npm test && harness all
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./load-env.mjs";

async function assertAgsHarnessEnv() {
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessAgsRuntimeEnv();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const HELP = `Usage: npm run harness -- <command>

Commands:
  e2e        stub 沙箱 e2e（无 AGS 凭证）
  full       真 AGS + sync + parity（要 .env + .env.harness）
  cos        COS 跨实例 write→snapshot→restore（要 HARNESS_COS_ENABLED=1）
  probe      COS snapshot 轻量探针
  teardown   Stop 本 env 全部 RUNNING 沙箱
  all        e2e → full →（COS 开启时）cos

Examples:
  npm run harness -- full
  npm run test:full
`;

function runNode(scriptRel, extraArgs = []) {
  const script = resolve(repoRoot, scriptRel);
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function truthyCos() {
  const v = process.env.HARNESS_COS_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  switch (cmd) {
    case "e2e":
      runNode("tests/harness/e2e.test.mjs");
      break;
    case "full":
      loadEnv();
      await assertAgsHarnessEnv();
      runNode("tests/harness/e2e.test.mjs", ["--full"]);
      break;
    case "cos":
      loadEnv();
      await assertAgsHarnessEnv();
      runNode("scripts/harness-cos-e2e.mjs");
      break;
    case "probe":
      loadEnv();
      await assertAgsHarnessEnv();
      runNode("scripts/harness-cos-probe.mjs");
      break;
    case "teardown":
      runNode("scripts/harness-ags-teardown.mjs");
      break;
    case "all": {
      loadEnv();
      console.log("=== harness all: e2e (stub) ===");
      runNode("tests/harness/e2e.test.mjs");
      console.log("=== harness all: full (AGS) ===");
      await assertAgsHarnessEnv();
      runNode("tests/harness/e2e.test.mjs", ["--full"]);
      if (truthyCos()) {
        console.log("=== harness all: cos (HARNESS_COS_ENABLED) ===");
        runNode("scripts/harness-cos-e2e.mjs");
      } else {
        console.log("(skip cos — set HARNESS_COS_ENABLED=1 to include)");
      }
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
