import { resolveCamControlPlaneCredentials } from "../../harness/harness-env.js";
import { getHarnessSessionStore } from "../../harness/sandbox/session-store.js";
import { createCmaMemoryStore } from "../vendor/cma-memory-store.js";
import type { CmaCreateSessionInput, CmaStore } from "../vendor/cma-store-types.js";
import { CloudBaseManagedAgentsStore } from "./cloudbase-managed-agents-store.js";

let _store: CmaStore | null = null;

async function ensureHarnessSessionRow(sessionId: string): Promise<void> {
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "default";
  const harnessStore = getHarnessSessionStore(envId);
  const existing = await harnessStore.get(sessionId);
  if (existing) return;
  await harnessStore.create({
    acpSessionId: sessionId,
    userId: "managed-agents",
    engine: "opencode",
  });
}

function wrapHarnessLinked(store: CmaStore): CmaStore {
  const baseCreate = store.createSession.bind(store);
  store.createSession = async (input: CmaCreateSessionInput) => {
    const session = await baseCreate(input);
    await ensureHarnessSessionRow(session.id);
    return session;
  };
  return store;
}

function useMemoryStore(): boolean {
  if (process.env.OAK_USE_MEMORY_STORE === "1") return true;
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
  if (!envId) return true;
  const cred = resolveCamControlPlaneCredentials();
  return !cred.secretId || !cred.secretKey;
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
