/**
 * Harness 主链路矩阵 #8 #9 #10 — 真 AGS 沙箱验收。
 *
 *   node tests/harness/matrix-parity.test.mjs
 *   node tests/harness/matrix-parity.test.mjs --engines opencode|claude|all
 *
 * 需要 `.env.harness`（与 harness -- local 相同）。
 * claude 还需 `scripts/harness/scenarios/.env.local-claude`。
 * 不测 LLM 对话，只验配置进箱、init、MCP/Skills 落盘与可列举。
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  loadEnv,
  assertHarnessCreds,
  applyHarnessScenario,
  parseHarnessEnginesArg,
  harnessEnginesIncludeOpencode,
  harnessEnginesIncludeClaude,
  assertHarnessEnginesEnv,
} from "../../scripts/harness/load-env.mjs";

loadEnv();
assertHarnessCreds();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillFixture = resolve(repoRoot, "tests/fixtures/skills/harness-e2e-demo.md");

/** agent.yaml 里声明的 HTTP MCP，指向箱内 TRW 内置 /mcp */
const MCP_SERVER_NAME = "harness_fixture_http";
const MCP_SERVER_URL = "http://127.0.0.1:9000/mcp";

const ENGINE_SKILL_MIRROR = {
  opencode: ".config/opencode/skills/harness-e2e-demo/SKILL.md",
  claude: ".claude/skills/harness-e2e-demo/SKILL.md",
};

const ENGINE_HEALTH = {
  opencode: {
    path: "/api/agents/opencode/health",
    ready: (h) => Boolean(h?.ok && h.acpReady && h.serveReady),
  },
  claude: {
    path: "/api/agents/claudecode/health",
    ready: (h) => Boolean(h?.ok && h.acpReady),
  },
};

export function buildMatrixParityAgentConfig(engine = "opencode") {
  return {
    name: `HarnessMatrixParity-${engine}`,
    model: engine === "claude" ? "deepseek-v4-flash" : "hunyuan-t1-latest",
    system: "Matrix parity harness agent.",
    runtime: "harness",
    engine,
    mcp_servers: [
      {
        type: "url",
        name: MCP_SERVER_NAME,
        url: MCP_SERVER_URL,
      },
    ],
    skills: [
      {
        name: "harness-e2e-demo",
        description: "E2E skill fixture",
        source: skillFixture,
      },
    ],
  };
}

async function postTool(handle, tool, body) {
  const res = await handle.request(`/api/tools/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${tool} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${tool} invalid JSON: ${text.slice(0, 400)}`);
  }
}

async function bash(handle, command) {
  const res = await handle.request("/api/tools/bash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`bash HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`bash invalid JSON: ${text.slice(0, 400)}`);
  }
  const output = json.output ?? json.result?.output ?? "";
  if (json.exitCode !== 0 && json.exitCode !== undefined) {
    throw new Error(`bash exit ${json.exitCode}: ${String(output).slice(0, 400)}`);
  }
  return String(output);
}

async function acquireParitySandbox(engine) {
  const { getSandboxOrchestrator } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const { buildHarnessSandboxEnv } = await import(
    "../../packages/agent-runtime/dist/harness/deploy.js"
  );

  const config = buildMatrixParityAgentConfig(engine);
  const acpSessionId = crypto.randomUUID();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "http://127.0.0.1:9000";

  console.log(`acquiring sandbox for matrix parity (engine=${engine})…`);
  const orch = getSandboxOrchestrator();
  return orch.acquire({
    envId,
    agentConfig: config,
    engine,
    acpSessionId,
    instanceEnv: buildHarnessSandboxEnv({
      config,
      engine,
      clientToolCallbackBase: callbackBase,
      acpSessionId,
    }),
  });
}

/** 矩阵 #8：agent.yaml 里的 mcp_servers 写进箱内 mcporter */
async function testMcpServersDeployed(handle) {
  const raw = await bash(handle, "cat .mcporter/mcporter.json");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`mcporter.json is not valid JSON: ${raw.slice(0, 300)}`);
  }
  const server = parsed?.mcpServers?.[MCP_SERVER_NAME];
  assert.ok(server, `mcporter.json missing server "${MCP_SERVER_NAME}"`);
  assert.equal(server.type, "streamable-http", "mcporter server type");
  assert.equal(server.url, MCP_SERVER_URL, "mcporter server url");
  console.log("  ✓ #8 mcp_servers → .mcporter/mcporter.json");
}

