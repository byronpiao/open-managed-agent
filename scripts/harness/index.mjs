#!/usr/bin/env node
/**
 * Harness 验收入口 — 见 CONTRIBUTING.md
 *
 * 主维度：--infra（OMA 在哪跑）× --engine（沙箱内 engine）
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  loadEnv,
  hydrateTcbApiKeyFromCam,
  applyHarnessScenario,
  applyHarnessTestDefaults,
  applyHarnessCosFromHarnessFile,
  applyPlatformLlmEnv,
  describeHarnessLlmMode,
  logHarnessScenario,
  parseHarnessEngineArg,
  parseHarnessAxes,
  assertHarnessEnginesEnv,
  assertHarnessCreds,
  harnessEnginesIncludeOpencode,
  harnessEnginesIncludeClaude,
  cloudHarnessScenario,
  parseCloudCosMount,
} from "./load-env.mjs";
import { harnessCosEnabledFromMap, readHarnessEnvMap } from "../../lib/harness-env-file.mjs";
import { HARNESS_PREFLIGHT_DONE_FLAG, stripHarnessAxisArgv } from "../../lib/harness-cli-flags.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const HELP = `Usage: npm run harness -- <command> [options]

主验收（6 格 = --infra × --engine）:
  run --infra local|tcbr|scf|all --engine opencode|claude|all

  --infra   OMA 部署面；all = local → tcbr → scf 顺序各跑一遍
            tcbr,scf = 两云面并行（不含 local）
  --engine  沙箱内 engine；all 仅 local，或配合 --infra all（云面拆成 opencode+claude）

  例:
    run --infra local --engine opencode
    run --infra local --engine all
    run --infra tcbr --engine claude
    run --infra tcbr,scf --engine opencode
    run --infra all --engine opencode          # 三面顺序
    run --infra all --engine all               # local 双引擎 + 云 4 格

  可选: --db-pressure [--db-pressure-rounds N]
        cloud: --with-cos | --no-cos（是否挂 COS 挂载，默认不挂；⑥ 段配 bucket）
        cloud: --verify-only / --no-verify / --agent-id <id>

编排 release --profile merge|cloud|delivery|full

工具箱（偶尔手动，不进 CI）:
  quickstart [--keep-agent]
  docker [--keep]
  ma-protocol [--engine opencode|claude]
  product-acceptance [--infra local] [--engine opencode|claude|all]
  db-pressure [--infra local] [--engine …] [--db-pressure-rounds N]

其它:
  node scripts/harness/load-env.mjs --check
  npm run check:harness
  node scripts/harness/ags-teardown.mjs
  node scripts/harness/cos-probe.mjs
  node scripts/harness/acp-bridge.mjs [baseURL]

详见 CONTRIBUTING.md
`;

function forwardE2eArgs(engine, extraArgs) {
  const out = ["--full", "--engine", engine, HARNESS_PREFLIGHT_DONE_FLAG];
  if (extraArgs.includes("--db-pressure")) out.push("--db-pressure");
  const ri = extraArgs.indexOf("--db-pressure-rounds");
  if (ri >= 0 && extraArgs[ri + 1]) {
    out.push("--db-pressure-rounds", extraArgs[ri + 1]);
  }
  return out;
}

function runStep(label, fn) {
  console.log(`\n${"=".repeat(72)}\n=== ${label} ===\n${"=".repeat(72)}\n`);
  fn();
}

function runHarnessArgv(argv) {
  const r = spawnSync(process.execPath, [resolve(__dirname, "index.mjs"), ...argv], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`harness ${argv.join(" ")} failed (exit ${r.status ?? 1})`);
  }
}

function parseReleaseProfile(argv) {
  const profiles = ["merge", "cloud", "delivery", "full"];
  let profile = "merge";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile" && argv[i + 1]) {
      profile = argv[++i].trim().toLowerCase();
      if (!profiles.includes(profile)) {
        console.error(`Invalid --profile ${profile}; use: ${profiles.join(" | ")}\n`);
        console.log(HELP);
        process.exit(1);
      }
    }
  }
  return profile;
}

async function runRelease(extraArgs) {
  const profile = parseReleaseProfile(extraArgs);
  loadEnv();
  assertHarnessCreds();
  await hydrateTcbApiKeyFromCam();

  console.log(`harness release profile=${profile}\n`);

  if (profile === "delivery" || profile === "full") {
    runStep("quickstart", () => {
      runHarnessArgv(["quickstart", "--keep-agent"]);
    });
  }

  if (profile === "full") {
    runStep("npm test", () => {
      const r = spawnSync("npm", ["test"], { cwd: repoRoot, stdio: "inherit", env: process.env });
      if (r.status !== 0) throw new Error(`npm test failed (exit ${r.status ?? 1})`);
    });
    runStep("run --infra all --engine all", () => {
      runHarnessArgv(["run", "--infra", "all", "--engine", "all"]);
    });
    runStep("ma-protocol", () => {
      runHarnessArgv(["ma-protocol"]);
    });
    console.log("\n✓ harness release --profile full complete");
    return;
  }

  runStep("npm test", () => {
    const r = spawnSync("npm", ["test"], { cwd: repoRoot, stdio: "inherit", env: process.env });
    if (r.status !== 0) throw new Error(`npm test failed (exit ${r.status ?? 1})`);
  });

  runStep("run --infra local --engine opencode", () => {
    runHarnessArgv(["run", "--infra", "local", "--engine", "opencode"]);
  });

  if (profile === "cloud" || profile === "delivery") {
    runStep("run --infra tcbr,scf --engine opencode", () => {
      runHarnessArgv(["run", "--infra", "tcbr,scf", "--engine", "opencode"]);
    });
  }

  console.log(`\n✓ harness release --profile ${profile} complete`);
}

async function assertHarnessAgsRuntimeEnvSync() {
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
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

function harnessCosConfiguredInFile() {
  return harnessCosEnabledFromMap(readHarnessEnvMap());
}

function harnessChildInfraLabel(argv) {
  const i = argv.indexOf("--infra");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "child";
}

function prefixHarnessChildLines(stream, prefix, out) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += String(chunk);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) out.write(`${prefix}${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buf.length > 0) out.write(`${prefix}${buf}\n`);
  });
}

function spawnHarnessChild(argv) {
  const label = harnessChildInfraLabel(argv);
  const prefix = `[${label}] `;
  const indexScript = resolve(__dirname, "index.mjs");
  return new Promise((fulfill, reject) => {
    const childArgv = [indexScript, ...argv];
    const child = spawn(process.execPath, childArgv, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    prefixHarnessChildLines(child.stdout, prefix, process.stdout);
    prefixHarnessChildLines(child.stderr, prefix, process.stderr);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) fulfill();
      else reject(new Error(`harness ${argv.join(" ")} failed (exit ${code ?? signal ?? 1})`));
    });
  });
}

async function runHarnessParallel(infraList, engine, extraArgs) {
  loadEnv();
  await hydrateTcbApiKeyFromCam();
  const passthrough = stripHarnessAxisArgv(extraArgs);
  console.log(`=== harness run infra=${infraList.join(",")} engine=${engine} (parallel) ===\n`);
  await Promise.all(
    infraList.map((infra) =>
      spawnHarnessChild(["run", "--infra", infra, "--engine", engine, ...passthrough]),
    ),
  );
  console.log(`\n✓ infra=${infraList.join(",")} engine=${engine} all passed`);
}

function logPreflightResult(preflight, { includeReply = false } = {}) {
  if (preflight.probe?.ok) {
    const reply =
      includeReply && preflight.probe.replySnippet != null
        ? ` reply=${preflight.probe.replySnippet}`
        : "";
    console.log(
      `✓ ${preflight.protocol} llm=${preflight.mode} ${preflight.probe.latencyMs}ms ` +
        `model=${preflight.probe.model}${reply}`,
    );
  } else if (preflight.mode === "zen") {
    console.log(`✓ llm=zen (${preflight.fallback ?? "platform unavailable"})`);
  }
}

function llmModeLabel(mode) {
  if (mode === "zen") return "zen";
  if (mode === "byok-openai") return "BYOK OpenAI";
  if (mode === "byok-anthropic") return "BYOK Anthropic";
  return "hy3";
}

async function runProductAcceptance(extraArgs = []) {
  const engine = parseHarnessEngineArg(extraArgs);
  loadEnv();
  try {
    assertHarnessEnginesEnv(engine);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const scenario = engine === "claude" ? "local-claude" : "local-opencode";
  logHarnessScenario(applyHarnessScenario(scenario));

  await hydrateTcbApiKeyFromCam();
  await assertHarnessAgsRuntimeEnvSync();

  const { runHarnessLlmPreflight } = await import("./llm-preflight.mjs");
  const localScenario = engine === "claude" ? "local-claude" : "local-opencode";
  console.log(`=== harness product-acceptance: LLM preflight (${localScenario}) ===`);
  let preflight;
  try {
    preflight = await runHarnessLlmPreflight(localScenario, { allowTestFallback: true });
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  logPreflightResult(preflight);
  applyHarnessTestDefaults();

  if (engine === "all") {
    console.log("=== harness product-acceptance: LLM preflight (local-claude) ===");
    try {
      const claudePreflight = await runHarnessLlmPreflight("local-claude", {
        allowTestFallback: true,
      });
      logPreflightResult(claudePreflight);
    } catch (err) {
      console.error(err.message ?? err);
      process.exit(1);
    }
  }

  console.log(
    `=== harness product-acceptance (engine=${engine}, llm=${describeHarnessLlmMode()}) ===`,
  );
  runNode("scripts/harness/product-acceptance.mjs", [
    "--engine",
    engine,
    HARNESS_PREFLIGHT_DONE_FLAG,
  ]);
}

async function runLocal(engine, extraArgs = []) {
  loadEnv();
  try {
    assertHarnessEnginesEnv(engine);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const scenario = engine === "claude" ? "local-claude" : "local-opencode";
  logHarnessScenario(applyHarnessScenario(scenario));

  console.log(`=== harness run infra=local engine=${engine}: e2e stub（网关 + 假沙箱）===`);
  runNode("tests/harness/e2e.test.mjs");

  await hydrateTcbApiKeyFromCam();
  await assertHarnessAgsRuntimeEnvSync();

  const { runHarnessLlmPreflight } = await import("./llm-preflight.mjs");
  const localScenario = engine === "claude" ? "local-claude" : "local-opencode";
  console.log(`=== harness run infra=local: LLM preflight (${localScenario}) ===`);
  let preflight;
  try {
    preflight = await runHarnessLlmPreflight(localScenario, { allowTestFallback: true });
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  logPreflightResult(preflight, { includeReply: true });
  applyHarnessTestDefaults();

  let claudeMode = engine === "claude" ? preflight.mode : null;
  if (engine === "all") {
    console.log("=== harness run infra=local: LLM preflight (local-claude) ===");
    try {
      const claudePreflight = await runHarnessLlmPreflight("local-claude", {
        allowTestFallback: true,
      });
      claudeMode = claudePreflight.mode;
      logPreflightResult(claudePreflight);
    } catch (err) {
      console.error(err.message ?? err);
      process.exit(1);
    }
  }

  const engineLabel =
    engine === "claude"
      ? llmModeLabel(preflight.mode)
      : engine === "all"
        ? `opencode=${llmModeLabel(preflight.mode)} + claude=${llmModeLabel(claudeMode)}`
        : llmModeLabel(preflight.mode);
  console.log(`=== harness run infra=local: e2e full（engine=${engine}，llm=${engineLabel}）===`);
  runNode("tests/harness/e2e.test.mjs", forwardE2eArgs(engine, extraArgs));

  if (harnessEnginesIncludeOpencode(engine) || harnessEnginesIncludeClaude(engine)) {
    console.log("=== harness run infra=local: matrix parity ===");
    await assertHarnessAgsRuntimeEnvSync();
    runNode("tests/harness/matrix-parity.test.mjs", ["--engine", engine]);
  }

  if (harnessCosConfiguredInFile()) {
    const { assertHarnessCosEnv } = await import(
      "../../packages/agent-runtime/dist/harness/harness-env.js"
    );
    applyHarnessCosFromHarnessFile();
    assertHarnessCosEnv();
    console.log("=== harness run infra=local: cos-e2e ===");
    runNode("scripts/harness/cos-e2e.mjs");
  } else {
    console.log("(skip cos-e2e — .env.harness HARNESS_COS_ENABLED=1 时跑)");
  }
}

async function runCloudSingle(backend, engine, extraArgs) {
  const cloudCosMount = parseCloudCosMount(extraArgs);
  loadEnv();
  logHarnessScenario(
    applyHarnessScenario(cloudHarnessScenario(backend, engine), process.env, { cloudCosMount }),
  );
  const { runCloudHarness } = await import("./cloud.mjs");
  await runCloudHarness(extraArgs, { backend, engine });
}

async function runHarnessAxes(axes, extraArgs) {
  const { infraTokens, engine, mode, plan } = axes;

  if (mode === "parallel") {
    await runHarnessParallel(infraTokens, engine, extraArgs);
    return;
  }

  if (plan.length === 1) {
    const { infra, engine: eng } = plan[0];
    if (infra === "local") await runLocal(eng, extraArgs);
    else await runCloudSingle(infra, eng, extraArgs);
    return;
  }

  console.log(`=== harness run sequential (${plan.length} steps) ===\n`);
  for (const { infra, engine: eng } of plan) {
    console.log(`\n--- infra=${infra} engine=${eng} ---\n`);
    if (infra === "local") await runLocal(eng, extraArgs);
    else await runCloudSingle(infra, eng, extraArgs);
  }
  console.log(`\n✓ harness run sequential (${plan.length} steps) complete`);
}

function formatAxesLabel(axes) {
  const infraLabel =
    axes.infraTokens.length === 1 && axes.infraTokens[0] === "all"
      ? "all→local,tcbr,scf"
      : axes.infraTokens.join(",");
  if (axes.plan.length > 1 && axes.mode === "sequential") {
    return `plan=${axes.plan.map((s) => `${s.infra}/${s.engine}`).join(" → ")}`;
  }
  return `infra=${infraLabel} engine=${axes.engine}`;
}

function parseAxesOrExit(extraArgs, opts = {}) {
  try {
    return parseHarnessAxes(extraArgs, opts);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "run") {
    const extraArgs = args.slice(1);
    if (extraArgs.includes("-h") || extraArgs.includes("--help")) {
      console.log(HELP);
      process.exit(0);
    }
    const axes = parseAxesOrExit(extraArgs);
    console.log(`=== harness run ${formatAxesLabel(axes)} ===\n`);
    await runHarnessAxes(axes, extraArgs);
    return;
  }

  if (cmd === "release") {
    await runRelease(args.slice(1));
    return;
  }

  if (cmd === "quickstart") {
    runNode("scripts/harness/quickstart.mjs", args.slice(1));
    return;
  }

  if (cmd === "docker") {
    runNode("scripts/harness/local-docker.mjs", args.slice(1));
    return;
  }

  if (cmd === "ma-protocol") {
    const extra = args.slice(1);
    const engine = parseHarnessEngineArg(extra, { defaultEngine: "opencode" });
    if (engine === "all") {
      console.error("--engine all is not valid for ma-protocol; use opencode or claude\n");
      process.exit(1);
    }
    const scenario = engine === "claude" ? "ma-protocol-claude" : "ma-protocol";
    runNode("scripts/harness/managed-agents-protocol.mjs", ["--scenario", scenario, ...extra]);
    return;
  }

  if (cmd === "product-acceptance") {
    await runProductAcceptance(args.slice(1));
    return;
  }

  if (cmd === "db-pressure") {
    const extraArgs = args.slice(1);
    const engine = parseHarnessEngineArg(extraArgs);
    parseAxesOrExit(extraArgs, { required: false });
    loadEnv();
    try {
      assertHarnessEnginesEnv(engine);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const scenario = engine === "claude" ? "local-claude" : "local-opencode";
    logHarnessScenario(applyHarnessScenario(scenario));
    await hydrateTcbApiKeyFromCam();
    await assertHarnessAgsRuntimeEnvSync();
    applyHarnessTestDefaults();
    if (engine !== "claude") {
      applyPlatformLlmEnv();
    }
    const forward = ["--db-pressure-only", "--db-pressure", "--engine", engine];
    const ri = extraArgs.indexOf("--db-pressure-rounds");
    if (ri >= 0 && extraArgs[ri + 1]) {
      forward.push("--db-pressure-rounds", extraArgs[ri + 1]);
    }
    console.log(`=== harness db-pressure infra=local engine=${engine} (FlexDB) ===`);
    runNode("tests/harness/e2e.test.mjs", forward);
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
