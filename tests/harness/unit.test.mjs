/**
 * Harness runtime unit tests (no network).
 * Run: npm test
 */

import { strict as assert } from "node:assert";
import {
  resolveRuntime,
  engineToDataPlaneSlug,
  harnessToolNameForEnv,
  buildHarnessInstanceEnv,
} from "../../packages/agent-runtime/dist/config.js";
import {
  buildHarnessAcpMcpServers,
  buildHarnessSandboxEnv,
  buildHarnessOpencodeConfigContent,
  buildManagedAgentClientMcpUrl,
  buildMcporterConfig,
  buildSandboxReachableClientMcpUrl,
  isLoopbackHarnessCallback,
  MANAGED_AGENT_CLIENT_MCP_SERVER,
  SANDBOX_TRW_MCP_RELAY_PATH,
  buildHarnessInitCredEnv,
  buildSkillsManifestEnv,
  normalizeAgentRuntime,
  applyHarnessRuntimeEnv,
  HARNESS_PUBLIC_MAGENT_IMAGE,
  deliverClientToolResult,
  invokeClientToolFromSandbox,
  registerActivePrompt,
  resetClientToolBridgeForTests,
  getHarnessSyncEventStore,
  resetHarnessSyncEventStoreForTests,
  exportOpencodeSyncEvents,
  hydrateOpencodeSyncEvents,
  resolveHarnessSandboxIdlePauseMs,
  resetSandboxPrewarmForTests,
} from "../../packages/agent-runtime/dist/harness/index.js";
import {
  buildCosMountOptions,
  buildCosStorageMounts,
  cosObjectKeyForSubPath,
  harnessCosToolNameForEnv,
  resolveHarnessCosConfig,
} from "../../packages/agent-runtime/dist/harness/sandbox/cos-mount.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("resolveRuntime defaults managed", () => {
  assert.deepEqual(resolveRuntime({ name: "x", model: "m", system: "s" }), {
    runtime: "managed",
    engine: "opencode",
  });
});

test("resolveRuntime harness + engine", () => {
  assert.deepEqual(
    resolveRuntime({
      name: "x",
      model: "m",
      system: "s",
      runtime: "harness",
      engine: "claude",
    }),
    { runtime: "harness", engine: "claude" },
  );
});

test("engineToDataPlaneSlug maps claude → claudecode", () => {
  assert.equal(engineToDataPlaneSlug("claude"), "claudecode");
  assert.equal(engineToDataPlaneSlug("codebuddy"), "codebuddy");
  assert.equal(engineToDataPlaneSlug("opencode"), "opencode");
});

test("harnessToolNameForEnv uses harness- prefix", () => {
  assert.equal(harnessToolNameForEnv("test-6g2rfs50c69b7fb8"), "harness-test-6g2rfs50c69b7fb8");
});

test("buildManagedAgentClientMcpUrl embeds acpSessionId query param", () => {
  const sid = "550e8400-e29b-41d4-a716-446655440000";
  const url = buildManagedAgentClientMcpUrl("https://gw.example.com", sid);
  assert.ok(url.includes("sessionId=550e8400-e29b-41d4-a716-446655440000"));
});

test("isLoopbackHarnessCallback detects localhost", () => {
  assert.equal(isLoopbackHarnessCallback("http://127.0.0.1:9000"), true);
  assert.equal(isLoopbackHarnessCallback("https://gw.example.com"), false);
});

test("buildSandboxReachableClientMcpUrl uses TRW relay for loopback", () => {
  const sid = "550e8400-e29b-41d4-a716-446655440000";
  const url = buildSandboxReachableClientMcpUrl("http://127.0.0.1:19090", sid);
  assert.ok(url.includes(SANDBOX_TRW_MCP_RELAY_PATH));
  assert.ok(url.includes(sid));
});

