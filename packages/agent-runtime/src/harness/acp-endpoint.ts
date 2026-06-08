/**
 * Harness runtime ACP gateway — forwards to in-sandbox engine ACP server.
 * Reuses acp-shared wire helpers; session index is harness_sessions (not oak_*).
 */

import type { Express, Request, Response } from "express";
import type { AgentConfig } from "../config.js";
import { resolveRuntime } from "../config.js";
import {
  buildHarnessAcpMcpServers,
  DEFAULT_HARNESS_SANDBOX_CWD,
} from "./deploy.js";
import { startSandboxMcpPump } from "./mcp-pump.js";
import {
  deliverClientToolResult,
  registerActivePrompt,
  unregisterActivePrompt,
} from "./client-tool-bridge.js";
import {
  isAcpUuid,
  rpcError,
  rpcResult,
  sseDone,
  sseStart,
  sseWrite,
} from "../acp-shared.js";
import {
  getSandboxOrchestrator,
  getCachedSandboxHandle,
  dropCachedSandboxHandle,
  type HarnessSandboxHandle,
} from "./sandbox/orchestrator.js";
import { isE2eStubSandboxEnabled } from "./sandbox/e2e-stub.js";
import {
  bindSandboxForSession,
  clearSandboxPrewarmState,
  isSandboxPrewarmInFlight,
  isSandboxReadyForSession,
  startSandboxPrewarm,
  touchSandboxActivity,
  waitForSandboxPrewarm,
} from "./sandbox/sandbox-prewarm.js";
import {
  getHarnessSessionStore,
  type HarnessSessionRecord,
} from "./sandbox/session-store.js";
import { isScfServerless } from "./harness-env.js";
import { harnessLog, runWithHarnessRequestContext } from "./logging.js";
import {
  persistOpencodeSyncForSession,
  snapshotWorkspaceIfAvailable,
} from "./opencode-sync.js";

const abortControllers = new Map<string, AbortController>();

function envIdFromConfig(): string {
  const envId = process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "";
  if (!envId) {
    throw Object.assign(new Error("CLOUDBASE_ENV_ID is required for harness runtime"), {
      rpcCode: -32000,
    });
  }
  return envId;
}

function harnessCallbackBase(): string {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");
  const port = process.env.PORT ?? 9000;
  return `http://127.0.0.1:${port}`;
}

function handleInitialize(params: Record<string, unknown>, config: AgentConfig) {
  const { runtime, engine } = resolveRuntime(config);
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { list: true },
    },
    agentInfo: {
      name: config.name ?? process.env.AGENT_NAME ?? "open-managed-agent",
      title: config.description ?? "OpenManagedAgent (沙箱 Agent)",
      version: "0.1.0",
    },
    agentConfig: { ...config, runtime, engine },
    authMethods: [],
    supportedModels: [],
  };
}

