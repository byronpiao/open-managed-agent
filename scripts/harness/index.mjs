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
import {
  loadEnv,
  hydrateTcbApiKeyFromCam,
  applyHarnessLlmTier,
  applyHarnessScenario,
  logHarnessScenario,
} from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const HELP = `Usage: npm run harness -- <local|cloud-tcbr|cloud-scf> [options]

  local        stub + 真 AGS（CloudBase AI hy3-preview，CAM 鉴权）+ 矩阵
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

function envForHarnessTier(tier) {
  const env = { ...process.env };
  applyHarnessLlmTier(tier, env);
  applyHarnessTestDefaults(env);
  return env;
}

function runNode(scriptRel, extraArgs = [], { tier } = {}) {
  const script = resolve(repoRoot, scriptRel);
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: tier ? envForHarnessTier(tier) : process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function truthyCos() {
  const v = process.env.HARNESS_COS_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function runLocal() {
  loadEnv();
  const scenarioMeta = applyHarnessScenario("local");
  logHarnessScenario(scenarioMeta);

  console.log("=== harness local: e2e stub（网关 + 假沙箱）===");
  runNode("tests/harness/e2e.test.mjs");

  await hydrateTcbApiKeyFromCam();
  console.log("=== harness local: AGS env（CloudBase AI hy3-preview，CAM）===");
  await assertHarnessAgsRuntimeEnvSync();

  console.log("=== harness local: platform LLM probe（30s，失败不进入 300s×N 真箱）===");
  const {
    probeCloudBasePlatformLlm,
    formatPlatformProbeFailureGuide,
    isPlatformQuotaExceeded,
  } = await import("../../packages/agent-runtime/dist/harness/llm-probe.js");

  let localTier = "platform";
  const platformProbe = await probeCloudBasePlatformLlm();
  if (!platformProbe.ok) {
    if (isPlatformQuotaExceeded(platformProbe)) {
      console.warn(
        "⚠ hy3-preview quota exhausted (HTTP 429) — local harness continues with opencode zen.\n" +
          "  Sandbox / CAM / AGS path still runs; this run does NOT validate CloudBase AI platform LLM.\n" +
          "  To test hy3 again: recharge quota in console, then re-run test:full.\n",
      );
      localTier = "zen";
    } else {
      console.error(formatPlatformProbeFailureGuide(platformProbe));
      process.exit(1);
    }
  } else {
    console.log(
      `✓ platform LLM ${platformProbe.latencyMs}ms model=${platformProbe.model} reply=${platformProbe.replySnippet ?? "(empty)"}`,
    );
  }

  applyHarnessLlmTier(localTier);
  applyHarnessTestDefaults();

  console.log(
    `=== harness local: e2e full（真 AGS + ${localTier === "zen" ? "opencode zen" : "平台 hy3-preview"} / sync）===`,
  );
  runNode("tests/harness/e2e.test.mjs", ["--full"], { tier: localTier });

  console.log("=== harness local: matrix parity（#1–#2 TRW #8 MCP #9 CloudBase #10 Skills）===");
  await assertHarnessAgsRuntimeEnvSync();
  runNode("tests/harness/matrix-parity.test.mjs", [], { tier: localTier });

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
      const scenario = cmd === "cloud-scf" ? "cloud-scf" : "cloud-tcbr";
      logHarnessScenario(applyHarnessScenario(scenario));
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
