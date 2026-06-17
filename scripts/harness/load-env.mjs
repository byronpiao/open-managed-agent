#!/usr/bin/env node
/**
 * Harness 验收 env：
 *   `.env.harness` — 基座 ①④⑤⑥
 *   `scenarios/.env.<scenario>` × `scenarios/agent.<engine>.yaml` — 6 格矩阵
 *
 *   cp .env.harness.example .env.harness
 *   node scripts/harness/load-env.mjs --check
 */

import { execSync } from "child_process";
import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  applyPlatformLlmEnv,
  clearHarnessLlmEnv,
  HARNESS_LLM_ENV_KEYS,
} from "../../lib/harness-llm-env.mjs";
import { hydrateCloudEnvFromCli } from "../../lib/env.mjs";
import {
  clearShellLeakedHarnessPins,
  expectedHarnessToolName,
  harnessCosEnabledFromMap,
  HARNESS_COS_ENV_KEYS,
  loadHarnessEnvIntoProcess,
  pinnedHarnessToolId,
  readHarnessEnvMap,
} from "../../lib/harness-env-file.mjs";
import { setHarnessScenario } from "../../lib/harness-scenario-state.mjs";
import {
  applyScenarioEnv,
  hasAnthropicScenarioEnv,
  hasAnthropicTripleInMap,
  hasOpenAiScenarioEnv,
  hasOpenAiTripleInMap,
  HARNESS_MATRIX_SCENARIOS,
  HARNESS_MA_PROTOCOL_SCENARIO,
  HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO,
  HARNESS_SIDECAR_SCENARIOS,
  normalizeHarnessScenario,
  pinnedMaProtocolAgentId,
  readScenarioEnvMap,
  resolveHarnessAgentYaml,
  scenarioAgentYamlPath,
  scenarioMaProtocolAgentYamlPath,
  scenarioMaProtocolClaudeAgentYamlPath,
  scenarioEngine,
  scenarioEnvFileExists,
  scenarioEnvPath,
  scenarioEnvExamplePath,
  scenarioEnvReady,
  scenarioFromAxes,
  parseHarnessInfraList,
  parseHarnessInfraTokens,
  expandHarnessInfraTokens,
  buildHarnessRunPlan,
  harnessInfraExecutionMode,
  parseHarnessEngineArg,
  parseHarnessAxes,
  HARNESS_INFRA_VALUES,
  HARNESS_CONCRETE_INFRAS,
  HARNESS_ENGINE_VALUES,
} from "./scenario-matrix.mjs";

export {
  applyPlatformLlmEnv,
  applyZenLlmEnv,
  captureHarnessLlmEnv,
  clearHarnessLlmEnv,
  describeHarnessLlmMode,
  hasAnthropicByokInEnv,
  hasOpenAiByokInEnv,
  isZenModelFromEnv,
  HARNESS_LLM_ENV_KEYS,
  resolveOpencodeModelFromEnv,
  restoreHarnessLlmEnv,
} from "../../lib/harness-llm-env.mjs";

export {
  clearHarnessScenario,
  getHarnessScenario,
  setHarnessScenario,
} from "../../lib/harness-scenario-state.mjs";

export {
  applyScenarioEnv,
  resolveHarnessAgentYaml,
  normalizeHarnessScenario,
  HARNESS_MATRIX_SCENARIOS,
  HARNESS_MA_PROTOCOL_SCENARIO,
  HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO,
  HARNESS_SIDECAR_SCENARIOS,
  pinnedMaProtocolAgentId,
  scenarioEngine,
  scenarioAgentYamlPath,
  scenarioMaProtocolAgentYamlPath,
  scenarioMaProtocolClaudeAgentYamlPath,
  scenarioFromAxes,
  parseHarnessInfraList,
  parseHarnessInfraTokens,
  expandHarnessInfraTokens,
  buildHarnessRunPlan,
  harnessInfraExecutionMode,
  parseHarnessEngineArg,
  parseHarnessAxes,
  HARNESS_INFRA_VALUES,
  HARNESS_CONCRETE_INFRAS,
  HARNESS_ENGINE_VALUES,
} from "./scenario-matrix.mjs";