async function ensureSandboxForSession(
  config: AgentConfig,
  acpSessionId: string,
): Promise<{
  handle: HarnessSandboxHandle;
  record: Awaited<ReturnType<ReturnType<typeof getHarnessSessionStore>["get"]>>;
  /** Events replayed via HTTP /sync/replay on this acquire (0 if cached handle). */
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

async function forwardAcpToSandbox(args: {
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

async function ingestSsePayload(
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

async function drainAcpResponseBody(
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

/** First prompt must create engine-side session in sandbox (gateway UUID ≠ engine session). */
async function ensureEngineSessionOnSandbox(
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

/** Live SSE flush — required for in-band client-tool bridge (tool_use_request mid-prompt). */
function makeHarnessStreamingSseSink(res: Response) {
  return {
    write: (frame: unknown) => {
      sseWrite(res, frame);
    },
    flush: () => {},
    getAll: () => "",
  };
}

async function pipeSandboxSseToClient(
  upstream: globalThis.Response,
  res: Response,
  rpcId: unknown,
  acpSessionId: string,
  store: ReturnType<typeof getHarnessSessionStore>,
  config: AgentConfig,
): Promise<void> {
  const startedAt = Date.now();
  const wl = harnessLog({
    lane: "acp",
    operation: "sse.pipe",
    acpSessionId,
    rpcId,
  });
  const sse = makeHarnessStreamingSseSink(res);
  sseStart(res);
  registerActivePrompt(acpSessionId, (frame) => sse.write(frame));
  const sandboxHandle = getCachedSandboxHandle(acpSessionId);
  const mcpPump =
    sandboxHandle &&
    startSandboxMcpPump({
      handle: sandboxHandle,
      acpSessionId,
      config,
      callbackBase: harnessCallbackBase(),
    });

  let sseFrames = 0;
  let permissionFrames = 0;
  const sseUpdateTypes = new Set<string>();

  const noteSessionUpdate = (payload: Record<string, unknown>) => {
    const su = (payload.params as { update?: { sessionUpdate?: string } } | undefined)?.update
      ?.sessionUpdate;
    if (su) sseUpdateTypes.add(su);
  };

  try {
    if (!upstream.ok) {
      const text = await upstream.text();
      wl.set({ httpStatus: upstream.status, errorBody: text.slice(0, 500) });
      wl.emit({ status: "error", durationMs: Date.now() - startedAt });
      sse.write(
        rpcError(rpcId, -32000, `Sandbox ACP error HTTP ${upstream.status}: ${text.slice(0, 500)}`),
      );
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const body = upstream.body;

    if (body && contentType.includes("text/event-stream")) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawResult = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payloadRaw = trimmed.slice(6).trim();
          if (payloadRaw === "[DONE]") continue;
          try {
            const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
            if (payload.result !== undefined) sawResult = true;
            sseFrames++;
            noteSessionUpdate(payload);
            if (
              (payload.params as Record<string, unknown> | undefined)?.update &&
              typeof (payload.params as { update?: { sessionUpdate?: string } }).update
                ?.sessionUpdate === "string" &&
              (payload.params as { update: { sessionUpdate: string } }).update.sessionUpdate ===
                "permission_request"
            ) {
              permissionFrames++;
            }
            await ingestSsePayload(payload, acpSessionId, store);
            sse.write(payload);
          } catch {
            // skip
          }
        }
      }
      if (!sawResult) {
        sse.write(rpcResult(rpcId, { stopReason: "end_turn" }));
      }
      wl.set({
        sseFrames,
        permissionFrames,
        sawResult,
        sseUpdateTypes: [...sseUpdateTypes],
      });
      wl.emit({ status: "sse", durationMs: Date.now() - startedAt });
      return;
    }

    const text = await upstream.text();
    if (text.includes("data: ")) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payloadRaw = trimmed.slice(6).trim();
        if (payloadRaw === "[DONE]") continue;
        try {
          const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
          noteSessionUpdate(payload);
          await ingestSsePayload(payload, acpSessionId, store);
          sse.write(payload);
        } catch {
          // skip
        }
      }
    } else {
      try {
        const json = JSON.parse(text) as { result?: Record<string, unknown>; error?: unknown };
        if (json.result?.sessionId && typeof json.result.sessionId === "string") {
          await store.setEngineSessionId(acpSessionId, json.result.sessionId);
        }
        sse.write(rpcResult(rpcId, json.result ?? json));
      } catch {
        sse.write(rpcError(rpcId, -32000, text.slice(0, 500)));
      }
    }
    wl.set({
      sseFrames,
      permissionFrames,
      sseUpdateTypes: [...sseUpdateTypes],
    });
    wl.emit({ status: "sse", durationMs: Date.now() - startedAt });
  } finally {
    mcpPump?.stop();
    unregisterActivePrompt(acpSessionId);
    sseDone(res, sse);
    touchSandboxActivity(acpSessionId);
    void persistOpencodeSyncForSession({
      acpSessionId,
      config,
      reason: "prompt_end",
    }).catch((err) => {
      harnessLog({
        lane: "opencode_sync",
        operation: "persist.prompt_end",
        acpSessionId,
      }).error(err);
    });
  }
}

async function handleSessionNew(params: Record<string, unknown>, config: AgentConfig) {
  const startedAt = Date.now();
  const reqSessionId =
    (params.conversationId as string | undefined) ??
    (params.sessionId as string | undefined);
  const meta = (params.meta as Record<string, unknown> | undefined) ?? {};
  const userId = (meta.userId as string | undefined) ?? "anonymous";
  const { engine } = resolveRuntime(config);
  const envId = envIdFromConfig();
  const store = getHarnessSessionStore(envId);

  let acpSessionId: string;
  if (reqSessionId) {
    if (!isAcpUuid(reqSessionId)) {
      throw Object.assign(
        new Error(`Invalid sessionId: must be a UUID (got "${reqSessionId.slice(0, 64)}")`),
        { rpcCode: -32602 },
      );
    }
    acpSessionId = reqSessionId;
    const existing = await store.get(acpSessionId);
    if (existing) {
      if (isScfServerless()) {
        await bindSandboxForSession(config, acpSessionId);
      } else {
        startSandboxPrewarm(config, acpSessionId);
      }
      const row = await store.get(acpSessionId);
      harnessLog({
        lane: "acp",
        operation: "session.new",
        acpSessionId,
      }).emit({
        status: "ok",
        reused: true,
        instanceId: row?.instanceId ?? null,
        sandboxReady: isSandboxReadyForSession(acpSessionId),
        durationMs: Date.now() - startedAt,
      });
      return { sessionId: acpSessionId, hasHistory: existing.status === "active" };
    }
  } else {
    acpSessionId = crypto.randomUUID();
  }

  await store.create({ acpSessionId, userId, engine });
  if (isScfServerless()) {
    await bindSandboxForSession(config, acpSessionId);
  } else {
    startSandboxPrewarm(config, acpSessionId);
  }
  const row = await store.get(acpSessionId);
  harnessLog({
    lane: "acp",
    operation: "session.new",
    acpSessionId,
  }).emit({
    status: "ok",
    reused: false,
    instanceId: row?.instanceId ?? null,
    engineSessionId: row?.engineSessionId ?? null,
    sandboxReady: isSandboxReadyForSession(acpSessionId),
    durationMs: Date.now() - startedAt,
  });
  return { sessionId: acpSessionId, hasHistory: false };
}

async function handleSessionStatus(params: Record<string, unknown>, config: AgentConfig) {
  const sessionId = String(params.sessionId ?? "");
  if (!sessionId) throw Object.assign(new Error("sessionId is required"), { rpcCode: -32602 });

  const envId = envIdFromConfig();
  const row = await getHarnessSessionStore(envId).get(sessionId);
  if (!row) {
    throw Object.assign(new Error(`Session not found: ${sessionId}`), { rpcCode: -32602 });
  }

  if (!isSandboxReadyForSession(sessionId) && isScfServerless()) {
    if (isSandboxPrewarmInFlight(sessionId)) {
      await waitForSandboxPrewarm(sessionId);
    } else {
      await bindSandboxForSession(config, sessionId);
    }
  }

  return {
    sessionId,
    sandboxReady: isSandboxReadyForSession(sessionId),
    prewarmInFlight: isSandboxPrewarmInFlight(sessionId),
    instanceId: row.instanceId ?? null,
  };
}

async function handleSessionList(_params: Record<string, unknown>, config: AgentConfig) {
  const envId = envIdFromConfig();
  const store = getHarnessSessionStore(envId);
  const rows = await store.list({ limit: 50 });
  const sessions = rows.map((s) => ({
    sessionId: s.acpSessionId,
    title: "",
    updatedAt: s.updatedAt,
    _meta: {
      status: s.status,
      createdAt: s.createdAt,
      engine: s.engine,
      instanceId: s.instanceId,
    },
  }));
  return { sessions, nextCursor: null };
}

async function handleSessionLoad(
  params: Record<string, unknown>,
  res: Response,
  id: unknown,
  config: AgentConfig,
): Promise<boolean> {
  const sessionId = String(params.sessionId ?? "");
  const envId = envIdFromConfig();
  const store = getHarnessSessionStore(envId);
  const row = await store.get(sessionId);
  if (!row) {
    res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
    return true;
  }

  if (!params.replay) {
    res.json(rpcResult(id, { sessionId }));
    return true;
  }

  const { handle, syncHydrated } = await ensureSandboxForSession(config, sessionId);
  const engineSessionId = row.engineSessionId ?? sessionId;
  const mcpServers = buildHarnessAcpMcpServers({
    config,
    clientToolCallbackBase: harnessCallbackBase(),
    acpSessionId: sessionId,
  });
  // HTTP hydrate in ensureSandbox already replays sync events; ACP replay again can hang opencode.
  const acpReplay = Boolean(params.replay) && syncHydrated === 0;
  const upstream = await forwardAcpToSandbox({
    handle,
    config,
    method: "session/load",
    params: {
      sessionId: engineSessionId,
      replay: acpReplay,
      cwd: DEFAULT_HARNESS_SANDBOX_CWD,
      mcpServers,
    },
    id,
    acpSessionId: sessionId,
  });
  await pipeSandboxSseToClient(upstream, res, id, sessionId, store, config);
  return true;
}

async function handleSessionPrompt(
  params: Record<string, unknown>,
  res: Response,
  id: unknown,
  config: AgentConfig,
): Promise<boolean> {
  const sessionId = String(params.sessionId ?? "");
  if (!sessionId) {
    res.json(rpcError(id, -32602, "sessionId is required"));
    return true;
  }

  const envId = envIdFromConfig();
  const store = getHarnessSessionStore(envId);
  const row = await store.get(sessionId);
  if (!row) {
    res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
    return true;
  }

  const abortController = new AbortController();
  abortControllers.set(sessionId, abortController);

  const promptStartedAt = Date.now();
  let sandboxWaitMs = 0;

  try {
    const promptBlocks = (params.prompt ?? []) as Array<{
      type: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
      decision?: string;
    }>;
    const toolResultBlock = promptBlocks.find((b) => b.type === "tool_result");
    if (toolResultBlock?.tool_use_id) {
      const consumed = deliverClientToolResult({
        acpSessionId: sessionId,
        toolUseId: toolResultBlock.tool_use_id,
        content: toolResultBlock.content,
        isError: toolResultBlock.is_error,
      });
      if (consumed) {
        res.json(rpcResult(id, { stopReason: "end_turn" }));
        return true;
      }
    }
    // permission_decision is not handled locally — forward to sandbox engine ACP.

    const sandboxWaitStart = Date.now();
    const { handle, record } = await ensureSandboxForSession(config, sessionId);
    sandboxWaitMs = Date.now() - sandboxWaitStart;
    if (!record) {
      res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
      return true;
    }
    const engineSessionId = await ensureEngineSessionOnSandbox(
      config,
      sessionId,
      handle,
      record,
      store,
    );
    const forwardParams = { ...params, sessionId: engineSessionId };

    const upstream = await forwardAcpToSandbox({
      handle,
      config,
      method: "session/prompt",
      params: forwardParams,
      id,
      acpSessionId: sessionId,
      signal: abortController.signal,
    });

    const forwardStartedAt = Date.now();
    await pipeSandboxSseToClient(upstream, res, id, sessionId, store, config);
    harnessLog({ lane: "acp", operation: "session.prompt", acpSessionId: sessionId }).emit({
      status: "ok",
      sandboxWaitMs,
      sandboxForwardMs: Date.now() - forwardStartedAt,
      totalMs: Date.now() - promptStartedAt,
    });
  } catch (err) {
    const wl = harnessLog({ lane: "acp", operation: "session.prompt", acpSessionId: sessionId });
    wl.error(err);
    wl.emit({
      status: "error",
      sandboxWaitMs,
      totalMs: Date.now() - promptStartedAt,
    });
    if (!res.headersSent) {
      res.json(
        rpcError(id, (err as { rpcCode?: number })?.rpcCode ?? -32000, String(err)),
      );
    }
  } finally {
    abortControllers.delete(sessionId);
  }
  return true;
}

async function handleSessionCancel(
  params: Record<string, unknown>,
  config: AgentConfig,
) {
  const sessionId = String(params.sessionId ?? "");
  abortControllers.get(sessionId)?.abort();
  abortControllers.delete(sessionId);
  unregisterActivePrompt(sessionId);
  const handle = getCachedSandboxHandle(sessionId);
  if (handle) {
    try {
      await forwardAcpToSandbox({
        handle,
        config,
        method: "session/cancel",
        params,
        id: null,
        acpSessionId: sessionId,
      });
    } catch {
      // best-effort
    }
  }
}

async function handleSessionDelete(params: Record<string, unknown>, config: AgentConfig) {
  const sessionId = String(params.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId is required");

  abortControllers.get(sessionId)?.abort();
  abortControllers.delete(sessionId);

  const envId = envIdFromConfig();
  const store = getHarnessSessionStore(envId);
  const row = await store.get(sessionId);
  if (!row) {
    clearSandboxPrewarmState(sessionId);
    dropCachedSandboxHandle(sessionId);
    return { sessionId, deleted: false };
  }

  const handle = getCachedSandboxHandle(sessionId);
  if (handle) {
    try {
      if (row.engine === "opencode" && row.engineSessionId && !isE2eStubSandboxEnabled(config)) {
        await persistOpencodeSyncForSession({
          acpSessionId: sessionId,
          config,
          reason: "session_delete",
        }).catch((err) => {
          harnessLog({
            lane: "opencode_sync",
            operation: "persist.session_delete",
            acpSessionId: sessionId,
          }).error(err);
        });
        await snapshotWorkspaceIfAvailable(handle);
      }
    } catch (err) {
      harnessLog({ lane: "acp", operation: "session.delete.export", acpSessionId: sessionId })
        .error(err);
    }
    try {
      await handle.stop();
    } catch (err) {
      harnessLog({ lane: "acp", operation: "session.delete.stop", acpSessionId: sessionId })
        .error(err);
    }
  }

  await store.clearInstanceBinding(sessionId);
  await store.setStatus(sessionId, "ended");
  clearSandboxPrewarmState(sessionId);
  dropCachedSandboxHandle(sessionId);
  return { sessionId, deleted: true };
}

export function mountHarnessAcpEndpoint(app: Express, agentConfig: AgentConfig) {
  const corsHandler = (req: Request, res: Response, next: () => void) => {
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Task-Id, X-Tenant-Id",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };

  const harnessHandler = async (req: Request, res: Response) => {
    await runWithHarnessRequestContext(req.headers, async () => {
    const body = req.body as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };

    if (!body || body.jsonrpc !== "2.0") {
      return res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC 2.0 request"));
    }
    if (!body.method) {
      return res.status(400).json(rpcError(body.id ?? null, -32600, "Missing method"));
    }

    const { id, method, params = {} } = body;
    const isNotification = id === undefined || id === null;
    const rpcStartedAt = Date.now();
    const rpcLog = harnessLog({
      lane: "acp",
      operation: "rpc",
      rpcMethod: method,
      rpcId: id,
      acpSessionId:
        typeof params.sessionId === "string"
          ? params.sessionId
          : typeof (params.meta as Record<string, unknown> | undefined)?.sessionId === "string"
            ? String((params.meta as Record<string, unknown>).sessionId)
            : undefined,
    });
    rpcLog.phase("rpc.start");

    let sseDelegated = false;
    let rpcOutcome: "ok" | "error" = "ok";
    try {
      switch (method) {
        case "initialize":
          return res.json(rpcResult(id, handleInitialize(params, agentConfig)));

        case "session/new":
          return res.json(rpcResult(id, await handleSessionNew(params, agentConfig)));

        case "session/list":
          return res.json(rpcResult(id, await handleSessionList(params, agentConfig)));

        case "session/status":
          return res.json(rpcResult(id, await handleSessionStatus(params, agentConfig)));

        case "session/load":
          sseDelegated = Boolean(params.replay);
          await handleSessionLoad(params, res, id, agentConfig);
          return;

        case "session/prompt":
          sseDelegated = true;
          await handleSessionPrompt(params, res, id, agentConfig);
          return;

        case "session/cancel":
          await handleSessionCancel(params, agentConfig);
          if (isNotification) return res.status(204).end();
          return res.json(rpcResult(id, { ok: true }));

        case "session/delete":
          return res.json(rpcResult(id, await handleSessionDelete(params, agentConfig)));

        default:
          if (isNotification) return res.status(200).end();
          return res.status(404).json(rpcError(id, -32601, `Method not found: ${method}`));
      }
    } catch (err) {
      rpcOutcome = "error";
      rpcLog.error(err);
      if (!res.headersSent) {
        const code = (err as { rpcCode?: number })?.rpcCode ?? -32000;
        const message = err instanceof Error ? err.message : String(err);
        return res.status(code === -32602 ? 400 : 500).json(rpcError(id, code, message));
      }
    } finally {
      const durationMs = Date.now() - rpcStartedAt;
      if (rpcOutcome === "error") {
        rpcLog.emit({ status: "error", durationMs });
      } else if (sseDelegated) {
        rpcLog.set({ sseDelegated: true });
        rpcLog.emit({ status: "sse_delegated", durationMs });
      } else {
        rpcLog.emit({ status: "ok", durationMs });
      }
    }
    });
  };

  app.post("/acp", corsHandler, harnessHandler);
  app.post("/v1/aibot/bots/:botId/acp", corsHandler, harnessHandler);

  const { runtime, engine } = resolveRuntime(agentConfig);
  harnessLog({ lane: "acp", operation: "mount", runtime, engine }).emit({ status: "ok" });
}
