/**
 * Cloud gateway hard gates — parity with local e2e session externalization.
 */
import { createCloudAcpClient, extractSseText } from "./cloud-acp-client.mjs";
import {
  waitForEngineSessionId,
  waitForOpencodeSyncEventsRemote,
  waitForClaudeSessionEntriesForAcp,
} from "./db-metrics.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** opencode: harness_sync_events + session/load replay + token recall (local testSyncPersistence parity). */
export async function verifyCloudOpencodeSync(agentId, envId) {
  console.log("\n=== cloud verify: opencode sync externalization ===");
  const client = createCloudAcpClient(envId, agentId);
  const token = `SYN${Date.now().toString(36)}`;
  const { sessionId } = await client.acpCall("session/new", {
    meta: { userId: "harness-cloud-opencode-sync" },
  });
  await client.waitSandboxReady(sessionId);
  await sleep(5000);

  let firstText = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(5000);
    const body = await client.promptSse(
      sessionId,
      `Remember exactly this token: ${token}. Reply with OK only.`,
      301 + attempt,
    );
    firstText = extractSseText(body);
    if (firstText.trim()) break;
  }
  if (!firstText.trim()) {
    throw new Error(`opencode cloud sync: empty LLM reply`);
  }

  const engineSessionId = await waitForEngineSessionId(envId, sessionId);
  const events = await waitForOpencodeSyncEventsRemote(envId, engineSessionId);
  if (!events.length) {
    throw new Error(
      `opencode cloud sync: no harness_sync_events for ${engineSessionId} (opencode >= 1.16.2)`,
    );
  }
  const blob = JSON.stringify(events);
  if (!blob.includes(token)) {
    throw new Error(`opencode cloud sync: token ${token} missing from harness_sync_events`);
  }
  console.log(`✓ harness_sync_events rows=${events.length} aggregate=${engineSessionId}`);

  const loadBody = await client.sessionLoadReplay(sessionId);
  if (loadBody.includes('"error"')) {
    throw new Error(`session/load replay error: ${loadBody.slice(0, 400)}`);
  }
  console.log("✓ session/load replay (gateway)");

  await client.waitSandboxReady(sessionId);
  await sleep(5000);
  const pongBody = await client.promptSse(sessionId, "Reply with exactly: pong", 302);
  if (!extractSseText(pongBody).trim() && !pongBody.includes("stopReason")) {
    throw new Error(`post-reload pong failed: ${pongBody.slice(0, 300)}`);
  }
  console.log("✓ post-reload prompt ok");

  let recalled = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(5000);
    const recallBody = await client.promptSse(
      sessionId,
      `What is the exact token I asked you to remember? Reply with ONLY that token.`,
      303 + attempt,
    );
    const recallText = extractSseText(recallBody);
    if (recallText.includes(token) || recallBody.includes(token)) {
      recalled = true;
      break;
    }
  }
  if (!recalled) {
    throw new Error(`opencode cloud: token recall failed for ${token}`);
  }
  console.log(`✓ token recall after session/load (${token})`);

  await client.acpCall("session/delete", { sessionId }).catch(() => {});
  console.log("✓ cloud opencode sync verify ok\n");
}

/** claude: harness_claude_session_entries + session/load + token recall. */
export async function verifyCloudClaudeSessionStore(agentId, envId) {
  console.log("\n=== cloud verify: claude SessionStore ===");
  const client = createCloudAcpClient(envId, agentId);
  const token = `CLD${Date.now().toString(36)}`;
  const { sessionId } = await client.acpCall("session/new", {
    meta: { userId: "harness-cloud-claude-store" },
  });
  await client.waitSandboxReady(sessionId);
  await sleep(8000);

  let firstText = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(5000);
    const body = await client.promptSse(
      sessionId,
      `Remember exactly this token: ${token}. Reply with OK only.`,
      401 + attempt,
    );
    firstText = extractSseText(body);
    if (firstText.trim()) break;
  }
  if (!firstText.trim()) {
    throw new Error("claude cloud: first prompt produced no LLM text");
  }

  const engineSessionId = await waitForEngineSessionId(envId, sessionId);
  const { entries: entryCount, engineSessionId: polledEngineId } =
    await waitForClaudeSessionEntriesForAcp(envId, sessionId);
  console.log(
    `✓ harness_claude_session_entries rows=${entryCount} engineSessionId=${polledEngineId ?? engineSessionId}`,
  );

  const { getHarnessSessionStore } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  const row = await getHarnessSessionStore(envId).get(sessionId);
  if (row?.claudeStoreEmptyAt) {
    throw new Error(`claude cloud: claudeStoreEmptyAt set on harness_sessions`);
  }

  const loadBody = await client.sessionLoadReplay(sessionId);
  if (loadBody.includes('"code":-32000')) {
    throw new Error(`claude session/load failed: ${loadBody.slice(0, 400)}`);
  }
  console.log("✓ session/load replay (gateway)");

  await client.waitSandboxReady(sessionId);
  await sleep(8000);

  let recalled = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(5000);
    const recallBody = await client.promptSse(
      sessionId,
      `What is the exact token I asked you to remember? Reply with ONLY that token.`,
      402 + attempt,
    );
    const recallText = extractSseText(recallBody);
    if (recallText.includes(token) || recallBody.includes(token)) {
      recalled = true;
      break;
    }
  }
  if (!recalled) {
    throw new Error(`claude cloud: token recall failed for ${token}`);
  }
  console.log(`✓ token recall after session/load (${token})`);

  await client.acpCall("session/delete", { sessionId }).catch(() => {});
  console.log("✓ cloud claude SessionStore verify ok\n");
}
