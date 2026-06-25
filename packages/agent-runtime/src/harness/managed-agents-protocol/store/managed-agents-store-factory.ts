import { resolveCamControlPlaneCredentials } from "../../harness-env.js";
import { getHarnessSessionStore } from "../../sandbox/session-store.js";
import { getManagedAgentsDeploymentConfig } from "../deployment-config.js";
import { resolveHarnessEngineForMaSession } from "../resolve-session-agent-config.js";
import { createCmaMemoryStore } from "../vendor/cma-memory-store.js";
import type { CmaCreateSessionInput, CmaStore } from "../vendor/cma-store-types.js";
import { CloudBaseManagedAgentsStore } from "./cloudbase-managed-agents-store.js";

let _store: CmaStore | null = null;

async function ensureHarnessSessionRow(sessionId: string, store: CmaStore): Promise<void> {
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "default";
  const harnessStore = getHarnessSessionStore(envId);
  const existing = await harnessStore.get(sessionId);
  const base = getManagedAgentsDeploymentConfig();
  const engine = await resolveHarnessEngineForMaSession(base, store, sessionId);

  if (existing) return;

  await harnessStore.create({
    acpSessionId: sessionId,
    userId: "managed-agents",
    engine,
  });
}

function wrapHarnessLinked(store: CmaStore): CmaStore {
  const baseCreate = store.createSession.bind(store);
  store.createSession = async (input: CmaCreateSessionInput) => {
    const session = await baseCreate(input);
    await ensureHarnessSessionRow(session.id, store);
    return session;
  };
  return store;
}

function useMemoryStore(): boolean {
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
  if (!envId) return true;
  const cred = resolveCamControlPlaneCredentials();
  if (cred.secretId && cred.secretKey) return false;
  // No CAM credentials — but CLOUDBASE_APIKEY allows FlexDB via Bearer auth.
  if (process.env.CLOUDBASE_APIKEY?.trim()) return false;
  return true;
}

/** Singleton Managed Agents store for this runtime process. */
export function getManagedAgentsStore(): CmaStore {
  if (_store) return _store;
  const inner = useMemoryStore() ? createCmaMemoryStore() : new CloudBaseManagedAgentsStore();
  _store = wrapHarnessLinked(inner);
  return _store;
}

export function resetManagedAgentsStoreForTests(): void {
  _store = null;
}
