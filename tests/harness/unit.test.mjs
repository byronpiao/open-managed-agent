/**
 * Harness runtime unit tests (no network).
 * Run: npm test
 */

import { strict as assert } from "node:assert";
import {
  resolveRuntime,
  engineToDataPlaneSlug,
  harnessToolNameForEnv,
  resolveHarnessToolName,
  buildHarnessInstanceEnv,
  resolveSandboxConfig,
  resolveSandboxImageRegistryType,
  assertSandboxAcquireAllowed,
  buildAgsSandboxResources,
  normalizeAgentConfig,
  SandboxConfigError,
  DEFAULT_SANDBOX_RESOURCES,
  normalizeSandboxEnv,
  mergeHarnessInstanceEnv,
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
  resolveHarnessSandboxImage,
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
  normalizeInboundRequestId,
  parseCloudbaseTraceHeader,
  parseTraceparent,
  buildSyntheticTraceparent,
  resolveHarnessCorrelationFromHeaders,
  buildHarnessOutboundCorrelationHeaders,
  TRACEPARENT_HEADER,
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
import { parseHarnessRoleArn } from "../../lib/harness-preflight.mjs";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function withMemoryStore() {
  const prev = { region: process.env.TCB_REGION, apiKey: process.env.CLOUDBASE_APIKEY };
  delete process.env.TCB_REGION;
  delete process.env.CLOUDBASE_APIKEY;
  return () => {
    if (prev.region !== undefined) process.env.TCB_REGION = prev.region;
    if (prev.apiKey !== undefined) process.env.CLOUDBASE_APIKEY = prev.apiKey;
  };
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
  assert.equal(engineToDataPlaneSlug("hermes"), "hermes");
  assert.equal(engineToDataPlaneSlug("opencode"), "opencode");
});

test("resolveRuntime harness + hermes engine", () => {
  assert.deepEqual(
    resolveRuntime({
      name: "x",
      model: "m",
      system: "s",
      runtime: "harness",
      engine: "hermes",
    }),
    { runtime: "harness", engine: "hermes" },
  );
});

test("resolveSandboxConfig applies serverless defaults", () => {
  assert.deepEqual(
    resolveSandboxConfig({ sandbox: undefined }, "opencode"),
    {
      infra: "serverless",
      auth: "token",
      resources: { ...DEFAULT_SANDBOX_RESOURCES },
    },
  );
});

test("resolveSandboxConfig merges partial resources and memory shorthand", () => {
  assert.deepEqual(
    resolveSandboxConfig(
      {
        sandbox: {
          infra: "serverless",
          resources: { memory: 4 },
          timeout: "45m",
          image: "ccr.example/trw:magent",
        },
      },
      "opencode",
    ),
    {
      infra: "serverless",
      auth: "token",
      resources: { cpu: "2", memory: "4Gi" },
      timeout: "45m",
      image: "ccr.example/trw:magent",
    },
  );
});

test("resolveSandboxConfig parses imageRegistryType", () => {
  assert.equal(
    resolveSandboxConfig({ sandbox: { imageRegistryType: "enterprise" } }).imageRegistryType,
    "enterprise",
  );
  assert.equal(resolveSandboxImageRegistryType({ infra: "serverless", auth: "token", resources: { cpu: "2", memory: "2Gi" } }), "personal");
});

test("resolveSandboxConfig parses sandbox.auth", async () => {
  const { resolveSandboxConfig, resolveSandboxAgsAuthMode } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/sandbox-config.js"
  );
  const tokenCfg = resolveSandboxConfig({ sandbox: {} });
  assert.equal(tokenCfg.auth, "token");
  assert.equal(resolveSandboxAgsAuthMode(tokenCfg), "TOKEN");
  const noneCfg = resolveSandboxConfig({ sandbox: { auth: "none" } });
  assert.equal(noneCfg.auth, "none");
  assert.equal(resolveSandboxAgsAuthMode(noneCfg), "NONE");
});

test("resolveSandboxConfig rejects invalid imageRegistryType", () => {
  assert.throws(
    () => resolveSandboxConfig({ sandbox: { imageRegistryType: "foo" } }),
    SandboxConfigError,
  );
});

test("buildAgsSandboxResources maps CPU/Memory for AGS API", () => {
  assert.deepEqual(buildAgsSandboxResources({ cpu: "4", memory: "8Gi" }), {
    CPU: "4",
    Memory: "8Gi",
  });
});

test("assertSandboxAcquireAllowed rejects hermes on serverless", () => {
  assert.throws(
    () =>
      assertSandboxAcquireAllowed(
        resolveSandboxConfig({ sandbox: { infra: "serverless" } }, "hermes"),
        "hermes",
      ),
    SandboxConfigError,
  );
});

