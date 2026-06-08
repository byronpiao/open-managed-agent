#!/usr/bin/env node
/**
 * Harness 验收 env：只读 `.env.harness`（单文件，不叠加 `.env`）。
 *
 *   cp .env.harness.example .env.harness
 *   node scripts/harness/load-env.mjs --check [--probe-llm]
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

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

function loadFile(path) {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    process.env[parsed.key] = parsed.val;
  }
  return true;
}

/** Load `.env.harness` only. */
export function loadEnv() {
  if (!loadFile(HARNESS_ENV_FILE)) {
    throw new Error(
      "Missing .env.harness — run: cp .env.harness.example .env.harness",
    );
  }
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
      `Missing in .env.harness: ${missing.join(", ")}. ` +
        `Fill required keys in .env.harness (see .env.harness.example).`,
    );
  }
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    loadEnv();
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  const missing = missingHarnessCreds();
  if (process.argv.includes("--check")) {
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
      console.log(`  LLM=${llmMissing.length ? `missing ${llmMissing.join(",")}` : "ok"}`);
      const cosMissing = missingHarnessCosEnv();
      if (process.env.HARNESS_COS_ENABLED === "1") {
        console.log(`  COS=${cosMissing.length ? `missing ${cosMissing.join(",")}` : "ok"}`);
      }
      console.log(
        `  HARNESS_TOOL_ID=${process.env.HARNESS_TOOL_ID ?? "(unset — auto harness-{CLOUDBASE_ENV_ID})"}`,
      );
      console.log(`  HARNESS_CLOUD_AGENT_ID=${process.env.HARNESS_CLOUD_AGENT_ID ?? "(unset)"}`);
      console.log(`  HARNESS_CLOUD_SCF_AGENT_ID=${process.env.HARNESS_CLOUD_SCF_AGENT_ID ?? "(unset)"}`);
      console.log(`  LLM_API_KEY=${process.env.LLM_API_KEY ? "(set)" : "(unset)"}`);
      console.log(`  HARNESS_COS_ENABLED=${process.env.HARNESS_COS_ENABLED ?? "(unset)"}`);
      if (process.argv.includes("--probe-llm")) {
        if (llmMissing.length) {
          console.error(`Cannot probe LLM: missing ${llmMissing.join(", ")}`);
          process.exit(1);
        }
        const { assertHarnessOpenAiLlmReachable } = await import(
          "../../packages/agent-runtime/dist/harness/llm-probe.js"
        );
        const probe = await assertHarnessOpenAiLlmReachable();
        console.log(
          `  LLM probe: ok ${probe.latencyMs}ms model=${probe.model} reply=${probe.replySnippet ?? "(empty)"}`,
        );
      }
      process.exit(0);
    };
    runCheck().catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  }
}