const ALIASES = [
  ["TCB_ENV_ID", "CLOUDBASE_ENV_ID"],
  ["TENCENTCLOUD_SECRETID", "TCB_SECRET_ID"],
  ["TENCENTCLOUD_SECRETKEY", "TCB_SECRET_KEY"],
];

/** @deprecated alias — use hydrateCloudEnvFromCli from lib/env.mjs */
export function resolveHarnessCloudFromCli() {
  hydrateCloudEnvFromCli();
}

function hasHarnessCamCredentials() {
  if (process.env.TCB_SECRET_ID?.trim() && process.env.TCB_SECRET_KEY?.trim()) return true;
  if (process.env.TENCENTCLOUD_SECRETID?.trim() && process.env.TENCENTCLOUD_SECRETKEY?.trim()) {
    return true;
  }
  if (readTcbLoginCredential()) return true;
  if (process.env.CLOUDBASE_APIKEY?.trim()) return true;
  return false;
}

/** Cleared on `loadEnv()` so scenario `.env.<id>` applies fresh; AGENT_MODEL may come from parent preflight. */
const SCENARIO_LLM_KEYS = [
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
];

/** @deprecated use hasAnthropicScenarioEnv */
export function hasAnthropicByokInMap() {
  return hasAnthropicScenarioEnv("local-claude");
}

/** local full 引擎覆盖：opencode=主力 · claude=旁路 · all=双引擎（仅 local） */
export function parseHarnessEnginesArg(argv = process.argv.slice(2)) {
  return parseHarnessEngineArg(argv);
}

export function harnessEnginesIncludeOpencode(engines) {
  return engines === "opencode" || engines === "all";
}

export function harnessEnginesIncludeClaude(engines) {
  return engines === "claude" || engines === "all";
}

export function assertHarnessEnginesEnv(engines) {
  if (harnessEnginesIncludeClaude(engines) && !hasAnthropicScenarioEnv("local-claude")) {
    throw new Error(
      `--engine claude|all requires ${scenarioEnvPath("local-claude")} ` +
        `(cp ${scenarioEnvExamplePath("local-claude")})`,
    );
  }
}

/** Stripped for cloud / no-cos scenarios — COS only via `applyHarnessCosFromHarnessFile` or cloud `--with-cos`. */
export { HARNESS_COS_ENV_KEYS } from "../../lib/harness-env-file.mjs";

/** 云上专用：AGS tool / deploy 是否挂 COS（默认不挂） */
export function parseCloudCosMount(argv = process.argv.slice(2)) {
  const withCos = argv.includes("--with-cos");
  const noCos = argv.includes("--no-cos");
  if (withCos && noCos) {
    throw new Error("Cannot use both --with-cos and --no-cos");
  }
  return withCos;
}

function missingHarnessCosKeysInMap(map) {
  const required = [
    "HARNESS_COS_BUCKET",
    "HARNESS_COS_BUCKET_PATH",
    "HARNESS_COS_ENDPOINT",
    "HARNESS_COS_REGION",
    "HARNESS_COS_MOUNT_NAME",
    "HARNESS_COS_MOUNT_DIR",
  ];
  return required.filter((k) => !map.get(k)?.trim());
}

function applyHarnessCosFromFile(map, target = process.env) {
  for (const k of HARNESS_COS_ENV_KEYS) {
    const v = map.get(k)?.trim();
    if (v) target[k] = v;
  }
  target.HARNESS_COS_ENABLED = "1";
}

/** Inject COS vars from `.env.harness` (cos-e2e, cloud --with-cos). */
export function applyHarnessCosFromHarnessFile(target = process.env) {
  const map = readHarnessEnvMap();
  if (!harnessCosEnabledFromMap(map)) return false;
  const missing = missingHarnessCosKeysInMap(map);
  if (missing.length) {
    throw new Error(`HARNESS_COS_ENABLED=1 requires .env.harness: ${missing.join(", ")}`);
  }
  applyHarnessCosFromFile(map, target);
  return true;
}

