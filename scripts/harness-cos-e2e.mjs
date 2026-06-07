#!/usr/bin/env node
/**
 * Harness COS full path: write → snapshot → stop → new instance same SubPath → restore proof.
 * Requires HARNESS_COS_ENABLED=1 + bucket vars (see .env.harness.example).
 * Aligns with code_sandbox/一条龙.md §5 and TRW ags-snapshot-verify-sop.md.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv } from "./load-env.mjs";
import { COS_POST_WRITE_SETTLE_MS, postWorkspaceSnapshot } from "./harness-cos-lib.mjs";

loadEnv();

const envId = process.env.CLOUDBASE_ENV_ID;
const subPath = process.env.HARNESS_COS_SUBPATH?.trim() || `harness-e2e-${Date.now().toString(36)}`;
process.env.HARNESS_COS_SUBPATH = subPath;

const marker = `cos-e2e-${randomBytes(4).toString("hex")}`;
const proofPath = `harness-cos-proof-${marker}.txt`;
const proofContent = `harness cos e2e ${marker}`;

async function parseHealth(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

async function acquireSandbox(orch, label) {
  const { buildHarnessInstanceEnv } = await import(
    "../packages/agent-runtime/dist/config.js"
  );
  const agentConfig = {
    name: "CosE2E",
    model: process.env.LLM_MODEL ?? "mimo-v2.5",
    system: "cos e2e",
    runtime: "harness",
    engine: "opencode",
  };
  console.log(`\n=== ${label}: acquire (subPath=${subPath}) ===`);
  return orch.acquire({
    envId,
    agentConfig,
    engine: "opencode",
    instanceEnv: buildHarnessInstanceEnv(agentConfig, "opencode"),
  });
}

async function main() {
  const { getSandboxOrchestrator } = await import(
    "../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const orch = getSandboxOrchestrator();

  let handleA;
  try {
    handleA = await acquireSandbox(orch, "instance A");
    console.log("instanceA:", handleA.instanceId);

    const healthA = await parseHealth(await handleA.request("/health"));
    console.log("restoreStatus A:", JSON.stringify(healthA.restoreStatus ?? null, null, 2));

    const writeRes = await handleA.request("/api/tools/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: proofPath, content: proofContent }),
    });
    const writeBody = await writeRes.text();
    if (!writeRes.ok) {
      throw new Error(`write failed ${writeRes.status}: ${writeBody.slice(0, 300)}`);
    }
    console.log("write ok:", proofPath);

    console.log(`waiting ${COS_POST_WRITE_SETTLE_MS}ms after write (TRW debounced sync window)…`);
    await sleep(COS_POST_WRITE_SETTLE_MS);
    const snapA = await postWorkspaceSnapshot(handleA);
    console.log("snapshot A:", snapA.status, snapA.text.slice(0, 300), `(attempt ${snapA.attempt ?? "?"})`);
    if (!snapA.ok) {
      throw new Error(`snapshot expected 200, got ${snapA.status}: ${snapA.text.slice(0, 200)}`);
    }
  } finally {
    if (handleA) {
      console.log("stopping instance A…");
      await handleA.stop();
      await sleep(3000);
    }
  }

  let handleB;
  try {
    handleB = await acquireSandbox(orch, "instance B (same SubPath)");
    console.log("instanceB:", handleB.instanceId);

    const healthB = await parseHealth(await handleB.request("/health"));
    const restored = healthB.restoreStatus?.restored;
    console.log("restoreStatus B:", JSON.stringify(healthB.restoreStatus ?? null, null, 2));

    const readRes = await handleB.request("/api/tools/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: proofPath }),
    });
    const readJson = await readRes.json().catch(async () => ({ raw: await readRes.text() }));
    const content =
      readJson.content ?? readJson.result?.content ?? readJson.raw ?? "";
    console.log("read back:", String(content).slice(0, 200));

    if (!String(content).includes(marker)) {
      throw new Error(
        `COS cross-instance restore failed: expected marker ${marker}, restored=${restored}`,
      );
    }
    console.log("\n✓ harness COS e2e: write → snapshot → stop → restore → read");
  } finally {
    if (handleB) {
      console.log("stopping instance B…");
      await handleB.stop();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
