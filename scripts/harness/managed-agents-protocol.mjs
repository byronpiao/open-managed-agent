#!/usr/bin/env node
/**
 * Managed Agents HTTP protocol — cloud acceptance on deployed harness agent.
 *
 *   npm run ma-protocol
 *   node scripts/harness/managed-agents-protocol.mjs --base-url https://...
 *
 * Scenario: scripts/harness/scenarios/agent.ma-protocol.yaml
 *           + scripts/harness/scenarios/.env.ma-protocol (HARNESS_MA_PROTOCOL_AGENT_ID)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  loadEnv,
  assertHarnessCreds,
  hydrateTcbApiKeyFromCam,
  applyHarnessScenario,
  logHarnessScenario,
} from "./load-env.mjs";
import { resolveHarnessAgentYaml } from "./scenario-matrix.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function getAccessToken(envId) {
  const { fetchGatewayAccessToken } = await import(
    join(repoRoot, "packages/agent-runtime/dist/harness/tcb-gateway-token.js")
  );
  return fetchGatewayAccessToken(envId);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let baseUrl;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) baseUrl = args[++i];
  }
  return { baseUrl };
}

function loadMaProtocolAgentSpec() {
  const yamlPath = resolveHarnessAgentYaml("ma-protocol");
  const doc = parseYaml(readFileSync(yamlPath, "utf8"));
  const engine = doc.engine === "claude" || doc.engine === "codebuddy" || doc.engine === "hermes"
    ? doc.engine
    : "opencode";
  const system =
    typeof doc.system === "string" && doc.system.trim()
      ? doc.system.trim()
      : "Reply concisely for acceptance.";
  return { yamlPath, engine, system };
}

async function runStory(client, label, { engine, system }) {
  console.log(`\n=== managed-agents-protocol: ${label} ===`);

  const environment = await client.createEnvironment({
    name: `${label}-env`,
    metadata: { engine },
  });
  assert.ok(environment.id, `${label}: environment`);

  const agent = await client.createAgent({
    name: `${label}-agent`,
    metadata: { system },
  });
  assert.ok(agent.id, `${label}: agent`);

  const session = await client.createSession({
    agentId: agent.id,
    environmentId: environment.id,
  });
  assert.ok(session.id, `${label}: session`);

  let sawOutbound = false;
  const ac = new AbortController();
  const streamTask = (async () => {
    for await (const record of client.streamSessionEvents(session.id, { signal: ac.signal })) {
      if (record.direction === "outbound") sawOutbound = true;
      if (record.event?.type === "session.status_idle") break;
    }
  })();

  await new Promise((r) => setTimeout(r, 100));

  const accepted = await client.sendSessionEvent(session.id, {
    type: "user.message",
    commandId: randomUUID(),
    requestId: randomUUID(),
    runId: randomUUID(),
    text: "Reply with exactly: MA_OK",
  });
  assert.equal(accepted.status, "accepted", `${label}: user.message`);

  await Promise.race([streamTask, new Promise((r) => setTimeout(r, 120_000))]);
  ac.abort();
  assert.ok(sawOutbound, `${label}: SSE outbound events`);

  const deleted = await client.deleteSession(session.id);
  assert.equal(deleted.deleted, true, `${label}: deleteSession`);
  console.log(`✓ ${label} passed`);
}

async function main() {
  loadEnv();
  assertHarnessCreds();
  await hydrateTcbApiKeyFromCam();

  const scenarioMeta = applyHarnessScenario("ma-protocol");
  logHarnessScenario(scenarioMeta);

  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  const agentId = process.env.CLOUDBASE_AGENT_ID?.trim();
  if (!envId) throw new Error("CLOUDBASE_ENV_ID required");
  if (!agentId) {
    throw new Error(
      "HARNESS_MA_PROTOCOL_AGENT_ID required — cp scripts/harness/scenarios/.env.ma-protocol.example scripts/harness/scenarios/.env.ma-protocol",
    );
  }

  const agentSpec = loadMaProtocolAgentSpec();
  console.log(`ma-protocol agent yaml: ${agentSpec.yamlPath} (engine=${agentSpec.engine})`);

  const token = await getAccessToken(envId);
  const { createManagedAgentsClient } = await import(
    join(repoRoot, "packages/sdk/dist/managed-agents-client.js")
  );

  const { baseUrl: baseOverride } = parseArgs();
  const gatewayBase =
    baseOverride ?? `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}`;

  await runStory(
    createManagedAgentsClient({ envId, agentId, accessKey: token, baseURL: gatewayBase }),
    "gateway",
    agentSpec,
  );

  console.log("\n✓ managed-agents-protocol complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
