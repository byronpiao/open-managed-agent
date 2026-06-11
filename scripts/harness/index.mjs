#!/usr/bin/env node
/**
 * Harness 验收入口 — agent 驱动，无交互。
 *
 *   npm run harness:smoke               # 合入默认：test:full + cloud-opencode
 *   npm run harness:local-claude
 *   npm run harness:cloud-claude
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  loadEnv,
  hydrateTcbApiKeyFromCam,
  applyHarnessLlmTier,
  applyHarnessScenario,
  applyScenarioEnv,
  applyHarnessTestDefaults,
  logHarnessScenario,
  parseHarnessEnginesArg,
  assertHarnessEnginesEnv,
  harnessEnginesIncludeOpencode,
  cloudHarnessScenario,
} from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const HELP = `Usage: npm run harness -- <command> [options]

Local（--engines 默认 opencode 主力）:
  local                 stub + 真 AGS + 矩阵（+ 可选 COS）
  --engines opencode|claude|all

Cloud（engine 后缀对等；无后缀 = opencode 主力）:
  cloud                 cloud-tcbr-opencode ∥ cloud-scf-opencode
  cloud-opencode        同上
  cloud-claude          cloud-tcbr-claude ∥ cloud-scf-claude
  cloud-tcbr-opencode   云托管 · opencode zen
  cloud-scf-opencode    SCF · ③ OpenAI BYOK
  cloud-tcbr-claude     云托管 · ③ Anthropic BYOK
  cloud-scf-claude      SCF · ③ Anthropic BYOK

  兼容别名: cloud-tcbr → cloud-tcbr-opencode · cloud-scf → cloud-scf-opencode

  --agent-id <id>  或 .env.harness ⑤ HARNESS_CLOUD_{TCBR|SCF}_{OPENCODE|CLAUDE}_AGENT_ID
  --verify-only / --no-verify

db-pressure（只跑 FlexDB 行数/体积采样，不跑完整 e2e）:
  db-pressure [--engines opencode|claude|all] [--db-pressure-rounds N]

product-acceptance（产品向验收，不合入 smoke）:
  product-acceptance [--engines opencode|claude|all]

可选（默认不跑）:
  --db-pressure              同上 N 默认 10；也可挂在 local full 末尾或 cloud verify 之后

编排: npm run harness:run -- [--engines …] [--cloud] [--cloud-claude] [--ma-protocol]
文档: Harness一条龙.md
`;

function forwardE2eArgs(engines, extraArgs) {
  const out = ["--full", "--engines", engines];
  if (extraArgs.includes("--db-pressure")) out.push("--db-pressure");
  const ri = extraArgs.indexOf("--db-pressure-rounds");
  if (ri >= 0 && extraArgs[ri + 1]) {
    out.push("--db-pressure-rounds", extraArgs[ri + 1]);
  }
  return out;
}

/** @returns {{ backend: "tcbr"|"scf"|null; engine: "opencode"|"claude"; parallel: boolean }|null} */
function parseCloudCommand(cmd) {
  const map = {
    cloud: { backend: null, engine: "opencode", parallel: true },
    "cloud-opencode": { backend: null, engine: "opencode", parallel: true },
    "cloud-claude": { backend: null, engine: "claude", parallel: true },
    "cloud-tcbr": { backend: "tcbr", engine: "opencode", parallel: false },
    "cloud-scf": { backend: "scf", engine: "opencode", parallel: false },
    "cloud-tcbr-opencode": { backend: "tcbr", engine: "opencode", parallel: false },
    "cloud-scf-opencode": { backend: "scf", engine: "opencode", parallel: false },
    "cloud-tcbr-claude": { backend: "tcbr", engine: "claude", parallel: false },
    "cloud-scf-claude": { backend: "scf", engine: "claude", parallel: false },
  };
  return map[cmd] ?? null;
}

async function assertHarnessAgsRuntimeEnvSync() {
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessAgsRuntimeEnv();
}

function envForHarnessTier(tier, { claudeTier } = {}) {
  const env = { ...process.env };
  if (tier === "anthropic-byok") {
    applyScenarioEnv("local-claude", env);
    applyHarnessLlmTier("anthropic-byok", env);
  } else if (tier === "byok") {
    applyScenarioEnv("local-opencode", env);
    applyHarnessLlmTier("byok", env);
  } else if (tier === "zen") {
    applyHarnessLlmTier("zen", env);
  } else {
    applyHarnessLlmTier("platform", env);
  }
  if (claudeTier?.trim()) {
    env.HARNESS_E2E_CLAUDE_TIER = claudeTier.trim();
  }
  applyHarnessTestDefaults(env);
  return env;
}

