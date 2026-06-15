/**
 * Read-only probe for harness_claude_session_entries (e2e / debug).
 */

import { resolveCamControlPlaneCredentials } from "./harness-env.js";

const PREFIX = "harness_claude_";

interface CloudBaseCredentials {
  envId: string;
  secretId: string;
  secretKey: string;
  sessionToken?: string;
  region?: string;
}

function encodeSessionKey(projectKey: string, sessionId: string, subpath?: string): string {
  const base = `${projectKey}|${sessionId}`;
  return subpath ? `${base}|${subpath}` : base;
}

/** Count transcript entries for engine session (main transcript only). */
export async function countHarnessClaudeSessionEntries(engineSessionId: string): Promise<number> {
  const footprint = await countHarnessClaudeSessionFootprint(engineSessionId);
  return footprint.entries;
}

export interface ClaudeSessionFootprint {
  entries: number;
  messages: number;
}

/** Count harness_claude_* rows for ops / db-pressure (entries + messages). */
export async function countHarnessClaudeSessionFootprint(
  engineSessionId: string,
): Promise<ClaudeSessionFootprint> {
  const creds = resolveCamControlPlaneCredentials();
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
  if (!creds.secretId || !creds.secretKey || !envId) {
    return { entries: 0, messages: 0 };
  }

  const projectKey = envId;
  const sessionKey = encodeSessionKey(projectKey, engineSessionId);

  const mod = await import("@cloudbase/node-sdk");
  const app = mod.default.init({
    env: envId,
    secretId: creds.secretId,
    secretKey: creds.secretKey,
    sessionToken: creds.sessionToken,
    region: process.env.TCB_REGION ?? "ap-shanghai",
  });
  const db = app.database();

  async function countCollection(suffix: string): Promise<number> {
    const col = db.collection(`${PREFIX}${suffix}`);
    const res = await col.where({ sessionKey }).limit(500).get();
    const data = (res as { data?: unknown[] }).data;
    return Array.isArray(data) ? data.length : 0;
  }

  const [entries, messages] = await Promise.all([
    countCollection("session_entries"),
    countCollection("session_messages"),
  ]);
  return { entries, messages };
}