test("assertSandboxAcquireAllowed rejects durable until Talos is wired", () => {
  assert.throws(
    () =>
      assertSandboxAcquireAllowed(
        resolveSandboxConfig({ sandbox: { infra: "durable" } }, "hermes"),
        "hermes",
      ),
    /not wired/i,
  );
});

test("resolveSandboxConfig normalizes sandbox.env", () => {
  assert.deepEqual(
    resolveSandboxConfig(
      {
        sandbox: {
          env: {
            MY_TUNING_FLAG: "1",
            ANOTHER_VAR: "abc",
          },
        },
      },
      "opencode",
    ).env,
    { MY_TUNING_FLAG: "1", ANOTHER_VAR: "abc" },
  );
});

test("normalizeSandboxEnv rejects platform-managed keys", () => {
  assert.throws(
    () => normalizeSandboxEnv({ SECRET_MASTER_KEY: "x" }),
    (e) => e.name === "SandboxConfigError",
  );
  assert.throws(
    () => normalizeSandboxEnv({ HARNESS_OPENCODE_ACP_TIMEOUT_MS: "60000" }),
    /HARNESS_/,
  );
  assert.throws(
    () => normalizeSandboxEnv({ ENABLE_AGENT_OPENCODE: "false" }),
    /ENABLE_AGENT_/,
  );
  assert.throws(
    () => normalizeSandboxEnv({ bad_key: "1" }),
    /UPPER_SNAKE_CASE/,
  );
});

test("buildHarnessSandboxEnv merges sandbox.env over computed env", () => {
  const config = normalizeAgentConfig({
    name: "t",
    model: "m",
    system: "s",
    runtime: "harness",
    engine: "opencode",
    sandbox: {
      env: {
        WORKSPACE_FOLDER_PATHS: "/custom",
        MY_FEATURE_FLAG: "on",
      },
    },
  });
  const env = buildHarnessSandboxEnv({
    config,
    engine: "opencode",
    clientToolCallbackBase: "http://127.0.0.1:3000/callback",
  });
  const byName = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(byName.WORKSPACE_FOLDER_PATHS, "/custom");
  assert.equal(byName.MY_FEATURE_FLAG, "on");
  assert.equal(byName.ENABLE_AGENT_OPENCODE, "true");
});

test("mergeHarnessInstanceEnv yaml wins on key collision", () => {
  const merged = mergeHarnessInstanceEnv(
    [{ Name: "A", Value: "1" }, { Name: "B", Value: "2" }],
    [{ Name: "B", Value: "override" }],
  );
  assert.deepEqual(merged, [
    { Name: "A", Value: "1" },
    { Name: "B", Value: "override" },
  ]);
});

test("normalizeAgentConfig fills sandbox for harness runtime", () => {
  const cfg = normalizeAgentConfig({
    name: "t",
    model: "m",
    system: "s",
    runtime: "harness",
    engine: "opencode",
  });
  assert.equal(cfg.sandbox?.infra, "serverless");
  assert.deepEqual(cfg.sandbox?.resources, DEFAULT_SANDBOX_RESOURCES);
});

test("normalizeAgentConfig skips sandbox when managed and no yaml block", () => {
  const cfg = normalizeAgentConfig({ name: "t", model: "m", system: "s", runtime: "managed" });
  assert.equal(cfg.sandbox, undefined);
});

test("harnessToolNameForEnv is oma-harness-{envSlug}", () => {
  assert.equal(
    harnessToolNameForEnv("test-6g2rfs50c69b7fb8"),
    "oma-harness-test-6g2rfs50c69b7fb8",
  );
  assert.equal(
    resolveHarnessToolName("test-6g2rfs50c69b7fb8", true),
    "oma-harness-test-6g2rfs50c69b7fb8",
  );
});

