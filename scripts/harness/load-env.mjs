#!/usr/bin/env node
/**
 * Harness 验收 env：只读 `.env.harness`（单文件，不叠加 `.env`）。
 *
 *   cp .env.harness.example .env.harness
 *   node scripts/harness/load-env.mjs --check [--probe-llm]
 */

import { execSync } from "child_process";
import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  clearShellLeakedHarnessPins,
  expectedHarnessToolName,
  harnessCosEnabledFromMap,
  loadHarnessEnvIntoProcess,
  pinnedHarnessToolId,
  readHarnessEnvMap,
} from "../../lib/harness-env-file.mjs";

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

/** Load `.env.harness` only. */
export function loadEnv() {
  if (!loadHarnessEnvIntoProcess()) {
    throw new Error(
      "Missing .env.harness — run: cp .env.harness.example .env.harness",
    );
  }
  for (const [from, to] of ALIASES) {
    if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
  }
  if (!process.env.LLM_API_KEY?.trim()) {
    const anthropicKey =
      process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.CLAUDE_API_KEY?.trim();
    if (anthropicKey) process.env.LLM_API_KEY = anthropicKey;
  }
  clearShellLeakedHarnessPins();
  const pinnedTool = pinnedHarnessToolId();
  if (pinnedTool) process.env.HARNESS_TOOL_ID = pinnedTool;
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
        `  HARNESS_TOOL_ID=${process.env.HARNESS_TOOL_ID ?? "(unset — auto oma-harness-{env}-no-cos|with-cos)"}`,
      );
      console.log(
        `  HARNESS_TOOL_ROLE_ARN=${process.env.HARNESS_TOOL_ROLE_ARN ? "(set)" : "(unset — required when auto-creating AGS tools)"}`,
      );
      console.log(`  HARNESS_CLOUD_AGENT_ID=${process.env.HARNESS_CLOUD_AGENT_ID ?? "(unset)"}`);
      console.log(`  HARNESS_CLOUD_SCF_AGENT_ID=${process.env.HARNESS_CLOUD_SCF_AGENT_ID ?? "(unset)"}`);
      console.log(`  LLM_API_KEY=${process.env.LLM_API_KEY ? "(set)" : "(unset)"}`);
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
