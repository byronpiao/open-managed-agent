#!/usr/bin/env node
/**
 * Customer quick-start smoke — mirrors docs/harness-tutorial.md (no COS, platform LLM).
 *
 *   node scripts/harness/quickstart.mjs
 *   node scripts/harness/quickstart.mjs --keep-agent
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEnv,
  hydrateTcbApiKeyFromCam,
  assertHarnessCreds,
  applyHarnessScenario,
  logHarnessScenario,
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

async function main() {
  loadEnv();
  assertHarnessCreds();
  logHarnessScenario(applyHarnessScenario("quickstart"));
  await hydrateTcbApiKeyFromCam();

  const envId = process.env.CLOUDBASE_ENV_ID?.trim();
  if (!envId) throw new Error("Missing CLOUDBASE_ENV_ID");

  if (!existsSync(exampleYaml)) {
    throw new Error(`Missing ${exampleYaml}`);
  }
  copyFileSync(exampleYaml, localYaml);
  console.log(`Wrote ${localYaml} (gitignored — from docs/examples)`);

  sh("npm run build --workspace=packages/agent-runtime");

  const suffix = Date.now().toString(36).slice(-8);
  const createOut = execSync(
    `node "${magent}" agent:create --name "deliv-${suffix}" --runtime harness --engine opencode ` +
      `--file "${localYaml}" --code "${resolve(repoRoot, "packages/agent-runtime")}" -e "${envId}"`,
    { encoding: "utf-8", cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 },
  );
  console.log(createOut);
  const agentId = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i)?.[1];
  if (!agentId) throw new Error("agent:create did not return agent id");

  console.log(`\n=== wait Ready (~60–120s) ===`);
  const maxWait = Number(process.env.HARNESS_QUICKSTART_READY_MS) || 180_000;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWait) {
    const detail = execSync(`node "${magent}" agent:get -a "${agentId}" -e "${envId}"`, {
      encoding: "utf-8",
    });
    if (/Ready|就绪/i.test(detail) && !/Creating|Updating|Deleting/i.test(detail)) {
      console.log(`✓ agent ready ${Date.now() - t0}ms`);
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  sh(
    `node "${magent}" run -a "${agentId}" -e "${envId}" -m "Run uname -a in sandbox and show output"`,
  );

  console.log(`\n✓ quickstart smoke ok — agent ${agentId}`);
  if (!hasFlag("--keep-agent")) {
    console.log("  (pass --keep-agent to retain; otherwise delete in console when done)");
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