/**
 * Harness acceptance scenarios — each maps to agent.yaml + env + AGS tool variant.
 *
 * | scenario     | agent yaml              | COS tool        | LLM        |
 * |--------------|-------------------------|-----------------|------------|
 * | quickstart   | docs/examples/...min    | no-cos          | platform   |
 * | local        | opencode orchestrator   | file ⑥ optional | platform   |
 * | 6 格         | agent.opencode.yaml | agent.claude.yaml |
 */
export function cloudHarnessScenario(backend, engine = "opencode") {
  const b = backend === "scf" ? "scf" : "tcbr";
  const e = engine === "claude" ? "claude" : "opencode";
  return `cloud-${b}-${e}`;
}

/** Pin var in `.env.harness` ⑤ — engine 后缀与 npm script 对齐。 */
export function cloudHarnessAgentPinVar(backend, engine = "opencode") {
  const b = backend === "scf" ? "SCF" : "TCBR";
  const e = engine === "claude" ? "CLAUDE" : "OPENCODE";
  return `HARNESS_CLOUD_${b}_${e}_AGENT_ID`;
}

export function pinnedCloudHarnessAgentId(backend, engine = "opencode", map = readHarnessEnvMap()) {
  const primary = map.get(cloudHarnessAgentPinVar(backend, engine))?.trim();
  if (primary) return primary;
  if (engine === "opencode") {
    const legacy =
      backend === "scf"
        ? map.get("HARNESS_CLOUD_SCF_AGENT_ID")?.trim()
        : map.get("HARNESS_CLOUD_AGENT_ID")?.trim();
    if (legacy) return legacy;
  }
  return "";
}

export function applyHarnessScenario(scenario, target = process.env, opts = {}) {
  const { cloudCosMount = false, devLocal = false } = opts;
  const map = readHarnessEnvMap();
  const envId = target.CLOUDBASE_ENV_ID?.trim() || map.get("CLOUDBASE_ENV_ID")?.trim() || "";
  const cosRequired = scenario === "local-cos";
  scenario = normalizeHarnessScenario(scenario);

  for (const k of HARNESS_COS_ENV_KEYS) delete target[k];

  if (scenario === "quickstart") {
    setHarnessScenario("quickstart");
    applyPlatformLlmEnv(target);
    applyHarnessTestDefaults(target);
    return {
      scenario,
      cosEnabled: false,
      toolName: envId ? expectedHarnessToolName(envId, false, map) : "",
    };
  }

  if (scenario === HARNESS_MA_PROTOCOL_SCENARIO || scenario === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO) {
    applyScenarioEnv(scenario, target);
    const deployedAgentId = pinnedMaProtocolAgentId(readScenarioEnvMap(scenario));
    if (deployedAgentId) target.CLOUDBASE_AGENT_ID = deployedAgentId;
    setHarnessScenario(scenario);
    applyHarnessTestDefaults(target);
    const agentYaml =
      scenario === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO
        ? scenarioMaProtocolClaudeAgentYamlPath()
        : scenarioMaProtocolAgentYamlPath();
    return {
      scenario,
      cosEnabled: false,
      toolName: "",
      engine: scenario === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO ? "claude" : "opencode",
      agentYaml,
      deployedAgentId,
    };
  }

  const cloudLocal = scenario.startsWith("cloud-") || scenario.startsWith("local-");
  if (!cloudLocal || !HARNESS_MATRIX_SCENARIOS.includes(scenario)) {
    throw new Error(`unknown harness scenario: ${scenario}`);
  }

  if (scenario.startsWith("cloud-")) {
    applyScenarioEnv(scenario, target);
    const cosEnabled = cloudCosMount === true;
    if (cosEnabled) {
      const missing = missingHarnessCosKeysInMap(map);
      if (missing.length) {
        throw new Error(`--with-cos requires .env.harness: ${missing.join(", ")}`);
      }
      applyHarnessCosFromFile(map, target);
    }
    setHarnessScenario(scenario);
    applyHarnessTestDefaults(target);
    return {
      scenario,
      cosEnabled,
      toolName: envId ? expectedHarnessToolName(envId, cosEnabled, map) : "",
      engine: scenarioEngine(scenario),
      agentYaml: scenarioAgentYamlPath(scenarioEngine(scenario)),
    };
  }

  const cosEnabled =
    scenario === "local-cos" ? harnessCosEnabledFromMap(map) : false;
  if (cosRequired && !cosEnabled) {
    throw new Error("scenario local-cos requires HARNESS_COS_ENABLED=1 in .env.harness (⑥ 段)");
  }
  if (cosEnabled) {
    applyHarnessCosFromFile(map, target);
  }

  applyScenarioEnv(scenario, target);
  applyPlatformLlmEnv(target);
  setHarnessScenario(scenario);
  applyHarnessTestDefaults(target);
  return {
    scenario,
    cosEnabled,
    toolName: envId ? expectedHarnessToolName(envId, cosEnabled, map) : "",
    engine: scenarioEngine(scenario),
    agentYaml: scenarioAgentYamlPath(scenarioEngine(scenario)),
  };
}

