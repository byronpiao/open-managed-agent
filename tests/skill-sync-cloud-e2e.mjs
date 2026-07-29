/**
 * Cloud E2E: deploy full 8-scenario skills schema to SCF + TCBR, verify downloaded package.
 *
 * Run: npm run test:skills-cloud-e2e
 *
 * Requires:
 *   CLOUDBASE_APIKEY or CLOUDBASE_ACCESS_KEY in .env (magent login 亦可)
 *   SKILL_E2E_ENV_ID — 默认 lowcode-8gtybv2a87db84a3（TCBR 需 normal tenant）
 *   Network + CloudBase permissions
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";

import { downloadDeployedCode } from "../lib/skills-sync.mjs";
import { lookupAgent } from "../lib/cloudrun.mjs";
import {
  prepareSkillE2eWorkspace,
  loadSkillsFromAgentYaml,
  assertFullSchemaDeployed,
  requireCloudCredentials,
  runMagent,
  extractAgentId,
  deleteAgent,
} from "./skill-e2e-lib.mjs";

const DOWNLOAD_ROOT = join("/tmp", "oma-skill-cloud-e2e-download");

function agentName(agentType) {
  const tag = Date.now().toString(36).slice(-5);
  return agentType === "scf" ? `sk-scf-${tag}` : `sk-tcb-${tag}`;
}

async function verifyCloudAgentSkills({
  envId,
  apiKey,
  agentId,
  agentType,
  serviceId,
}) {
  const destDir = join(DOWNLOAD_ROOT, `${agentType}-${agentId}`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  await downloadDeployedCode(envId, agentType, destDir, { agentId, serviceId });
  return assertFullSchemaDeployed(destDir, { minBundleSkills: 1 });
}

async function runCloudSkillE2e(agentType) {
  const creds = requireCloudCredentials({ cloud: true });
  if (!creds) {
    console.log("  skip: set CLOUDBASE_APIKEY or CLOUDBASE_ACCESS_KEY in .env");
    return;
  }
  const { envId, apiKey } = creds;
  console.log(`  env: ${envId} (${agentType})`);
  const name = agentName(agentType);
  const { workspaceDir, agentYaml } = prepareSkillE2eWorkspace(
    join("/tmp", `oma-skill-cloud-ws-${agentType}-${Date.now()}`),
  );
  const skills = loadSkillsFromAgentYaml(agentYaml);
  assert.equal(skills.length, 8);

  let agentId = "";
  try {
    const createOut = runMagent(
      `agent:create --type ${agentType} -n ${name} -f "${agentYaml}" -e ${envId}`,
      { envId, apiKey, timeoutMs: 900_000 },
    );
    agentId = extractAgentId(createOut);
    assert.ok(agentId, `no agent id in create output for ${agentType}`);

    const { agentType: resolvedType, serviceId } = await lookupAgent(envId, agentId);
    assert.equal(resolvedType, agentType);
    if (agentType === "tcbr") assert.ok(serviceId, "tcbr missing serviceId");

    const { names } = await verifyCloudAgentSkills({
      envId,
      apiKey,
      agentId,
      agentType,
      serviceId,
    });

    assert.ok(names.length >= 8, `expected ≥8 skills on ${agentType}, got ${names.length}`);
    console.log(`  ✓ ${agentType} ${agentId}: ${names.length} skills verified`);
  } finally {
    if (agentId) deleteAgent(agentId, { envId, apiKey });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

test("cloud SCF: full skills schema deploy + download verify", async (t) => {
  if (!requireCloudCredentials({ cloud: true })) {
    t.skip("API key required (CLOUDBASE_APIKEY or CLOUDBASE_ACCESS_KEY)");
  }
  await runCloudSkillE2e("scf");
}, { timeout: 900_000 });

test("cloud TCBR: full skills schema deploy + download verify", async (t) => {
  if (!requireCloudCredentials({ cloud: true })) {
    t.skip("API key required (CLOUDBASE_APIKEY or CLOUDBASE_ACCESS_KEY)");
  }
  await runCloudSkillE2e("tcbr");
}, { timeout: 900_000 });
