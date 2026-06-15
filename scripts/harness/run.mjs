#!/usr/bin/env node
/**
 * Harness 编排 — 唯一高层 npm 入口（配合 `npm run harness -- <cmd>`）。
 *
 *   npm run harness:run                    # test:full（opencode 合入）
 *   npm run harness:run -- --cloud         # = harness:smoke
 *   npm run harness:run -- --delivery      # quickstart + test:full + cloud-opencode
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

  (无参数)            test:full — npm test + harness local --engines opencode
  --delivery          quickstart + test:full + cloud-opencode（原 test:delivery）
  --engines           opencode | claude | all（默认 opencode；非 opencode 时跑 npm test + harness local）
  --cloud             harness cloud-opencode（tcbr ∥ scf）
  --cloud-claude      harness cloud-claude
  --quickstart        对客 tutorial（可与 --delivery 叠加）
  --ma-protocol       MA HTTP 云上协议

日常四条:
  npm test
  npm run test:full
  npm run harness -- local --engines all
  npm run harness:run -- --cloud

分步 cloud 单格: npm run harness -- cloud-tcbr-claude  等（见 Harness一条龙.md）
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
    if (a === "--delivery") {
      quickstart = true;
      cloudOpencode = true;
    } else if (a === "--quickstart") quickstart = true;
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

function runHarness(subcmd, extraArgs = []) {
  runStep(`harness ${subcmd}`, "npm", ["run", "harness", "--", subcmd, ...extraArgs]);
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
    runStep("test:full (npm test + harness local opencode)", "npm", ["run", "test:full"]);
  } else {
    runStep("unit tests", "npm", ["test"]);
    runHarness("local", ["--engines", plan.engines]);
  }

  if (plan.cloudOpencode) {
    runHarness("cloud-opencode");
  }
  if (plan.cloudClaude) {
    runHarness("cloud-claude");
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
