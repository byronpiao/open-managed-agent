/**
 * OAK runtime ACP (Agent Client Protocol) endpoint — backed by open-agent-kernel.
 *
 * Wire format unchanged from the previous (HunyuanAgent) implementation.
 * Underlying agent loop is @cloudbase/open-agent-kernel.
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
 *                             May pause with stopReason='awaiting_permission'
 *                             (request_permission session/update) or
 *                             stopReason='tool_use' (ask_user session/update)
 *   session/cancel            Notification: abort the in-flight prompt
 *   session/delete            Idempotent delete (ACP spec extension)
 *
 * Reverse RPC (agent → client) — HITL:
 *   request_permission            Sent inside the SSE stream as a JSON-RPC
 *                                 session/update notification. Client resumes
 *                                 by POSTing a fresh session/prompt with a
 *                                 permission_decision block whose decision
 *                                 field carries the selected optionId.
 */

import type { Express, Request, Response } from "express";
import expressLib from "express";
import type { AgentConfig } from "../config.js";
import type { MessageRecord } from "@cloudbase/open-agent-kernel";
import {
  abortKernelSession,
  dropKernelSession,
  getKernelAgent,
  getOrCreateKernelSession,
  makeSseSink,
  outcomeToDecision,
  pumpEvents,
  registerKernelSession,
  syncRegisterSession,
  type ApprovalOutcome,
  type StopReason,
} from "./kernel-adapter.js";
import { withActiveSpan } from "../harness/telemetry/telemetry.js";
import {
  rpcResult,
  rpcError,
  sseStart,
  sseWrite,
  sseDone,
  sseSessionUpdate,
  isAcpUuid,
} from "../acp-shared.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Decode JWT payload from Authorization header (no signature verification —
 *  the gateway already validated). Returns null if missing/malformed. */
