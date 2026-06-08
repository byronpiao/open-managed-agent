#!/usr/bin/env node
/**
 * Probe COS snapshot readiness on a live harness sandbox (AGS data plane).
 * With HARNESS_COS_ENABLED=1 expects snapshot 200; otherwise documents §5 skip.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv, assertHarnessCreds } from "./load-env.mjs";
import { COS_POST_WRITE_SETTLE_MS, postWorkspaceSnapshot } from "./cos-lib.mjs";

loadEnv();
assertHarnessCreds();

const envId = process.env.CLOUDBASE_ENV_ID;

async function main() {
  const { getSandboxOrchestrator } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const { buildHarnessInstanceEnv } = await import(
    "../../packages/agent-runtime/dist/config.js"
  );

  const orch = getSandboxOrchestrator();
  const agentConfig = {
    name: "CosProbe",
    model: process.env.LLM_MODEL ?? "mimo-v2.5",
    system: "probe",
    runtime: "harness",
    engine: "opencode",
  };

  console.log("cos-probe: acquiring sandbox…");
  const handle = await orch.acquire({
    envId,
    agentConfig,
    engine: "opencode",
    instanceEnv: buildHarnessInstanceEnv(agentConfig, "opencode"),
  });

  try {
    const healthRes = await handle.request("/health");
    const healthText = await healthRes.text();
    let health = {};
    try {
      health = JSON.parse(healthText);
    } catch {
      console.log("health raw:", healthText.slice(0, 400));
    }
    const restore = health.restoreStatus ?? health.restore ?? null;
    console.log("instanceId:", handle.instanceId);
    console.log("health.ok:", health.ok);
    console.log("restoreStatus:", restore ? JSON.stringify(restore, null, 2) : "(none)");

    if (process.env.HARNESS_COS_ENABLED === "1") {
      const writeRes = await handle.request("/api/tools/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: ".harness-cos-probe", content: "probe\n" }),
      });
      const writeText = await writeRes.text();
      console.log("write probe file:", writeRes.status, writeText.slice(0, 120));
      if (!writeRes.ok) {
        console.error("COS probe write failed");
        process.exit(1);
      }
      if (COS_POST_WRITE_SETTLE_MS > 0) {
        console.log(`waiting ${COS_POST_WRITE_SETTLE_MS}ms after write…`);
        await sleep(COS_POST_WRITE_SETTLE_MS);
      }
    }

    const snap = await postWorkspaceSnapshot(handle);
    console.log(
      "POST /api/workspace/snapshot:",
      snap.status,
      snap.text.slice(0, 500),
      snap.attempt ? `(attempt ${snap.attempt})` : "",
    );

    if (!snap.ok) {
      if (process.env.HARNESS_COS_ENABLED === "1") {
        console.error("\nCOS enabled but snapshot failed — see docs/harness-architecture.md §2 COS / §6");
        process.exit(1);
      }
      console.log("\nNote: default harness-{envId} tool has no COS_MOUNT_DIR — skip is expected.");
      console.log("Enable: HARNESS_COS_* in .env.harness → HARNESS_COS_ENABLED=1 npm run harness -- local");
    } else {
      console.log("\n✓ COS snapshot ready");
    }
  } finally {
    console.log("cos-probe: stopping instance…");
    await handle.stop();
    await sleep(500);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
