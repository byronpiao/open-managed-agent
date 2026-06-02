/**
 * ACP (Agent Client Protocol) endpoint backed by open-agent-kernel.
 *
 * Wire format unchanged from the previous (HunyuanAgent) implementation.
 * Underlying agent loop is now @cloudbase/open-agent-kernel.
 *
 * Transport:
 *   - JSON-RPC 2.0 over HTTP POST
 *   - Streaming uses SSE (`text/event-stream`), `data: <json>\n\n` frames,
 *     terminated by `data: [DONE]\n\n`.
 *
 * Endpoints (both routes share the same handler):
 *   POST /acp                              Direct ACP entry
 *   POST /v1/aibot/bots/:botId/acp         Gateway path (deployment-only)
 *
 * Supported JSON-RPC methods:
 *   initialize                Capability negotiation
 *   session/new               Create session
 *   session/list              List sessions
 *   session/load              Load session (replay=true → SSE history_page)
 *   session/prompt            SSE: agent_message_chunk / tool_call(_update)
 *                             May embed reverse JSON-RPC `session/request_permission`
 *   session/cancel            Notification: abort the in-flight prompt
 *   session/delete            Idempotent delete (ACP spec extension)
 *
 * Reverse RPC (agent → client) — HITL:
 *   session/request_permission   Sent inside the SSE stream as a JSON-RPC
 *                                request. Client replies with a JSON-RPC
 *                                `result` whose body is `{ outcome: { outcome:
 *                                'selected', optionId } | { outcome: 'cancelled' } }`,
 *                                POSTed back to the same /acp URL.
 */

import type { Express, Request, Response } from "express";
import expressLib from "express";
import type { AgentConfig } from "./config.js";
import type { MessageRecord } from "@cloudbase/open-agent-kernel";
import {
  dropKernelSession,
  getKernelAgent,
  getOrCreateKernelSession,
  makeSseSink,
  outcomeToDecision,
  pumpEvents,
  registerKernelSession,
  type ApprovalOutcome,
  type StopReason,
} from "./kernel-adapter.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

const abortControllers = new Map<string, AbortController>();

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

// ── SSE helpers ──────────────────────────────────────────────────────────────