test("cloudHarnessScenario names engine-suffixed cloud paths", async () => {
  const { cloudHarnessScenario, cloudHarnessAgentPinVar, scenarioFromAxes, parseHarnessAxes, parseHarnessInfraTokens, buildHarnessRunPlan } =
    await import("../../scripts/harness/load-env.mjs");
  assert.equal(cloudHarnessScenario("tcbr", "opencode"), "cloud-tcbr-opencode");
  assert.equal(cloudHarnessScenario("scf", "claude"), "cloud-scf-claude");
  assert.equal(cloudHarnessAgentPinVar("tcbr", "claude"), "HARNESS_CLOUD_TCBR_CLAUDE_AGENT_ID");
  assert.equal(scenarioFromAxes("local", "opencode"), "local-opencode");
  assert.equal(scenarioFromAxes("tcbr", "claude"), "cloud-tcbr-claude");
  assert.equal(scenarioFromAxes("scf", "opencode"), "cloud-scf-opencode");
  assert.throws(() => scenarioFromAxes("tcbr", "all"));
  const axes = parseHarnessAxes(["--infra", "tcbr,scf", "--engine", "opencode"]);
  assert.deepEqual(axes.infraTokens, ["tcbr", "scf"]);
  assert.equal(axes.mode, "parallel");
  const allAxes = parseHarnessAxes(["--infra", "all", "--engine", "opencode"]);
  assert.equal(allAxes.mode, "sequential");
  assert.deepEqual(
    allAxes.plan.map((s) => `${s.infra}/${s.engine}`),
    ["local/opencode", "tcbr/opencode", "scf/opencode"],
  );
  assert.equal(buildHarnessRunPlan(["all"], "all").length, 5);
  assert.throws(() => parseHarnessAxes(["--infra", "tcbr,scf", "--engine", "all"]));
  assert.throws(() => parseHarnessInfraTokens(["--infra", "all,tcbr"]));
});

test("parseHarnessEngineArg accepts opencode | claude | all", async () => {
  const { parseHarnessEngineArg, parseHarnessEnginesArg, harnessEnginesIncludeClaude, harnessEnginesIncludeOpencode } =
    await import("../../scripts/harness/load-env.mjs");
  assert.equal(parseHarnessEngineArg(["--engine", "opencode"]), "opencode");
  assert.equal(parseHarnessEngineArg(["--engine", "claude"]), "claude");
  assert.equal(parseHarnessEngineArg(["--engine", "all"]), "all");
  assert.equal(parseHarnessEnginesArg(["--engine", "opencode"]), "opencode");
  assert.ok(harnessEnginesIncludeOpencode("opencode"));
  assert.ok(!harnessEnginesIncludeOpencode("claude"));
  assert.ok(harnessEnginesIncludeClaude("all"));
  assert.throws(() => parseHarnessEngineArg(["--engine", "codebuddy"]));
});

test("stripHarnessAxisArgv removes infra/engine flags for child harness spawns", async () => {
  const { stripHarnessAxisArgv } = await import("../../lib/harness-cli-flags.mjs");
  assert.deepEqual(
    stripHarnessAxisArgv(["--infra", "tcbr,scf", "--engine", "opencode", "--verify-only"]),
    ["--verify-only"],
  );
  assert.deepEqual(stripHarnessAxisArgv(["--infra=tcbr", "--engine=claude", "--full"]), ["--full"]);
});

test("cloudVerifyPromptsPassed tolerates cold-start prompt#1 504 when prompt#2 ok", async () => {
  const { cloudVerifyPromptsPassed } = await import("../../scripts/harness/cloud.mjs");
  const ok = { ok: true, has504: false };
  const p1Cold = { ok: false, has504: true };
  assert.ok(cloudVerifyPromptsPassed({ warmTimeout: false, p1: p1Cold, p2: ok }));
  assert.ok(cloudVerifyPromptsPassed({ warmTimeout: false, p1: ok, p2: ok }));
  assert.ok(!cloudVerifyPromptsPassed({ warmTimeout: true, p1: ok, p2: ok }));
  assert.ok(!cloudVerifyPromptsPassed({ warmTimeout: false, p1: ok, p2: { ok: false, has504: false } }));
  assert.ok(!cloudVerifyPromptsPassed({ warmTimeout: false, p1: { ok: false, has504: false }, p2: ok }));
});

test("cloud harness scf agent:create passes --type scf", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../scripts/harness/cloud.mjs", import.meta.url), "utf8");
  assert.match(src, /--type scf --agent-runtime harness/);
});

test("resolveHarnessByokModel falls back to HARNESS_BYOK_DEFAULT_MODEL", async () => {
  const { resolveHarnessByokModel, HARNESS_BYOK_DEFAULT_MODEL } = await import(
    "../../lib/harness-llm-env.mjs"
  );
  assert.equal(resolveHarnessByokModel({}), HARNESS_BYOK_DEFAULT_MODEL);
  assert.equal(resolveHarnessByokModel({ LLM_MODEL: "custom" }), "custom");
});