export function logHarnessScenario(meta) {
  if (!meta?.scenario) return;
  if (meta.scenario === HARNESS_MA_PROTOCOL_SCENARIO || meta.scenario === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO) {
    console.log(
      `harness scenario: ${meta.scenario} → deployed ${meta.deployedAgentId || "(unset)"} · yaml ${meta.agentYaml || (meta.scenario === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO ? scenarioMaProtocolClaudeAgentYamlPath() : scenarioMaProtocolAgentYamlPath())}`,
    );
    return;
  }
  const cos = meta.cosEnabled ? "with-cos" : "no-cos";
  console.log(
    `harness scenario: ${meta.scenario} → AGS tool ${meta.toolName || "(unset)"} (${cos})`,
  );
}

/** 验收阶段默认短超时（生产箱内 relay 仍可用 300000）。 */
export function applyHarnessTestDefaults(target = process.env) {
  if (!target.HARNESS_OPENCODE_ACP_TIMEOUT_MS?.trim()) {
    target.HARNESS_OPENCODE_ACP_TIMEOUT_MS = "90000";
  }
  if (!target.HARNESS_PLATFORM_PROBE_TIMEOUT_MS?.trim()) {
    target.HARNESS_PLATFORM_PROBE_TIMEOUT_MS = "30000";
  }
}

/** Keys cleared for tutorial / quickstart smoke (no cloud pin, no COS). */
export const QUICKSTART_ENV_STRIP_KEYS = [
  ...HARNESS_COS_ENV_KEYS,
  "HARNESS_TOOL_ID",
  "CLOUDBASE_AGENT_ID",
  "HARNESS_CLOUD_AGENT_ID",
  "HARNESS_CLOUD_SCF_AGENT_ID",
  "HARNESS_CLOUD_TCBR_OPENCODE_AGENT_ID",
  "HARNESS_CLOUD_SCF_OPENCODE_AGENT_ID",
  "HARNESS_CLOUD_TCBR_CLAUDE_AGENT_ID",
  "HARNESS_CLOUD_SCF_CLAUDE_AGENT_ID",
  "HARNESS_MA_PROTOCOL_AGENT_ID",
];

/** Remove cloud/COS/agent pins so quickstart matches customer fresh deploy. */
export function stripQuickstartPins(target = process.env) {
  for (const k of QUICKSTART_ENV_STRIP_KEYS) delete target[k];
}

/**
 * Env for `quickstart.mjs` — does not require `.env.harness`.
 * Prereq: magent login + tcb env use (or TCB_SECRET_* + CLOUDBASE_ENV_ID in env).
 */
export function prepareQuickstartEnv() {
  if (loadHarnessEnvIntoProcess()) {
    // optional file — ①④ may be empty; login + tcb env use fills gaps
  }
  applyPlatformLlmEnv();
  for (const [from, to] of ALIASES) {
    if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
  }
  stripQuickstartPins();
  clearShellLeakedHarnessPins();
  hydrateCloudEnvFromCli();
}

