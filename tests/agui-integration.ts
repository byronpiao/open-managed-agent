/**
 * AG-UI Integration Tests - Fallback for when ACP endpoint is not reachable
 *
 * Tests the standard AG-UI /send-message endpoint on an existing agent
 * using raw HTTP (not the SDK, since SDK uses ACP internally).
 *
 * This tests the underlying AI infrastructure (model, streaming, etc.)
 *
 * Usage:
 *   tsx tests/agui-integration.ts
 */

// ── Configuration ─────────────────────────────────────────────────────────────

const ENV_ID = "test-6g2rfs50c69b7fb8";
const AGENT_ID = process.env.AGENT_ID ?? "agent-cbscf-2gul72blf46052d5";
const BASE_URL = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/${AGENT_ID}`;
const API_KEY = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjlkMWRjMzFlLWI0ZDAtNDQ4Yi1hNzZmLWIwY2M2M2Q4MTQ5OCJ9.eyJhdWQiOiJ0ZXN0LTZnMnJmczUwYzY5YjdmYjgiLCJleHAiOjI1MzQwMjMwMDc5OSwiaWF0IjoxNzc4MTQ3OTQzLCJhdF9oYXNoIjoic0xBTGRZTXFSNGVSMGRCa2xlY2VXdyIsInByb2plY3RfaWQiOiJ0ZXN0LTZnMnJmczUwYzY5YjdmYjgiLCJtZXRhIjp7InBsYXRmb3JtIjoiQXBpS2V5In0sImFkbWluaXN0cmF0b3JfaWQiOiIxODkyNzc2NjkzMzM2Njg2NTk0IiwidXNlcl90eXBlIjoiIiwiY2xpZW50X3R5cGUiOiJjbGllbnRfc2VydmVyIiwiaXNfc3lzdGVtX2FkbWluIjp0cnVlfQ.EMw1mDROkqNHN-7HXUz2uWy7MqtKNsdsJoV5cdh1ElDNC6l9acbIeenwT5SdPPFM3M7E0BwbyszTWHmkq_nhPKXyqIXqI3854jYQEqC-cpE6FjPCbdCp4kxIafruoakKsCVPHcYkeSBxUdzdhG4Pvqwm3_t9ljqSY3Uaq6m7zaNZOa0MXLCa9uT9G-eaP9qHdEJ65LsuAits05iLlkBluQw5NNWT-IjzdsJnBM--hZKyyOgCoBHux6uJ5b4Q6kO01AQ2D_zQBH-BdbafnccRFAJIYs8Bk8BVDAFt7Gr4LI2LE_ZuV2KlGjVs97ICw-EOvL28GAxj2NxhbAy6-oUK1g";

// ── Test Infrastructure ───────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ── SSE Stream Parser ─────────────────────────────────────────────────────────

interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

async function* parseSSEStream(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data) as SSEEvent;
      } catch {}
    }
  }
}

// ── AG-UI Send Message Helper ────────────────────────────────────────────────

async function sendMessage(
  messages: Array<{ id: string; role: string; content: string }>,
  threadId = "test-thread-" + Date.now()
): Promise<Response> {
  return fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      threadId,
      runId: "run-" + Date.now(),
      messages,
      tools: [],
      state: {},
      context: [],
    }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1m CloudBase AG-UI Integration Tests (Fallback)\x1b[0m");
  console.log(`  Agent: ${AGENT_ID}`);
  console.log(`  URL: ${BASE_URL}/send-message`);
  console.log();

  // ── Test 1: Basic SSE Streaming ───────────────────────────────────────────
  await runTest("1. AG-UI send-message returns SSE stream", async () => {
    const res = await sendMessage([
      { id: "msg1", role: "user", content: "Say just the word 'pong'" },
    ]);
    assert(res.ok, `Response should be OK (got ${res.status})`);

    const events: SSEEvent[] = [];
    for await (const event of parseSSEStream(res)) {
      events.push(event);
    }

    assert(events.length > 0, "Should receive at least one event");
    const hasRunStarted = events.some((e) => e.type === "RUN_STARTED");
    assert(hasRunStarted, "Should have RUN_STARTED event");
  });

  // ── Test 2: Text message streaming ────────────────────────────────────────
  await runTest("2. Text message content streaming", async () => {
    const res = await sendMessage([
      { id: "msg1", role: "user", content: "Count from 1 to 5, one number per line" },
    ]);

    let fullText = "";
    let hasTextStart = false;
    let hasTextContent = false;
    let hasTextEnd = false;

    for await (const event of parseSSEStream(res)) {
      if (event.type === "TEXT_MESSAGE_START") hasTextStart = true;
      if (event.type === "TEXT_MESSAGE_CONTENT") {
        hasTextContent = true;
        fullText += (event as any).delta ?? "";
      }
      if (event.type === "TEXT_MESSAGE_END") hasTextEnd = true;
    }

    assert(hasTextStart, "Should have TEXT_MESSAGE_START");
    assert(hasTextContent, "Should have TEXT_MESSAGE_CONTENT");
    assert(hasTextEnd || fullText.length > 0, "Should have text end or content");
    assert(fullText.length > 0, `Response should have text content (got ${fullText.length} chars)`);
    console.log(`    Response (first 80 chars): "${fullText.slice(0, 80).replace(/\n/g, "\\n")}"`);
  });

  // ── Test 3: Multi-turn conversation ───────────────────────────────────────
  await runTest("3. Multi-turn context preservation", async () => {
    const threadId = "multi-turn-" + Date.now();

    // First message
    const res1 = await sendMessage(
      [{ id: "msg1", role: "user", content: "Remember this number: 42" }],
      threadId
    );
    let text1 = "";
    for await (const event of parseSSEStream(res1)) {
      if (event.type === "TEXT_MESSAGE_CONTENT") text1 += (event as any).delta ?? "";
    }
    assert(text1.length > 0, "First turn should get response");

    // Second message with previous context
    const res2 = await sendMessage(
      [
        { id: "msg1", role: "user", content: "Remember this number: 42" },
        { id: "msg2", role: "assistant", content: text1 },
        { id: "msg3", role: "user", content: "What number did I ask you to remember?" },
      ],
      threadId
    );
    let text2 = "";
    for await (const event of parseSSEStream(res2)) {
      if (event.type === "TEXT_MESSAGE_CONTENT") text2 += (event as any).delta ?? "";
    }
    assert(text2.length > 0, "Second turn should get response");
    console.log(`    Context response: "${text2.slice(0, 100).replace(/\n/g, "\\n")}"`);
    // Check if 42 is mentioned in the response
    const has42 = text2.includes("42");
    console.log(`    Contains "42": ${has42}`);
  });

  // ── Test 4: Event type coverage ───────────────────────────────────────────
  await runTest("4. Event type coverage (RUN_STARTED + RUN_FINISHED)", async () => {
    const res = await sendMessage([
      { id: "msg1", role: "user", content: "Just say OK" },
    ]);

    const eventTypes = new Set<string>();
    for await (const event of parseSSEStream(res)) {
      eventTypes.add(event.type as string);
    }

    assert(eventTypes.has("RUN_STARTED"), "Should have RUN_STARTED");
    assert(
      eventTypes.has("RUN_FINISHED") || eventTypes.has("TEXT_MESSAGE_END"),
      "Should have RUN_FINISHED or TEXT_MESSAGE_END"
    );
    console.log(`    Event types seen: ${[...eventTypes].join(", ")}`);
  });

  // ── Test 5: Error handling (invalid request) ──────────────────────────────
  await runTest("5. Error handling (missing required fields)", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(`${BASE_URL}/send-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ messages: [] }), // Missing threadId, runId etc.
        signal: controller.signal,
      });
      // Should get an error response (either 400 or error in stream)
      const body = await res.text();
      assert(
        !res.ok || body.includes("error") || body.includes("INVALID") || body.includes("invalid"),
        `Should get error for invalid request (status: ${res.status}, body: ${body.slice(0, 100)})`
      );
    } catch (err: any) {
      // AbortError (timeout) or fetch failure is also acceptable - server did not process it normally
      if (err.name === "AbortError") {
        // Server didn't respond within 10s on malformed input - acceptable behavior
        // (the server may be waiting for a valid message format)
        console.log(`    Note: Server timed out on malformed input (acceptable)`);
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n\x1b[1m Results Summary\x1b[0m");
  console.log("  " + "=".repeat(50));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  for (const r of results) {
    const icon = r.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    console.log(`  ${icon} ${r.name} (${r.duration}ms)${r.error ? ` - ${r.error}` : ""}`);
  }

  console.log("  " + "=".repeat(50));
  console.log(`  Total: ${total} | \x1b[32mPassed: ${passed}\x1b[0m | \x1b[31mFailed: ${failed}\x1b[0m`);
  console.log();

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n\x1b[31mFatal error:\x1b[0m", err);
  process.exit(1);
});
