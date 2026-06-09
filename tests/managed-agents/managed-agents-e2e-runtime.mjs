/**
 * Boot full agent-runtime (index.js) for Managed Agents HTTP e2e.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const MANAGED_AGENTS_E2E_PORT = 19191;
export const MANAGED_AGENTS_E2E_BASE = `http://127.0.0.1:${MANAGED_AGENTS_E2E_PORT}`;

export const MANAGED_AGENTS_E2E_STUB_AGENT_CONFIG = {
  name: "ManagedAgentsHarnessE2E",
  system: "e2e",
  runtime: "harness",
  engine: "opencode",
  metadata: { harnessE2eStub: "1" },
  model: "stub",
};

let child;

export async function waitManagedAgentsRuntimeHealthz(base = MANAGED_AGENTS_E2E_BASE) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      const body = await res.json();
      if (body.ok && body.runtime === "harness") return body;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error("Managed Agents e2e runtime did not become ready");
}

export async function startManagedAgentsE2eRuntime({
  port = MANAGED_AGENTS_E2E_PORT,
  agentConfig = MANAGED_AGENTS_E2E_STUB_AGENT_CONFIG,
} = {}) {
  const base = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...process.env,
    PORT: String(port),
    CLOUDBASE_SERVER_URL: base,
    CLOUDBASE_ENV_ID: process.env.CLOUDBASE_ENV_ID ?? "managed-agents-e2e",
    OAK_USE_MEMORY_STORE: "1",
    AGENT_CONFIG: JSON.stringify(agentConfig),
  };

  child = spawn(process.execPath, ["packages/agent-runtime/dist/index.js"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  await waitManagedAgentsRuntimeHealthz(base);
  return { base, child };
}

export async function stopManagedAgentsE2eRuntime() {
  if (!child) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      resolve();
    }, 3000);
  });
  child = undefined;
}
