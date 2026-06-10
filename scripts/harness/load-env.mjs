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
import { readTcbLoginCredential } from "../../lib/credentials.mjs";
import { hydrateCloudEnvFromCli } from "../../lib/env.mjs";
import {
  clearShellLeakedHarnessPins,
  expectedHarnessToolName,
  harnessCosEnabledFromMap,
  loadHarnessEnvIntoProcess,
  pinnedHarnessToolId,
  readHarnessEnvMap,
} from "../../lib/harness-env-file.mjs";
import {
  applyScenarioEnv,
  hasAnthropicScenarioEnv,
  hasAnthropicTripleInMap,
  hasOpenAiScenarioEnv,
  hasOpenAiTripleInMap,
  HARNESS_MATRIX_SCENARIOS,
  normalizeHarnessScenario,
  readScenarioEnvMap,
  resolveHarnessAgentYaml,
  scenarioAgentYamlPath,
  scenarioEngine,
  scenarioEnvFileExists,
  scenarioEnvPath,
  scenarioEnvExamplePath,
  scenarioEnvReady,
} from "./scenario-matrix.mjs";

export {
  applyScenarioEnv,
  resolveHarnessAgentYaml,
  normalizeHarnessScenario,
  HARNESS_MATRIX_SCENARIOS,
  scenarioEngine,
  scenarioAgentYamlPath,
};

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
  if (process.env.TCB_API_KEY?.trim()) return true;
  return false;
}

const BYOK_LLM_KEYS = [
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "HARNESS_FORCE_ZEN",
];

/** @deprecated use hasAnthropicScenarioEnv */
export function hasAnthropicByokInMap() {
  return hasAnthropicScenarioEnv("local-claude");
}

/** local full 引擎覆盖：opencode=主力默认 · claude=旁路 · all=两者 */
export const HARNESS_ENGINE_VALUES = ["opencode", "claude", "all"];

export function parseHarnessEnginesArg(argv = process.argv.slice(2)) {
  let engines = "opencode";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--engines" && argv[i + 1]) {
      engines = argv[++i].trim().toLowerCase();
    }
  }
  if (!HARNESS_ENGINE_VALUES.includes(engines)) {
    throw new Error(`Invalid --engines ${engines}; use opencode | claude | all`);
  }
  return engines;
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
      `--engines claude|all requires ${scenarioEnvPath("local-claude")} ` +
        `(cp ${scenarioEnvExamplePath("local-claude")})`,
    );
  }
}

/** Stripped for cloud / no-cos scenarios — COS only applies to `local` when enabled in `.env.harness`. */
export const HARNESS_COS_ENV_KEYS = [
  "HARNESS_COS_ENABLED",
  "HARNESS_COS_BUCKET",
  "HARNESS_COS_BUCKET_PATH",
  "HARNESS_COS_ENDPOINT",
  "HARNESS_COS_REGION",
  "HARNESS_COS_MOUNT_NAME",
  "HARNESS_COS_MOUNT_DIR",
  "HARNESS_COS_SUBPATH",
];

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

export function applyHarnessScenario(scenario, target = process.env) {
  const map = readHarnessEnvMap();
  const envId = target.CLOUDBASE_ENV_ID?.trim() || map.get("CLOUDBASE_ENV_ID")?.trim() || "";
  const cosRequired = scenario === "local-cos";
  scenario = normalizeHarnessScenario(scenario);

  for (const k of HARNESS_COS_ENV_KEYS) delete target[k];

  if (scenario === "quickstart") {
    target.HARNESS_SCENARIO = "quickstart";
    applyHarnessLlmTier("platform", target);
    applyHarnessTestDefaults(target);
    return {
      scenario,
      cosEnabled: false,
      toolName: envId ? expectedHarnessToolName(envId, false, map) : "",
    };
  }

  const cloudLocal = scenario.startsWith("cloud-") || scenario.startsWith("local-");
  if (!cloudLocal || !HARNESS_MATRIX_SCENARIOS.includes(scenario)) {
    throw new Error(`unknown harness scenario: ${scenario}`);
  }

  if (scenario.startsWith("cloud-")) {
    applyScenarioEnv(scenario, target);
    if (scenario === "cloud-tcbr-opencode") {
      applyHarnessLlmTier("zen", target);
    } else if (scenario === "cloud-scf-opencode") {
      applyHarnessLlmTier("byok", target);
    } else {
      applyHarnessLlmTier("anthropic-byok", target);
    }
    target.HARNESS_SCENARIO = scenario;
    applyHarnessTestDefaults(target);
    return {
      scenario,
      cosEnabled: false,
      toolName: envId ? expectedHarnessToolName(envId, false, map) : "",
      engine: scenarioEngine(scenario),
      agentYaml: scenarioAgentYamlPath(scenarioEngine(scenario)),
    };
  }

  const cosFromFile = harnessCosEnabledFromMap(map);
  if (cosRequired && !cosFromFile) {
    throw new Error("scenario local-cos requires HARNESS_COS_ENABLED=1 in .env.harness (⑥ 段)");
  }
  if (cosFromFile) {
    for (const k of HARNESS_COS_ENV_KEYS) {
      const v = map.get(k)?.trim();
      if (v) target[k] = v;
    }
  }

  applyScenarioEnv(scenario, target);
  applyHarnessLlmTier("platform", target);
  target.HARNESS_SCENARIO = scenario;
  applyHarnessTestDefaults(target);
  return {
    scenario,
    cosEnabled: cosFromFile,
    toolName: envId ? expectedHarnessToolName(envId, cosFromFile, map) : "",
    engine: scenarioEngine(scenario),
    agentYaml: scenarioAgentYamlPath(scenarioEngine(scenario)),
  };
}

