/**
 * ACP (Agent Client Protocol) endpoint for OpenManagedAgent Runtime
 *
 * 对齐 chat-playground 的协议契约（详见 chat-playground/INTEGRATION.md）。
 *
 * Transport：
 *   - JSON-RPC 2.0 over HTTP POST
 *   - 流式响应使用 SSE（`text/event-stream`），帧格式 `data: <json>\n\n`，
 *     结束 `data: [DONE]\n\n`
 *
 * Endpoints:
 *   POST /acp                              ACP JSON-RPC 入口（直连）
 *   POST /v1/aibot/bots/:botId/acp         网关代理路径（部署适配，非协议规定）
 *
 * Supported JSON-RPC methods:
 *   initialize       capability 协商
 *   session/new      创建会话（params.meta 可携带 title 等）
 *   session/list     列出会话（按 createdAt desc）
 *   session/load     不带 replay → RPC；带 replay=true → SSE 推 history_page
 *   session/prompt   SSE 推 agent_message_chunk / tool_call / tool_call_update
 *   session/cancel   notification，中断进行中的轮次
 *   session/delete   幂等删除会话（ACP spec 扩展）
 */

import type { Express, Request, Response } from "express";
import expressLib from "express";
import cloudbase from "@cloudbase/node-sdk";
import { HunyuanAgent } from "./hunyuan-agent.js";
import { EventType } from "@ag-ui/client";
import type { AgentConfig } from "./config.js";

// ── DB ────────────────────────────────────────────────────────────────────────

const cbApp = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID ?? "" });
const db = cbApp.database();
let SESSIONS_COL = "acp_sessions";

let collectionReady = false;
export async function ensureCollection(collectionName?: string) {
  if (collectionName) SESSIONS_COL = collectionName;
  if (collectionReady) return;
  try {
    await db.createCollection(SESSIONS_COL);
    console.log(`[ACP] Created collection: ${SESSIONS_COL}`);
  } catch (err: any) {
    if (err?.code === "DATABASE_COLLECTION_EXIST" || err?.message?.includes("already exist")) {
      // ok
    } else {
      console.log(`[ACP] Collection check: ${err?.message ?? err}`);
    }
  }
  collectionReady = true;
}

async function genId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── In-flight cancellation registry ──────────────────────────────────────────

const abortControllers = new Map<string, AbortController>();

// ── Types ─────────────────────────────────────────────────────────────────────

type AcpRole = "user" | "agent";

type AcpPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      status?: string;
      parentToolCallId?: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName?: string;
      content: string;
      isError?: boolean;
      status?: string;
      parentToolCallId?: string;
    };

interface AcpHistoryMessage {
  id: string;
  taskId: string;
  role: AcpRole;
  content: string;
  parts?: AcpPart[];
  status?: string;
  createdAt: number;
}

