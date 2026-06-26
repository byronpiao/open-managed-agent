/**
 * Sandbox operations — ensure sandbox, forward ACP, engine session management.
 * Extracted from acp-endpoint.ts for separation of concerns.
 */

import type { AgentConfig } from "../config.js";
import { resolveRuntime } from "../config.js";
import {
  buildHarnessAcpMcpServers,
  DEFAULT_HARNESS_SANDBOX_CWD,
} from "./deploy.js";
import {
  getSandboxOrchestrator,
  getCachedSandboxHandle,
  type HarnessSandboxHandle,
} from "./sandbox/orchestrator.js";
import {
  bindSandboxForSession,
  touchSandboxActivity,
  waitForSandboxPrewarm,
} from "./sandbox/sandbox-prewarm.js";
import {
  getHarnessSessionStore,
  type HarnessSessionRecord,
} from "./sandbox/session-store.js";
import { harnessLog } from "./observability/logging.js";

export function envIdFromConfig(): string {
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
  if (!envId) {
    throw Object.assign(new Error("CLOUDBASE_ENV_ID is required for harness runtime"), {
      rpcCode: -32000,
    });
  }
  return envId;
}

export function harnessCallbackBase(): string {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");
  const port = process.env.PORT ?? 9000;
  return `http://127.0.0.1:${port}`;
}

export async function ensureSandboxForSession(
  config: AgentConfig,
  acpSessionId: string,
): Promise<{
  handle: HarnessSandboxHandle;
  record: Awaited<ReturnType<ReturnType<typeof getHarnessSessionStore>["get"]>>;
  syncHydrated: number;
}> {
  const envId = envIdFromConfig();
  const store = getHarnessSessionStore(envId);
  let record = await store.get(acpSessionId);
  if (!record) {
    throw Object.assign(new Error(`Session not found: ${acpSessionId}`), { rpcCode: -32602 });
  }

  let handle = getCachedSandboxHandle(acpSessionId);
  let syncHydrated = 0;

  if (!handle) {
    await waitForSandboxPrewarm(acpSessionId);
    handle = getCachedSandboxHandle(acpSessionId);
  }

  if (!handle) {
    const bound = await bindSandboxForSession(config, acpSessionId);
    syncHydrated = bound.syncHydrated;
    handle = getCachedSandboxHandle(acpSessionId);
    if (!handle) {
      throw Object.assign(new Error(`Sandbox bind failed for ${acpSessionId}`), {
        rpcCode: -32000,
      });
    }
  } else {
    await handle.resumeIfPaused();
  }

  touchSandboxActivity(acpSessionId);
  record = (await store.get(acpSessionId)) ?? record;
  return { handle, record, syncHydrated };
}

export async function forwardAcpToSandbox(args: {
  handle: HarnessSandboxHandle;
  config: AgentConfig;
  method: string;
  params: Record<string, unknown>;
  id: unknown;
  acpSessionId: string;
  signal?: AbortSignal;
}): Promise<globalThis.Response> {
  const startedAt = Date.now();
  const wl = harnessLog({
    lane: "acp",
    operation: "sandbox.forward",
    acpSessionId: args.acpSessionId,
    sandboxMethod: args.method,
    instanceId: args.handle.instanceId,
    toolId: args.handle.toolId,
  });
  const orchestrator = getSandboxOrchestrator();
  const { engine } = resolveRuntime(args.config);
  const path = orchestrator.acpPathForEngine(engine);
  wl.set({ engine, acpPath: path });

  const body = {
    jsonrpc: "2.0",
    id: args.id,
    method: args.method,
    params: args.params,
  };

  try {
    const res = await args.handle.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: args.signal,
    });
    wl.set({
      httpStatus: res.status,
      contentType: res.headers.get("content-type") ?? "",
    });
    wl.emit({ status: res.ok ? "ok" : "http_error", durationMs: Date.now() - startedAt });
    return res;
  } catch (err) {
    wl.error(err);
    wl.emit({ status: "error", durationMs: Date.now() - startedAt });
    throw err;
  }
}

export async function ingestSsePayload(
  payload: Record<string, unknown>,
  acpSessionId: string,
  store: ReturnType<typeof getHarnessSessionStore>,
): Promise<void> {
  if (payload.result && typeof payload.result === "object") {
    const result = payload.result as Record<string, unknown>;
    if (typeof result.sessionId === "string") {
      await store.setEngineSessionId(acpSessionId, result.sessionId);
    }
  }
}

export async function drainAcpResponseBody(
  res: globalThis.Response,
): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("event-stream") || text.includes("data: ")) {
    for (const line of text.split("\n")) {
      let payload = line.trim();
      if (payload.startsWith("data:")) payload = payload.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        messages.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // skip heartbeats
      }
    }
    return messages;
  }
  if (text.trim()) {
    try {
      messages.push(JSON.parse(text) as Record<string, unknown>);
    } catch {
      // ignore non-json
    }
  }
  return messages;
}

export async function ensureEngineSessionOnSandbox(
  config: AgentConfig,
  acpSessionId: string,
  handle: HarnessSandboxHandle,
  record: HarnessSessionRecord,
  store: ReturnType<typeof getHarnessSessionStore>,
): Promise<string> {
  if (record.engineSessionId) return record.engineSessionId;

  const mcpServers = buildHarnessAcpMcpServers({
    config,
    clientToolCallbackBase: harnessCallbackBase(),
    acpSessionId,
  });

  const upstream = await forwardAcpToSandbox({
    handle,
    config,
    method: "session/new",
    params: {
      cwd: DEFAULT_HARNESS_SANDBOX_CWD,
      mcpServers,
      meta: { userId: record.userId },
    },
    id: crypto.randomUUID(),
    acpSessionId,
  });

  const messages = await drainAcpResponseBody(upstream);
  for (const msg of messages) {
    await ingestSsePayload(msg, acpSessionId, store);
    if (msg.error) {
      const err = msg.error as { message?: string; code?: number };
      throw Object.assign(new Error(err.message ?? "sandbox session/new failed"), {
        rpcCode: err.code ?? -32000,
      });
    }
  }

  const updated = await store.get(acpSessionId);
  return updated?.engineSessionId ?? acpSessionId;
}
