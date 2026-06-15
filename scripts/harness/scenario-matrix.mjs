/**
 * Harness 场景矩阵（3 部署面 × 2 engine = 6 格）
 *
 *   .env.<scenario>     — 每格一个（③ LLM / tier 差异）
 *   agent.<engine>.yaml — 仅 2 个（engine 决定沙箱 ACP 路径）
 *
 * 基座 `.env.harness` = ①④⑤⑥
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const HARNESS_SCENARIOS_DIR = resolve(__dirname, "scenarios");

/** 6 格主矩阵（quickstart / ma-protocol 旁路，不在此表） */
export const HARNESS_MATRIX_SCENARIOS = [
  "local-opencode",
  "local-claude",
  "cloud-tcbr-opencode",
  "cloud-scf-opencode",
  "cloud-tcbr-claude",
  "cloud-scf-claude",
];

/** 旁路验收：独立 agent.yaml × .env.<scenario>，不进 6 格 LLM 矩阵 */
export const HARNESS_SIDECAR_SCENARIOS = ["quickstart", "ma-protocol", "ma-protocol-claude"];

export const HARNESS_MA_PROTOCOL_SCENARIO = "ma-protocol";
export const HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO = "ma-protocol-claude";

const LLM_KEYS = [
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "HARNESS_FORCE_ZEN",
];

export function parseEnvLines(content) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    map.set(key, val);
  }
  return map;
}

export function readEnvFileMap(filePath) {
  if (!existsSync(filePath)) return new Map();
  return parseEnvLines(readFileSync(filePath, "utf-8"));
}

export function normalizeHarnessScenario(scenario) {
  if (scenario === "local" || scenario === "local-cos") return "local-opencode";
  if (scenario === "cloud-tcbr") return "cloud-tcbr-opencode";
  if (scenario === "cloud-scf") return "cloud-scf-opencode";
  if (scenario === "cloud" || scenario === "cloud-opencode") return "cloud-tcbr-opencode";
  return scenario;
}

export function scenarioEngine(scenario) {
  return normalizeHarnessScenario(scenario).endsWith("-claude") ? "claude" : "opencode";
}

export function scenarioEnvPath(scenario) {
  return resolve(HARNESS_SCENARIOS_DIR, `.env.${normalizeHarnessScenario(scenario)}`);
}

export function scenarioEnvExamplePath(scenario) {
  return resolve(HARNESS_SCENARIOS_DIR, `.env.${normalizeHarnessScenario(scenario)}.example`);
}

export function scenarioAgentYamlPath(engine) {
  return resolve(HARNESS_SCENARIOS_DIR, `agent.${engine}.yaml`);
}

export function scenarioMaProtocolAgentYamlPath() {
  return resolve(HARNESS_SCENARIOS_DIR, "agent.ma-protocol.yaml");
}

export function scenarioMaProtocolClaudeAgentYamlPath() {
  return resolve(HARNESS_SCENARIOS_DIR, "agent.ma-protocol-claude.yaml");
}

export function readScenarioEnvMap(scenario) {
  return readEnvFileMap(scenarioEnvPath(scenario));
}

/** 每格必须有 `.env.<scenario>` 文件（可为空 = platform / zen） */
export function scenarioEnvFileExists(scenario) {
  return existsSync(scenarioEnvPath(scenario));
}

/** 云上 BYOK 格子 — ③ 必须在 `.env.<scenario>` 填齐（local-claude ③ 仅测试 fallback 用，可空） */
export function scenarioNeedsByokEnv(scenario) {
  const id = normalizeHarnessScenario(scenario);
  return (
    id === "cloud-scf-opencode" ||
    id === "cloud-tcbr-claude" ||
    id === "cloud-scf-claude"
  );
}

export function scenarioNeedsOpenAiByok(scenario) {
  return normalizeHarnessScenario(scenario) === "cloud-scf-opencode";
}

export function scenarioNeedsAnthropicByok(scenario) {
  const id = normalizeHarnessScenario(scenario);
  return id === "cloud-tcbr-claude" || id === "cloud-scf-claude";
}

/** local-claude 可选 ③ — 平台额度用尽时测试 fallback */
export function scenarioAllowsAnthropicByokFallback(scenario) {
  const id = normalizeHarnessScenario(scenario);
  return id === "local-claude" || scenarioNeedsAnthropicByok(id);
}

