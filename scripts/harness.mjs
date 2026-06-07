#!/usr/bin/env node
/**
 * Harness 验收 — 两个入口：
 *
 *   npm run harness -- local    # stub e2e + 真 AGS full（+ 可选 COS）
 *   npm run harness -- cloud    # tcbr deploy/update + prompt smoke
 *
 * 进阶（COS / teardown / 镜像）：见 docs/harness-env.md
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const HELP = `Usage: npm run harness -- <local|cloud> [options]

  local   stub e2e + full AGS（.env + .env.harness）；HARNESS_COS_ENABLED=1 时追加 cos
  cloud   build → agent:create|update → magent pong → ACP prompt smoke
          --agent-id <id>     更新已有 agent（或 HARNESS_CLOUD_AGENT_ID）
          --verify-only       只跑 ACP smoke，不 deploy
          --no-verify         只 deploy，不 ACP smoke

Examples:
  npm run harness -- local
  npm run test:full              # npm test && harness local
  npm run harness -- cloud
  npm run harness -- cloud --verify-only --agent-id agent-oma-harness-xxx

More: docs/harness-env.md · ../Harness一条龙.md
`;

async function assertAgsHarnessEnv() {
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessAgsRuntimeEnv();
}

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

async function runLocal() {
  console.log("=== harness local: e2e (stub) ===");
  runNode("tests/harness/e2e.test.mjs");

  loadEnv();
  console.log("=== harness local: full (AGS) ===");
  await assertAgsHarnessEnv();
  runNode("tests/harness/e2e.test.mjs", ["--full"]);

  if (truthyCos()) {
    console.log("=== harness local: cos (HARNESS_COS_ENABLED) ===");
    runNode("scripts/harness-cos-e2e.mjs");
  } else {
    console.log("(skip cos — set HARNESS_COS_ENABLED=1 or see docs/harness-env.md)");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  // Legacy aliases → local
  if (cmd === "e2e" || cmd === "full" || cmd === "all") {
    console.warn(`WARN: harness ${cmd} is deprecated — use: npm run harness -- local\n`);
    if (cmd === "e2e") {
      runNode("tests/harness/e2e.test.mjs");
      return;
    }
    if (cmd === "full") {
      loadEnv();
      await assertAgsHarnessEnv();
      runNode("tests/harness/e2e.test.mjs", ["--full"]);
      return;
    }
    await runLocal();
    return;
  }

  switch (cmd) {
    case "local":
      await runLocal();
      break;
    case "cloud": {
      loadEnv();
      const { runCloudHarness } = await import("./harness/cloud.mjs");
      await runCloudHarness(args.slice(1));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
