#!/usr/bin/env node
/**
 * Customer quick-start smoke — mirrors docs/harness-tutorial.md (no COS, platform LLM).
 *
 * Prereq (script does NOT run magent login):
 *   magent login && tcb env use <envId>
 *   — or export TCB_SECRET_ID/KEY + CLOUDBASE_ENV_ID + TCB_REGION
 *
 *   node scripts/harness/quickstart.mjs
 *   node scripts/harness/quickstart.mjs --keep-agent
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatHarnessPreflightReport,
  runHarnessDeployPreflight,
} from "../../lib/harness-preflight.mjs";
import {
  hydrateTcbApiKeyFromCam,
  assertHarnessCreds,
  applyHarnessScenario,
  logHarnessScenario,
  prepareQuickstartEnv,
} from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const magent = resolve(repoRoot, "magent.mjs");
const exampleYaml = resolve(repoRoot, "docs/examples/agent.sandbox.opencode.min.yaml");
const localYaml = resolve(repoRoot, "agent.sandbox.yaml");

function sh(cmd, env = process.env) {
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, { cwd: repoRoot, stdio: "inherit", env });
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function waitAgentReady(agentId, envId) {
  console.log(`\n=== wait Ready (~60–120s) ===`);
  const maxWait = Number(process.env.HARNESS_QUICKSTART_READY_MS) || 180_000;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWait) {
    const detail = execSync(`node "${magent}" agent:get -a "${agentId}" -e "${envId}"`, {
      encoding: "utf-8",
    });
    if (/Ready|就绪/i.test(detail) && !/Creating|Updating|Deleting/i.test(detail)) {
      console.log(`✓ agent ready ${Date.now() - t0}ms`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`agent ${agentId} not Ready within ${maxWait}ms`);
}

async function main() {
  console.log("=== harness quickstart (post-login customer smoke) ===\n");

  prepareQuickstartEnv();
  assertHarnessCreds();
  logHarnessScenario(applyHarnessScenario("quickstart"));
  await hydrateTcbApiKeyFromCam();

  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");

  console.log("=== deploy preflight (check-harness-ready) ===\n");
  const preflight = await runHarnessDeployPreflight({ envId });
  console.log(formatHarnessPreflightReport(preflight));
  console.log();
  if (!preflight.ok) {
    throw new Error("Deploy preflight failed — fix ✗ rows above (see docs/harness-credentials.md)");
  }

  if (!existsSync(exampleYaml)) {
    throw new Error(`Missing ${exampleYaml}`);
  }
  copyFileSync(exampleYaml, localYaml);
  console.log(`Wrote ${localYaml} (gitignored — from docs/examples)`);

  sh("npm run build --workspace=packages/agent-runtime");

  const suffix = Date.now().toString(36).slice(-8);
  const agentName = `qs-${suffix}`;
  let agentId;

  try {
    const createOut = execSync(
      `node "${magent}" agent:create --name "${agentName}" --runtime harness --engine opencode ` +
        `--file "${localYaml}" --code "${resolve(repoRoot, "packages/agent-runtime")}" -e "${envId}"`,
      { encoding: "utf-8", cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 },
    );
    console.log(createOut);
    agentId = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i)?.[1];
    if (!agentId) throw new Error("agent:create did not return agent id");

    await waitAgentReady(agentId, envId);

    console.log("\n=== smoke: uname ===");
    sh(
      `node "${magent}" run -a "${agentId}" -e "${envId}" ` +
        `-m "在沙箱里执行 uname -a，把输出原样返回。"`,
    );

    console.log("\n=== smoke: pong ===");
    sh(
      `node "${magent}" run -a "${agentId}" -e "${envId}" -m "只回复一个词：pong"`,
    );

    console.log(`\n✓ quickstart smoke ok — agent ${agentId}`);
  } finally {
    if (agentId && !hasFlag("--keep-agent")) {
      console.log(`\n=== cleanup: agent:delete ${agentId} ===`);
      sh(`node "${magent}" agent:delete -a "${agentId}" -e "${envId}"`);
    } else if (agentId) {
      console.log(`\n  kept agent ${agentId} (--keep-agent)`);
    }
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
