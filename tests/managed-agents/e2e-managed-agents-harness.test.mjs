/**
 * Managed Agents HTTP e2e — full runtime + open-managed-agent-sdk over HTTP/SSE.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createManagedAgentsClient } from "../../packages/sdk/dist/managed-agents-client.js";
import {
  MANAGED_AGENTS_E2E_BASE,
  MANAGED_AGENTS_E2E_STUB_AGENT_CONFIG,
  startManagedAgentsE2eRuntime,
  stopManagedAgentsE2eRuntime,
} from "./managed-agents-e2e-runtime.mjs";

const { resetManagedAgentsStoreForTests } = await import(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../packages/agent-runtime/dist/managed-agents/store/managed-agents-store-factory.js",
  )
);
const { setManagedAgentsDeploymentConfig, resetManagedAgentsDeploymentConfigForTests } =
  await import("../../packages/agent-runtime/dist/managed-agents/deployment-config.js");
const { mergeManagedAgentsAgentConfig } = await import(
  "../../packages/agent-runtime/dist/managed-agents/resolve-session-agent-config.js",
);
const { resetHarnessSessionStoreForTests } = await import(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js",
  )
);
const { resetE2eStubSandboxForTests } = await import(
  join(dirname(fileURLToPath(import.meta.url)), "../../packages/agent-runtime/dist/harness/sandbox/e2e-stub.js")
);

const HITL_MARKER = "HITL_E2E";
const ACCESS_KEY = "e2e-token";

function makeClient(baseURL, label) {
  return createManagedAgentsClient({
    envId: "managed-agents-e2e",
    agentId: "e2e-bot",
    accessKey: ACCESS_KEY,
    baseURL,
  });
}

async function runQuickstart(client, label) {
  const environment = await client.createEnvironment({ name: `${label}-env` });
  assert.ok(environment.id, `${label}: environment id`);

  const agent = await client.createAgent({ name: `${label}-agent` });
  assert.ok(agent.id, `${label}: agent id`);

  const session = await client.createSession({
    agentId: agent.id,
    environmentId: environment.id,
  });
  assert.ok(session.id, `${label}: session id`);

  const retrieved = await client.getSession(session.id);
  assert.equal(retrieved.id, session.id, `${label}: getSession`);

  const agents = await client.listAgents();
  assert.ok(agents.some((a) => a.id === agent.id), `${label}: listAgents`);

  await runHitlViaSse(client, session.id, label);

  const deleted = await client.deleteSession(session.id);
  assert.equal(deleted.deleted, true, `${label}: deleteSession`);

  const events = await client.listSessionEvents(session.id);
  assert.ok(events.some((e) => e.direction === "inbound"), `${label}: listSessionEvents`);
}

async function runHitlViaSse(client, sessionId, label) {
  const state = {
    permissionRequestId: null,
    sawHitlOk: false,
    finished: false,
  };
  const ac = new AbortController();

  const streamTask = (async () => {
    for await (const record of client.streamSessionEvents(sessionId, { signal: ac.signal })) {
      if (record.direction !== "outbound") continue;
      const ev = record.event;
      if (ev?.type === "session.status_idle" && ev.requiresAction?.requestId) {
        state.permissionRequestId = ev.requiresAction.requestId;
      }
      const blob = JSON.stringify(ev ?? {});
      if (blob.includes("HITL_OK")) state.sawHitlOk = true;
      if (state.sawHitlOk && ev?.type === "session.status_idle") {
        state.finished = true;
        ac.abort();
        break;
      }
    }
  })();

  await sleep(80);

  const dispatch = await client.sendSessionEvent(sessionId, {
    type: "user.message",
    commandId: randomUUID(),
    requestId: randomUUID(),
    runId: randomUUID(),
    text: HITL_MARKER,
  });
  assert.equal(dispatch.status, "accepted", `${label}: user.message accepted`);

  for (let i = 0; i < 80 && !state.permissionRequestId; i++) {
    await sleep(50);
  }
  assert.ok(state.permissionRequestId, `${label}: permission via SSE`);

  const confirm = await client.sendSessionEvent(sessionId, {
    type: "user.tool_confirmation",
    commandId: randomUUID(),
    requestId: state.permissionRequestId,
    decision: "allow_once",
  });
  assert.equal(confirm.status, "accepted", `${label}: tool_confirmation accepted`);

  for (let i = 0; i < 80 && !state.sawHitlOk; i++) {
    await sleep(50);
  }
  assert.ok(state.sawHitlOk, `${label}: HITL_OK via SSE`);

  ac.abort();
  await Promise.race([streamTask.catch(() => {}), sleep(500)]);
}

resetManagedAgentsStoreForTests();
resetManagedAgentsDeploymentConfigForTests();
resetHarnessSessionStoreForTests();
resetE2eStubSandboxForTests();

setManagedAgentsDeploymentConfig(MANAGED_AGENTS_E2E_STUB_AGENT_CONFIG);

const merged = mergeManagedAgentsAgentConfig(
  MANAGED_AGENTS_E2E_STUB_AGENT_CONFIG,
  { id: "a1", name: "e2e-agent", metadata: { model: "stub", system: "e2e" }, createdAt: "", updatedAt: "" },
  { id: "e1", name: "e2e-env", metadata: { engine: "opencode" }, config: { type: "cloud", networking: { type: "unrestricted" }, packages: {} }, createdAt: "", updatedAt: "", archivedAt: null },
);
assert.equal(merged.engine, "opencode");
assert.equal(merged.model, "stub");

const { base } = await startManagedAgentsE2eRuntime({
  agentConfig: MANAGED_AGENTS_E2E_STUB_AGENT_CONFIG,
});

try {
  await runQuickstart(makeClient(base, "direct"), "direct");
  await runQuickstart(makeClient(`${base}/v1/aibot/bots/e2e-bot`, "gateway"), "gateway");

  console.log("managed agents harness e2e passed (ManagedAgentsClient → full runtime HTTP/SSE)");
} finally {
  await stopManagedAgentsE2eRuntime();
  resetE2eStubSandboxForTests();
}