test("buildHarnessAcpMcpServers returns http MCP for custom tools", () => {
  const sid = "550e8400-e29b-41d4-a716-446655440000";
  const servers = buildHarnessAcpMcpServers({
    config: {
      name: "t",
      model: "m",
      system: "s",
      tools: [
        {
          type: "custom",
          name: "my_tool",
          description: "d",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
    clientToolCallbackBase: "http://127.0.0.1:9000",
    acpSessionId: sid,
  });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].type, "http");
  assert.equal(servers[0].name, MANAGED_AGENT_CLIENT_MCP_SERVER);
  assert.ok(servers[0].url.includes(SANDBOX_TRW_MCP_RELAY_PATH));
});

test("buildHarnessOpencodeConfigContent ignores model.apiBaseUrl (OpenAI from env only)", () => {
  const cfg = {
    name: "x",
    model: {
      id: "mimo-v2.5-pro",
      apiKey: "tp-test",
      apiBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    },
    system: "s",
    runtime: "harness",
    engine: "opencode",
  };
  assert.equal(buildHarnessOpencodeConfigContent(cfg), null);
});

test("buildHarnessOpencodeConfigContent uses LLM_* + OPENAI_BASE_URL", () => {
  const saved = {
    key: process.env.LLM_API_KEY,
    url: process.env.OPENAI_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "https://example.com/v1";
  process.env.LLM_MODEL = "hunyuan-t1-latest";
  const raw = buildHarnessOpencodeConfigContent({
    name: "t",
    model: "ignored",
    system: "s",
  });
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.provider["openai-compat"].options.apiKey, "sk-test");
  assert.ok(parsed.model.includes("hunyuan-t1-latest"));
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("buildHarnessSandboxEnv injects OPENCODE_CONFIG_CONTENT from LLM_* + OPENAI_BASE_URL", () => {
  const saved = {
    key: process.env.LLM_API_KEY,
    url: process.env.OPENAI_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "https://example.com/v1";
  process.env.LLM_MODEL = "hunyuan-t1-latest";
  const sid = "550e8400-e29b-41d4-a716-446655440000";
  const env = buildHarnessSandboxEnv({
    config: { name: "t", model: "hunyuan-t1-latest", system: "s" },
    engine: "opencode",
    clientToolCallbackBase: "http://127.0.0.1:19090",
    acpSessionId: sid,
  });
  const oc = env.find((e) => e.Name === "OPENCODE_CONFIG_CONTENT");
  assert.ok(oc);
  assert.ok(JSON.parse(oc.Value).model.includes("hunyuan-t1-latest"));
  assert.ok(env.some((e) => e.Name === "HARNESS_RUNTIME_CALLBACK_URL"));
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("buildHarnessSandboxEnv binds session to mcporter URL and env", () => {
  const sid = "550e8400-e29b-41d4-a716-446655440000";
  const env = buildHarnessSandboxEnv({
    config: {
      name: "t",
      model: "m",
      system: "s",
      tools: [
        {
          type: "custom",
          name: "my_tool",
          description: "d",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
    engine: "opencode",
    clientToolCallbackBase: "http://127.0.0.1:19090",
    acpSessionId: sid,
  });
  const mcporter = env.find((e) => e.Name === "MCPORTER_CONFIG_CONTENT");
  assert.ok(mcporter);
  const parsed = JSON.parse(mcporter.Value);
  const mcpUrl = parsed.mcpServers[MANAGED_AGENT_CLIENT_MCP_SERVER].url;
  assert.ok(mcpUrl.includes(sid));
  assert.ok(mcpUrl.includes(SANDBOX_TRW_MCP_RELAY_PATH));
  assert.ok(env.some((e) => e.Name === "HARNESS_ACP_SESSION_ID" && e.Value === sid));
  assert.ok(env.some((e) => e.Name === "HARNESS_CLIENT_TOOLS_JSON"));
});

test("normalizeAgentRuntime sets harness + engine from CLI args", () => {
  const cfg = normalizeAgentRuntime(
    { name: "t", model: "m", system: "s" },
    { runtime: "harness", engine: "claude" },
  );
  assert.equal(cfg.runtime, "harness");
  assert.equal(cfg.engine, "claude");
});

test("applyHarnessRuntimeEnv writes mcporter for custom tools", () => {
  const env = applyHarnessRuntimeEnv(
    {},
    {
      name: "t",
      model: "m",
      system: "s",
      runtime: "harness",
      engine: "opencode",
      tools: [
        {
          type: "custom",
          name: "my_tool",
          description: "d",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
    { clientToolCallbackBase: "https://gw.example.com", sandboxImage: HARNESS_PUBLIC_MAGENT_IMAGE },
  );
  assert.ok(env.MCPORTER_CONFIG_CONTENT);
  assert.equal(env.HARNESS_SANDBOX_IMAGE, HARNESS_PUBLIC_MAGENT_IMAGE);
});

test("buildMcporterConfig adds managed-agent-client for custom tools", () => {
  const cfg = buildMcporterConfig({
    config: {
      name: "t",
      model: "m",
      system: "s",
      tools: [
        {
          type: "custom",
          name: "my_tool",
          description: "d",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
    clientToolCallbackBase: "https://gw.example.com",
  });
  assert.ok(cfg.mcpServers[MANAGED_AGENT_CLIENT_MCP_SERVER]);
  assert.equal(
    cfg.mcpServers[MANAGED_AGENT_CLIENT_MCP_SERVER].url,
    buildManagedAgentClientMcpUrl("https://gw.example.com"),
  );
});

test("buildMcporterConfig merges agent.yaml mcp_servers url entries", () => {
  const cfg = buildMcporterConfig({
    config: {
      name: "t",
      model: "m",
      system: "s",
      mcp_servers: [
        {
          type: "url",
          name: "fixture_http",
          url: "http://127.0.0.1:9000/mcp",
        },
      ],
    },
    clientToolCallbackBase: "https://gw.example.com",
  });
  assert.equal(cfg.mcpServers.fixture_http.type, "streamable-http");
  assert.equal(cfg.mcpServers.fixture_http.url, "http://127.0.0.1:9000/mcp");
});

test("buildHarnessInitCredEnv maps TCB secrets", () => {
  const prev = {
    CLOUDBASE_ENV_ID: process.env.CLOUDBASE_ENV_ID,
    TCB_SECRET_ID: process.env.TCB_SECRET_ID,
    TCB_SECRET_KEY: process.env.TCB_SECRET_KEY,
  };
  process.env.CLOUDBASE_ENV_ID = "env-test";
  process.env.TCB_SECRET_ID = "sid";
  process.env.TCB_SECRET_KEY = "skey";
  const env = buildHarnessInitCredEnv();
  assert.ok(env.some((e) => e.Name === "TENCENTCLOUD_SECRETID" && e.Value === "sid"));
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("buildSkillsManifestEnv packs skill files", () => {
  const dir = join(tmpdir(), `oma-skills-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const skillPath = join(dir, "demo.md");
  writeFileSync(skillPath, "# demo skill\n");
  const env = buildSkillsManifestEnv(
    {
      name: "t",
      model: "m",
      system: "s",
      skills: [{ name: "demo", source: skillPath }],
    },
    dir,
  );
  assert.ok(env);
  const parsed = JSON.parse(env.Value);
  assert.equal(parsed[0].name, "demo");
  assert.ok(parsed[0].content.includes("demo skill"));
  rmSync(dir, { recursive: true, force: true });
});

test("sandbox permission_request SSE is relayed verbatim", () => {
  const frames = [];
  const payload = {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "permission_request",
        toolName: "bash",
        options: [{ optionId: "allow", name: "Allow" }],
      },
    },
  };
  frames.push(payload);
  assert.equal(frames[0].params.update.sessionUpdate, "permission_request");
});

test("client tool bridge deliver round-trip", async () => {
  resetClientToolBridgeForTests();
  const frames = [];
  registerActivePrompt("sess-1", (f) => frames.push(f));

  const pending = invokeClientToolFromSandbox({
    acpSessionId: "sess-1",
    toolName: "my_tool",
    input: { q: 1 },
  });

  assert.equal(frames.length, 1);
  const update = frames[0].params.update;
  assert.equal(update.sessionUpdate, "tool_use_request");
  assert.equal(update.toolName, "my_tool");

  const ok = deliverClientToolResult({
    acpSessionId: "sess-1",
    toolUseId: update.toolCallId,
    content: "done",
  });
  assert.equal(ok, true);
  const result = await pending;
  assert.equal(result.content, "done");
  assert.equal(result.isError, false);
});

test("buildHarnessSandboxEnv maps LLM_* + OPENAI_BASE_URL for codebuddy engine", () => {
  const saved = {
    key: process.env.LLM_API_KEY,
    url: process.env.OPENAI_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_API_KEY = "sk-cb";
  process.env.OPENAI_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_MODEL = "deepseek-v4-pro";
  const env = buildHarnessSandboxEnv({
    config: { name: "t", model: "deepseek-v4-pro", system: "s" },
    engine: "codebuddy",
    clientToolCallbackBase: "http://127.0.0.1:19090",
  });
  const names = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(names.CODEBUDDY_API_KEY, "sk-cb");
  assert.equal(names.CODEBUDDY_BASE_URL, "https://api.deepseek.com");
  assert.equal(names.CODEBUDDY_MODEL, "deepseek-v4-pro");
  assert.equal(names.CODEBUDDY_INTERNET_ENVIRONMENT, undefined);
  assert.equal(names.OPENCODE_CONFIG_CONTENT, undefined);
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("buildHarnessSandboxEnv maps LLM_* + ANTHROPIC_BASE_URL for claude engine", () => {
  const saved = {
    key: process.env.LLM_API_KEY,
    url: process.env.ANTHROPIC_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_API_KEY = "sk-ant";
  process.env.ANTHROPIC_BASE_URL = "https://example.com/v1";
  process.env.LLM_MODEL = "hy3-preview";
  const env = buildHarnessSandboxEnv({
    config: { name: "t", model: "hy3-preview", system: "s" },
    engine: "claude",
    clientToolCallbackBase: "http://127.0.0.1:19090",
  });
  const names = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(names.ANTHROPIC_AUTH_TOKEN, "sk-ant");
  assert.equal(names.ANTHROPIC_BASE_URL, "https://example.com");
  assert.equal(names.ANTHROPIC_MODEL, "hy3-preview");
  assert.equal(names.OPENCODE_CONFIG_CONTENT, undefined);
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("buildHarnessInstanceEnv enables opencode serve for sync persistence", () => {
  const env = buildHarnessInstanceEnv(
    { name: "t", model: "m", system: "s" },
    "opencode",
  );
  const names = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(names.ENABLE_AGENT_OPENCODE, "true");
  assert.equal(names.ENABLE_AGENT_OPENCODE_ACP, "true");
  assert.equal(names.ENABLE_AGENT_OPENCODE_SERVE, "true");
});

test("harness sync event store append + hydrate round-trip", async () => {
  process.env.OAK_USE_MEMORY_STORE = "1";
  resetHarnessSyncEventStoreForTests();
  const store = getHarnessSyncEventStore("test-env");
  const aggregateId = "550e8400-e29b-41d4-a716-446655440000";
  const events = [
    {
      id: "ev-1",
      aggregate_id: aggregateId,
      seq: 1,
      type: "session.created",
      data: { sessionID: aggregateId },
    },
    {
      id: "ev-2",
      aggregate_id: aggregateId,
      seq: 2,
      type: "session.updated",
      data: { title: "t" },
    },
  ];
  const calls = [];
  const handle = {
    instanceId: "i",
    toolId: "t",
    baseUrl: "http://127.0.0.1:1",
    headers: {},
    async request(path, init) {
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ path, body });
      if (path.endsWith("/health")) {
        return new Response(
          JSON.stringify({ ok: true, acpReady: true, serveReady: true }),
          { status: 200 },
        );
      }
      if (path.endsWith("/sync/start") || path.endsWith("/sync/steal")) {
        return new Response(JSON.stringify(true), { status: 200 });
      }
      if (path.endsWith("/sync/history")) {
        return new Response(JSON.stringify(events), { status: 200 });
      }
      if (path.endsWith("/sync/replay")) {
        return new Response(JSON.stringify({ sessionID: aggregateId }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
    async stop() {},
    async pause() {},
    async resumeIfPaused() {},
  };
  const { inserted } = await exportOpencodeSyncEvents({
    handle,
    syncStore: store,
    acpSessionId: "acp-1",
    aggregateId,
  });
  assert.equal(inserted, 2);
  const { replayed } = await hydrateOpencodeSyncEvents({
    handle,
    syncStore: store,
    acpSessionId: "acp-1",
    aggregateId,
  });
  assert.equal(replayed, 2);
  assert.ok(calls.some((c) => c.path.endsWith("/sync/replay")));
  delete process.env.OAK_USE_MEMORY_STORE;
  resetHarnessSyncEventStoreForTests();
});

test("harnessCosToolNameForEnv prefix", () => {
  assert.equal(harnessCosToolNameForEnv("test-6g2rfs50c69b7fb8"), "harness-cos-test-6g2rfs50c69b7fb8");
});

test("resolveHarnessCosConfig returns null when disabled", () => {
  const prev = process.env.HARNESS_COS_ENABLED;
  delete process.env.HARNESS_COS_ENABLED;
  assert.equal(resolveHarnessCosConfig(), null);
  if (prev) process.env.HARNESS_COS_ENABLED = prev;
});

test("buildCosStorageMounts and mount options", () => {
  process.env.HARNESS_COS_ENABLED = "1";
  process.env.HARNESS_COS_BUCKET = "b";
  process.env.HARNESS_COS_BUCKET_PATH = "/test-sync-out";
  process.env.HARNESS_COS_ENDPOINT = "b.cos.ap-shanghai.myqcloud.com";
  process.env.HARNESS_COS_REGION = "ap-shanghai";
  process.env.HARNESS_COS_MOUNT_NAME = "cos-mount";
  process.env.HARNESS_COS_MOUNT_DIR = "/mnt/workspace";
  const cos = resolveHarnessCosConfig({
    subPathOverride: "inst-1",
    secretMasterKey: "test-secret",
  });
  assert.ok(cos);
  const mounts = buildCosStorageMounts(cos);
  assert.equal(mounts[0].Name, "cos-mount");
  assert.deepEqual(buildCosMountOptions(cos), [{ Name: "cos-mount", SubPath: "inst-1" }]);
  assert.equal(cosObjectKeyForSubPath(cos), "test-sync-out/inst-1/.keep");
  for (const k of [
    "HARNESS_COS_ENABLED",
    "HARNESS_COS_BUCKET",
    "HARNESS_COS_BUCKET_PATH",
    "HARNESS_COS_ENDPOINT",
    "HARNESS_COS_REGION",
    "HARNESS_COS_MOUNT_NAME",
    "HARNESS_COS_MOUNT_DIR",
  ]) {
    delete process.env[k];
  }
});

test("resolveHarnessSandboxIdlePauseMs defaults to 20 minutes", () => {
  resetSandboxPrewarmForTests();
  const prev = process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS;
  delete process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS;
  assert.equal(resolveHarnessSandboxIdlePauseMs(), 20 * 60 * 1000);
  process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS = "0";
  assert.equal(resolveHarnessSandboxIdlePauseMs(), 0);
  process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS = "60000";
  assert.equal(resolveHarnessSandboxIdlePauseMs(), 60000);
  if (prev === undefined) delete process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS;
  else process.env.HARNESS_SANDBOX_IDLE_PAUSE_MS = prev;
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}
process.exit(failed ? 1 : 0);
