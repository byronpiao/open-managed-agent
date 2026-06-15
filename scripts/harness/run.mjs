#!/usr/bin/env node
/**
 * Harness 一条龙编排 — 纯 CLI，供 agent 驱动（无交互）。
 *
 *   npm run harness:run                              # = test:full（opencode 主力）
 *   npm run harness:run -- --cloud                   # test:full + cloud-opencode
 *   npm run harness:run -- --engines claude --cloud-claude
 *   npm run harness:run -- --engines all --cloud --cloud-claude --ma-protocol
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEnv,
  hydrateTcbApiKeyFromCam,
  assertHarnessCreds,
  assertHarnessEnginesEnv,
  HARNESS_ENGINE_VALUES,
} from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const HELP = `Usage: npm run harness:run [-- options]

  无参数              test:full（opencode 主力合入路径）
  --engines           opencode | claude | all（默认 opencode）
  --cloud             cloud-tcbr-opencode + cloud-scf-opencode 并行
  --cloud-claude      cloud-tcbr-claude + cloud-scf-claude 并行
  --quickstart        对客 tutorial 冒烟（post-login，见 harness:quickstart）
  --ma-protocol       MA HTTP 云上协议

示例:
  npm run harness:smoke
  npm run harness:run -- --engines claude --cloud-claude
  npm run harness:run -- --engines all --cloud --cloud-claude --ma-protocol

分步见 Harness一条龙.md · npm run harness:local-claude 等
`;

function parseRunArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  let engines = "opencode";
  let quickstart = false;
  let cloudOpencode = false;
  let cloudClaude = false;
  let maProtocol = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quickstart") quickstart = true;
    else if (a === "--cloud") cloudOpencode = true;
    else if (a === "--cloud-claude") cloudClaude = true;
    else if (a === "--ma-protocol") maProtocol = true;
    else if (a === "--engines" && argv[i + 1]) {
      engines = argv[++i].trim().toLowerCase();
      if (!HARNESS_ENGINE_VALUES.includes(engines)) {
        console.error(`Invalid --engines ${engines}; use opencode | claude | all\n`);
        console.log(HELP);
        process.exit(1);
      }
    }
  }

  return { engines, quickstart, cloudOpencode, cloudClaude, maProtocol };
}

function runStep(label, cmd, args = []) {
  console.log(`\n${"=".repeat(72)}\n=== ${label} ===\n${"=".repeat(72)}\n`);
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status ?? 1})`);
  }
}

async function main() {
  const plan = parseRunArgs(process.argv.slice(2));

  loadEnv();
  assertHarnessCreds();
  await hydrateTcbApiKeyFromCam();

  try {
    assertHarnessEnginesEnv(plan.engines);
  } catch (err) {
    console.error(`Preflight: ${err.message}`);
    process.exit(1);
  }
  if (plan.cloudClaude) {
    try {
      assertHarnessEnginesEnv("claude");
    } catch (err) {
      console.error(`Preflight (--cloud-claude): ${err.message}`);
      process.exit(1);
    }
  }

  console.log(
    `harness:run plan engines=${plan.engines} quickstart=${plan.quickstart} ` +
      `cloud-opencode=${plan.cloudOpencode} cloud-claude=${plan.cloudClaude} ma=${plan.maProtocol}\n`,
  );

  if (plan.quickstart) {
    runStep("quickstart", process.execPath, [resolve(__dirname, "quickstart.mjs"), "--keep-agent"]);
  }

  if (plan.engines === "opencode") {
    runStep("test:full (local opencode)", "npm", ["run", "test:full"]);
  } else {
    runStep("unit tests", "npm", ["test"]);
    runStep(`harness:local-${plan.engines === "all" ? "all" : "claude"}`, "npm", [
      "run",
      plan.engines === "all" ? "harness:local-all" : "harness:local-claude",
    ]);
  }

  if (plan.cloudOpencode) {
    runStep("harness:cloud-opencode", "npm", ["run", "harness:cloud-opencode"]);
  }
  if (plan.cloudClaude) {
    runStep("harness:cloud-claude", "npm", ["run", "harness:cloud-claude"]);
  }
  if (plan.maProtocol) {
    runStep("ma-protocol", "npm", ["run", "ma-protocol"]);
  }

  console.log("\n✓ harness:run complete");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
