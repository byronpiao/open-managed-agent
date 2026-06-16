/**
 * Read pin values from `.env.harness` only — never trust shell exports for deploy pins.
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ENV_FILE = resolve(__dirname, "../.env.harness");

/** COS vars live in `.env.harness` but are not injected by `loadEnv()` — use `applyHarnessCosFromHarnessFile`. */
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

/** Keys that must come from `.env.harness` only (shell export ignored / cleared on load). */
export const HARNESS_FILE_ONLY_KEYS = ["HARNESS_TOOL_ID"];

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return { key, val };
}

/** @returns {Map<string, string>} */
export function readHarnessEnvMap() {
  const map = new Map();
  if (!existsSync(HARNESS_ENV_FILE)) return map;
  for (const line of readFileSync(HARNESS_ENV_FILE, "utf-8").split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    map.set(parsed.key, parsed.val);
  }
  return map;
}

/** Apply parsed `.env.harness` entries to process.env. */
export function applyHarnessEnvMapToProcess(map) {
  for (const [key, val] of map) process.env[key] = val;
}

/** Load `.env.harness` into process.env. COS keys are skipped unless `skipCos: false`. */
export function loadHarnessEnvIntoProcess(opts = {}) {
  const skipCos = opts.skipCos !== false;
  const map = readHarnessEnvMap();
  if (!existsSync(HARNESS_ENV_FILE)) return false;
  for (const [key, val] of map) {
    if (skipCos && HARNESS_COS_ENV_KEYS.includes(key)) continue;
    process.env[key] = val;
  }
  return true;
}

export function harnessEnvFileValue(key) {
  return readHarnessEnvMap().get(key)?.trim() ?? "";
}

export function pinnedHarnessToolId() {
  return harnessEnvFileValue("HARNESS_TOOL_ID");
}

export function harnessCosEnabledFromMap(map) {
  const v = map.get("HARNESS_COS_ENABLED")?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Mirrors `harnessEnvSlug` / tool names in packages/agent-runtime/src/config.ts */
export function harnessEnvSlug(envId, maxLen = 40) {
  return envId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, maxLen) || "default";
}

export function expectedHarnessToolName(envId, cosEnabled, map = readHarnessEnvMap()) {
  void cosEnabled;
  void map;
  return `oma-harness-${harnessEnvSlug(envId, 40)}`;
}

export function clearShellLeakedHarnessPins() {
  for (const key of HARNESS_FILE_ONLY_KEYS) {
    if (!harnessEnvFileValue(key)) delete process.env[key];
  }
}
