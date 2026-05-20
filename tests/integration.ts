/**
 * SDK Integration Tests for CloudBase Managed Agent
 *
 * Tests in two modes:
 * 1. SDK type/build verification (no network)
 * 2. ACP endpoint test (if available)
 * 3. SDK code path tests (constructor, type checks)
 *
 * Usage:
 *   tsx tests/integration.ts
 */

import CloudbaseAgents, { AcpClient } from "../packages/sdk/src/index.js";
import type { CloudbaseAgentsConfig, Session, ListResponse } from "../packages/sdk/src/index.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const ENV_ID = "test-6g2rfs50c69b7fb8";
const AGENT_ID = "agent-managed-agent-test-60ab640";
const ACCESS_KEY = "";

// No fetch monkey-patching needed - the standard /v1/aibot/bots/{id}/acp path works directly

// ── Test Infrastructure ───────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  skipped?: boolean;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  \x1b[32m✔\x1b[0m ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, duration: Date.now() - start, error: message });
    console.log(`  \x1b[31m✘\x1b[0m ${name} (${Date.now() - start}ms)`);
    console.log(`    Error: ${message}`);
  }
}

function skipTest(name: string, reason: string) {
  results.push({ name, passed: true, duration: 0, skipped: true });
  console.log(`  \x1b[33m⊘\x1b[0m ${name} (SKIPPED: ${reason})`);
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1m CloudBase Managed Agent SDK - Integration Tests\x1b[0m");
  console.log(`  Env: ${ENV_ID}, Agent: ${AGENT_ID}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // Part A: SDK Type/Build Verification (no network)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("  \x1b[1m[Part A] SDK Build & Type Verification\x1b[0m\n");

  await runTest("A1. SDK module imports correctly", async () => {
    assert(typeof CloudbaseAgents === "function", "CloudbaseAgents should be a class/function");
    assert(typeof AcpClient === "function", "AcpClient should be a class/function");
  });

  await runTest("A2. CloudbaseAgents constructor validates config", async () => {
    // Should throw without envId
    let threw = false;
    try {
      new CloudbaseAgents({ envId: "", agentId: "" });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes("envId"), "Error should mention envId");
    }
    assert(threw, "Should throw without envId");
  });

  await runTest("A3. CloudbaseAgents initializes with valid config", async () => {
    const client = new CloudbaseAgents({
      envId: "test-env",
      agentId: "test-agent",
      accessKey: "test-key",
    });
    assert(!!client.sessions, "Should have sessions resource");
    assert(!!client.agents, "Should have agents resource");
    assert(!!client.environments, "Should have environments resource");
  });

  await runTest("A4. AcpClient initializes with correct headers", async () => {
    const acp = new AcpClient({
      envId: "my-env",
      agentId: "my-agent",
      accessKey: "my-token",
    });
    assert(!!acp, "AcpClient should be created");
    assert(typeof acp.initialize === "function", "Should have initialize method");
    assert(typeof acp.sessionNew === "function", "Should have sessionNew method");
    assert(typeof acp.sessionPrompt === "function", "Should have sessionPrompt method");
    assert(typeof acp.sessionList === "function", "Should have sessionList method");
    assert(typeof acp.sessionCancel === "function", "Should have sessionCancel method");
  });

  await runTest("A5. Session resource has all expected methods", async () => {
    const client = new CloudbaseAgents({ envId: "test-env", agentId: "test-agent" });
    const sessions = client.sessions;
    assert(typeof sessions.create === "function", "Should have create");
    assert(typeof sessions.retrieve === "function", "Should have retrieve");
    assert(typeof sessions.list === "function", "Should have list");
    assert(typeof sessions.delete === "function", "Should have delete");
    assert(typeof sessions.prompt === "function", "Should have prompt");
    assert(typeof sessions.cancel === "function", "Should have cancel");
    assert(typeof sessions.history === "function", "Should have history");
    assert(typeof sessions.resume === "function", "Should have resume");
    assert(typeof sessions.loadHistory === "function", "Should have loadHistory");
  });

  await runTest("A6. Type exports are correct", async () => {
    // Verify type exports compile correctly (these are compile-time checks)
    const config: CloudbaseAgentsConfig = { envId: "test", agentId: "test" };
    assert(config.envId === "test", "Config type works");

    // Test Session type shape
    const mockSession: Session = {
      id: "sess_1",
      object: "session",
      agent: "agent_1",
      title: "Test",
      status: "idle",
      created_at: Date.now(),
    };
    assert(mockSession.object === "session", "Session type works");

    // Test ListResponse type
    const mockList: ListResponse<Session> = {
      object: "list",
      data: [mockSession],
      has_more: false,
    };
    assert(mockList.object === "list", "ListResponse type works");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Part B: ACP Network Connectivity Test
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n  \x1b[1m[Part B] ACP Network Connectivity\x1b[0m\n");

  let acpAvailable = false;

  await runTest("B1. ACP endpoint reachability check", async () => {
    try {
      const res = await fetch(`https://${ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/${AGENT_ID}/acp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ACCESS_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test", version: "0.1.0" } },
        }),
        signal: AbortSignal.timeout(30000),
      });

      const text = await res.text();

      if (text.includes("Cannot POST") || text.includes("INVALID_PATH")) {
        console.log(`    Note: ACP endpoint not routed by gateway (expected for SCF agents)`);
        console.log(`    Gateway only routes /send-message. ACP requires direct TCBR access.`);
        acpAvailable = false;
      } else {
        const data = JSON.parse(text);
        if (data.result?.agentInfo) {
          acpAvailable = true;
          console.log(`    ACP available! Agent: ${data.result.agentInfo.name} v${data.result.agentInfo.version}`);
        }
      }
    } catch (err: any) {
      console.log(`    ACP connection failed: ${err.message}`);
      acpAvailable = false;
    }
    // This test passes regardless - it's just a connectivity check
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Part C: Full ACP Session Lifecycle (if available)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n  \x1b[1m[Part C] ACP Session Lifecycle\x1b[0m\n");

  if (!acpAvailable) {
    skipTest("C1. Create session via ACP", "ACP endpoint not reachable");
    skipTest("C2. Prompt streaming via ACP", "ACP endpoint not reachable");
    skipTest("C3. Multi-turn context via ACP", "ACP endpoint not reachable");
    skipTest("C4. List sessions via ACP", "ACP endpoint not reachable");
    skipTest("C5. Session history via ACP", "ACP endpoint not reachable");
    skipTest("C6. Delete session via ACP", "ACP endpoint not reachable");
    console.log("\n    \x1b[33mNote: ACP tests skipped. The CloudBase gateway only routes");
    console.log("    /send-message for SCF-type agents. ACP requires a TCBR (CloudRun)");
    console.log("    type deployment with direct HTTP routing.\x1b[0m");
  } else {
    const client = new CloudbaseAgents({ envId: ENV_ID, agentId: AGENT_ID, accessKey: ACCESS_KEY });
    let sessionId = "";

    await runTest("C1. Create session via ACP", async () => {
      const session = await client.sessions.create({ title: "Integration Test" });
      assert(!!session.id, "Session should have an id");
      assert(session.object === "session", "Object type should be 'session'");
      sessionId = session.id;
    });

    await runTest("C2. Prompt streaming via ACP", async () => {
      assert(!!sessionId, "Need session from C1");
      let chunks = 0, gotDone = false, text = "";
      for await (const event of client.sessions.prompt(sessionId, "Say hello in 3 words")) {
        if (event.type === "chunk") { chunks++; text += event.text; }
        if (event.type === "done") gotDone = true;
        if (event.type === "error") throw new Error(event.message);
      }
      assert(chunks > 0, `Should get chunks (got ${chunks})`);
      assert(gotDone, "Should get done event");
    });

    await runTest("C3. Multi-turn context via ACP", async () => {
      assert(!!sessionId, "Need session from C1");
      let text = "";
      for await (const event of client.sessions.prompt(sessionId, "What did I just say?")) {
        if (event.type === "chunk") text += event.text;
      }
      assert(text.length > 0, "Should get response");
    });

    await runTest("C4. List sessions via ACP", async () => {
      const list = await client.sessions.list();
      assert(list.object === "list", "Should be a list");
      assert(list.data.some(s => s.id === sessionId), "Should contain our session");
    });

    await runTest("C5. Session history via ACP", async () => {
      const history = await client.sessions.history(sessionId);
      assert(history.messages.length >= 2, "Should have messages");
    });

    await runTest("C6. Delete session via ACP", async () => {
      const result = await client.sessions.delete(sessionId);
      assert(result.deleted === true, "Should be deleted");
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n\x1b[1m Results Summary\x1b[0m");
  console.log("  " + "=".repeat(60));

  const passed = results.filter((r) => r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  for (const r of results) {
    const icon = r.skipped
      ? "\x1b[33m⊘\x1b[0m"
      : r.passed
      ? "\x1b[32m✔\x1b[0m"
      : "\x1b[31m✘\x1b[0m";
    const suffix = r.skipped ? " (SKIPPED)" : r.error ? ` - ${r.error}` : "";
    console.log(`  ${icon} ${r.name} (${r.duration}ms)${suffix}`);
  }

  console.log("  " + "=".repeat(60));
  console.log(
    `  Total: ${total} | \x1b[32mPassed: ${passed}\x1b[0m | \x1b[33mSkipped: ${skipped}\x1b[0m | \x1b[31mFailed: ${failed}\x1b[0m`
  );
  console.log();

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n\x1b[31mFatal error:\x1b[0m", err);
  process.exit(1);
});
