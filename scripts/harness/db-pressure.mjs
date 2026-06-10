#!/usr/bin/env node
/**
 * Optional DB pressure soak — default OFF.
 *
 *   npm run harness -- local --engines opencode --db-pressure
 *   npm run harness -- cloud-tcbr-claude --db-pressure --db-pressure-rounds 10
 *
 * Runs N independent sessions; reports FlexDB row counts / byte estimates per round.
 */
import { createCloudAcpClient, extractSseText } from "./cloud-acp-client.mjs";
import {
  waitForEngineSessionId,
  waitForOpencodeSyncEvents,
  waitForOpencodeSyncEventsRemote,
  waitForClaudeSessionEntries,
  measureOpencodeSyncFootprint,
  measureClaudeSessionFootprint,
  printDbPressureSummary,
} from "./db-metrics.mjs";

const DEFAULT_ROUNDS = 10;

export function parseDbPressureArgs(argv = []) {
  const enabled = argv.includes("--db-pressure");
  let rounds = DEFAULT_ROUNDS;
  const ri = argv.indexOf("--db-pressure-rounds");
  if (ri >= 0 && argv[ri + 1]) {
    rounds = Math.max(1, Number(argv[ri + 1]) || DEFAULT_ROUNDS);
  }
  return { enabled, rounds };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runCloudDbPressure(agentId, envId, engine, rounds) {
  console.log(`\n=== db-pressure cloud engine=${engine} rounds=${rounds} agent=${agentId} ===\n`);
  const client = createCloudAcpClient(envId, agentId);
  const samples = [];

  for (let round = 1; round <= rounds; round++) {
    const { sessionId } = await client.acpCall("session/new", {
      meta: { userId: `db-pressure-cloud-${round}` },
    });
    await client.waitSandboxReady(sessionId);
    const body = await client.promptSse(
      sessionId,
      `Round ${round}: reply with exactly the word ok`,
      500 + round,
    );
    if (!extractSseText(body).trim() && !body.includes("stopReason")) {
      console.warn(`round ${round}: weak LLM reply — still measuring DB footprint`);
    }
    await sleep(5000);

    const engineSessionId = await waitForEngineSessionId(envId, sessionId, 48);
    let metric;
    if (engine === "claude") {
      await waitForClaudeSessionEntries(engineSessionId, 1, 24).catch(() => {});
      metric = await measureClaudeSessionFootprint(engineSessionId);
    } else {
      await waitForOpencodeSyncEventsRemote(envId, engineSessionId, 18).catch(() => {});
      metric = await measureOpencodeSyncFootprint(envId, engineSessionId);
    }
    samples.push({ round, ...metric });
    console.log(
      `round ${round}/${rounds}: ${metric.collection} rows=${metric.rows} bytes~${metric.bytesEstimate}`,
    );
    await client.acpCall("session/delete", { sessionId }).catch(() => {});
    await sleep(2000);
  }

  printDbPressureSummary(engine, rounds, samples);
}

export async function maybeRunCloudDbPressure(agentId, envId, engine, argv) {
  const { enabled, rounds } = parseDbPressureArgs(argv);
  if (!enabled) return;
  await runCloudDbPressure(agentId, envId, engine, rounds);
}

/**
 * Local db-pressure while e2e runtime is still up (called from e2e.test.mjs).
 * @param {{ engine: string; rounds: number; envId: string; deps: object }} args
 */
export async function runE2eDbPressure({ engine, rounds, envId, deps }) {
  const {
    sleep,
    startRuntime,
    stopRuntime,
    rpc,
    promptSessionText,
    waitSandboxReady,
    agentConfig,
  } = deps;

  console.log(`\n=== db-pressure local engine=${engine} rounds=${rounds} ===\n`);
  stopRuntime();
  await sleep(500);
  await startRuntime({ useCloudDb: true, agentConfig });

  const samples = [];
  for (let round = 1; round <= rounds; round++) {
    const sessionId = crypto.randomUUID();
    await rpc("/acp", "session/new", { sessionId, meta: { userId: `db-pressure-${round}` } });
    await waitSandboxReady(sessionId);
    await sleep(3000);
    await promptSessionText(sessionId, `Round ${round}: reply with exactly the word ok`, 800 + round);
    await sleep(5000);

    const engineSessionId = await waitForEngineSessionId(envId, sessionId, 48);
    let metric;
    if (engine === "claude") {
      await waitForClaudeSessionEntries(engineSessionId, 1, 24).catch(() => {});
      metric = await measureClaudeSessionFootprint(engineSessionId);
    } else {
      await waitForOpencodeSyncEvents(envId, sessionId, engineSessionId, 18).catch(() => {});
      metric = await measureOpencodeSyncFootprint(envId, engineSessionId);
    }
    samples.push({ round, ...metric });
    console.log(
      `round ${round}/${rounds}: ${metric.collection} rows=${metric.rows} bytes~${metric.bytesEstimate}`,
    );
    await rpc("/acp", "session/delete", { sessionId }).catch(() => {});
    await sleep(1000);
  }

  printDbPressureSummary(engine, rounds, samples);
}