function runNode(scriptRel, extraArgs = [], { tier, claudeTier } = {}) {
  const script = resolve(repoRoot, scriptRel);
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: tier ? envForHarnessTier(tier, { claudeTier }) : process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function truthyCos() {
  const v = process.env.HARNESS_COS_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function spawnHarnessChild(cmd, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(__dirname, "index.mjs"), cmd, ...extraArgs],
      { cwd: repoRoot, stdio: "inherit", env: process.env },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code ?? 1})`));
    });
  });
}

async function runCloudParallel(engine, extraArgs) {
  loadEnv();
  await hydrateTcbApiKeyFromCam();
  const tcbr = `cloud-tcbr-${engine}`;
  const scf = `cloud-scf-${engine}`;
  console.log(`=== harness cloud-${engine}: ${tcbr} + ${scf} in parallel ===\n`);
  await Promise.all([spawnHarnessChild(tcbr, extraArgs), spawnHarnessChild(scf, extraArgs)]);
  console.log(`\n✓ cloud-tcbr-${engine} + cloud-scf-${engine} both passed`);
}

async function runProductAcceptance(extraArgs = []) {
  const engines = parseHarnessEnginesArg(extraArgs);
  loadEnv();
  try {
    assertHarnessEnginesEnv(engines);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const scenario = engines === "claude" ? "local-claude" : "local-opencode";
  logHarnessScenario(applyHarnessScenario(scenario));

  await hydrateTcbApiKeyFromCam();
  await assertHarnessAgsRuntimeEnvSync();

  const { runHarnessLlmPreflight } = await import("./llm-preflight.mjs");
  const localScenario = engines === "claude" ? "local-claude" : "local-opencode";
  console.log(`=== harness product-acceptance: LLM preflight (${localScenario}) ===`);
  let preflight;
  try {
    preflight = await runHarnessLlmPreflight(localScenario, { allowTestFallback: true });
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  if (preflight.probe?.ok) {
    console.log(
      `✓ ${preflight.protocol} tier=${preflight.tier} ${preflight.probe.latencyMs}ms ` +
        `model=${preflight.probe.model}`,
    );
  } else if (preflight.tier === "zen") {
    console.log(`✓ tier=zen (${preflight.fallback ?? "platform unavailable"})`);
  }

  applyHarnessTestDefaults();
  const localTier = preflight.tier;
  let claudeTierForE2e = engines === "claude" ? preflight.tier : null;
  if (engines === "all") {
    console.log("=== harness product-acceptance: LLM preflight (local-claude) ===");
    let claudePreflight;
    try {
      claudePreflight = await runHarnessLlmPreflight("local-claude", { allowTestFallback: true });
    } catch (err) {
      console.error(err.message ?? err);
      process.exit(1);
    }
    claudeTierForE2e = claudePreflight.tier;
    if (claudePreflight.probe?.ok) {
      console.log(
        `✓ ${claudePreflight.protocol} tier=${claudePreflight.tier} ` +
          `${claudePreflight.probe.latencyMs}ms model=${claudePreflight.probe.model}`,
      );
    }
  }

  if (engines !== "claude") {
    process.env.HARNESS_E2E_OPENCODE_TIER = localTier === "zen" ? "zen" : "platform";
    applyHarnessLlmTier(localTier === "zen" ? "zen" : "platform");
  }
  if (claudeTierForE2e) {
    process.env.HARNESS_E2E_CLAUDE_TIER = claudeTierForE2e;
  }

  console.log(
    `=== harness product-acceptance (engines=${engines}, opencodeTier=${process.env.HARNESS_E2E_OPENCODE_TIER}) ===`,
  );
  runNode("scripts/harness/product-acceptance.mjs", ["--engines", engines], {
    tier: engines === "claude" ? (claudeTierForE2e ?? preflight.tier) : localTier,
    claudeTier: claudeTierForE2e,
  });
}

async function runLocal(extraArgs = []) {
  const engines = parseHarnessEnginesArg(extraArgs);
  loadEnv();
  try {
    assertHarnessEnginesEnv(engines);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const scenario = engines === "claude" ? "local-claude" : "local-opencode";
  logHarnessScenario(applyHarnessScenario(scenario));

  console.log("=== harness local: e2e stub（网关 + 假沙箱）===");
  runNode("tests/harness/e2e.test.mjs");

  await hydrateTcbApiKeyFromCam();
  await assertHarnessAgsRuntimeEnvSync();

  const { runHarnessLlmPreflight } = await import("./llm-preflight.mjs");
  const localScenario = engines === "claude" ? "local-claude" : "local-opencode";
  console.log(`=== harness local: LLM preflight (${localScenario}) ===`);
  let preflight;
  try {
    preflight = await runHarnessLlmPreflight(localScenario, { allowTestFallback: true });
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  if (preflight.probe?.ok) {
    console.log(
      `✓ ${preflight.protocol} tier=${preflight.tier} ${preflight.probe.latencyMs}ms ` +
        `model=${preflight.probe.model} reply=${preflight.probe.replySnippet ?? "(empty)"}`,
    );
  } else if (preflight.tier === "zen") {
    console.log(`✓ tier=zen (${preflight.fallback ?? "platform unavailable"})`);
  }
  applyHarnessTestDefaults();
  const localTier = preflight.tier;
  if (engines !== "claude") {
    process.env.HARNESS_E2E_OPENCODE_TIER = localTier === "zen" ? "zen" : "platform";
  }

  let claudeTierForE2e = engines === "claude" ? preflight.tier : null;
  if (engines === "all") {
    console.log("=== harness local: LLM preflight (local-claude) ===");
    let claudePreflight;
    try {
      claudePreflight = await runHarnessLlmPreflight("local-claude", { allowTestFallback: true });
    } catch (err) {
      console.error(err.message ?? err);
      process.exit(1);
    }
    claudeTierForE2e = claudePreflight.tier;
    if (claudePreflight.probe?.ok) {
      console.log(
        `✓ ${claudePreflight.protocol} tier=${claudePreflight.tier} ` +
          `${claudePreflight.probe.latencyMs}ms model=${claudePreflight.probe.model}`,
      );
    }
  }

  const engineLabel =
    engines === "claude"
      ? preflight.tier === "anthropic-byok"
        ? "BYOK Anthropic"
        : "hy3-preview"
      : engines === "all"
        ? `opencode=${localTier === "zen" ? "zen" : "hy3"} + claude=${claudeTierForE2e === "anthropic-byok" ? "BYOK" : claudeTierForE2e}`
        : localTier === "zen"
          ? "zen"
          : "hy3-preview";
  console.log(`=== harness local: e2e full（engines=${engines}，llm=${engineLabel}）===`);
  runNode("tests/harness/e2e.test.mjs", forwardE2eArgs(engines, extraArgs), {
    tier: localTier,
    claudeTier: claudeTierForE2e,
  });

  if (harnessEnginesIncludeOpencode(engines)) {
    console.log("=== harness local: matrix parity ===");
    await assertHarnessAgsRuntimeEnvSync();
    runNode("tests/harness/matrix-parity.test.mjs", [], { tier: localTier });
  }

  if (truthyCos()) {
    const { assertHarnessCosEnv } = await import(
      "../../packages/agent-runtime/dist/harness/harness-env.js"
    );
    assertHarnessCosEnv();
    console.log("=== harness local: cos-e2e ===");
    runNode("scripts/harness/cos-e2e.mjs");
  } else {
    console.log("(skip cos — HARNESS_COS_ENABLED=1 时硬门)");
  }
}

async function runCloudSingle(backend, engine, extraArgs) {
  loadEnv();
  logHarnessScenario(applyHarnessScenario(cloudHarnessScenario(backend, engine)));
  const { runCloudHarness } = await import("./cloud.mjs");
  await runCloudHarness(extraArgs, { backend, engine });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "local") {
    await runLocal(args.slice(1));
    return;
  }

  if (cmd === "product-acceptance") {
    await runProductAcceptance(args.slice(1));
    return;
  }

  if (cmd === "db-pressure") {
    const extraArgs = args.slice(1);
    const engines = parseHarnessEnginesArg(extraArgs);
    loadEnv();
    try {
      assertHarnessEnginesEnv(engines);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const scenario = engines === "claude" ? "local-claude" : "local-opencode";
    logHarnessScenario(applyHarnessScenario(scenario));
    await hydrateTcbApiKeyFromCam();
    await assertHarnessAgsRuntimeEnvSync();
    applyHarnessTestDefaults();
    if (engines !== "claude") {
      process.env.HARNESS_E2E_OPENCODE_TIER = "platform";
    }
    const forward = ["--db-pressure-only", "--db-pressure", "--engines", engines];
    const ri = extraArgs.indexOf("--db-pressure-rounds");
    if (ri >= 0 && extraArgs[ri + 1]) {
      forward.push("--db-pressure-rounds", extraArgs[ri + 1]);
    }
    console.log(`=== harness db-pressure only (engines=${engines}, FlexDB) ===`);
    runNode("tests/harness/e2e.test.mjs", forward, { tier: "platform" });
    return;
  }

  const cloud = parseCloudCommand(cmd);
  if (cloud) {
    if (cloud.parallel) {
      await runCloudParallel(cloud.engine, args.slice(1));
    } else {
      await runCloudSingle(cloud.backend, cloud.engine, args.slice(1));
    }
    return;
  }

  console.error(`Unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
