#!/usr/bin/env node
/**
 * 本地开发 / 本地冒烟 — 默认最轻：local · opencode · model:zen · 不挂云 COS
 *
 *   cp agent.harness.yaml.example agent.harness.yaml
 *   magent login && tcb env use <envId>
 *   npm run dev:harness
 *
 * 模型走 agent.yaml 常规字段（AGENT_MODEL=zen），不用 harness 内部 tier env。
 * COS 不挂云 bucket；本地持久化以后用临时目录方案（见 CONTRIBUTING.md）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, applyHarnessScenario, parseHarnessEngineArg } from "./harness/load-env.mjs";
import {
  applyScenarioEnv,
  ensureScenarioEnvFile,
  scenarioFromAxes,
} from "./harness/scenario-matrix.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeEntry = resolve(repoRoot, "packages/agent-runtime/dist/index.js");
const DEV_INFRA = "local";
const DEV_ENGINE_DEFAULT = "opencode";

function parseArgs(argv) {
  let port = 19090;
  const harnessArgv = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log(`Usage: npm run dev:harness [-- --engine opencode|claude] [--port 19090]

  默认（本地开发 / 本地冒烟）:
    infra=local  engine=opencode  model=zen  不挂云 COS

  可选:
    --engine claude   本地 Claude（LLM 跟 scenario env / agent.yaml）

  ACP: http://127.0.0.1:<port>/acp
`);
      process.exit(0);
    } else harnessArgv.push(argv[i]);
  }
  return { port, harnessArgv };
}

function linkAgentYaml(source) {
  const agentYaml = resolve(repoRoot, "agent.yaml");
  if (existsSync(agentYaml)) {
    const st = lstatSync(agentYaml);
    if (!st.isSymbolicLink()) {
      console.error(`已有 ${agentYaml}（非 symlink）— 请移走；dev 需要 symlink → agent.harness.yaml`);
      process.exit(1);
    }
    unlinkSync(agentYaml);
  }
  symlinkSync(resolve(source), agentYaml);
}

function ensureRuntimeBuilt() {
  if (existsSync(runtimeEntry)) return;
  console.log("packages/agent-runtime 未构建，正在 npm run build:runtime …\n");
  const r = spawnSync("npm", ["run", "build:runtime"], { cwd: repoRoot, stdio: "inherit" });
  if (r.status !== 0 || !existsSync(runtimeEntry)) {
    console.error("build:runtime 失败 — 无法启动 dev:harness");
    process.exit(r.status ?? 1);
  }
}

async function main() {
  const { port, harnessArgv } = parseArgs(process.argv.slice(2));

  let engine;
  try {
    engine = parseHarnessEngineArg(harnessArgv, { defaultEngine: DEV_ENGINE_DEFAULT });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (engine === "all") {
    console.error("--engine all 不适用于 dev:harness；用 opencode 或 claude\n");
    process.exit(1);
  }

  const harnessYaml = resolve(repoRoot, "agent.harness.yaml");
  if (!existsSync(harnessYaml)) {
    console.error("缺少 agent.harness.yaml\n  cp agent.harness.yaml.example agent.harness.yaml");
    process.exit(1);
  }

  const scenario = scenarioFromAxes(DEV_INFRA, engine);
  ensureScenarioEnvFile(scenario);

  loadEnv();
  const meta = applyHarnessScenario(scenario, process.env, { devLocal: true });
  applyScenarioEnv(scenario);

  linkAgentYaml(harnessYaml);
  ensureRuntimeBuilt();

  const childEnv = { ...process.env };
  delete childEnv.AGENT_CONFIG;
  delete childEnv.AGENT_CONFIG_B64;
  childEnv.PORT = String(port);
  childEnv.CLOUDBASE_SERVER_URL = `http://127.0.0.1:${port}`;
  childEnv.OAK_USE_MEMORY_STORE = childEnv.OAK_USE_MEMORY_STORE ?? "1";
  if (engine === "opencode") {
    childEnv.AGENT_MODEL = "zen";
  }

  const modelLabel = engine === "opencode" ? "zen" : "yaml/scenario";
  console.log(
    `\ndev:harness  http://127.0.0.1:${port}/acp` +
      `  infra=${DEV_INFRA}  engine=${engine}  model=${modelLabel}  cos=off\n`,
  );

  const child = spawn(process.execPath, [runtimeEntry], {
    cwd: repoRoot,
    env: childEnv,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
