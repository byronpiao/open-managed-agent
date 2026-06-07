#!/usr/bin/env node
/**
 * Load .env + .env.harness for harness tests and magent ops.
 *
 *   node scripts/load-env.mjs --check
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const ENV_FILE = resolve(repoRoot, ".env");
const HARNESS_ENV_FILE = resolve(repoRoot, ".env.harness");

const ALIASES = [
  ["TCB_ENV_ID", "CLOUDBASE_ENV_ID"],
  ["TENCENTCLOUD_SECRETID", "TCB_SECRET_ID"],
  ["TENCENTCLOUD_SECRETKEY", "TCB_SECRET_KEY"],
];

const REQUIRED_FOR_AGS = [
  "CLOUDBASE_ENV_ID",
  "TCB_API_KEY",
  "TCB_SECRET_ID",
  "TCB_SECRET_KEY",
  "TCB_REGION",
];

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

function loadFile(path, { force = false } = {}) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const { key, val } = parsed;
    if (force || !process.env[key]) {
      process.env[key] = val;
    }
  }
}

/** Load .env then overlay .env.harness (harness wins). */
export function loadEnv() {
  loadFile(ENV_FILE);
  loadFile(HARNESS_ENV_FILE, { force: true });
  for (const [from, to] of ALIASES) {
    if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
  }
}

export function missingHarnessCreds() {
  return REQUIRED_FOR_AGS.filter((k) => !process.env[k]);
}

export function assertHarnessCreds() {
  const missing = missingHarnessCreds();
  if (missing.length) {
    throw new Error(
      `Missing in .env: ${missing.join(", ")}. ` +
        `cp .env.example .env — harness 见 .env.harness.example`,
    );
  }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  loadEnv();
  const missing = missingHarnessCreds();
  if (process.argv.includes("--check")) {
    const runCheck = async () => {
    if (missing.length) {
      console.error(`Missing env: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log("OK: CloudBase credentials present");
    console.log(`  CLOUDBASE_ENV_ID=${process.env.CLOUDBASE_ENV_ID}`);
    console.log(`  TCB_REGION=${process.env.TCB_REGION}`);
    const { HARNESS_PUBLIC_MAGENT_IMAGE, missingHarnessLlmEnv, missingHarnessCosEnv } =
      await import("../packages/agent-runtime/dist/harness/harness-env.js");
    const image = process.env.HARNESS_SANDBOX_IMAGE?.trim() || HARNESS_PUBLIC_MAGENT_IMAGE;
    console.log(`  HARNESS_SANDBOX_IMAGE=${image}`);
    const llmMissing = missingHarnessLlmEnv();
    console.log(`  LLM=${llmMissing.length ? `missing ${llmMissing.join(",")}` : "ok"}`);
    const cosMissing = missingHarnessCosEnv();
    if (process.env.HARNESS_COS_ENABLED === "1") {
      console.log(`  COS=${cosMissing.length ? `missing ${cosMissing.join(",")}` : "ok"}`);
    }
    console.log(
      `  HARNESS_TOOL_ID=${process.env.HARNESS_TOOL_ID ?? "(unset — auto harness-{CLOUDBASE_ENV_ID})"}`,
    );
    console.log(`  LLM_API_KEY=${process.env.LLM_API_KEY ? "(set)" : "(unset)"}`);
    console.log(`  LLM_MODEL=${process.env.LLM_MODEL ?? "(unset)"}`);
    console.log(`  OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL ? "(set)" : "(unset)"}`);
    console.log(`  ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ? "(set)" : "(unset)"}`);
    console.log(`  HARNESS_COS_ENABLED=${process.env.HARNESS_COS_ENABLED ?? "(unset)"}`);
    console.log(
      `  HARNESS_TOOL_ROLE_ARN=${process.env.HARNESS_TOOL_ROLE_ARN ? "(set)" : "(unset — required only when auto-creating tool)"}`,
    );
    process.exit(0);
    };
    runCheck().catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  }
}