/** Load `.env.harness` only. */
export function loadEnv() {
  if (!loadHarnessEnvIntoProcess()) {
    throw new Error(
      "Missing .env.harness — run: cp .env.harness.example .env.harness",
    );
  }
  for (const k of SCENARIO_LLM_KEYS) delete process.env[k];
  for (const [from, to] of ALIASES) {
    if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
  }
  clearShellLeakedHarnessPins();
  const envMap = readHarnessEnvMap();
  const pinnedTool = pinnedHarnessToolId();
  if (pinnedTool) process.env.HARNESS_TOOL_ID = pinnedTool;
  hydrateCloudEnvFromCli();
}

/** Resolve CLOUDBASE_APIKEY from CAM when unset (for probes / local harness). */
export async function hydrateTcbApiKeyFromCam() {
  if (process.env.CLOUDBASE_APIKEY?.trim()) return;
  const { ensureTcbApiKeyInProcess } = await import("../../lib/resolve-tcb-api-key.mjs");
  await ensureTcbApiKeyInProcess();
}

export function missingHarnessCreds() {
  hydrateCloudEnvFromCli();
  const missing = [];
  if (!process.env.CLOUDBASE_ENV_ID?.trim()) {
    missing.push("CLOUDBASE_ENV_ID (or: tcb env use <envId>)");
  }
  if (!process.env.TCB_REGION?.trim()) {
    missing.push("TCB_REGION (or: readable via tcb env detail)");
  }
  if (!hasHarnessCamCredentials()) {
    missing.push("TCB_SECRET_ID/KEY (or: magent login)");
  }
  return missing;
}

