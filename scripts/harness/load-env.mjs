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
  "TCB_SECRET_ID",
  "TCB_SECRET_KEY",
  "TCB_REGION",
];

const BYOK_LLM_KEYS = [
  "LLM_API_KEY",
  "LLM_MODEL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "HARNESS_FORCE_ZEN",
];

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
 * | local        | (host orchestrator)     | file ⑥ optional | platform   |
 * | cloud-tcbr   | agent.harness.cloud     | no-cos (strip)  | zen        |
 * | cloud-scf    | agent.harness.cloud     | no-cos (strip)  | BYOK ③     |
 */
export function applyHarnessScenario(scenario, target = process.env) {
  const map = readHarnessEnvMap();
  const envId = target.CLOUDBASE_ENV_ID?.trim() || map.get("CLOUDBASE_ENV_ID")?.trim() || "";

  for (const k of HARNESS_COS_ENV_KEYS) delete target[k];

  if (scenario === "cloud-tcbr") {
    target.HARNESS_SCENARIO = "cloud-tcbr";
    applyHarnessLlmTier("zen", target);
    applyHarnessTestDefaults(target);
    return {
      scenario,
      cosEnabled: false,
      toolName: envId ? expectedHarnessToolName(envId, false, map) : "",
    };
  }

  if (scenario === "cloud-scf") {
    target.HARNESS_SCENARIO = "cloud-scf";
    applyHarnessLlmTier("byok", target);
    applyHarnessTestDefaults(target);
    return {
      scenario,
      cosEnabled: false,
      toolName: envId ? expectedHarnessToolName(envId, false, map) : "",
    };
  }

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

  if (scenario === "local" || scenario === "local-cos") {
    const cosFromFile = harnessCosEnabledFromMap(map);
    if (scenario === "local-cos") {
      if (!cosFromFile) {
        throw new Error(
          "scenario local-cos requires HARNESS_COS_ENABLED=1 in .env.harness (⑥ 段)",
        );
      }
    }
    if (cosFromFile) {
      for (const k of HARNESS_COS_ENV_KEYS) {
        const v = map.get(k)?.trim();
        if (v) target[k] = v;
      }
    }
    target.HARNESS_SCENARIO = scenario;
    applyHarnessLlmTier("platform", target);
    applyHarnessTestDefaults(target);
    return {
      scenario,
      cosEnabled: cosFromFile,
      toolName: envId ? expectedHarnessToolName(envId, cosFromFile, map) : "",
    };
  }

  throw new Error(`unknown harness scenario: ${scenario}`);
}

export function logHarnessScenario(meta) {
  if (!meta?.scenario) return;
  const cos = meta.cosEnabled ? "with-cos" : "no-cos";
  console.log(
    `harness scenario: ${meta.scenario} → AGS tool ${meta.toolName || "(unset)"} (${cos})`,
  );
}

/** Harness 三层 LLM：local=platform(hy3) | cloud-tcbr=zen | cloud-scf=BYOK(③段). */
export function applyHarnessLlmTier(tier, target = process.env) {
  for (const k of BYOK_LLM_KEYS) delete target[k];
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
    const map = readHarnessEnvMap();
    for (const k of ["LLM_API_KEY", "LLM_MODEL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) {
      const v = map.get(k)?.trim();
      if (v) target[k] = v;
    }
    target.HARNESS_LLM_TIER = "byok";
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
}

/** Resolve TCB_API_KEY from CAM when unset (for probes / local harness). */
export async function hydrateTcbApiKeyFromCam() {
  if (process.env.TCB_API_KEY?.trim()) return;
  const { ensureTcbApiKeyInProcess } = await import("../../lib/resolve-tcb-api-key.mjs");
  await ensureTcbApiKeyInProcess();
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
      console.log(`  LLM=${llmMissing.length ? `missing ${llmMissing.join(",")}` : "ok"}`);
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
  })().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
