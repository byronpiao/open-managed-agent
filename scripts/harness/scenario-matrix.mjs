/**
 * Harness 场景矩阵（3 部署面 × 2 engine = 6 格）
 *
 *   .env.<scenario>     — 每格一个（③ LLM / tier 差异）
 *   agent.<engine>.yaml — 仅 2 个（engine 决定沙箱 ACP 路径）
 *
 * 基座 `.env.harness` = ①④⑤⑥
 */
import { existsSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
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

/** OMA 部署面（具体值） */
export const HARNESS_CONCRETE_INFRAS = ["local", "tcbr", "scf"];

/** CLI `--infra` 取值（含 all = 三面对齐跑） */
export const HARNESS_INFRA_VALUES = [...HARNESS_CONCRETE_INFRAS, "all"];

/** 沙箱内 engine；`all` 仅与 `--infra local` 联用（双引擎验收） */
export const HARNESS_ENGINE_VALUES = ["opencode", "claude", "all"];

/** 旁路验收：独立 agent.yaml × .env.<scenario>，不进 6 格 LLM 矩阵 */
export const HARNESS_SIDECAR_SCENARIOS = ["quickstart", "ma-protocol", "ma-protocol-claude"];

export const HARNESS_MA_PROTOCOL_SCENARIO = "ma-protocol";
export const HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO = "ma-protocol-claude";

const LLM_KEYS = [
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "AGENT_MODEL",
  "AGENT_ENV_OVERRIDES",
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
  return scenario;
}

/** Map CLI axes → scenario id (`.env.<id>` / tier 格子) */
export function scenarioFromAxes(infra, engine) {
  const i = infra.trim().toLowerCase();
  const e = engine.trim().toLowerCase();
  if (!HARNESS_CONCRETE_INFRAS.includes(i)) {
    throw new Error(`Invalid infra ${infra}; use ${HARNESS_CONCRETE_INFRAS.join(" | ")}`);
  }
  if (!HARNESS_ENGINE_VALUES.includes(e)) {
    throw new Error(`Invalid --engine ${engine}; use ${HARNESS_ENGINE_VALUES.join(" | ")}`);
  }
  if (e === "all" && i !== "local") {
    throw new Error("--engine all only valid with --infra local");
  }
  if (i === "local") {
    return e === "all" ? "local-opencode" : `local-${e}`;
  }
  return `cloud-${i}-${e}`;
}

/** Raw `--infra` tokens before `all` expansion (e.g. `tcbr,scf` or `all`) */
export function parseHarnessInfraTokens(argv = process.argv.slice(2), { required = true } = {}) {
  let raw = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--infra" && argv[i + 1]) raw = argv[++i];
  }
  if (!raw?.trim()) {
    if (required) {
      throw new Error(
        `Missing --infra ${HARNESS_INFRA_VALUES.join(" | ")} (comma-separate cloud for parallel)`,
      );
    }
    return ["local"];
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid --infra ${raw}`);
  }
  if (parts.includes("all") && parts.length > 1) {
    throw new Error("--infra all cannot combine with other values");
  }
  for (const p of parts) {
    if (!HARNESS_INFRA_VALUES.includes(p)) {
      throw new Error(`Invalid --infra ${p}; use ${HARNESS_INFRA_VALUES.join(" | ")}`);
    }
  }
  return parts;
}

/** `all` → [local, tcbr, scf]；`tcbr,scf` 保持原样 */
export function expandHarnessInfraTokens(tokens) {
  if (tokens.length === 1 && tokens[0] === "all") {
    return [...HARNESS_CONCRETE_INFRAS];
  }
  return tokens;
}

/**
 * Expand axes into atomic runs `{ infra, engine }[]`.
 * - `--infra all` → local → tcbr → scf（顺序）
 * - `--infra all --engine all` → local 双引擎 + 各云面 opencode/claude
 */
export function buildHarnessRunPlan(infraTokens, engine) {
  const e = engine.trim().toLowerCase();
  const expanded = expandHarnessInfraTokens(infraTokens);

  if (e === "all" && infraTokens.length > 1 && !(infraTokens.length === 1 && infraTokens[0] === "all")) {
    throw new Error("--engine all only valid with --infra local or --infra all");
  }

  /** @type {{ infra: string, engine: string }[]} */
  const runs = [];
  for (const infra of expanded) {
    if (e === "all") {
      if (infra === "local") {
        runs.push({ infra, engine: "all" });
      } else {
        runs.push({ infra, engine: "opencode" });
        runs.push({ infra, engine: "claude" });
      }
    } else {
      runs.push({ infra, engine: e });
    }
  }
  return runs;
}

/** Parallel when explicit multi-cloud (`tcbr,scf`); sequential for `all` expansion or single infra */
export function harnessInfraExecutionMode(infraTokens) {
  if (infraTokens.length === 1 && infraTokens[0] === "all") return "sequential";
  if (infraTokens.length > 1) return "parallel";
  return "single";
}

/** Parse `--infra tcbr,scf` into tokens (legacy name — prefer parseHarnessInfraTokens) */
export function parseHarnessInfraList(argv = process.argv.slice(2), opts = {}) {
  return expandHarnessInfraTokens(parseHarnessInfraTokens(argv, opts));
}

export function parseHarnessEngineArg(argv = process.argv.slice(2), { defaultEngine = "opencode" } = {}) {
  let engine = defaultEngine;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--engine" || argv[i] === "--engines") && argv[i + 1]) {
      engine = argv[++i].trim().toLowerCase();
    }
  }
  if (!HARNESS_ENGINE_VALUES.includes(engine)) {
    throw new Error(`Invalid --engine ${engine}; use ${HARNESS_ENGINE_VALUES.join(" | ")}`);
  }
  return engine;
}

export function parseHarnessAxes(argv = process.argv.slice(2), opts = {}) {
  const engine = parseHarnessEngineArg(argv, opts);
  const infraTokens = parseHarnessInfraTokens(argv, opts);
  const mode = harnessInfraExecutionMode(infraTokens);
  const plan = buildHarnessRunPlan(infraTokens, engine);
  const infraList =
    mode === "parallel" ? infraTokens : plan.length === 1 ? [plan[0].infra] : expandHarnessInfraTokens(infraTokens);
  return {
    infraTokens,
    infraList,
    engine,
    mode,
    plan,
    scenario: scenarioFromAxes(plan[0].infra, plan[0].engine),
  };
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

/** 研发本地：缺格子 env 时从 example 复制或创建空文件（platform 格） */
export function ensureScenarioEnvFile(scenario) {
  const id = normalizeHarnessScenario(scenario);
  const path = scenarioEnvPath(id);
  if (existsSync(path)) return path;
  const example = scenarioEnvExamplePath(id);
  if (existsSync(example)) {
    copyFileSync(example, path);
    return path;
  }
  if (!scenarioNeedsByokEnv(id)) {
    writeFileSync(path, `# ${id}\n`, "utf8");
    return path;
  }
  throw new Error(
    `Missing ${path} — cp ${example} or fill BYOK keys (see CONTRIBUTING.md)`,
  );
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
