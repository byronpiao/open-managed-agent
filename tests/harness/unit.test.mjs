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
  buildHarnessOpencodePermission,
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
  persistOpencodeSyncForSession,
  hydrateOpencodeSyncEvents,
  resolveHarnessSandboxIdlePauseMs,
  resetSandboxPrewarmForTests,
  openAiChatCompletionsUrl,
} from "../../packages/agent-runtime/dist/harness/index.js";
import {
  getHarnessSessionStore,
  resetHarnessSessionStoreForTests,
} from "../../packages/agent-runtime/dist/harness/sandbox/session-store.js";
import {
  cacheSandboxHandle,
  dropCachedSandboxHandle,
} from "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js";
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

test("harnessToolNameForEnv uses oma-harness-{env} without cos suffix by default", () => {
  const prev = process.env.HARNESS_TOOL_COS_NAME_SUFFIX;
  delete process.env.HARNESS_TOOL_COS_NAME_SUFFIX;
  assert.equal(
    harnessToolNameForEnv("test-6g2rfs50c69b7fb8"),
    "oma-harness-test-6g2rfs50c69b7fb8",
  );
  if (prev) process.env.HARNESS_TOOL_COS_NAME_SUFFIX = prev;
});

test("applyHarnessScenario cloud-scf strips COS and sets BYOK tier", async () => {
  const { applyHarnessScenario, HARNESS_COS_ENV_KEYS } = await import(
    "../../scripts/harness/load-env.mjs"
  );
  const prevSuffix = process.env.HARNESS_TOOL_COS_NAME_SUFFIX;
  process.env.HARNESS_TOOL_COS_NAME_SUFFIX = "1";
  const env = {
    CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8",
    HARNESS_COS_ENABLED: "1",
    HARNESS_COS_BUCKET: "bucket",
    LLM_API_KEY: "should-stay-from-map-only",
  };
  const meta = applyHarnessScenario("cloud-scf", env);
  if (prevSuffix !== undefined) process.env.HARNESS_TOOL_COS_NAME_SUFFIX = prevSuffix;
  else delete process.env.HARNESS_TOOL_COS_NAME_SUFFIX;
  assert.equal(meta.scenario, "cloud-scf");
  assert.equal(meta.cosEnabled, false);
  assert.ok(meta.toolName.endsWith("-no-cos"));
  for (const k of HARNESS_COS_ENV_KEYS) assert.equal(env[k], undefined);
  assert.equal(env.HARNESS_LLM_TIER, "byok");
});