/** 矩阵 #8：mcporter 能连上 yaml 里声明的上游 MCP */
async function testMcpServerToolsListable(handle) {
  const out = await bash(
    handle,
    `mcporter list ${MCP_SERVER_NAME} --schema --output json 2>&1 | head -c 4000`,
  );
  assert.ok(out.length > 30, `mcporter list ${MCP_SERVER_NAME} returned empty output`);
  assert.ok(
    /"name"\s*:|tools|bash|read/i.test(out),
    `expected tool schema from upstream MCP, got: ${out.slice(0, 280)}`,
  );
  console.log(`  ✓ #8 mcporter list ${MCP_SERVER_NAME}`);
}

/** TRW 双端点：/mcp 内置 vs /mcp_user_define（mcporter 聚合） */
async function testDualMcpEndpoints(handle) {
  const res = await handle.request("/mcp/discovery");
  assert.equal(res.status, 200, `GET /mcp/discovery HTTP ${res.status}`);
  const discovery = await res.json();

  const builtin = discovery.servers?.find((s) => s.endpoint === "/mcp");
  assert.ok(builtin, "discovery missing builtin /mcp");
  const builtinTools = (builtin.tools ?? []).map((t) => (typeof t === "string" ? t : t.name));
  assert.ok(builtinTools.includes("bash"), `/mcp discovery missing bash: ${builtinTools.join(",")}`);
  assert.ok(builtinTools.includes("read"), `/mcp discovery missing read`);
  assert.equal(builtin.source, "builtin");
  console.log("  ✓ TRW /mcp (builtin): discovery lists bash, read, …");

  const userDefine = discovery.servers?.find((s) => s.endpoint === "/mcp_user_define");
  assert.ok(userDefine, "discovery missing /mcp_user_define");
  assert.equal(userDefine.source, "user");
  const userServers = userDefine.servers ?? [];
  assert.ok(
    userServers.includes(MCP_SERVER_NAME),
    `/mcp_user_define should aggregate mcporter server "${MCP_SERVER_NAME}", got: ${userServers.join(",")}`,
  );
  assert.ok(
    !userServers.includes("cloudbase"),
    "cloudbase belongs to mcporter_cli path, not mcp_user_define aggregation list",
  );
  console.log(
    `  ✓ TRW /mcp_user_define: aggregates yaml mcp_servers (${MCP_SERVER_NAME}), not cloudbase`,
  );

  const mcpInit = await handle.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "matrix-parity", version: "1.0" },
      },
    }),
  });
  const initBody = await mcpInit.text();
  assert.ok(
    initBody.includes("protocolVersion"),
    `POST /mcp initialize failed: ${initBody.slice(0, 300)}`,
  );
  console.log("  ✓ TRW /mcp: initialize (streamable HTTP alive)");
}

/** 矩阵 #9a：创箱 env 里注入了 CloudBase 控制面凭证（OMA 默认行为，与用户 yaml 无关） */
async function testCloudbaseCredsOnInstanceEnv(handle) {
  const envId = (await bash(handle, 'printf "%s" "$CLOUDBASE_ENV_ID"')).trim();
  assert.ok(envId.length >= 4, "instance env missing CLOUDBASE_ENV_ID (check .env.harness)");

  const secretId = (await bash(handle, 'printf "%s" "$TENCENTCLOUD_SECRETID"')).trim();
  assert.ok(
    secretId.length >= 8,
    "instance env missing TENCENTCLOUD_SECRETID (check .env.harness TCB_SECRET_ID)",
  );
  console.log(`  ✓ #9 creds on instance env (envId=${envId.slice(0, 8)}…)`);
}

/** 矩阵 #9b：workspace/init 把凭证写进 mcporter 的 cloudbase 服务 */
async function testCloudbaseMcporterWiredAfterInit(handle) {
  const raw = await bash(handle, "cat .mcporter/mcporter.json");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`mcporter.json invalid: ${raw.slice(0, 300)}`);
  }
  const cloudbase = parsed?.mcpServers?.cloudbase;
  assert.ok(cloudbase, "mcporter.json missing cloudbase server after workspace/init");
  const cbEnv = cloudbase.env ?? {};
  assert.ok(cbEnv.CLOUDBASE_ENV_ID, "cloudbase mcporter env missing CLOUDBASE_ENV_ID");
  assert.ok(cbEnv.TENCENTCLOUD_SECRETID, "cloudbase mcporter env missing TENCENTCLOUD_SECRETID");
  console.log("  ✓ #9 workspace/init → mcporter cloudbase server + env");
}

