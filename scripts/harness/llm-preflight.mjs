/**
 * Harness 矩阵 LLM 预检 — 起 AGS / deploy 前按场景协议探活。
 *
 * opencode 平台额度用尽 → 测试可 fallback zen
 * claude 平台额度用尽 → 测试可 fallback scenarios ③ Anthropic BYOK（对客无 zen）
 */
import {
  applyHarnessLlmTier,
  applyScenarioEnv,
} from "./load-env.mjs";
import {
  normalizeHarnessScenario,
  scenarioNeedsAnthropicByok,
  scenarioNeedsOpenAiByok,
  hasAnthropicScenarioEnv,
} from "./scenario-matrix.mjs";

/**
 * @typedef {object} HarnessLlmPreflightResult
 * @property {string} tier platform | zen | byok | anthropic-byok
 * @property {string} scenario
 * @property {import('../../packages/agent-runtime/dist/harness/llm-probe.js').HarnessLlmProbeResult} [probe]
 * @property {string} [fallback] human-readable fallback reason
 * @property {string} [protocol] openai-chat | anthropic-messages
 */

/**
 * @param {string} scenario
 * @param {{ allowTestFallback?: boolean; target?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<HarnessLlmPreflightResult>}
 */
export async function runHarnessLlmPreflight(scenario, opts = {}) {
  const id = normalizeHarnessScenario(scenario);
  const allowTestFallback = opts.allowTestFallback !== false;
  const target = opts.target ?? process.env;

  const {
    probeCloudBasePlatformLlm,
    probeCloudBasePlatformAnthropicLlm,
    probeHarnessOpenAiLlm,
    probeHarnessAnthropicLlmSandboxCompat,
    isPlatformQuotaExceeded,
    formatPlatformProbeFailureGuide,
    formatClaudePlatformProbeFailureGuide,
  } = await import("../../packages/agent-runtime/dist/harness/llm-probe.js");

  if (id === "local-opencode" || id === "local" || id === "local-cos") {
    const probe = await probeCloudBasePlatformLlm();
    if (probe.ok) {
      applyHarnessLlmTier("platform", target);
      return { tier: "platform", scenario: id, probe, protocol: "openai-chat" };
    }
    if (allowTestFallback && isPlatformQuotaExceeded(probe)) {
      applyHarnessLlmTier("zen", target);
      return {
        tier: "zen",
        scenario: id,
        probe,
        fallback: "hy3-preview quota → opencode zen",
        protocol: "openai-chat",
      };
    }
    throw new Error(formatPlatformProbeFailureGuide(probe));
  }

  if (id === "local-claude") {
    const platformProbe = await probeCloudBasePlatformAnthropicLlm();
    if (platformProbe.ok) {
      applyHarnessLlmTier("platform", target);
      return {
        tier: "platform",
        scenario: id,
        probe: platformProbe,
        protocol: "anthropic-messages",
      };
    }
    if (allowTestFallback && hasAnthropicScenarioEnv(id)) {
      applyScenarioEnv(id, target);
      applyHarnessLlmTier("anthropic-byok", target);
      const byokProbe = await probeHarnessAnthropicLlmSandboxCompat();
      if (byokProbe.ok) {
        const reason = isPlatformQuotaExceeded(platformProbe)
          ? "hy3-preview quota → Anthropic BYOK (test only)"
          : "platform unreachable → Anthropic BYOK (test only)";
        console.warn(`⚠ ${reason}\n`);
        return {
          tier: "anthropic-byok",
          scenario: id,
          probe: byokProbe,
          fallback: reason,
          protocol: "anthropic-messages",
        };
      }
      throw new Error(
        `${formatClaudePlatformProbeFailureGuide(platformProbe)}\n` +
          `BYOK sandbox-compat probe also failed: ${byokProbe.error ?? "unknown"}`,
      );
    }
    throw new Error(formatClaudePlatformProbeFailureGuide(platformProbe));
  }

  if (id === "cloud-tcbr-opencode") {
    applyHarnessLlmTier("zen", target);
    return { tier: "zen", scenario: id, protocol: "openai-chat" };
  }

  if (scenarioNeedsOpenAiByok(id)) {
    applyScenarioEnv(id, target);
    applyHarnessLlmTier("byok", target);
    const probe = await probeHarnessOpenAiLlm();
    if (!probe.ok) {
      throw new Error(
        `OpenAI BYOK probe failed (HTTP ${probe.httpStatus || 0}): ${probe.error ?? "unknown"}`,
      );
    }
    return { tier: "byok", scenario: id, probe, protocol: "openai-chat" };
  }

  if (scenarioNeedsAnthropicByok(id)) {
    applyScenarioEnv(id, target);
    applyHarnessLlmTier("anthropic-byok", target);
    const probe = await probeHarnessAnthropicLlmSandboxCompat();
    if (!probe.ok) {
      throw new Error(
        `Anthropic BYOK sandbox-compat probe failed (HTTP ${probe.httpStatus || 0}): ${probe.error ?? "unknown"}`,
      );
    }
    return { tier: "anthropic-byok", scenario: id, probe, protocol: "anthropic-messages" };
  }

  throw new Error(`No LLM preflight rule for scenario: ${id}`);
}

/** `load-env.mjs --check --probe-matrix` */
export async function probeHarnessMatrixPreflight() {
  const cells = [
    "local-opencode",
    "local-claude",
    "cloud-tcbr-opencode",
    "cloud-scf-opencode",
    "cloud-tcbr-claude",
    "cloud-scf-claude",
  ];
  let failed = 0;
  for (const cell of cells) {
    const snap = { ...process.env };
    try {
      try {
        const result = await runHarnessLlmPreflight(cell, {
          allowTestFallback: true,
          target: process.env,
        });
        const fb = result.fallback ? ` fallback=${result.fallback}` : "";
        const lat = result.probe?.latencyMs != null ? ` ${result.probe.latencyMs}ms` : "";
        console.log(`  probe ${cell}: ok tier=${result.tier}${lat}${fb}`);
      } catch (err) {
        failed++;
        const msg = (err.message ?? String(err)).split("\n")[0];
        console.log(`  probe ${cell}: FAIL ${msg}`);
      }
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in snap)) delete process.env[k];
      }
      Object.assign(process.env, snap);
    }
  }
  if (failed) process.exit(1);
}