function sseStart(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function sseWrite(res: Response, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseDone(res: Response, sse?: { getAll?: () => string }) {
  // SCF web-function: only res.end() content reaches the client.
  // All intermediate res.write() are dropped by the gateway.
  // Deliver the entire SSE body — buffered frames + [DONE] — in one call.
  const all = sse?.getAll?.() ?? "";
  res.end(`${all}data: [DONE]\n\n`);
}

function sseSessionUpdate(res: Response, sessionId: string, update: unknown) {
  sseWrite(res, {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

// ── Translate kernel MessageRecord[] → ACP history messages ─────────────────

interface AcpHistoryPart {
  type: string;
  [k: string]: unknown;
}

interface AcpHistoryMessage {
  id: string;
  taskId: string;
  role: "user" | "agent";
  content: string;
  parts: AcpHistoryPart[];
  status: string;
  createdAt: number;
}

function recordToAcpMessage(rec: MessageRecord): AcpHistoryMessage {
  const parts: AcpHistoryPart[] = [];
  let textBuf = "";
  for (const p of rec.parts ?? []) {
    if (p.type === "text") {
      textBuf += p.text;
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "tool_call") {
      parts.push({
        type: "tool_call",
        toolCallId: p.toolUseId,
        toolName: p.toolName,
        input: p.input,
        status: p.status ?? "done",
      });
    } else if (p.type === "tool_result") {
      parts.push({
        type: "tool_result",
        toolCallId: p.toolUseId,
        content: typeof p.output === "string" ? p.output : JSON.stringify(p.output),
        isError: p.isError,
        status: p.status ?? "done",
      });
    } else if (p.type === "image") {
      // Best-effort surface for legacy clients
      const ref: any = p.ref;
      if (ref?.kind === "base64") {
        parts.push({ type: "image", data: ref.dataUrl, mimeType: p.mimeType });
      }
    }
    // 'thinking' / 'tool_approval_required' parts: don't surface in history page
  }
  return {
    id: rec.id,
    taskId: rec.conversationId,
    role: rec.role === "assistant" ? "agent" : "user",
    content: textBuf,
    parts,
    status: rec.status === "done" ? "done" : rec.status,
    createdAt: rec.createdAt,
  };
}

// ── RPC handlers ─────────────────────────────────────────────────────────────

function handleInitialize(_params: Record<string, unknown>, config: AgentConfig) {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { list: true },
    },
    agentInfo: {
      name: config.name ?? process.env.AGENT_NAME ?? "open-managed-agent",
      title: config.description ?? "OpenManagedAgent",
      version: "0.1.0",
    },
    // Echo the loaded AgentConfig back so `magent agent:update` can fetch
    // it and patch only the fields the user touched (instead of falling
    // back to silent defaults that would corrupt the agent's identity).
    // The trust boundary is the gateway access_token — anyone who can
    // call initialize already has full agent access.
    agentConfig: config,
    authMethods: [],
    supportedModels: [],
  };
}

async function handleSessionNew(params: Record<string, unknown>, config: AgentConfig) {
  const reqSessionId =
    (params.conversationId as string | undefined) ??
    (params.sessionId as string | undefined);
  const meta = (params.meta as Record<string, unknown> | undefined) ?? {};
  const userId = (meta.userId as string | undefined) ?? "anonymous";

  const agent = getKernelAgent(config);

  // ACP allows the client to supply its own session id (for idempotent create
  // and resume). But the underlying Claude Agent SDK requires a UUID-shaped
  // conversation id — non-UUID ids crash the SDK child process. So we enforce
  // UUID at the wire boundary: clients must use UUIDs (e.g. crypto.randomUUID()).
  if (reqSessionId) {
    if (!isUuid(reqSessionId)) {
      throw Object.assign(
        new Error(
          `Invalid sessionId: must be a UUID (got "${reqSessionId.slice(0, 64)}"). ` +
            `Use crypto.randomUUID() to generate one client-side, or omit the field ` +
            `to let the server generate it.`,
        ),
        { rpcCode: -32602 },
      );
    }
    const existing = await agent.sessions.get(reqSessionId);
    if (existing) return { sessionId: reqSessionId, hasHistory: true };
    await getOrCreateKernelSession(config, reqSessionId, { userId, isNew: true });
    return { sessionId: reqSessionId, hasHistory: false };
  }

  // No id supplied — let kernel generate a UUID.
  const session = await agent.startSession({ userId });
  registerKernelSession(session.id, session);
  return { sessionId: session.id, hasHistory: false };
}

async function handleSessionList(_params: Record<string, unknown>, config: AgentConfig) {
  const agent = getKernelAgent(config);
  const summaries = await agent.sessions.list({ limit: 50 });
  // Sort newest first
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  const sessions = summaries.map((s) => ({
    sessionId: s.conversationId,
    title: s.title ?? "",
    updatedAt: s.updatedAt,
    _meta: {
      status: s.status,
      createdAt: s.createdAt,
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
  const agent = getKernelAgent(config);
  const summary = await agent.sessions.get(sessionId);
  if (!summary) {
    res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
    return true;
  }

  if (!params.replay) {
    res.json(rpcResult(id, { sessionId }));
    return true;
  }

  // Replay history. Pull MessageRecord[] from the kernel session.
  const session = await getOrCreateKernelSession(config, sessionId);

  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100);
  const sort = (params.sort as "ASC" | "DESC" | undefined) ?? "DESC";
  const offset = Math.max(Number(params.cursor ?? 0) || 0, 0);

  const history = await session.getHistory({ limit: 500 });
  const acpMessages = history.map(recordToAcpMessage);
  const ordered = sort === "ASC" ? acpMessages : [...acpMessages].reverse();
  const page = ordered.slice(offset, offset + limit);
  const messages = sort === "DESC" ? [...page].reverse() : page;
  const nextCursor = ordered.length > offset + limit ? String(offset + limit) : null;

  sseStart(res);
  sseSessionUpdate(res, sessionId, {
    sessionUpdate: "history_page",
    messages,
    cursor: String(offset),
    nextCursor,
  });
  sseWrite(res, rpcResult(id, { sessionId, nextCursor }));
  sseDone(res);
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

  const promptBlocks = (params.prompt ?? []) as Array<{
    type: string;
    text?: string;
    // tool_result block (client → agent, resumes a paused turn)
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
    // permission_decision block (client → agent, resolves a paused approval)
    decision?: string;        // optionId, e.g. "allow-once"
  }>;

  // Dispatch by the FIRST non-text block type. Mixed prompts (e.g. text + tool_result)
  // aren't supported — the kernel takes one logical SessionInput at a time.
  const toolResultBlock = promptBlocks.find((b) => b.type === "tool_result");
  const permissionBlock = promptBlocks.find((b) => b.type === "permission_decision");

  const session = await getOrCreateKernelSession(config, sessionId);

  // SCF diagnostic: test streaming model API to verify connectivity and format.
  const model = config.model;
  if (typeof model === "object" && model.apiBaseUrl && model.apiKey) {
    try {
      const testRes = await fetch(`${model.apiBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": model.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
        body: JSON.stringify({
          model: model.id,
          max_tokens: 16000,
          thinking: { type: "enabled", budget_tokens: 5000 },
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const streamText = await testRes.text();
      // Count delta types
      const textDeltaCount = (streamText.match(/"type":"text_delta"/g) || []).length;
      const thinkingDeltaCount = (streamText.match(/"type":"thinking_delta"/g) || []).length;
      console.error(`[direct-stream] status=${testRes.status} len=${streamText.length} text_deltas=${textDeltaCount} thinking_deltas=${thinkingDeltaCount}`);
      if (textDeltaCount === 0) {
        console.error(`[direct-stream] NO TEXT DELTAS! first500: ${streamText.slice(0, 500)}`);
      }
    } catch (e) {
      console.error(`[direct-stream] FAILED: ${(e as Error).message}`);
    }
  }

  sseStart(res);
  const sse = makeSseSink(res);
  const abortController = new AbortController();
  abortControllers.set(sessionId, abortController);

  try {
    let events;
    if (toolResultBlock) {
      if (!toolResultBlock.tool_use_id) {
        res.json(rpcError(id, -32602, "tool_result block requires tool_use_id"));
        return true;
      }
      events = session.send({
        type: "tool_result",
        toolUseId: toolResultBlock.tool_use_id,
        output: toolResultBlock.content ?? "",
        isError: toolResultBlock.is_error ?? false,
      });
    } else if (permissionBlock) {
      if (!permissionBlock.tool_use_id || !permissionBlock.decision) {
        res.json(rpcError(id, -32602, "permission_decision requires tool_use_id and decision"));
        return true;
      }
      const outcome: ApprovalOutcome = permissionBlock.decision === "cancelled"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: permissionBlock.decision };
      events = session.respondApproval({
        toolUseId: permissionBlock.tool_use_id,
        decision: outcomeToDecision(outcome),
      });
    } else {
      const userText = promptBlocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
      sse.write({ _diag: "before_send", textLen: userText.length, sessionId });
      events = session.send(userText);
      sse.write({ _diag: "after_send", eventsType: typeof events });
    }

    const result = await pumpEvents(events, session, {
      sse,
      rpcId: id,
      acpSessionId: sessionId,
    });
    let stopReason: StopReason = result.stopReason;
    if (abortController.signal.aborted) stopReason = "cancelled";
    // Write result through sse sink so it's included in the buffered body.
    sse.write(rpcResult(id, {
      stopReason,
      ...(result.pendingToolUse ? { pendingToolUse: result.pendingToolUse } : {}),
      ...(result.pendingPermission ? { pendingPermission: result.pendingPermission } : {}),
    }));
  } catch (err) {
    console.error("[ACP] session/prompt failed:", err);
    sse.write(rpcError(id, -32000, String(err)));
  } finally {
    abortControllers.delete(sessionId);
    sseDone(res, sse);
  }
  return true;
}

async function handleSessionCancel(params: Record<string, unknown>) {
  const sessionId = String(params.sessionId ?? "");
  const ctrl = abortControllers.get(sessionId);
  if (ctrl) {
    ctrl.abort();
    abortControllers.delete(sessionId);
  }
  // Best-effort: tell the kernel to abort.
  // (kernel session.abort() returns Promise<void>; ignore errors)
  // Note: we don't have a sync handle here without a per-session lookup map,
  // so we leave the kernel side to react via session.abort caller below if any.
}

async function handleSessionDelete(params: Record<string, unknown>, config: AgentConfig) {
  const sessionId = String(params.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId is required");

  const ctrl = abortControllers.get(sessionId);
  if (ctrl) {
    ctrl.abort();
    abortControllers.delete(sessionId);
  }

  const agent = getKernelAgent(config);
  const existing = await agent.sessions.get(sessionId);
  if (!existing) {
    dropKernelSession(sessionId);
    return { sessionId, deleted: false };
  }
  await agent.sessions.delete(sessionId);
  dropKernelSession(sessionId);
  return { sessionId, deleted: true };
}

// ── Mount function ──────────────────────────────────────────────────────────

export function mountAcpEndpoint(app: Express, agentConfig: AgentConfig) {
  app.use("/acp", expressLib.json({ limit: "10mb" }));
  app.use("/v1/aibot/bots", expressLib.json({ limit: "10mb" }));

  // CORS — let chat-playground (cross-origin) talk to us.
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
  app.use("/acp", corsHandler);
  app.use("/v1/aibot/bots", corsHandler);

  const acpHandler = async (req: Request, res: Response) => {
    const body = req.body as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: unknown;
    };

    if (!body || body.jsonrpc !== "2.0") {
      return res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC 2.0 request"));
    }

    if (!body.method) {
      return res.status(400).json(rpcError(body.id ?? null, -32600, "Missing method"));
    }

    const { id, method, params = {} } = body;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize":
          return res.json(rpcResult(id, handleInitialize(params, agentConfig)));

        case "session/new":
          return res.json(rpcResult(id, await handleSessionNew(params, agentConfig)));

        case "session/list":
          return res.json(rpcResult(id, await handleSessionList(params, agentConfig)));

        case "session/load":
          await handleSessionLoad(params, res, id, agentConfig);
          return;

        case "session/prompt":
          await handleSessionPrompt(params, res, id, agentConfig);
          return;

        case "session/cancel":
          await handleSessionCancel(params);
          if (isNotification) return res.status(204).end();
          return res.json(rpcResult(id, { ok: true }));

        case "session/delete":
          return res.json(rpcResult(id, await handleSessionDelete(params, agentConfig)));

        default:
          if (isNotification) return res.status(200).end();
          return res.status(404).json(rpcError(id, -32601, `Method not found: ${method}`));
      }
    } catch (err) {
      console.error("[ACP] Error handling method:", method, err);
      if (!res.headersSent) {
        const code = (err as { rpcCode?: number })?.rpcCode ?? -32000;
        const message = err instanceof Error ? err.message : String(err);
        return res.status(code === -32602 ? 400 : 500).json(rpcError(id, code, message));
      }
    }
  };

  app.post("/acp", acpHandler);
  app.post("/v1/aibot/bots/:botId/acp", acpHandler);

  console.log("[ACP] Endpoints mounted: POST /acp (+ gateway /v1/aibot/bots/:botId/acp)");
}