export function hasOpenAiTripleInMap(map) {
  return Boolean(
    map.get("LLM_API_KEY")?.trim() &&
      map.get("LLM_MODEL")?.trim() &&
      map.get("OPENAI_BASE_URL")?.trim(),
  );
}

export function hasAnthropicTripleInMap(map) {
  return Boolean(
    map.get("LLM_API_KEY")?.trim() &&
      map.get("LLM_MODEL")?.trim() &&
      map.get("ANTHROPIC_BASE_URL")?.trim(),
  );
}

export function pinnedMaProtocolAgentId(map = readScenarioEnvMap(HARNESS_MA_PROTOCOL_SCENARIO)) {
  return (
    map.get("HARNESS_MA_PROTOCOL_AGENT_ID")?.trim() ||
    map.get("CLOUDBASE_AGENT_ID")?.trim() ||
    ""
  );
}

export function scenarioEnvReady(scenario) {
  const id = normalizeHarnessScenario(scenario);
  if (!scenarioEnvFileExists(id)) return false;
  const map = readScenarioEnvMap(id);
  if (id === HARNESS_MA_PROTOCOL_SCENARIO || id === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO) {
    return Boolean(pinnedMaProtocolAgentId(map));
  }
  if (scenarioNeedsOpenAiByok(id)) return hasOpenAiTripleInMap(map);
  if (scenarioNeedsAnthropicByok(id)) return hasAnthropicTripleInMap(map);
  if (id === "local-claude") return true;
  return true;
}

export function hasAnthropicScenarioEnv(scenario = "local-claude") {
  const id = normalizeHarnessScenario(scenario);
  if (!scenarioEnvFileExists(id)) return false;
  return hasAnthropicTripleInMap(readScenarioEnvMap(id));
}

export function hasOpenAiScenarioEnv(scenario = "cloud-scf-opencode") {
  return scenarioEnvReady(scenario);
}

/** Merge scenario `.env.<id>` into target; clears prior LLM keys first. */
export function applyScenarioEnv(scenario, target = process.env) {
  const id = normalizeHarnessScenario(scenario);
  for (const k of LLM_KEYS) delete target[k];
  delete target.HARNESS_LLM_TIER;

  const path = scenarioEnvPath(id);
  if (!existsSync(path)) {
    const hint = existsSync(scenarioEnvExamplePath(id))
      ? `cp ${scenarioEnvExamplePath(id)} ${path}`
      : `create ${path}`;
    throw new Error(`Missing scenario env ${path} — ${hint}`);
  }

  const map = readScenarioEnvMap(id);
  if (scenarioNeedsByokEnv(id)) {
    if (scenarioNeedsOpenAiByok(id) && !hasOpenAiTripleInMap(map)) {
      throw new Error(`${path} needs LLM_API_KEY + LLM_MODEL + OPENAI_BASE_URL`);
    }
    if (scenarioNeedsAnthropicByok(id) && !hasAnthropicTripleInMap(map)) {
      throw new Error(`${path} needs LLM_API_KEY + LLM_MODEL + ANTHROPIC_BASE_URL`);
    }
  }
  for (const [key, val] of map) target[key] = val;
  return map;
}

/** Scenario → agent yaml（6 格按 engine；旁路各有一份） */
export function resolveHarnessAgentYaml(scenario) {
  const id = normalizeHarnessScenario(scenario);
  if (id === "quickstart") {
    return resolve(__dirname, "../../docs/examples/agent.sandbox.opencode.min.yaml");
  }
  if (id === HARNESS_MA_PROTOCOL_SCENARIO) {
    const path = scenarioMaProtocolAgentYamlPath();
    if (!existsSync(path)) {
      throw new Error(`Missing ${path} for scenario ${id}`);
    }
    return path;
  }
  if (id === HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO) {
    const path = scenarioMaProtocolClaudeAgentYamlPath();
    if (!existsSync(path)) {
      throw new Error(`Missing ${path} for scenario ${id}`);
    }
    return path;
  }
  const engine = scenarioEngine(id);
  const path = scenarioAgentYamlPath(engine);
  if (!existsSync(path)) {
    throw new Error(`Missing ${path} for scenario ${id}`);
  }
  return path;
}
