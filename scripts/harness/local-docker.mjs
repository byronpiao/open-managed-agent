#!/usr/bin/env node
/**
 * Smoke harness runtime inside Docker (memory store, no FlexDB / no agent:create).
 *
 *   node scripts/harness/local-docker.mjs
 *   node scripts/harness/local-docker.mjs --keep
 */
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const composeFile = resolve(__dirname, "docker-compose.local.yml");
const repoRoot = resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:19090";

function composeCmd() {
  const r = spawnSync("docker", ["compose", "version"], { encoding: "utf-8" });
  if (r.status === 0) return ["docker", "compose"];
  const dc = spawnSync("which", ["docker-compose"], { encoding: "utf-8" }).stdout?.trim();
  if (dc) return [dc];
  throw new Error("need docker compose or docker-compose");
}

function compose(args, opts = {}) {
  const [bin, ...prefix] = composeCmd();
  sh(bin, [...prefix, "-f", composeFile, ...args], opts);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
}

async function waitHealthz() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      const j = await res.json();
      if (j.ok && j.runtime === "harness") return j;
    } catch {
      // retry
    }
    await sleep(1000);
  }
  throw new Error("harness runtime in docker did not become ready");
}

async function smokeAcp() {
  const res = await fetch(`${BASE}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "docker-smoke", version: "0" } },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`ACP initialize: ${j.error.message}`);
  if (j.result?.agentConfig?.runtime !== "harness") {
    throw new Error(`expected harness runtime, got ${j.result?.agentConfig?.runtime}`);
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  console.log("=== harness local-docker smoke ===\n");

  sh("npm", ["run", "build", "--workspace=packages/agent-runtime"]);
  compose(["up", "--build", "-d"]);

  try {
    const health = await waitHealthz();
    console.log(`✓ GET /healthz runtime=${health.runtime} engine=${health.engine}`);
    await smokeAcp();
    console.log("✓ POST /acp initialize (harness)");
    console.log("\n✓ local-docker smoke ok");
  } finally {
    if (!keep) {
      compose(["down"]);
    } else {
      console.log(`\n  kept container (--keep) — ${BASE}/healthz`);
    }
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  if (!process.argv.includes("--keep")) {
    try {
      compose(["down"]);
    } catch {
      // best effort
    }
  }
  process.exit(1);
});