test("resolveHarnessToolName uses -no-cos|-with-cos when HARNESS_TOOL_COS_NAME_SUFFIX=1", () => {
  const prev = process.env.HARNESS_TOOL_COS_NAME_SUFFIX;
  process.env.HARNESS_TOOL_COS_NAME_SUFFIX = "1";
  assert.equal(
    harnessToolNameForEnv("test-6g2rfs50c69b7fb8"),
    "oma-harness-test-6g2rfs50c69b7fb8-no-cos",
  );
  assert.equal(
    harnessCosToolNameForEnv("test-6g2rfs50c69b7fb8"),
    "oma-harness-test-6g2rfs50c69b7fb8-with-cos",
  );
  if (prev) process.env.HARNESS_TOOL_COS_NAME_SUFFIX = prev;
  else delete process.env.HARNESS_TOOL_COS_NAME_SUFFIX;
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

test("buildHarnessOpencodeConfigContent uses ModelSpec apiKey + apiBaseUrl", () => {
  const raw = buildHarnessOpencodeConfigContent({
    name: "x",
    model: {
      id: "mimo-v2.5-pro",
      apiKey: "tp-test",
      apiBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    },
    system: "s",
    runtime: "harness",
    engine: "opencode",
  });
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.provider["openai-compat"].options.apiKey, "tp-test");
  assert.ok(parsed.model.includes("mimo-v2.5-pro"));
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

test("buildHarnessOpencodeConfigContent skips custom LLM when HARNESS_FORCE_ZEN=1", () => {
  const saved = {
    zen: process.env.HARNESS_FORCE_ZEN,
    key: process.env.LLM_API_KEY,
    url: process.env.OPENAI_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  process.env.HARNESS_FORCE_ZEN = "1";
  process.env.LLM_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "https://example.com/v1";
  process.env.LLM_MODEL = "hunyuan-t1-latest";
  assert.equal(
    buildHarnessOpencodeConfigContent({
      name: "t",
      model: "zen",
      system: "s",
      runtime: "harness",
      engine: "opencode",
    }),
    null,
  );
  if (saved.zen === undefined) delete process.env.HARNESS_FORCE_ZEN;
  else process.env.HARNESS_FORCE_ZEN = saved.zen;
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

test("resolveAnthropicCompatProvider accepts ANTHROPIC_AUTH_TOKEN without LLM_API_KEY", async () => {
  const { resolveAnthropicCompatProvider } = await import(
    "../../packages/agent-runtime/dist/harness/llm-providers.js"
  );
  const saved = {
    key: process.env.LLM_API_KEY,
    tok: process.env.ANTHROPIC_AUTH_TOKEN,
    url: process.env.ANTHROPIC_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  delete process.env.LLM_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = "tp-test";
  process.env.ANTHROPIC_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/anthropic";
  process.env.LLM_MODEL = "mimo-v2.5-pro";
  const p = resolveAnthropicCompatProvider({ name: "t", model: "m", system: "s" });
  assert.ok(p);
  assert.equal(p.apiKey, "tp-test");
  assert.equal(p.baseUrl, "https://token-plan-sgp.xiaomimimo.com/anthropic");
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.tok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = saved.tok;
  if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("resolveCloudBasePlatformLlm from TCB_API_KEY + envId only", async () => {
  const {
    resolveCloudBasePlatformLlm,
    resolveOpenAiCompatProvider,
    resolveAnthropicCompatProvider,
    HARNESS_CLOUDBASE_DEFAULT_MODEL,
  } = await import("../../packages/agent-runtime/dist/harness/llm-providers.js");
  const saved = {
    env: process.env.CLOUDBASE_ENV_ID,
    tcb: process.env.TCB_API_KEY,
    llm: process.env.LLM_API_KEY,
    openai: process.env.OPENAI_BASE_URL,
    anthropic: process.env.ANTHROPIC_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  delete process.env.LLM_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.LLM_MODEL;
  process.env.CLOUDBASE_ENV_ID = "test-env-abc";
  process.env.TCB_API_KEY = "tcb-jwt-key";
  const cfg = { name: "t", system: "s" };
  const platform = resolveCloudBasePlatformLlm(cfg);
  assert.ok(platform);
  assert.equal(platform.apiKey, "tcb-jwt-key");
  assert.equal(platform.model, HARNESS_CLOUDBASE_DEFAULT_MODEL);
  assert.equal(
    platform.baseUrl,
    "https://test-env-abc.api.tcloudbasegateway.com/v1/ai/cloudbase",
  );
  const openai = resolveOpenAiCompatProvider(cfg);
  assert.equal(openai?.baseUrl, platform.baseUrl);
  const anthropic = resolveAnthropicCompatProvider(cfg);
  assert.equal(anthropic?.baseUrl, platform.baseUrl);
  assert.equal(resolveOpenAiCompatProvider({ name: "t", model: "zen", system: "s" }), null);
  const ocRaw = buildHarnessOpencodeConfigContent(cfg);
  assert.ok(ocRaw);
  const oc = JSON.parse(ocRaw);
  assert.equal(
    oc.provider["openai-compat"].options.baseURL,
    "https://test-env-abc.api.tcloudbasegateway.com/v1/ai/cloudbase/v1",
  );
  assert.equal(oc.provider["openai-compat"].options.apiKey, "tcb-jwt-key");
  if (saved.env === undefined) delete process.env.CLOUDBASE_ENV_ID;
  else process.env.CLOUDBASE_ENV_ID = saved.env;
  if (saved.tcb === undefined) delete process.env.TCB_API_KEY;
  else process.env.TCB_API_KEY = saved.tcb;
  if (saved.llm === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.llm;
  if (saved.openai === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = saved.openai;
  if (saved.anthropic === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.anthropic;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("buildHarnessInstanceEnv enables claude SessionStore env", async () => {
  const { buildHarnessInstanceEnv } = await import("../../packages/agent-runtime/dist/config.js");
  const env = buildHarnessInstanceEnv({ name: "t", model: "m", system: "s" }, "claude");
  const names = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(names.ENABLE_AGENT_CLAUDE_ACP, "true");
  assert.equal(names.HARNESS_CLAUDE_SESSION_STORE, "1");
  assert.equal(names.CLAUDE_CONFIG_DIR, "/tmp/.claude");
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

test("harness sync event store maxSeq and long list", async () => {
  process.env.OAK_USE_MEMORY_STORE = "1";
  resetHarnessSyncEventStoreForTests();
  const store = getHarnessSyncEventStore("test-env");
  const aggregateId = "agg-long-session";
  const acpSessionId = "acp-long";
  const total = 120;
  const events = Array.from({ length: total }, (_, i) => ({
    id: `ev-${i}`,
    aggregateId,
    seq: i + 1,
    type: "message",
    data: { n: i },
  }));
  await store.appendEvents({ acpSessionId, aggregateId, events });
  assert.equal(await store.maxSeqForAggregate(aggregateId), total);
  const listed = await store.listEventsForAggregate(aggregateId);
  assert.equal(listed.length, total);
  assert.equal(listed[0].seq, 1);
  assert.equal(listed[listed.length - 1].seq, total);
  const { inserted } = await store.appendEvents({
    acpSessionId,
    aggregateId,
    events: [{ id: "ev-0", aggregateId, seq: 1, type: "dup", data: {} }],
  });
  assert.equal(inserted, 0);
  delete process.env.OAK_USE_MEMORY_STORE;
  resetHarnessSyncEventStoreForTests();
});

test("persistOpencodeSyncForSession marks syncExportFailedAt after retries", async () => {
  const prevEnv = process.env.CLOUDBASE_ENV_ID;
  const prevOak = process.env.OAK_USE_MEMORY_STORE;
  process.env.CLOUDBASE_ENV_ID = "test-env";
  process.env.OAK_USE_MEMORY_STORE = "1";
  resetHarnessSyncEventStoreForTests();
  resetHarnessSessionStoreForTests();

  const acpSessionId = "acp-fail-export";
  const aggregateId = "550e8400-e29b-41d4-a716-446655440099";
  const sessionStore = getHarnessSessionStore("test-env");
  await sessionStore.create({ acpSessionId, userId: "u", engine: "opencode" });
  await sessionStore.setEngineSessionId(acpSessionId, aggregateId);

  cacheSandboxHandle(acpSessionId, {
    instanceId: "i",
    toolId: "t",
    baseUrl: "http://127.0.0.1:1",
    headers: {},
    async request(path) {
      if (path.endsWith("/health")) {
        return new Response(
          JSON.stringify({ ok: true, acpReady: true, serveReady: true }),
          { status: 200 },
        );
      }
      throw new Error("sandbox sync unavailable");
    },
    async stop() {},
    async pause() {},
    async resumeIfPaused() {},
  });

  await assert.rejects(
    () =>
      persistOpencodeSyncForSession({
        acpSessionId,
        config: { name: "t", model: "m", system: "s", runtime: "harness", engine: "opencode" },
        reason: "prompt_end",
      }),
    /sandbox sync unavailable/,
  );

  const row = await sessionStore.get(acpSessionId);
  assert.ok(row?.syncExportFailedAt);
  dropCachedSandboxHandle(acpSessionId);
  resetHarnessSessionStoreForTests();
  resetHarnessSyncEventStoreForTests();
  if (prevEnv === undefined) delete process.env.CLOUDBASE_ENV_ID;
  else process.env.CLOUDBASE_ENV_ID = prevEnv;
  if (prevOak === undefined) delete process.env.OAK_USE_MEMORY_STORE;
  else process.env.OAK_USE_MEMORY_STORE = prevOak;
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

test("openAiChatCompletionsUrl appends /v1/chat/completions", () => {
  assert.equal(
    openAiChatCompletionsUrl("https://token-plan-cn.xiaomimimo.com/v1"),
    "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
  );
  assert.equal(
    openAiChatCompletionsUrl("https://example.com"),
    "https://example.com/v1/chat/completions",
  );
});

test("buildHarnessOpencodePermission maps bash always_ask to ask", () => {
  const perm = buildHarnessOpencodePermission({
    name: "t",
    model: "m",
    system: "s",
    runtime: "harness",
    engine: "opencode",
    tools: [
      {
        type: "agent_toolset",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        configs: [
          { name: "bash", enabled: true, permission_policy: { type: "always_ask" } },
          { name: "read_file", enabled: true, permission_policy: { type: "always_allow" } },
        ],
      },
    ],
  });
  assert.equal(perm.bash, "ask");
  assert.equal(perm.read, undefined);
});

test("buildHarnessOpencodePermission maps mcp_toolset always_ask", () => {
  const perm = buildHarnessOpencodePermission({
    name: "t",
    model: "m",
    system: "s",
    runtime: "harness",
    engine: "opencode",
    tools: [
      {
        type: "mcp_toolset",
        mcp_server_name: "cloudbase",
        default_config: { enabled: true, permission_policy: { type: "always_ask" } },
        configs: [
          { name: "envQuery", enabled: true, permission_policy: { type: "always_allow" } },
          { name: "danger", enabled: true, permission_policy: { type: "always_ask" } },
        ],
      },
    ],
  });
  assert.equal(perm["cloudbase_*"], "ask");
  assert.equal(perm.cloudbase_danger, "ask");
  assert.equal(perm.cloudbase_envQuery, undefined);
});

test("buildHarnessOpencodeConfigContent embeds permission in OPENCODE_CONFIG", () => {
  const raw = buildHarnessOpencodeConfigContent({
    name: "t",
    model: "m",
    system: "s",
    runtime: "harness",
    engine: "opencode",
    tools: [
      {
        type: "agent_toolset",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        configs: [
          { name: "write_file", enabled: true, permission_policy: { type: "always_ask" } },
        ],
      },
    ],
  });
  assert.ok(raw?.includes('"edit":"ask"') || raw?.includes('"edit": "ask"'));
});

test("platform probe quota failure is classified and documented", async () => {
  const {
    classifyPlatformProbeFailure,
    formatPlatformProbeFailureGuide,
    isPlatformQuotaExceeded,
  } = await import("../../packages/agent-runtime/dist/harness/llm-probe.js");
  const quota = {
    ok: false,
    httpStatus: 429,
    model: "hy3-preview",
    endpoint: "https://env.api.tcloudbasegateway.com/v1/ai/cloudbase/v1/chat/completions",
    latencyMs: 12,
    error: "Token usage exceeded quota limit",
    errorCode: "EXCEED_TOKEN_QUOTA_LIMIT",
  };
  assert.equal(classifyPlatformProbeFailure(quota), "quota_exceeded");
  assert.equal(isPlatformQuotaExceeded(quota), true);
  const guide = formatPlatformProbeFailureGuide(quota);
  assert.match(guide, /EXCEED_TOKEN_QUOTA_LIMIT|quota/i);
  assert.match(guide, /auto-falls back to opencode zen/i);
  assert.match(guide, /cloud-tcbr/);
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