/** 矩阵 #9c：注入后可列举 CloudBase MCP 工具（不经 LLM） */
async function testCloudbaseMcpToolsListable(handle) {
  const out = await bash(
    handle,
    "mcporter list cloudbase --schema --output json 2>&1 | head -c 6000",
  );
  assert.ok(
    out.length > 40,
    "cloudbase MCP tool list empty after inject — creds invalid or workspace/init failed",
  );
  assert.ok(
    /"name"\s*:/i.test(out),
    `cloudbase schema missing tool names: ${out.slice(0, 280)}`,
  );
  console.log("  ✓ #9 mcporter list cloudbase (tools reachable)");
}

/**
 * 矩阵 #9d：无害只读调用（TRW 文档标准探针 envQuery info，不读写用户数据）
 * @see tcb-remote-workspace/src/tools/mcporter-cli.doc.ts
 */
async function testCloudbaseMcpHarmlessCall(handle) {
  const out = await bash(
    handle,
    `mcporter call 'cloudbase.envQuery(action: "info")' 2>&1 | head -c 6000`,
  );
  assert.ok(out.length > 15, `cloudbase envQuery(info) empty output`);
  const lower = out.toLowerCase();
  assert.ok(
    !lower.includes("unauthorized") &&
      !lower.includes("invalid credentials") &&
      !/error:\s*401/.test(lower),
    `cloudbase envQuery(info) auth failed: ${out.slice(0, 400)}`,
  );
  assert.ok(
    /env|cloudbase|region|info|result|success/i.test(out),
    `cloudbase envQuery(info) unexpected body: ${out.slice(0, 400)}`,
  );
  console.log("  ✓ #9 mcporter call cloudbase.envQuery(action=info)");
}

/** 矩阵 #10a：Skills 注入创箱 env */
async function testSkillsInjectedOnInstanceEnv(handle) {
  const envSkills = await bash(handle, 'printf "%s" "$HARNESS_SKILLS_JSON" | head -c 800');
  assert.ok(
    envSkills.includes("harness-e2e-demo"),
    "HARNESS_SKILLS_JSON missing skill name on instance env",
  );
  console.log("  ✓ #10 HARNESS_SKILLS_JSON on instance env");
}

/** 矩阵 #10b：workspace/init 物化到 .agents/skills/ */
async function testSkillsMaterializedOnDisk(handle) {
  const skillPath = ".agents/skills/harness-e2e-demo/SKILL.md";
  const exists = await bash(handle, `test -f ${skillPath} && echo OK`);
  assert.ok(exists.includes("OK"), `${skillPath} not found after workspace/init`);

  const content = await bash(handle, `cat ${skillPath}`);
  const fixtureFirstLine = readFileSync(skillFixture, "utf8").trim().split("\n")[0];
  assert.ok(
    content.includes(fixtureFirstLine),
    `SKILL.md missing fixture heading; got: ${content.slice(0, 200)}`,
  );
  assert.ok(
    content.includes("HARNESS_SKILL_CHECK"),
    "SKILL.md missing fixture marker text",
  );
  console.log(`  ✓ #10 ${skillPath} content matches fixture`);
}

/** 矩阵 #10c：skill mirror 到 engine-native 路径 */
async function testSkillsMirroredToEngine(handle, engine) {
  const mirrorPath = ENGINE_SKILL_MIRROR[engine];
  assert.ok(mirrorPath, `no skill mirror path for engine ${engine}`);
  const exists = await bash(handle, `test -f ${mirrorPath} && echo OK`);
  assert.ok(exists.includes("OK"), `${mirrorPath} not found after workspace/init`);
  const content = await bash(handle, `cat ${mirrorPath}`);
  assert.ok(
    content.includes("HARNESS_SKILL_CHECK"),
    `${mirrorPath} missing fixture marker`,
  );
  console.log(`  ✓ #10 ${mirrorPath} mirrored for ${engine}`);
}

