/**
 * FlexDB footprint probes for harness session externalization (read-only).
 */

export async function waitForEngineSessionId(envId, acpSessionId, maxAttempts = 36) {
  const { getHarnessSessionStore } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/session-store.js"
  );
  for (let i = 0; i < maxAttempts; i++) {
    const row = await getHarnessSessionStore(envId).get(acpSessionId);
    if (row?.engineSessionId) return row.engineSessionId;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`engineSessionId not set for acp session ${acpSessionId}`);
}

export async function measureOpencodeSyncFootprint(envId, engineSessionId) {
  const { getHarnessSyncEventStore } = await import(
    "../../packages/agent-runtime/dist/harness/sync-event-store.js"
  );
  const events = await getHarnessSyncEventStore(envId).listEventsForAggregate(engineSessionId);
  const json = JSON.stringify(events);
  return {
    collection: "harness_sync_events",
    rows: events.length,
    bytesEstimate: Buffer.byteLength(json, "utf8"),
  };
}

export async function measureClaudeSessionFootprint(engineSessionId) {
  const { countHarnessClaudeSessionFootprint } = await import(
    "../../packages/agent-runtime/dist/harness/claude-session-probe.js"
  );
  const footprint = await countHarnessClaudeSessionFootprint(engineSessionId);
  return {
    collection: "harness_claude_session_entries",
    rows: footprint.entries,
    bytesEstimate: footprint.entries * 512,
    messages: footprint.messages,
  };
}

/** Poll FlexDB only — for cloud gateway verify (no local sandbox handle). */
export async function waitForOpencodeSyncEventsRemote(envId, engineSessionId, maxAttempts = 36) {
  const { getHarnessSyncEventStore } = await import(
    "../../packages/agent-runtime/dist/harness/sync-event-store.js"
  );
  const syncStore = getHarnessSyncEventStore(envId);
  for (let i = 0; i < maxAttempts; i++) {
    const events = await syncStore.listEventsForAggregate(engineSessionId);
    if (events.length > 0) return events;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return syncStore.listEventsForAggregate(engineSessionId);
}

/** Poll until opencode sync events appear (local — may trigger export from cached handle). */
export async function waitForOpencodeSyncEvents(envId, acpSessionId, engineSessionId, maxAttempts = 24) {
  const { getHarnessSyncEventStore } = await import(
    "../../packages/agent-runtime/dist/harness/sync-event-store.js"
  );
  const { exportOpencodeSyncEvents } = await import(
    "../../packages/agent-runtime/dist/harness/opencode-sync.js"
  );
  const { getCachedSandboxHandle } = await import(
    "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
  );
  const syncStore = getHarnessSyncEventStore(envId);
  for (let i = 0; i < maxAttempts; i++) {
    const handle = getCachedSandboxHandle(acpSessionId);
    if (handle) {
      await exportOpencodeSyncEvents({
        handle,
        syncStore,
        acpSessionId,
        aggregateId: engineSessionId,
      }).catch(() => {});
    }
    const events = await syncStore.listEventsForAggregate(engineSessionId);
    if (events.length > 0) return events;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const events = await syncStore.listEventsForAggregate(engineSessionId);
  return events;
}

export async function waitForClaudeSessionEntries(engineSessionId, minRows = 1, maxAttempts = 36) {
  const { countHarnessClaudeSessionEntries } = await import(
    "../../packages/agent-runtime/dist/harness/claude-session-probe.js"
  );
  for (let i = 0; i < maxAttempts; i++) {
    const n = await countHarnessClaudeSessionEntries(engineSessionId);
    if (n >= minRows) return n;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const n = await countHarnessClaudeSessionEntries(engineSessionId);
  if (n < minRows) {
    throw new Error(
      `expected >= ${minRows} harness_claude_session_entries for ${engineSessionId}, got ${n}`,
    );
  }
  return n;
}

export function printDbPressureSummary(engine, rounds, samples) {
  const totals = samples.reduce(
    (acc, s) => {
      acc.rows += s.rows;
      acc.bytes += s.bytesEstimate;
      return acc;
    },
    { rows: 0, bytes: 0 },
  );
  console.log(`\n=== db-pressure summary (${engine}, ${rounds} rounds) ===`);
  console.log("round | collection rows | bytes~");
  for (const s of samples) {
    console.log(
      `  ${String(s.round).padStart(2)} | ${s.collection} ${String(s.rows).padStart(4)} | ${s.bytesEstimate}`,
    );
  }
  console.log(
    `total rows~${totals.rows} bytes~${totals.bytes} avg/round rows~${Math.round(totals.rows / rounds)} bytes~${Math.round(totals.bytes / rounds)}`,
  );
  console.log("(harness_sessions: 1 row per ACP session — not re-counted per round)\n");
}
