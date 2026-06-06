#!/usr/bin/env node
/**
 * Local harness parity smokes (AGS sandbox, no magent deploy):
 *   - mcp_servers → MCPORTER_CONFIG_CONTENT merge
 *   - Skills → .agents/skills/
 *   - CloudBase MCP → mcporter list cloudbase
 *
 *   node scripts/harness-parity-smoke.mjs
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, assertHarnessCreds } from "./load-env.mjs";

loadEnv();
assertHarnessCreds();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillFixture = resolve(repoRoot, "tests/fixtures/skills/harness-e2e-demo.md");

const MCP_FIXTURE_SERVER = "harness_fixture_http";
const MCP_FIXTURE_URL = "http://127.0.0.1:9000/mcp";

export function buildParityAgentConfig() {
  return {
    name: "HarnessParitySmoke",
    model: "hunyuan-t1-latest",
    system: "Harness parity smoke agent.",
    runtime: "harness",
    engine: "opencode",
    mcp_servers: [
      {
        type: "url",
        name: MCP_FIXTURE_SERVER,
        url: MCP_FIXTURE_URL,
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

export async function runHarnessParitySmokes() {
  const { getSandboxOrchestrator } = await import(
    "../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const { buildHarnessSandboxEnv } = await import(
    "../packages/agent-runtime/dist/harness/deploy.js"
  );

  const config = buildParityAgentConfig();
  const acpSessionId = crypto.randomUUID();
  const envId = process.env.CLOUDBASE_ENV_ID;
  const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "http://127.0.0.1:9000";

  console.log("parity: acquiring sandbox...");
  const orch = getSandboxOrchestrator();
  const handle = await orch.acquire({
    envId,
    agentConfig: config,
    engine: "opencode",
    acpSessionId,
    instanceEnv: buildHarnessSandboxEnv({
      config,
      engine: "opencode",
      clientToolCallbackBase: callbackBase,
      acpSessionId,
    }),
  });

  try {
    const mcporterRaw = await bash(handle, "cat .mcporter/mcporter.json 2>/dev/null || true");
    assert.ok(
      mcporterRaw.includes(MCP_FIXTURE_SERVER),
      `mcporter.json missing ${MCP_FIXTURE_SERVER} (rebuild magent image with TRW merge)`,
    );
    assert.ok(mcporterRaw.includes(MCP_FIXTURE_URL), "mcporter.json missing fixture URL");
    console.log("✓ mcp_servers merged into sandbox mcporter.json");

    const envSkills = await bash(
      handle,
      'echo -n "$HARNESS_SKILLS_JSON" | head -c 500',
    );
    assert.ok(
      envSkills.includes("harness-e2e-demo"),
      "HARNESS_SKILLS_JSON missing on sandbox (buildHarnessSandboxEnv)",
    );
    console.log("✓ HARNESS_SKILLS_JSON present on instance env");

    const skillPath = ".agents/skills/harness-e2e-demo/SKILL.md";
    const skillCheck = await bash(handle, `test -f ${skillPath} && echo SKILL_FILE_OK`);
    assert.ok(
      skillCheck.includes("SKILL_FILE_OK"),
      `${skillPath} missing — magent image must include TRW materializeHarnessSkills + workspace/init skills body`,
    );
    const skillFull = await bash(handle, `cat ${skillPath}`);
    const fixtureSnippet = readFileSync(skillFixture, "utf8").trim().slice(0, 80);
    assert.ok(
      skillFull.includes(fixtureSnippet.split("\n")[0]) ||
        skillFull.includes("materialized into the sandbox"),
      `SKILL.md content unexpected: ${skillFull.slice(0, 240)}`,
    );
    console.log("✓ skills materialized under .agents/skills/");

    const cloudbaseList = await bash(
      handle,
      "mcporter list cloudbase --schema --output json 2>/dev/null | head -c 4000",
    );
    assert.ok(
      cloudbaseList.length > 20,
      "cloudbase mcporter list empty — check workspace/init creds in instance env",
    );
    console.log("✓ cloudbase MCP schema list non-empty");

    console.log("✓ mcporter cloudbase + harness mcp_servers (json + schema)");
  } finally {
    try {
      await handle.stop();
    } catch (err) {
      console.warn("parity: stop skipped:", err.message);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHarnessParitySmokes().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