/** 矩阵 #1–#2 探针：TRW 内置 bash / write（不经 LLM） */
async function testTrwBuiltinBashWrite(handle) {
  const echoOut = await bash(handle, "echo MATRIX_TRW_BASH_OK");
  assert.ok(echoOut.includes("MATRIX_TRW_BASH_OK"), `bash echo failed: ${echoOut.slice(0, 200)}`);
  console.log("  ✓ TRW /api/tools/bash");

  const relPath = ".harness-matrix-write-probe.txt";
  const marker = `MATRIX_TRW_WRITE_${Date.now()}`;
  const writeJson = await postTool(handle, "write", { path: relPath, content: marker });
  const writeResult = writeJson.result ?? writeJson;
  assert.ok(
    writeResult.bytesWritten > 0 ||
      writeResult.created === true ||
      writeJson.bytesWritten > 0 ||
      writeJson.created === true,
    `write unexpected payload: ${JSON.stringify(writeJson).slice(0, 300)}`,
  );
  const readBack = await bash(handle, `cat ${relPath}`);
  assert.ok(readBack.includes(marker), `write/read mismatch: ${readBack.slice(0, 200)}`);
  console.log("  ✓ TRW /api/tools/write");
}

/** 箱内 engine 就绪 */
async function testEngineReady(handle, engine) {
  const spec = ENGINE_HEALTH[engine];
  assert.ok(spec, `unknown engine health spec: ${engine}`);
  let health = null;
  let status = 503;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await handle.request(spec.path);
    status = res.status;
    health = await res.json();
    if (status === 200 && spec.ready(health)) break;
    await sleep(2_000);
  }
  assert.equal(status, 200, `${engine} health HTTP ${status}`);
  assert.ok(spec.ready(health), `${engine} not ready: ${JSON.stringify(health).slice(0, 400)}`);
  console.log(`  ✓ ${engine} engine health (${spec.path})`);
}

async function runMatrixParityForEngine(engine) {
  const scenario = engine === "claude" ? "local-claude" : "local-opencode";
  applyHarnessScenario(scenario);

  let handle;
  try {
    handle = await acquireParitySandbox(engine);

    console.log(`\n=== matrix [${engine}] #8 external MCP (mcp_servers) ===`);
    await testMcpServersDeployed(handle);
    await testMcpServerToolsListable(handle);
    await testDualMcpEndpoints(handle);

    console.log(`\n=== matrix [${engine}] #9 CloudBase MCP (inject + verify) ===`);
    await testCloudbaseCredsOnInstanceEnv(handle);
    await testCloudbaseMcporterWiredAfterInit(handle);
    await testCloudbaseMcpToolsListable(handle);
    await testCloudbaseMcpHarmlessCall(handle);

    console.log(`\n=== matrix [${engine}] #10 Skills (inject + materialize) ===`);
    await testSkillsInjectedOnInstanceEnv(handle);
    await testSkillsMaterializedOnDisk(handle);
    await testSkillsMirroredToEngine(handle, engine);

    console.log(`\n=== matrix [${engine}] TRW builtin tools (bash / write) ===`);
    await testTrwBuiltinBashWrite(handle);

    console.log(`\n=== matrix [${engine}] engine readiness ===`);
    await testEngineReady(handle, engine);

    console.log(`\n✓ matrix parity [${engine}] #1–#2 #8 #9 #10 passed`);
  } finally {
    if (handle) {
      try {
        await handle.stop();
      } catch (err) {
        console.warn(`stop sandbox (${engine}):`, err.message);
      }
    }
  }
}

export async function runMatrixParityTests(enginesArg) {
  const { assertHarnessAgsRuntimeEnv } = await import(
    "../../packages/agent-runtime/dist/harness/harness-env.js"
  );
  assertHarnessAgsRuntimeEnv();

  const engines =
    enginesArg ??
    (process.argv.includes("--engines")
      ? parseHarnessEnginesArg(process.argv.slice(2))
      : "all");
  assertHarnessEnginesEnv(engines);

  const engineList = [];
  if (harnessEnginesIncludeOpencode(engines)) engineList.push("opencode");
  if (harnessEnginesIncludeClaude(engines)) engineList.push("claude");
  assert.ok(engineList.length > 0, `no engines selected from --engines ${engines}`);

  const { teardownHarnessSandboxes } = await import("../../scripts/harness/ags-teardown.mjs");
  console.log("teardown (pre-flight)…");
  await teardownHarnessSandboxes();

  for (const engine of engineList) {
    console.log(`\n══════════════════════════════════════`);
    console.log(` MATRIX PARITY — engine=${engine}`);
    console.log(`══════════════════════════════════════`);
    await runMatrixParityForEngine(engine);
  }

  try {
    console.log("teardown (post-flight)…");
    await teardownHarnessSandboxes();
  } catch (err) {
    console.warn("teardown:", err.message);
  }

  console.log(`\n✓ matrix parity complete (${engineList.join(" + ")})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMatrixParityTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
