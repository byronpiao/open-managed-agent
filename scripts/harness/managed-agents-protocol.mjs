#!/usr/bin/env node
/**
 * Managed Agents HTTP protocol — cloud acceptance on deployed harness agent.
 *
 *   npm run harness -- ma-protocol
 *   node scripts/harness/managed-agents-protocol.mjs --scenario ma-protocol-claude
 *   node scripts/harness/managed-agents-protocol.mjs --base-url https://...
 *
 * Scenarios:
 *   ma-protocol        → agent.ma-protocol.yaml + .env.ma-protocol
 *   ma-protocol-claude → agent.ma-protocol-claude.yaml + .env.ma-protocol-claude
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
  HARNESS_MA_PROTOCOL_SCENARIO,
  HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO,
} from "./load-env.mjs";
import { resolveHarnessAgentYaml } from "./scenario-matrix.mjs";
import {
  waitForEngineSessionId,
  waitForClaudeSessionEntries,
} from "./db-metrics.mjs";

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
  let scenario = HARNESS_MA_PROTOCOL_SCENARIO;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) baseUrl = args[++i];
    if (args[i] === "--scenario" && args[i + 1]) scenario = args[++i];
  }
  return { baseUrl, scenario };
}

function loadMaProtocolAgentSpec(scenario) {
  const yamlPath = resolveHarnessAgentYaml(scenario);
  const doc = parseYaml(readFileSync(yamlPath, "utf8"));
  const engine = doc.engine === "claude" || doc.engine === "codebuddy" || doc.engine === "hermes"
    ? doc.engine
    : "opencode";
  const system =
    typeof doc.system === "string" && doc.system.trim()
      ? doc.system.trim()
      : "Reply concisely for acceptance.";
  return { yamlPath, engine, system, scenario };
}

async function verifyClaudeStoreAfterMaPrompt(envId, acpSessionId, label) {
  const engineSessionId = await waitForEngineSessionId(envId, acpSessionId, 48);
  const entryCount = await waitForClaudeSessionEntries(engineSessionId, 1, 48);
  assert.ok(entryCount >= 1, `${label}: harness_claude_session_entries`);

  const { getHarnessSessionStore } = await import(
    join(repoRoot, "packages/agent-runtime/dist/harness/sandbox/session-store.js")
  );
  const row = await getHarnessSessionStore(envId).get(acpSessionId);
  assert.ok(row?.engineSessionId, `${label}: harness_sessions.engineSessionId`);
  assert.equal(row?.claudeStoreEmptyAt, undefined, `${label}: claudeStoreEmptyAt unset`);
  console.log(`✓ ${label} claude store: entries=${entryCount}`);
}

async function runStory(client, label, { engine, system }, envId) {
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

  if (engine === "claude") {
    await verifyClaudeStoreAfterMaPrompt(envId, session.id, label);
  }

  const deleted = await client.deleteSession(session.id);
  assert.equal(deleted.deleted, true, `${label}: deleteSession`);
  console.log(`✓ ${label} passed`);
}

async function main() {
  const { baseUrl: baseOverride, scenario } = parseArgs();
  if (
    scenario !== HARNESS_MA_PROTOCOL_SCENARIO &&
    scenario !== HARNESS_MA_PROTOCOL_CLAUDE_SCENARIO
  ) {
    throw new Error(`unsupported ma scenario: ${scenario}`);
  }

  loadEnv();
  assertHarnessCreds();
  await hydrateTcbApiKeyFromCam();

  const scenarioMeta = applyHarnessScenario(scenario);
  logHarnessScenario(scenarioMeta);

  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  const agentId = process.env.CLOUDBASE_AGENT_ID?.trim();
  if (!envId) throw new Error("CLOUDBASE_ENV_ID required");
  if (!agentId) {
    throw new Error(
      `HARNESS_MA_PROTOCOL_AGENT_ID required — cp scripts/harness/scenarios/.env.${scenario}.example scripts/harness/scenarios/.env.${scenario}`,
    );
  }

  const agentSpec = loadMaProtocolAgentSpec(scenario);
  console.log(`ma-protocol agent yaml: ${agentSpec.yamlPath} (engine=${agentSpec.engine})`);

  const token = await getAccessToken(envId);
  const { createManagedAgentsClient } = await import(
    join(repoRoot, "packages/sdk/dist/managed-agents-client.js")
  );

  const gatewayBase =
    baseOverride ?? `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}`;

  await runStory(
    createManagedAgentsClient({ envId, agentId, accessKey: token, baseURL: gatewayBase }),
    "gateway",
    agentSpec,
    envId,
  );

  console.log("\n✓ managed-agents-protocol complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
