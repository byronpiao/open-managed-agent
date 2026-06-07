#!/usr/bin/env node
/**
 * §7 harness cloud deploy: build runtime → tcbr agent:create|update → healthz → magent run pong.
 *
 *   node scripts/deploy-harness-cloud.mjs [--agent-id <id>]
 *
 * Requires .env + .env.harness (LLM_*, TCB_*, optional HARNESS_COS_* / HARNESS_TOOL_ID).
 * Set CLOUDBASE_SERVER_URL to the public gateway if re-updating an existing agent.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const runtimeRoot = resolve(repoRoot, "packages/agent-runtime");
const magent = resolve(repoRoot, "magent.mjs");

loadEnv();

const envId = process.env.CLOUDBASE_ENV_ID?.trim();
if (!envId) {
  console.error("Missing CLOUDBASE_ENV_ID");
  process.exit(1);
}

const agentIdArg = process.argv.includes("--agent-id")
  ? process.argv[process.argv.indexOf("--agent-id") + 1]
  : process.env.HARNESS_CLOUD_AGENT_ID?.trim();

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, { stdio: "inherit", cwd: repoRoot, ...opts });
}

async function buildAgentYaml() {
  const templatePath = resolve(runtimeRoot, "agent.harness.cloud.yaml");
  const { parse, stringify } = await import("yaml");
  const doc = parse(readFileSync(templatePath, "utf8"));
  const apiKey = process.env.LLM_API_KEY?.trim();
  const modelId = process.env.LLM_MODEL?.trim() || "mimo-v2.5";
  if (!apiKey) throw new Error("Missing LLM_API_KEY in .env.harness");
  doc.model = {
    id: modelId,
    apiKey,
    apiBaseUrl:
      process.env.ANTHROPIC_BASE_URL?.trim() ||
      "https://token-plan-cn.xiaomimimo.com/anthropic",
  };
  if (process.env.OPENAI_BASE_URL?.trim()) {
    doc.metadata = { ...(doc.metadata ?? {}), openaiBaseUrl: process.env.OPENAI_BASE_URL.trim() };
  }
  const out = resolve(runtimeRoot, "agent.harness.yaml");
  writeFileSync(out, stringify(doc));
  return out;
}

async function main() {
  console.log("=== build agent-runtime ===");
  sh("npm run build --workspace=packages/agent-runtime");

  const yamlPath = await buildAgentYaml();
  console.log(`Wrote ${yamlPath}`);

  let agentId = agentIdArg || process.env.HARNESS_CLOUD_AGENT_ID?.trim();

  if (agentId) {
    console.log(`=== magent agent:update ${agentId} ===`);
    sh(
      `node "${magent}" agent:update -i "${agentId}" -f "${yamlPath}" --runtime harness --engine opencode -e "${envId}"`,
    );
  } else {
    console.log("=== magent agent:create (tcbr harness, ~3–5 min) ===");
    const createOut = execSync(
      `node "${magent}" agent:create -n "OMA-Harness" --type tcbr --runtime harness --engine opencode -f "${yamlPath}" -e "${envId}"`,
      { encoding: "utf-8", cwd: repoRoot, env: process.env, maxBuffer: 20 * 1024 * 1024 },
    );
    console.log(createOut);
    const created = createOut.match(/Agent created:\s*(agent-[a-z0-9-]+)/i);
    agentId = created?.[1];
  }

  if (!agentId) {
    console.error("Could not resolve agent id — set HARNESS_CLOUD_AGENT_ID or use --agent-id");
    process.exit(1);
  }
  console.log(`\nAgent ID: ${agentId}`);

  let base = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (!base || base.includes("127.0.0.1") || base.includes("localhost")) {
    try {
      const detail = execSync(`node "${magent}" agent:get -i "${agentId}" -e "${envId}"`, {
        encoding: "utf-8",
      });
      const urlMatch = detail.match(/https:\/\/[^\s]+\.tcloudbase\.com[^\s]*/i);
      if (urlMatch) base = urlMatch[0].replace(/[)\],]+$/, "");
    } catch {
      /* agent:get may not print URL */
    }
  }

  if (base && !base.includes("127.0.0.1")) {
    console.log(`\n=== healthz ${base}/healthz ===`);
    process.env.CLOUDBASE_SERVER_URL = base;
    sh(`curl -sf "${base}/healthz" | head -c 800`);
    console.log("\n");
    sh(
      `node "${magent}" agent:update -i "${agentId}" -f "${yamlPath}" --runtime harness --engine opencode -e "${envId}"`,
      { env: { ...process.env, CLOUDBASE_SERVER_URL: base } },
    );
  } else {
    console.warn("WARN: set CLOUDBASE_SERVER_URL to public gateway for client-tool callback");
  }

  console.log("\n=== magent run pong ===");
  sh(`node "${magent}" run -a "${agentId}" -e "${envId}" -m "Reply with exactly: pong"`);
  console.log(`\n✓ Cloud harness smoke done. Agent: ${agentId}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