function parseJwtPayload(req: Request): Record<string, unknown> | null {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

/** Resolve userId from JWT (sub → user_id → administrator_id), fallback to provided default. */
function resolveUserId(req: Request, fallback: string): string {
  const payload = parseJwtPayload(req);
  if (payload) {
    const fromJwt =
      (payload.sub as string) ??
      (payload.user_id as string) ??
      (payload.administrator_id as string) ??
      undefined;
    if (fromJwt) return fromJwt;
  }
  return fallback;
}

const abortControllers = new Map<string, AbortController>();

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

async function handleSessionNew(params: Record<string, unknown>, config: AgentConfig, req: Request) {
  const reqSessionId =
    (params.conversationId as string | undefined) ??
    (params.sessionId as string | undefined);
  const meta = (params.meta as Record<string, unknown> | undefined) ?? {};
  const title = (meta.title as string | undefined) ?? undefined;
  const userId = resolveUserId(req, (meta.userId as string | undefined) ?? "anonymous");

  const agent = getKernelAgent(config);

  // ACP allows the client to supply its own session id (for idempotent create
  // and resume). But the underlying Claude Agent SDK requires a UUID-shaped
  // conversation id — non-UUID ids crash the SDK child process. So we enforce
  // UUID at the wire boundary: clients must use UUIDs (e.g. crypto.randomUUID()).
  if (reqSessionId) {
    if (!isAcpUuid(reqSessionId)) {
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
    await syncRegisterSession(reqSessionId, userId, title);
    return { sessionId: reqSessionId, hasHistory: false };
  }

  // No id supplied — let kernel generate a UUID.
  const session = await agent.startSession({ userId });
  registerKernelSession(session.id, session);
  await syncRegisterSession(session.id, userId, title);
  return { sessionId: session.id, hasHistory: false };
}

async function handleSessionList(params: Record<string, unknown>, config: AgentConfig) {
  const agent = getKernelAgent(config);
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const summaries = await agent.sessions.list({ limit: 200 });
  // De-duplicate by sessionId. The store can legitimately end up with two
  // rows per session under a narrow race: kernel's own registerSession
  // (fire-and-forget) and our syncRegisterSession both run within ~1ms, both
  // hit `where().limit(1).get()` BEFORE either has flushed, both miss, both
  // .add(). The driver's existence check isn't atomic, so we accept the
  // occasional dup at write time and collapse here at read time. We keep the
  // earliest createdAt (most stable identity) and the latest updatedAt.
  const dedupedMap = new Map<string, typeof summaries[number]>();
  for (const s of summaries) {
    const prev = dedupedMap.get(s.conversationId);
    if (!prev) {
      dedupedMap.set(s.conversationId, s);
    } else {
      dedupedMap.set(s.conversationId, {
        ...prev,
        createdAt: Math.min(prev.createdAt ?? Infinity, s.createdAt ?? Infinity),
        updatedAt: Math.max(prev.updatedAt ?? 0, s.updatedAt ?? 0),
      });
    }
  }
  const deduped = Array.from(dedupedMap.values());
  // Sort newest first
  deduped.sort((a, b) => b.updatedAt - a.updatedAt);
  const mapped = deduped.map((s) => ({
    sessionId: s.conversationId,
    title: s.title ?? "",
    updatedAt: s.updatedAt,
    _meta: {
      status: s.status,
      createdAt: s.createdAt,
    },
  }));
  const sessions = mapped.slice(offset, offset + limit);
  const nextOffset = offset + limit < mapped.length ? offset + limit : null;
  return { sessions, nextCursor: nextOffset !== null ? String(nextOffset) : null };
}

async function handleSessionLoad(
  params: Record<string, unknown>,
  res: Response,
  id: unknown,
  config: AgentConfig,
): Promise<boolean> {
  const sessionId = String(params.sessionId ?? "");

  if (!params.replay) {
    // Existence check via kernel SessionManagement.get(). The kernel reads
    // the session index (no side effects, no auto-create), returning null
    // when the session has no FlexDB record. Returns the SessionSummary as
    // _meta so the CLI can render status/timestamps (mirrors Anthropic
    // `sessions retrieve`).
    const agent = getKernelAgent(config);
    const summary = await agent.sessions.get(sessionId);
    if (!summary) {
      res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
      return true;
    }
    res.json(rpcResult(id, {
      sessionId,
      _meta: {
        status: summary.status,
        userId: summary.userId,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      },
    }));
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
      // PR #7.1: protocol-pure path. The kernel's PreToolUse hook stashed
      // a pending entry when the model first called the client-side tool;
      // we now feed the real result back via session.respondToolUse(). The
      // kernel resumes the SDK with a prompt that tells the model to retry
      // the call; the hook then ALLOWs and injects the result via
      // updatedInput, so the SDK records a clean (non-error) tool_result
      // in the transcript with the new tool_use_id. No duplicate
      // tool_result blocks, no fake "user message" wrapping.
      const output =
        typeof toolResultBlock.content === "string"
          ? toolResultBlock.content
          : JSON.stringify(toolResultBlock.content ?? "");
      events = session.respondToolUse({
        toolUseId: toolResultBlock.tool_use_id,
        output,
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
      events = session.send(userText);
    }

    const result = await pumpEvents(events, {
      sse,
      rpcId: id,
      acpSessionId: sessionId,
    });
    let stopReason: StopReason = result.stopReason;
    if (abortController.signal.aborted) stopReason = "cancelled";
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
  // Tell the kernel to abort the session (best-effort).
  await abortKernelSession(sessionId);
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

async function handleSessionResume(params: Record<string, unknown>, config: AgentConfig) {
  const sessionId = String(params.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId is required");

  const agent = getKernelAgent(config);
  const session = await agent.resumeSession(sessionId);
  registerKernelSession(sessionId, session);
  console.log(`[ACP] session.resume sessionId=${sessionId}`);
  return { sessionId };
}

// ── Mount function ──────────────────────────────────────────────────────────

export function mountManagedAcpEndpoint(app: Express, agentConfig: AgentConfig) {
  app.use("/acp", expressLib.json({ limit: "10mb" }));
  app.use("/v1/aibot/bots", expressLib.json({ limit: "10mb" }));

  // CORS — let chat-playground (cross-origin) talk to us.
  // In SCF (behind tcloudbasegateway), the gateway already sets CORS headers;
  // duplicating them causes browsers to reject "multiple values". Only set
  // Origin/Credentials locally; always handle OPTIONS preflight.
  const isBehindGateway = !!process.env.TENCENTCLOUD_RUNENV;
  const corsHandler = (req: Request, res: Response, next: () => void) => {
    if (!isBehindGateway) {
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
    }
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
          return res.json(rpcResult(id, await withActiveSpan(
            "managed.initialize", {}, async () => handleInitialize(params, agentConfig),
          )));

        case "session/new":
          return res.json(rpcResult(id, await withActiveSpan(
            "managed.session.new", {}, async () => handleSessionNew(params, agentConfig, req),
          )));

        case "session/list":
          return res.json(rpcResult(id, await withActiveSpan(
            "managed.session.list", {}, async () => handleSessionList(params, agentConfig),
          )));

        case "session/load":
          await withActiveSpan(
            "managed.session.load", { sessionId: String((params as Record<string,unknown>).sessionId ?? "") },
            async () => { await handleSessionLoad(params, res, id, agentConfig); },
          );
          return;

        case "session/prompt":
          await withActiveSpan(
            "managed.session.prompt", { sessionId: String((params as Record<string,unknown>).sessionId ?? "") },
            async () => { await handleSessionPrompt(params, res, id, agentConfig); },
          );
          return;

        case "session/cancel":
          await withActiveSpan(
            "managed.session.cancel", {},
            async () => { await handleSessionCancel(params); },
          );
          if (isNotification) return res.status(204).end();
          return res.json(rpcResult(id, { ok: true }));

        case "session/delete":
          return res.json(rpcResult(id, await withActiveSpan(
            "managed.session.delete", { sessionId: String((params as Record<string,unknown>).sessionId ?? "") },
            async () => handleSessionDelete(params, agentConfig),
          )));

        case "session/resume":
          return res.json(rpcResult(id, await withActiveSpan(
            "managed.session.resume", { sessionId: String((params as Record<string,unknown>).sessionId ?? "") },
            async () => handleSessionResume(params, agentConfig),
          )));

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

  console.log("[ACP] Managed endpoints mounted: POST /acp (+ gateway /v1/aibot/bots/:botId/acp)");
}
