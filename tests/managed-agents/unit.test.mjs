/**
 * Managed Agents vendor golden fixtures + memory store smoke.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeDist = join(root, "packages/agent-runtime/dist/managed-agents/index.js");

process.env.OAK_USE_MEMORY_STORE = "1";

const {
  projectCmaInboundToDriverCommand,
  createCmaMemoryStore,
  createCmaHttpHandler,
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  mergeManagedAgentsAgentConfig,
  setManagedAgentsDeploymentConfig,
} = await import(runtimeDist);

const fixturesDir = join(root, "tests/fixtures/cma");
const userMessage = JSON.parse(readFileSync(join(fixturesDir, "user-message.json"), "utf8"));
const inputStart = JSON.parse(readFileSync(join(fixturesDir, "input-start.json"), "utf8"));

assert.deepEqual(projectCmaInboundToDriverCommand(userMessage), inputStart);

const baseYaml = {
  name: "deployed",
  model: "hy3-preview",
  system: "base",
  runtime: "harness",
  engine: "opencode",
};
setManagedAgentsDeploymentConfig(baseYaml);
const merged = mergeManagedAgentsAgentConfig(
  baseYaml,
  {
    id: "agent-1",
    name: "Reviewer",
    metadata: { model: "custom-model", system: "review strictly" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "env-1",
    name: "claude-box",
    metadata: { engine: "claude" },
    config: { type: "cloud", networking: { type: "unrestricted" }, packages: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  },
);
assert.equal(merged.engine, "claude");
assert.equal(merged.model, "custom-model");
assert.equal(merged.system, "review strictly");
assert.equal(merged.name, "Reviewer");

const authHeaders = {
  authorization: "Bearer test-token",
  [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
};

const store = createCmaMemoryStore();
const dispatched = [];
const handler = createCmaHttpHandler({
  store,
  betaHeader: {
    name: CMA_DEFAULT_BETA_HEADER_NAME,
    value: CMA_DEFAULT_BETA_HEADER_VALUE,
  },
  authorize: ({ request }) => {
    const auth = request.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) return;
    return new Response(
      JSON.stringify({ error: { code: "CMA_UNAUTHORIZED", message: "Authorization required." } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  },
  dispatchDriverCommand: async (input) => {
    dispatched.push(input.command.kind);
    return { requestId: input.command.requestId ?? "req-1" };
  },
});

const env = await handler(
  new Request("https://test/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ name: "Main" }),
  }),
);
assert.equal(env.status, 201);

const agent = await handler(
  new Request("https://test/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ name: "Reviewer" }),
  }),
);
assert.equal(agent.status, 201);
const agentJson = await agent.json();
const agentId = agentJson.data.id;

const session = await handler(
  new Request("https://test/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ agentId }),
  }),
);
assert.equal(session.status, 201);
const sessionJson = await session.json();
const sessionId = sessionJson.data.id;

const eventRes = await handler(
  new Request(`https://test/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(userMessage),
  }),
);
assert.equal(eventRes.status, 202);
assert.deepEqual(dispatched, ["input.start"]);

const missingAuth = await handler(
  new Request("https://test/v1/agents", {
    headers: { [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE },
  }),
);
assert.equal(missingAuth.status, 401);

const missingBeta = await handler(
  new Request("https://test/v1/agents", {
    headers: { authorization: "Bearer test-token" },
  }),
);
assert.equal(missingBeta.status, 400);

console.log("managed agents unit tests passed");
