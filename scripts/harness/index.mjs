#!/usr/bin/env node
/**
 * Harness 验收入口：
 *
 *   npm run harness -- local    # stub → 真箱 e2e（CloudBase AI）→ 矩阵 →（COS 硬门）
 *   npm run harness -- cloud-tcbr  # 云托管 tcbr + smoke（另跑，不进 test:full）
 *   npm run harness -- cloud-scf  # SCF + smoke（完整一条龙时与 cloud-tcbr 都跑）
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const HELP = `Usage: npm run harness -- <local|cloud-tcbr|cloud-scf> [options]

  local        stub + 真 AGS（CloudBase AI hy3-preview，用 TCB_API_KEY）+ 矩阵
  cloud-tcbr   云托管 tcbr：deploy opencode **zen** → gateway smoke
  cloud-scf    SCF：deploy **自定义 LLM**（.env.harness ③ 段 LLM_*）→ smoke

  cloud-scf  deploy 前 probe LLM_*；cloud-tcbr 固定 zen（忽略 ③ 段）
          --agent-id <id>   或 HARNESS_CLOUD_AGENT_ID / HARNESS_CLOUD_SCF_AGENT_ID
          --verify-only     只 smoke
          --no-verify       只 deploy

日常：  npm run test:full && npm run harness -- cloud-tcbr
完整：  上式 + npm run harness -- cloud-scf

More: docs/harness-architecture.md · docs/harness-env.md
`;

async function assertHarnessAgsRuntimeEnvSync() {
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessAgsRuntimeEnv();
}

/** Local 主链：走 CloudBase AI（TCB_API_KEY），不用 zen / 不用 BYOK LLM_*。 */
function envForPlatformHarness() {
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  delete env.LLM_MODEL;
  delete env.OPENAI_BASE_URL;
  delete env.ANTHROPIC_BASE_URL;
  delete env.HARNESS_FORCE_ZEN;
  return env;
}

function runNode(scriptRel, extraArgs = [], { platform = false } = {}) {
  const script = resolve(repoRoot, scriptRel);
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: platform ? envForPlatformHarness() : process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function truthyCos() {
  const v = process.env.HARNESS_COS_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function runLocal() {
  console.log("=== harness local: e2e stub（网关 + 假沙箱）===");
  runNode("tests/harness/e2e.test.mjs");

  loadEnv();
  console.log("=== harness local: AGS env（CloudBase AI hy3-preview，TCB_API_KEY）===");
  await assertHarnessAgsRuntimeEnvSync();

  console.log("=== harness local: e2e full（真 AGS + 平台模型 / custom tool / sync）===");
  runNode("tests/harness/e2e.test.mjs", ["--full"], { platform: true });

  console.log("=== harness local: matrix parity（#1–#2 TRW #8 MCP #9 CloudBase #10 Skills）===");
  await assertHarnessAgsRuntimeEnvSync();
  runNode("tests/harness/matrix-parity.test.mjs", [], { platform: true });

  if (truthyCos()) {
    const { assertHarnessCosEnv } = await import(
      "../../packages/agent-runtime/dist/harness/harness-env.js"
    );
    assertHarnessCosEnv();
    console.log("=== harness local: cos（工作区快照，HARNESS_COS_ENABLED=1 硬门）===");
    runNode("scripts/harness/cos-e2e.mjs");
  } else {
    console.log("(skip cos — 在 .env.harness 设 HARNESS_COS_ENABLED=1，见 docs/harness-env.md)");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  switch (cmd) {
    case "local":
      await runLocal();
      break;
    case "cloud-tcbr":
    case "cloud-scf": {
      loadEnv();
      const { runCloudHarness } = await import("./cloud.mjs");
      const backend = cmd === "cloud-scf" ? "scf" : "tcbr";
      await runCloudHarness(args.slice(1), { backend });
      break;
    }
    default:
      if (cmd === "cloud") {
        console.error("Renamed: use cloud-tcbr (tcbr) or cloud-scf (SCF), not cloud.\n");
      } else {
        console.error(`Unknown command: ${cmd}\n`);
      }
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
