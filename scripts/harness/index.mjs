#!/usr/bin/env node
/**
 * Harness 验收入口：
 *
 *   npm run harness -- local    # stub → zen 真箱 e2e → 矩阵 →（COS 硬门）
 *   npm run harness -- cloud       # 云托管 tcbr + smoke（另跑，不进 test:full）
 *   npm run harness -- cloud-scf   # SCF + smoke（完整一条龙时与 cloud 都跑）
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const HELP = `Usage: npm run harness -- <local|cloud|cloud-scf> [options]

  local      stub e2e + 真 AGS（zen）+ 矩阵；HARNESS_COS_ENABLED=1 时 COS
  cloud      云托管 tcbr：deploy/redeploy → gateway ACP smoke（日常云上验收）
  cloud-scf  SCF 云函数：agent:create/update → 同上 smoke（完整一条龙时必跑）

  cloud / cloud-scf 共用：
          有 LLM_* 时先 probe；无则 zen
          --agent-id <id>   或 HARNESS_CLOUD_AGENT_ID / HARNESS_CLOUD_SCF_AGENT_ID
          --verify-only     只 smoke
          --no-verify       只 deploy

日常：  npm run test:full && npm run harness -- cloud
完整：  上式 + npm run harness -- cloud-scf

More: docs/harness-architecture.md · docs/harness-env.md
`;

async function assertHarnessAgsRuntimeEnvSync() {
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessAgsRuntimeEnv();
}

/** Strip host LLM_* so sandbox uses built-in opencode zen. */
function envForZenHarness() {
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  delete env.LLM_MODEL;
  delete env.OPENAI_BASE_URL;
  delete env.ANTHROPIC_BASE_URL;
  env.HARNESS_FORCE_ZEN = "1";
  return env;
}

function runNode(scriptRel, extraArgs = [], { zen = false } = {}) {
  const script = resolve(repoRoot, scriptRel);
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: zen ? envForZenHarness() : process.env,
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
  console.log("=== harness local: AGS env（CloudBase；主链 opencode zen，无需 LLM_*）===");
  await assertHarnessAgsRuntimeEnvSync();

  console.log("=== harness local: e2e full（真 AGS + zen 对话 / custom tool / sync）===");
  runNode("tests/harness/e2e.test.mjs", ["--full"], { zen: true });

  console.log("=== harness local: matrix parity（#1–#2 TRW #8 MCP #9 CloudBase #10 Skills）===");
  await assertHarnessAgsRuntimeEnvSync();
  runNode("tests/harness/matrix-parity.test.mjs", [], { zen: true });

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
    case "cloud":
    case "cloud-scf": {
      loadEnv();
      const { runCloudHarness } = await import("./cloud.mjs");
      const backend = cmd === "cloud-scf" ? "scf" : "tcbr";
      await runCloudHarness(args.slice(1), { backend });
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