export function assertHarnessCreds() {
  const missing = missingHarnessCreds();
  if (missing.length) {
    throw new Error(
      `Missing CloudBase creds: ${missing.join("; ")}. ` +
        `See .env.harness.example — or magent login + tcb env use.`,
    );
  }
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  (async () => {
    try {
      loadEnv();
      await hydrateTcbApiKeyFromCam();
    } catch (err) {
      console.error(err.message ?? err);
      process.exit(1);
    }
    const missing = missingHarnessCreds();
    if (!process.argv.includes("--check")) return;
    const runCheck = async () => {
      if (missing.length) {
        console.error(`Missing env: ${missing.join(", ")}`);
        process.exit(1);
      }
      console.log("OK: .env.harness loaded");
      console.log(`  CLOUDBASE_ENV_ID=${process.env.CLOUDBASE_ENV_ID}`);
      console.log(`  TCB_REGION=${process.env.TCB_REGION}`);
      const { HARNESS_PUBLIC_MAGENT_IMAGE, missingHarnessLlmEnv } =
        await import("../../packages/agent-runtime/dist/harness/harness-env.js");
      const { resolveSandboxImageFromYaml } = await import("../../lib/resolve-harness-sandbox-image.mjs");
      const image = resolveSandboxImageFromYaml() || HARNESS_PUBLIC_MAGENT_IMAGE;
      console.log(`  sandbox.image=${image}`);
      const envMap = readHarnessEnvMap();
      const llmMissing = missingHarnessLlmEnv();
      console.log(
        `  LLM(process)=${llmMissing.length ? `unset (${llmMissing.join(",")} — scenario inject)` : "ok"}`,
      );
      if (harnessCosEnabledFromMap(envMap)) {
        const cosMissing = missingHarnessCosKeysInMap(envMap);
        console.log(`  COS=${cosMissing.length ? `missing ${cosMissing.join(",")}` : "ok"}`);
      }
      console.log(
        `  gateway token=${process.env.CLOUDBASE_APIKEY ? "ok (CAM-derived)" : "not resolved"}`,
      );
      console.log(
        `  HARNESS_TOOL_ID=${process.env.HARNESS_TOOL_ID ?? "(unset — auto oma-harness-{env})"}`,
      );
      console.log(
        `  HARNESS_TOOL_ROLE_ARN=${process.env.HARNESS_TOOL_ROLE_ARN ? "(set)" : "(unset — 仅首次自动创工具时需要)"}`,
      );
      console.log("  matrix (6 scenarios × agent.<engine>.yaml):");
      for (const id of HARNESS_MATRIX_SCENARIOS) {
        const fileOk = scenarioEnvFileExists(id);
        const ready = scenarioEnvReady(id);
        const engine = scenarioEngine(id);
        const status = !fileOk ? "missing .env" : ready ? "ok" : "incomplete ③";
        console.log(`    ${id} → agent.${engine}.yaml : ${status}`);
      }
      console.log("  sidecar (agent.yaml × .env.<scenario>):");
      for (const id of HARNESS_SIDECAR_SCENARIOS) {
        if (id === "quickstart") {
          console.log(
            `    ${id} → docs/examples/agent.sandbox.opencode.min.yaml : post-login (no .env.harness required)`,
          );
          continue;
        }
        const fileOk = scenarioEnvFileExists(id);
        const ready = scenarioEnvReady(id);
        const yaml =
          id === HARNESS_MA_PROTOCOL_SCENARIO
            ? "agent.ma-protocol.yaml"
            : id === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO
              ? "agent.ma-protocol-claude.yaml"
              : resolveHarnessAgentYaml(id).split("/").pop();
        const status = !fileOk
          ? "missing .env"
          : ready
            ? "ok"
            : "incomplete HARNESS_MA_PROTOCOL_AGENT_ID";
        console.log(`    ${id} → ${yaml} : ${status}`);
      }
      console.log(
        `  HARNESS_COS_ENABLED=${harnessCosEnabledFromMap(envMap) ? "1" : "(unset in process — cos-e2e only)"}`,
      );
      const publicTag = HARNESS_PUBLIC_MAGENT_IMAGE.split(":").pop();
      const sandboxTag = image.split(":").pop();
      if (publicTag !== sandboxTag) {
        console.warn(
          `  WARN: HARNESS_PUBLIC_MAGENT_IMAGE tag (${publicTag}) != resolved sandbox image (${sandboxTag}) — run build-push or set sandbox.image in agent.harness.yaml`,
        );
      }
      try {
        const envId = process.env.CLOUDBASE_ENV_ID?.trim();
        if (envId) {
          const toolName = expectedHarnessToolName(envId, harnessCosEnabledFromMap(envMap));
          const listRaw = execSync("tcb sandbox tool list --json", {
            encoding: "utf-8",
            maxBuffer: 20 * 1024 * 1024,
          });
          const tools = JSON.parse(listRaw.slice(listRaw.indexOf("{"))).data?.SandboxToolSet ?? [];
          const pinned = pinnedHarnessToolId();
          const tool = pinned
            ? tools.find((t) => t.ToolId === pinned)
            : tools.find((t) => t.ToolName === toolName);
          if (tool) {
            const toolTag = tool.CustomConfiguration?.Image?.split(":").pop();
            console.log(`  AGS tool: ${tool.ToolName} (${tool.ToolId}) image tag=${toolTag ?? "?"}`);
            if (toolTag && toolTag !== sandboxTag) {
              console.warn(`  WARN: tool image tag != sandbox.image — run: node scripts/harness/sync-tool.mjs`);
            }
          } else {
            console.log(`  AGS tool: (none yet for ${toolName})`);
          }
        }
      } catch (err) {
        console.warn(`  AGS tool check skipped: ${err.message ?? err}`);
      }
      if (process.argv.includes("--probe-matrix")) {
        const { probeHarnessMatrixPreflight } = await import("./llm-preflight.mjs");
        console.log("  LLM preflight (6 cells):");
        await probeHarnessMatrixPreflight();
      } else if (process.argv.includes("--probe-llm")) {
        const scenarioArg = process.argv.find((a, i) => process.argv[i - 1] === "--scenario");
        const { runHarnessLlmPreflight } = await import("./llm-preflight.mjs");
        const scenario = scenarioArg || "cloud-scf-opencode";
        const result = await runHarnessLlmPreflight(scenario, { allowTestFallback: true });
        if (result.probe) {
          console.log(
            `  LLM probe (${scenario}): llm=${result.mode} ok ${result.probe.latencyMs}ms ` +
              `model=${result.probe.model} reply=${result.probe.replySnippet ?? "(empty)"}`,
          );
        } else {
          console.log(`  LLM probe (${scenario}): llm=${result.mode}`);
        }
      }
      process.exit(0);
    };
    runCheck().catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  })().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
