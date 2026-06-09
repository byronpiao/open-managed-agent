#!/usr/bin/env node
/**
 * Managed Agents HTTP protocol — cloud acceptance on deployed harness agent.
 *
 *   node scripts/harness/managed-agents-protocol.mjs
 *   node scripts/harness/managed-agents-protocol.mjs --base-url https://...
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, assertHarnessCreds, hydrateTcbApiKeyFromCam } from "./load-env.mjs";

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

async function runStory(client, label) {
  console.log(`\n=== managed-agents-protocol: ${label} ===`);

  const environment = await client.createEnvironment({
    name: `${label}-env`,
    metadata: { engine: "opencode" },
  });
  assert.ok(environment.id, `${label}: environment`);

  const agent = await client.createAgent({
    name: `${label}-agent`,
    metadata: { system: "Reply concisely for acceptance." },
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

  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  const agentId =
    process.env.HARNESS_CLOUD_AGENT_ID?.trim() ?? process.env.CLOUDBASE_AGENT_ID?.trim();
  if (!envId) throw new Error("CLOUDBASE_ENV_ID required");
  if (!agentId) {
    throw new Error("HARNESS_CLOUD_AGENT_ID or CLOUDBASE_AGENT_ID required (harness deployment)");
  }

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
  );

  console.log("\n✓ managed-agents-protocol complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