interface AcpSession {
  sessionId: string;
  title?: string | null;
  agentName: string;
  model: string;
  system: string;
  cwd?: string;
  /** meta 字段保留，方便 list 时回带（playground SessionInfo._meta） */
  meta?: Record<string, unknown>;
  messages: AcpHistoryMessage[];
  status?: string;
  createdAt: number;
  updatedAt: number;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

// ── SSE helpers (chat-playground 期望的格式：每帧 `data: <json>\n\n`) ─────────

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

function sseDone(res: Response) {
  res.write("data: [DONE]\n\n");
  res.end();
}

function sseSessionUpdate(res: Response, sessionId: string, update: unknown) {
  sseWrite(res, {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

// ── RPC Handlers ─────────────────────────────────────────────────────────────

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
    authMethods: [],
    supportedModels: [],
  };
}

async function handleSessionNew(params: Record<string, unknown>, config: AgentConfig) {
  const conversationId = (params.conversationId as string | undefined) ?? (await genId("sess"));
  const meta = (params.meta as Record<string, unknown> | undefined) ?? {};
  const now = Date.now();

  // Idempotent: 已存在则复用，回传 hasHistory
  const existing = await db.collection(SESSIONS_COL).where({ sessionId: conversationId }).get();
  if (existing.data.length) {
    const s = existing.data[0] as AcpSession;
    return { sessionId: conversationId, hasHistory: (s.messages?.length ?? 0) > 0 };
  }

  const session: AcpSession = {
    sessionId: conversationId,
    title: (meta.title as string | undefined) ?? null,
    agentName: config.name ?? "open-managed-agent",
    model: (meta.selectedModel as string | undefined) ?? config.model,
    system: config.system,
    cwd: String(params.cwd ?? "/"),
    meta,
    messages: [],
    status: "created",
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(SESSIONS_COL).add(session);
  return { sessionId: conversationId, hasHistory: false };
}

async function handleSessionList(_params: Record<string, unknown>) {
  const result = await db.collection(SESSIONS_COL).orderBy("createdAt", "desc").limit(20).get();
  const sessions = (result.data as AcpSession[]).map((s) => ({
    sessionId: s.sessionId,
    title: s.title || "",
    updatedAt: s.updatedAt,
    _meta: {
      status: s.status ?? "created",
      createdAt: s.createdAt,
    },
  }));
  return { sessions, nextCursor: null };
}

async function handleSessionLoad(
  params: Record<string, unknown>,
  res: Response,
  id: unknown
): Promise<boolean> {
  const sessionId = String(params.sessionId ?? "");
  const result = await db.collection(SESSIONS_COL).where({ sessionId }).get();
  if (!result.data.length) {
    res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
    return true;
  }

  const session = result.data[0] as AcpSession;

  // Plain load（playground 在 AcpClient.initializeSession 里调一次）
  if (!params.replay) {
    res.json(rpcResult(id, { sessionId }));
    return true;
  }

  // Replay：SSE 推一条 history_page，然后 result + [DONE]
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100);
  const sort = (params.sort as "ASC" | "DESC" | undefined) ?? "DESC";
  const offset = Math.max(Number(params.cursor ?? 0) || 0, 0);

  const all = session.messages ?? [];
  const ordered = sort === "ASC" ? all : [...all].reverse();
  const page = ordered.slice(offset, offset + limit);
  // history_page 的 messages 在 client 端总是按时间正序渲染
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
  agent: HunyuanAgent
): Promise<boolean> {
  const sessionId = String(params.sessionId ?? "");
  const promptBlocks = (params.prompt ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  const userText = promptBlocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");

  const sessionResult = await db.collection(SESSIONS_COL).where({ sessionId }).get();
  if (!sessionResult.data.length) {
    res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
    return true;
  }

  const session = sessionResult.data[0] as AcpSession;
  const history = session.messages ?? [];

  // Append user message to history
  const userMessageId = await genId("msg");
  const userParts: AcpPart[] = [];
  for (const block of promptBlocks) {
    if (block.type === "image" && block.data && block.mimeType) {
      userParts.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  userParts.push({ type: "text", text: userText });
  const userMsg: AcpHistoryMessage = {
    id: userMessageId,
    taskId: sessionId,
    role: "user",
    content: userText,
    parts: userParts,
    status: "done",
    createdAt: Date.now(),
  };
  const messagesAfterUser = [...history, userMsg];

  await db.collection(SESSIONS_COL).where({ sessionId }).update({
    messages: messagesAfterUser,
    status: "processing",
    updatedAt: Date.now(),
  });

  sseStart(res);

  const abortController = new AbortController();
  abortControllers.set(sessionId, abortController);

  // 喂给 agent 的消息（agent 内部用 AG-UI 的 user/assistant 概念）
  const aguiMessages = messagesAfterUser.map((m) => ({
    id: m.id,
    role: m.role === "agent" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  const runId = await genId("run");
  const assistantMessageId = await genId("msg");
  const assistantTextChunks: string[] = [];
  const assistantParts: AcpPart[] = [];
  // 跟踪进行中的 tool_call，便于 result 到达时回填 toolName
  const toolCallNameById = new Map<string, string>();

  const flushTextSoFar = () => {
    if (assistantTextChunks.length === 0) return;
    const text = assistantTextChunks.join("");
    // 合并到一条 text part（如果上一条是 text 就追加）
    const last = assistantParts[assistantParts.length - 1];
    if (last && last.type === "text") {
      last.text += text;
    } else {
      assistantParts.push({ type: "text", text });
    }
    assistantTextChunks.length = 0;
  };

  let stopReason: "end_turn" | "cancelled" | "error" = "end_turn";

  try {
    const stream$ = agent.run({
      threadId: sessionId,
      runId,
      messages: aguiMessages,
      tools: [],
      context: [],
      state: {},
    } as any);

    await new Promise<void>((resolve, reject) => {
      const sub = stream$.subscribe({
        next: (event) => {
          if (abortController.signal.aborted) return;

          switch (event.type) {
            case EventType.TEXT_MESSAGE_CONTENT: {
              const delta = (event as { delta?: string }).delta ?? "";
              if (!delta) break;
              assistantTextChunks.push(delta);
              sseSessionUpdate(res, sessionId, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: delta },
              });
              break;
            }

            case EventType.TOOL_CALL_START: {
              flushTextSoFar();
              const e = event as { toolCallName?: string; toolCallId?: string };
              const toolCallId = e.toolCallId ?? `tc_${Date.now()}`;
              const toolName = e.toolCallName ?? "tool";
              toolCallNameById.set(toolCallId, toolName);
              assistantParts.push({
                type: "tool_call",
                toolCallId,
                toolName,
                input: undefined,
                status: "in_progress",
              });
              sseSessionUpdate(res, sessionId, {
                sessionUpdate: "tool_call",
                toolCallId,
                title: toolName,
                kind: "function",
                status: "in_progress",
              });
              break;
            }

            case EventType.TOOL_CALL_ARGS: {
              const e = event as { toolCallId?: string; delta?: string };
              const toolCallId = e.toolCallId ?? "";
              const part = assistantParts.find(
                (p) => p.type === "tool_call" && p.toolCallId === toolCallId
              ) as Extract<AcpPart, { type: "tool_call" }> | undefined;
              if (part) {
                const prev = typeof part.input === "string" ? (part.input as string) : "";
                part.input = prev + (e.delta ?? "");
              }
              // playground 当前不依赖增量 args，input 在 tool_call_update 里也会带；这里不发独立事件
              break;
            }

            case EventType.TOOL_CALL_END: {
              const e = event as { toolCallId?: string };
              const toolCallId = e.toolCallId ?? "";
              const part = assistantParts.find(
                (p) => p.type === "tool_call" && p.toolCallId === toolCallId
              ) as Extract<AcpPart, { type: "tool_call" }> | undefined;
              // 尝试 JSON.parse 累积的字符串 args
              if (part && typeof part.input === "string") {
                try {
                  part.input = JSON.parse(part.input as string);
                } catch {
                  // keep raw string
                }
              }
              sseSessionUpdate(res, sessionId, {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "in_progress",
                input: part?.input,
              });
              break;
            }

            case EventType.CUSTOM: {
              // HunyuanAgent 用 CUSTOM 携带工具结果
              const e = event as { toolCallId?: string; content?: string };
              const toolCallId = e.toolCallId ?? "";
              const result = String(e.content ?? "");
              const toolName = toolCallNameById.get(toolCallId);
              assistantParts.push({
                type: "tool_result",
                toolCallId,
                toolName,
                content: result,
                status: "done",
              });
              sseSessionUpdate(res, sessionId, {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "completed",
                result,
              });
              break;
            }

            case EventType.RUN_ERROR: {
              const e = event as { message?: string };
              stopReason = "error";
              sseSessionUpdate(res, sessionId, {
                sessionUpdate: "log",
                level: "error",
                message: e.message ?? "agent error",
                timestamp: Date.now(),
              });
              break;
            }

            // TEXT_MESSAGE_START / TEXT_MESSAGE_END / RUN_STARTED / RUN_FINISHED 等不需透传
            default:
              break;
          }
        },
        error: (err) => {
          stopReason = "error";
          sseSessionUpdate(res, sessionId, {
            sessionUpdate: "log",
            level: "error",
            message: String(err),
            timestamp: Date.now(),
          });
          sub.unsubscribe();
          resolve();
        },
        complete: () => resolve(),
      });
    });

    if (abortController.signal.aborted) {
      stopReason = "cancelled";
    }

    flushTextSoFar();

    // Persist assistant message (parts + 聚合文本)
    const aggregatedText = assistantParts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("");
    const assistantMsg: AcpHistoryMessage = {
      id: assistantMessageId,
      taskId: sessionId,
      role: "agent",
      content: aggregatedText,
      parts: assistantParts,
      status: stopReason === "end_turn" ? "done" : stopReason === "cancelled" ? "cancel" : "error",
      createdAt: Date.now(),
    };
    await db
      .collection(SESSIONS_COL)
      .where({ sessionId })
      .update({
        messages: [...messagesAfterUser, assistantMsg],
        status: stopReason === "end_turn" ? "completed" : stopReason,
        updatedAt: Date.now(),
      });

    sseWrite(res, rpcResult(id, { stopReason }));
  } catch (err) {
    console.error("[ACP] session/prompt failed:", err);
    sseWrite(res, rpcError(id, -32000, String(err)));
  } finally {
    abortControllers.delete(sessionId);
    sseDone(res);
  }

  return true;
}

function handleSessionCancel(params: Record<string, unknown>) {
  const sessionId = String(params.sessionId ?? "");
  const ctrl = abortControllers.get(sessionId);
  if (ctrl) {
    ctrl.abort();
    abortControllers.delete(sessionId);
  }
}

/**
 * session/delete — 删除会话（ACP spec 扩展，幂等）。
 *
 * 不存在或已被删的 sessionId 也返回 200 + deleted: false，避免 client 上手动 retry 时报错。
 * 对应进行中的 prompt 也会被一并取消。
 */
async function handleSessionDelete(params: Record<string, unknown>) {
  const sessionId = String(params.sessionId ?? "");
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  // 中断进行中的 prompt（如果有）
  const ctrl = abortControllers.get(sessionId);
  if (ctrl) {
    ctrl.abort();
    abortControllers.delete(sessionId);
  }

  const existing = await db.collection(SESSIONS_COL).where({ sessionId }).get();
  if (!existing.data.length) {
    return { sessionId, deleted: false };
  }

  await db.collection(SESSIONS_COL).where({ sessionId }).remove();
  return { sessionId, deleted: true };
}

// ── Mount function ────────────────────────────────────────────────────────────

export function mountAcpEndpoint(app: Express, agentConfig: AgentConfig) {
  const agent = new HunyuanAgent(agentConfig);

  app.use("/acp", expressLib.json({ limit: "10mb" }));
  app.use("/v1/aibot/bots", expressLib.json({ limit: "10mb" }));

  // CORS：让 chat-playground（不同源）可访问。具体允许的 Origin 由部署侧控制。
  // 如果 createExpressServer 已经开了 CORS，这里的 OPTIONS handler 是兜底。
  const corsHandler = (req: Request, res: Response, next: () => void) => {
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Task-Id, X-Tenant-Id");
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
    };

    if (!body || body.jsonrpc !== "2.0" || !body.method) {
      return res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC 2.0 request"));
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
          return res.json(rpcResult(id, await handleSessionList(params)));

        case "session/load":
          await handleSessionLoad(params, res, id);
          return;

        case "session/prompt":
          await handleSessionPrompt(params, res, id, agent);
          return;

        case "session/cancel":
          handleSessionCancel(params);
          if (isNotification) return res.status(204).end();
          return res.json(rpcResult(id, { ok: true }));

        case "session/delete":
          return res.json(rpcResult(id, await handleSessionDelete(params)));

        default:
          if (isNotification) return res.status(200).end();
          return res.status(404).json(rpcError(id, -32601, `Method not found: ${method}`));
      }
    } catch (err) {
      console.error("[ACP] Error handling method:", method, err);
      if (!res.headersSent) {
        return res.status(500).json(rpcError(id, -32000, String(err)));
      }
    }
  };

  app.post("/acp", acpHandler);
  app.post("/v1/aibot/bots/:botId/acp", acpHandler);

  console.log("[ACP] Endpoints mounted: POST /acp (+ gateway path /v1/aibot/bots/:botId/acp)");
}