export function logHarnessScenario(meta) {
  if (!meta?.scenario) return;
  const cos = meta.cosEnabled ? "with-cos" : "no-cos";
  console.log(
    `harness scenario: ${meta.scenario} → AGS tool ${meta.toolName || "(unset)"} (${cos})`,
  );
}

/**
 * LLM tier 标记。byok / anthropic-byok 要求先 `applyScenarioEnv` 写入标准 ③ 键。
 */
export function applyHarnessLlmTier(tier, target = process.env) {
  if (tier === "platform" || tier === "zen") {
    for (const k of BYOK_LLM_KEYS) delete target[k];
  }
  if (tier === "platform") {
    target.HARNESS_LLM_TIER = "platform";
    return;
  }
  if (tier === "zen") {
    target.HARNESS_FORCE_ZEN = "1";
    target.HARNESS_LLM_TIER = "zen";
    return;
  }
  if (tier === "byok") {
    if (!hasOpenAiTripleInMap(new Map(Object.entries(target)))) {
      throw new Error("byok tier: missing LLM_API_KEY + LLM_MODEL + OPENAI_BASE_URL (apply scenario env first)");
    }
    delete target.ANTHROPIC_BASE_URL;
    target.HARNESS_LLM_TIER = "byok";
    return;
  }
  if (tier === "anthropic-byok") {
    if (!hasAnthropicTripleInMap(new Map(Object.entries(target)))) {
      throw new Error(
        "anthropic-byok tier: missing LLM_API_KEY + LLM_MODEL + ANTHROPIC_BASE_URL (apply scenario env first)",
      );
    }
    delete target.OPENAI_BASE_URL;
    target.HARNESS_LLM_TIER = "anthropic-byok";
    return;
  }
  throw new Error(`unknown HARNESS LLM tier: ${tier}`);
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

/** Load `.env.harness` only. */
export function loadEnv() {
  if (!loadHarnessEnvIntoProcess()) {
    throw new Error(
      "Missing .env.harness — run: cp .env.harness.example .env.harness",
    );
  }
  for (const k of BYOK_LLM_KEYS) delete process.env[k];
  delete process.env.HARNESS_LLM_TIER;
  for (const [from, to] of ALIASES) {
    if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
  }
  clearShellLeakedHarnessPins();
  const envMap = readHarnessEnvMap();
  // E2e: parallel no-cos / with-cos tools unless explicitly disabled in `.env.harness`.
  if (!envMap.has("HARNESS_TOOL_COS_NAME_SUFFIX")) {
    process.env.HARNESS_TOOL_COS_NAME_SUFFIX = "1";
  }
  const pinnedTool = pinnedHarnessToolId();
  if (pinnedTool) process.env.HARNESS_TOOL_ID = pinnedTool;
  hydrateCloudEnvFromCli();
}

/** Resolve TCB_API_KEY from CAM when unset (for probes / local harness). */
export async function hydrateTcbApiKeyFromCam() {
  if (process.env.TCB_API_KEY?.trim()) return;
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
      const { HARNESS_PUBLIC_MAGENT_IMAGE, missingHarnessLlmEnv, missingHarnessCosEnv } =
        await import("../../packages/agent-runtime/dist/harness/harness-env.js");
      const image = process.env.HARNESS_SANDBOX_IMAGE?.trim() || HARNESS_PUBLIC_MAGENT_IMAGE;
      console.log(`  HARNESS_SANDBOX_IMAGE=${image}`);
      const llmMissing = missingHarnessLlmEnv();
      console.log(
        `  LLM(process)=${llmMissing.length ? `unset (${llmMissing.join(",")} — scenario inject)` : "ok"}`,
      );
      const cosMissing = missingHarnessCosEnv();
      if (process.env.HARNESS_COS_ENABLED === "1") {
        console.log(`  COS=${cosMissing.length ? `missing ${cosMissing.join(",")}` : "ok"}`);
      }
      console.log(
        `  gateway token=${process.env.TCB_API_KEY ? "ok (CAM-derived)" : "not resolved"}`,
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
      console.log(`  HARNESS_COS_ENABLED=${process.env.HARNESS_COS_ENABLED ?? "(unset)"}`);
      const publicTag = HARNESS_PUBLIC_MAGENT_IMAGE.split(":").pop();
      const sandboxTag = image.split(":").pop();
      if (publicTag !== sandboxTag) {
        console.warn(
          `  WARN: HARNESS_PUBLIC_MAGENT_IMAGE tag (${publicTag}) != HARNESS_SANDBOX_IMAGE (${sandboxTag}) — run build-push or align harness-env.ts`,
        );
      }
      try {
        const envId = process.env.CLOUDBASE_ENV_ID?.trim();
        if (envId) {
          const envMap = readHarnessEnvMap();
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
              console.warn(`  WARN: tool image tag != HARNESS_SANDBOX_IMAGE — run: node scripts/harness/sync-tool.mjs`);
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
            `  LLM probe (${scenario}): tier=${result.tier} ok ${result.probe.latencyMs}ms ` +
              `model=${result.probe.model} reply=${result.probe.replySnippet ?? "(empty)"}`,
          );
        } else {
          console.log(`  LLM probe (${scenario}): tier=${result.tier}`);
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