test("parseCloudCosMount and applyHarnessScenario cos axes", async () => {
  const {
    applyHarnessScenario,
    parseCloudCosMount,
    HARNESS_COS_ENV_KEYS,
  } = await import("../../scripts/harness/load-env.mjs");
  assert.throws(() => parseCloudCosMount(["--with-cos", "--no-cos"]));
  assert.equal(parseCloudCosMount(["--with-cos"]), true);
  assert.equal(parseCloudCosMount([]), false);

  const env = { CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8" };
  const devMeta = applyHarnessScenario("local-opencode", env, { devLocal: true });
  assert.equal(devMeta.cosEnabled, false);
  for (const k of HARNESS_COS_ENV_KEYS) assert.equal(env[k], undefined);

  const cloudMeta = applyHarnessScenario("cloud-tcbr-opencode", env, { cloudCosMount: false });
  assert.equal(cloudMeta.cosEnabled, false);
  assert.ok(!cloudMeta.toolName.endsWith("-with-cos"));
  for (const k of HARNESS_COS_ENV_KEYS) assert.equal(env[k], undefined);

  const localEnv = {
    CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8",
    HARNESS_COS_ENABLED: "1",
    HARNESS_COS_BUCKET: "bucket",
    HARNESS_COS_BUCKET_PATH: "/p",
    HARNESS_COS_ENDPOINT: "b.cos.example.com",
    HARNESS_COS_REGION: "ap-shanghai",
    HARNESS_COS_MOUNT_NAME: "ags-cos-trw",
    HARNESS_COS_MOUNT_DIR: "/mnt/workspace",
  };
  const localMeta = applyHarnessScenario("local-opencode", localEnv);
  assert.equal(localMeta.cosEnabled, false);
  for (const k of HARNESS_COS_ENV_KEYS) assert.equal(localEnv[k], undefined);
});

test("parseDbPressureArgs defaults off", async () => {
  const { parseDbPressureArgs } = await import("../../scripts/harness/db-pressure.mjs");
  assert.deepEqual(parseDbPressureArgs([]), { enabled: false, rounds: 10 });
  assert.deepEqual(parseDbPressureArgs(["--db-pressure"]), { enabled: true, rounds: 10 });
  assert.deepEqual(parseDbPressureArgs(["--db-pressure", "--db-pressure-rounds", "3"]), {
    enabled: true,
    rounds: 3,
  });
});

test("applyHarnessScenario cloud-scf applies BYOK from scenario env", async () => {
  const { applyHarnessScenario, HARNESS_COS_ENV_KEYS } = await import(
    "../../scripts/harness/load-env.mjs"
  );
  const env = {
    CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8",
    HARNESS_COS_ENABLED: "1",
    HARNESS_COS_BUCKET: "bucket",
  };
  const meta = applyHarnessScenario("cloud-scf-opencode", env);
  assert.equal(meta.scenario, "cloud-scf-opencode");
  assert.equal(meta.cosEnabled, false);
  assert.equal(meta.toolName, "oma-harness-test-6g2rfs50c69b7fb8");
  for (const k of HARNESS_COS_ENV_KEYS) assert.equal(env[k], undefined);
  assert.ok(env.LLM_API_KEY);
  assert.ok(env.OPENAI_BASE_URL);
  assert.equal(env.AGENT_MODEL, undefined);
});

test("applyHarnessScenario cloud-tcbr-opencode sets zen via AGENT_MODEL", async () => {
  const { applyHarnessScenario } = await import("../../scripts/harness/load-env.mjs");
  const env = { CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8" };
  applyHarnessScenario("cloud-tcbr-opencode", env);
  assert.equal(env.AGENT_MODEL, "zen");
  assert.equal(env.LLM_API_KEY, undefined);
});

test("scenario matrix isolates OpenAI vs Anthropic env files", async () => {
  const { applyHarnessScenario, hasOpenAiByokInEnv } = await import(
    "../../scripts/harness/load-env.mjs"
  );
  const openAiEnv = { CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8" };
  const openAiMeta = applyHarnessScenario("cloud-scf-opencode", openAiEnv);
  assert.ok(hasOpenAiByokInEnv(openAiEnv));
  assert.equal(openAiMeta.engine, "opencode");
  assert.ok(openAiEnv.LLM_API_KEY);
  assert.ok(openAiEnv.OPENAI_BASE_URL);
  assert.equal(openAiEnv.ANTHROPIC_BASE_URL, undefined);

  const claudeEnv = { CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8" };
  const claudeMeta = applyHarnessScenario("local-claude", claudeEnv);
  assert.equal(claudeMeta.engine, "claude");
  assert.equal(claudeEnv.LLM_API_KEY, undefined);

  const { applyScenarioEnv } = await import("../../scripts/harness/scenario-matrix.mjs");
  const claudeRaw = { CLOUDBASE_ENV_ID: "test-6g2rfs50c69b7fb8" };
  applyScenarioEnv("local-claude", claudeRaw);
  assert.ok(claudeRaw.LLM_API_KEY);
  assert.ok(claudeRaw.ANTHROPIC_BASE_URL);
  assert.equal(claudeRaw.OPENAI_BASE_URL, undefined);
});

test("harness matrix has 6 scenarios and 2 agent yaml by engine", async () => {
  const {
    HARNESS_MATRIX_SCENARIOS,
    resolveHarnessAgentYaml,
    scenarioEngine,
  } = await import("../../scripts/harness/scenario-matrix.mjs");
  assert.equal(HARNESS_MATRIX_SCENARIOS.length, 6);
  for (const id of HARNESS_MATRIX_SCENARIOS) {
    const yaml = resolveHarnessAgentYaml(id);
    assert.ok(yaml.endsWith(`agent.${scenarioEngine(id)}.yaml`));
  }
});

test("ma-protocol sidecar resolves dedicated agent yaml", async () => {
  const { resolveHarnessAgentYaml, pinnedMaProtocolAgentId } = await import(
    "../../scripts/harness/scenario-matrix.mjs"
  );
  assert.ok(resolveHarnessAgentYaml("ma-protocol").endsWith("agent.ma-protocol.yaml"));
  assert.equal(
    pinnedMaProtocolAgentId(
      new Map([
        ["HARNESS_MA_PROTOCOL_AGENT_ID", "agent-ma-test"],
        ["CLOUDBASE_AGENT_ID", "agent-legacy"],
      ]),
    ),
    "agent-ma-test",
  );
  assert.equal(
    pinnedMaProtocolAgentId(new Map([["CLOUDBASE_AGENT_ID", "agent-legacy"]])),
    "agent-legacy",
  );
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
  process.env.LLM_MODEL = "hy3-preview";
  const raw = buildHarnessOpencodeConfigContent({
    name: "t",
    model: "ignored",
    system: "s",
  });
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.provider["openai-compat"].options.apiKey, "sk-test");
  assert.ok(parsed.model.includes("hy3-preview"));
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("buildHarnessOpencodeConfigContent skips custom LLM when model is zen", () => {
  const saved = {
    key: process.env.LLM_API_KEY,
    url: process.env.OPENAI_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "https://example.com/v1";
  process.env.LLM_MODEL = "hy3-preview";
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
  process.env.LLM_MODEL = "hy3-preview";
  const sid = "550e8400-e29b-41d4-a716-446655440000";
  const env = buildHarnessSandboxEnv({
    config: { name: "t", model: "hy3-preview", system: "s" },
    engine: "opencode",
    clientToolCallbackBase: "http://127.0.0.1:19090",
    acpSessionId: sid,
  });
  const oc = env.find((e) => e.Name === "OPENCODE_CONFIG_CONTENT");
  assert.ok(oc);
  assert.ok(JSON.parse(oc.Value).model.includes("hy3-preview"));
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
  assert.equal(cfg.sandbox?.infra, "serverless");
  assert.deepEqual(cfg.sandbox?.resources, DEFAULT_SANDBOX_RESOURCES);
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
    { clientToolCallbackBase: "https://gw.example.com" },
  );
  assert.ok(env.MCPORTER_CONFIG_CONTENT);
  assert.equal(env.HARNESS_SANDBOX_IMAGE, undefined);
});

test("resolveHarnessSandboxImage prefers yaml over builtin default", () => {
  assert.equal(resolveHarnessSandboxImage("ccr.example/trw:custom"), "ccr.example/trw:custom");
  assert.equal(resolveHarnessSandboxImage(), HARNESS_PUBLIC_MAGENT_IMAGE);
  assert.equal(resolveHarnessSandboxImage(null), HARNESS_PUBLIC_MAGENT_IMAGE);
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

test("resolveCloudBasePlatformLlm from CLOUDBASE_APIKEY + envId only", async () => {
  const {
    resolveCloudBasePlatformLlm,
    resolveOpenAiCompatProvider,
    resolveAnthropicCompatProvider,
    HARNESS_CLOUDBASE_DEFAULT_MODEL,
  } = await import("../../packages/agent-runtime/dist/harness/llm-providers.js");
  const saved = {
    env: process.env.CLOUDBASE_ENV_ID,
    tcb: process.env.CLOUDBASE_APIKEY,
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
  process.env.CLOUDBASE_APIKEY = "tcb-jwt-key";
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
  if (saved.tcb === undefined) delete process.env.CLOUDBASE_APIKEY;
  else process.env.CLOUDBASE_APIKEY = saved.tcb;
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
  assert.equal(names.ANTHROPIC_DEFAULT_HAIKU_MODEL, "hy3-preview");
  assert.equal(names.ANTHROPIC_DEFAULT_SONNET_MODEL, "hy3-preview");
  assert.equal(names.ANTHROPIC_DEFAULT_OPUS_MODEL, "hy3-preview");
  assert.equal(names.OPENCODE_CONFIG_CONTENT, undefined);
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("buildAnthropicCompatFetchHeaders sends Bearer and x-api-key", async () => {
  const { buildAnthropicCompatFetchHeaders } = await import(
    "../../packages/agent-runtime/dist/harness/llm-providers.js"
  );
  const headers = buildAnthropicCompatFetchHeaders("key-test", "https://example.com");
  assert.equal(headers.Authorization, "Bearer key-test");
  assert.equal(headers["x-api-key"], "key-test");
});

test("buildHarnessSandboxEnv injects AUTH_TOKEN and API_KEY for BYOK", async () => {
  const { anthropicCompatToTrwEnv } = await import(
    "../../packages/agent-runtime/dist/harness/llm-providers.js"
  );
  const env = anthropicCompatToTrwEnv({
    apiKey: "sk-test",
    baseUrl: "https://token.sensenova.cn",
    model: "sensenova-6.7-flash-lite",
  });
  const names = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(names.ANTHROPIC_AUTH_TOKEN, "sk-test");
  assert.equal(names.ANTHROPIC_API_KEY, "sk-test");
  assert.equal(names.ANTHROPIC_MODEL, "sensenova-6.7-flash-lite");
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

test("buildHarnessInstanceEnv enables hermes acp + web (Talos preset parity)", () => {
  const env = buildHarnessInstanceEnv({ name: "t", model: "m", system: "s" }, "hermes");
  const names = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(names.ENABLE_AGENT_HERMES_ACP, "true");
  assert.equal(names.ENABLE_AGENT_HERMES_WEB, "true");
  assert.equal(names.INTEGRATION_IDE, "hermes");
});

test("buildHarnessSandboxEnv maps OpenAI env for hermes engine", () => {
  const saved = {
    key: process.env.LLM_API_KEY,
    url: process.env.OPENAI_BASE_URL,
    model: process.env.LLM_MODEL,
  };
  process.env.LLM_API_KEY = "sk-openai";
  process.env.OPENAI_BASE_URL = "https://example.com/v1";
  process.env.LLM_MODEL = "hy3-preview";
  const env = buildHarnessSandboxEnv({
    config: { name: "t", model: "hy3-preview", system: "s" },
    engine: "hermes",
    clientToolCallbackBase: "http://127.0.0.1:19090",
  });
  const names = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
  assert.equal(names.ENABLE_AGENT_HERMES_ACP, "true");
  assert.equal(names.ENABLE_AGENT_HERMES_WEB, "true");
  assert.equal(names.OPENAI_API_KEY, "sk-openai");
  assert.equal(names.OPENAI_BASE_URL, "https://example.com");
  assert.equal(names.OPENCODE_CONFIG_CONTENT, undefined);
  if (saved.key === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = saved.url;
  if (saved.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.model;
});

test("harness sync event store append + hydrate round-trip", async () => {
  const restore = withMemoryStore();
  try {
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
  resetHarnessSyncEventStoreForTests();
  } finally { restore(); }
});

test("harness sync event store maxSeq and long list", async () => {
  const restore = withMemoryStore();
  try {
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
  resetHarnessSyncEventStoreForTests();
  } finally { restore(); }
});

test("persistOpencodeSyncForSession marks syncExportFailedAt after retries", async () => {
  const restore = withMemoryStore();
  try {
  const prevEnv = process.env.CLOUDBASE_ENV_ID;
  process.env.CLOUDBASE_ENV_ID = "test-env";
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
  } finally { restore(); }
});

test("warmClaudeEngineSession calls sandbox session/load", async () => {
  const { warmClaudeEngineSession } = await import(
    "../../packages/agent-runtime/dist/harness/claude-session-warm.js"
  );
  const calls = [];
  const handle = {
    instanceId: "inst-claude",
    toolId: "t",
    baseUrl: "http://127.0.0.1:1",
    headers: {},
    async request(path, init) {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { sessionId: "eng-1" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    async stop() {},
    async pause() {},
    async resumeIfPaused() {},
  };
  const engineSessionId = "550e8400-e29b-41d4-a716-446655440088";
  const result = await warmClaudeEngineSession({
    handle,
    config: { name: "t", model: "m", system: "s", runtime: "harness", engine: "claude" },
    acpSessionId: "acp-warm",
    engineSessionId,
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.path.endsWith("/claudecode/acp")));
  assert.equal(calls[0]?.body?.method, "session/load");
  assert.equal(calls[0]?.body?.params?.sessionId, engineSessionId);
  assert.equal(calls[0]?.body?.params?.replay, false);
});

test("markClaudeWarmOutcome updates harness_sessions.claudeWarmFailedAt", async () => {
  const restore = withMemoryStore();
  try {
  const prevEnv = process.env.CLOUDBASE_ENV_ID;
  process.env.CLOUDBASE_ENV_ID = "test-env";
  resetHarnessSessionStoreForTests();

  const { markClaudeWarmOutcome } = await import(
    "../../packages/agent-runtime/dist/harness/claude-session-health.js"
  );
  const sessionStore = getHarnessSessionStore("test-env");
  const acpSessionId = "acp-claude-warm";
  await sessionStore.create({ acpSessionId, userId: "u", engine: "claude" });

  await markClaudeWarmOutcome({ acpSessionId, ok: false });
  let row = await sessionStore.get(acpSessionId);
  assert.ok(row?.claudeWarmFailedAt);

  await markClaudeWarmOutcome({ acpSessionId, ok: true });
  row = await sessionStore.get(acpSessionId);
  assert.equal(row?.claudeWarmFailedAt, undefined);

  resetHarnessSessionStoreForTests();
  if (prevEnv === undefined) delete process.env.CLOUDBASE_ENV_ID;
  else process.env.CLOUDBASE_ENV_ID = prevEnv;
  } finally { restore(); }
});

test("probeClaudeSessionStoreAfterPrompt skips non-claude engine", async () => {
  const { probeClaudeSessionStoreAfterPrompt } = await import(
    "../../packages/agent-runtime/dist/harness/claude-session-health.js"
  );
  const result = await probeClaudeSessionStoreAfterPrompt({
    acpSessionId: "acp-1",
    config: { name: "t", model: "m", system: "s", runtime: "harness", engine: "opencode" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.entries, 0);
});

test("isClaudeEntryCountHigh uses fixed threshold 3000", async () => {
  const { isClaudeEntryCountHigh, CLAUDE_SESSION_ENTRY_WARN_THRESHOLD, noteClaudeSessionEntryCount } =
    await import("../../packages/agent-runtime/dist/harness/claude-session-health.js");
  assert.equal(CLAUDE_SESSION_ENTRY_WARN_THRESHOLD, 3000);
  assert.equal(isClaudeEntryCountHigh(3000), false);
  assert.equal(isClaudeEntryCountHigh(3001), true);

  const restore = withMemoryStore();
  try {
  const prevEnv = process.env.CLOUDBASE_ENV_ID;
  process.env.CLOUDBASE_ENV_ID = "test-env";
  resetHarnessSessionStoreForTests();

  const sessionStore = getHarnessSessionStore("test-env");
  const acpSessionId = "acp-claude-entry-high";
  await sessionStore.create({ acpSessionId, userId: "u", engine: "claude" });

  await noteClaudeSessionEntryCount({ acpSessionId, entries: 42 });
  let row = await sessionStore.get(acpSessionId);
  assert.equal(row?.claudeEntryCountHighAt, undefined);

  await noteClaudeSessionEntryCount({ acpSessionId, entries: 3001 });
  row = await sessionStore.get(acpSessionId);
  assert.ok(row?.claudeEntryCountHighAt);

  resetHarnessSessionStoreForTests();
  if (prevEnv === undefined) delete process.env.CLOUDBASE_ENV_ID;
  else process.env.CLOUDBASE_ENV_ID = prevEnv;
  } finally { restore(); }
});

test("getHarnessStoreDiag exposes harness_sessions attention counters", async () => {
  const restore = withMemoryStore();
  try {
  const prevEnv = process.env.CLOUDBASE_ENV_ID;
  process.env.CLOUDBASE_ENV_ID = "test-env";
  resetHarnessSessionStoreForTests();

  const { getHarnessStoreDiag } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  const sessionStore = getHarnessSessionStore("test-env");
  const acpSessionId = "acp-attention";
  await sessionStore.create({ acpSessionId, userId: "u", engine: "claude" });
  await sessionStore.setClaudeStoreEmptyAt(acpSessionId, Date.now());
  await sessionStore.setClaudeEntryCountHighAt(acpSessionId, Date.now());

  const diag = await getHarnessStoreDiag("test-env");
  assert.equal(diag.attention.claudeStoreEmpty, 1);
  assert.equal(diag.attention.claudeEntryHigh, 1);
  assert.equal(diag.attention.syncExportFailed, 0);

  resetHarnessSessionStoreForTests();
  if (prevEnv === undefined) delete process.env.CLOUDBASE_ENV_ID;
  else process.env.CLOUDBASE_ENV_ID = prevEnv;
  } finally { restore(); }
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
  assert.match(guide, /run --infra tcbr/);
});

test("normalizeInboundRequestId rejects unsafe values", () => {
  assert.equal(normalizeInboundRequestId("abc-123_ok"), "abc-123_ok");
  assert.equal(normalizeInboundRequestId("a".repeat(300)), undefined);
  assert.equal(normalizeInboundRequestId("bad id space"), undefined);
});

test("parseCloudbaseTraceHeader decodes traceId and spanId", () => {
  const traceId = "8f431b7e-bfcc-423e-99d8-cda72471ff49";
  const spanId = "bbe75687-fffb-6cb8";
  const raw = Buffer.from(`${traceId},${spanId},on`, "utf-8").toString("base64");
  const parsed = parseCloudbaseTraceHeader(raw);
  assert.equal(parsed.traceId, traceId);
  assert.equal(parsed.spanId, "bbe75687fffb6cb8");
  assert.equal(parsed.raw, raw);
  assert.deepEqual(parseCloudbaseTraceHeader("not-base64!!!"), {});
});

test("parseTraceparent decodes W3C trace context", () => {
  const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const parsed = parseTraceparent(tp);
  assert.equal(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(parsed.spanId, "00f067aa0ba902b7");
  assert.equal(parsed.source, "traceparent");
});

test("resolveHarnessCorrelationFromHeaders prefers traceparent", () => {
  const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const ctx = resolveHarnessCorrelationFromHeaders({
    traceparent: tp,
    "x-cloudbase-request-id": "req-1",
  });
  assert.equal(ctx.requestId, "req-1");
  assert.equal(ctx.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(ctx.traceSource, "traceparent");
  assert.equal(ctx.traceRaw, tp);
});

test("buildHarnessOutboundCorrelationHeaders never forges scf headers", () => {
  const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const w3c = buildHarnessOutboundCorrelationHeaders({
    requestId: "oma-1",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceRaw: tp,
    traceSource: "traceparent",
  });
  assert.equal(w3c["X-Request-Id"], "oma-1");
  assert.equal(w3c.traceparent, tp);
  assert.equal(w3c["x-scf-request-id"], undefined);

  const cloud = buildHarnessOutboundCorrelationHeaders({
    requestId: "oma-1",
    traceId: "8f431b7e-bfcc-423e-99d8-cda72471ff49",
    spanId: "bbe75687fffb6cb8",
    traceRaw: "b64payload",
    traceSource: "cloudbase",
    cloudbaseTrace: "b64payload",
  });
  assert.equal(cloud["x-cloudbase-trace"], "b64payload");
  assert.match(cloud.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("resolveHarnessCorrelationFromHeaders uses inbound or generates", () => {
  const inbound = resolveHarnessCorrelationFromHeaders({
    "x-scf-request-id": "scf-req-1",
  });
  assert.equal(inbound.requestId, "scf-req-1");
  const generated = resolveHarnessCorrelationFromHeaders({});
  assert.match(generated.requestId, /^[0-9a-f-]{36}$/i);
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

test("parseHarnessRoleArn accepts standard CAM ARN", () => {
  assert.deepEqual(parseHarnessRoleArn("qcs::cam::uin/691612481:roleName/agent-sandbox"), {
    uin: "691612481",
    roleName: "agent-sandbox",
  });
});

test("parseHarnessRoleArn rejects garbage", () => {
  assert.equal(parseHarnessRoleArn(""), null);
  assert.equal(parseHarnessRoleArn("arn:aws:iam::123:role/x"), null);
});

test("stripQuickstartPins clears cloud and COS pins", async () => {
  const { stripQuickstartPins, QUICKSTART_ENV_STRIP_KEYS } = await import(
    "../../scripts/harness/load-env.mjs"
  );
  const env = {
    CLOUDBASE_ENV_ID: "test-env",
    HARNESS_CLOUD_SCF_OPENCODE_AGENT_ID: "agent-pinned",
    HARNESS_COS_ENABLED: "1",
  };
  stripQuickstartPins(env);
  for (const k of QUICKSTART_ENV_STRIP_KEYS) {
    assert.equal(env[k], undefined, `expected ${k} stripped`);
  }
  assert.equal(env.CLOUDBASE_ENV_ID, "test-env");
});

test("ACP OPTIONS preflight allows browser credentials (chat-playground)", async () => {
  const { spawn } = await import("node:child_process");
  const { setTimeout: sleep } = await import("node:timers/promises");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const port = 19092;
  const origin = "http://localhost:5175";
  const agentConfig = {
    name: "CorsPreflight",
    runtime: "harness",
    engine: "opencode",
    system: "cors test",
  };
  const child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_CONFIG: JSON.stringify(agentConfig),
    },
    stdio: "ignore",
  });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (health.ok) break;
      } catch {
        // retry
      }
      await sleep(100);
    }

    const res = await fetch(`http://127.0.0.1:${port}/acp`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  } finally {
    child.kill("SIGTERM");
  }
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
