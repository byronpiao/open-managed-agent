/**
 * ACP (Agent Client Protocol) endpoint for CloudBase Managed Agent Runtime
 *
 * Implements JSON-RPC 2.0 over HTTP (NDJSON streaming for notifications).
 * Spec: https://agentclientprotocol.org
 *
 * Endpoints:
 *   POST /acp          → JSON-RPC 2.0 dispatcher
 *   GET  /acp/sessions → list sessions (convenience REST)
 *
 * Supported methods:
 *   initialize         → version negotiation + capabilities
 *   session/new        → create session, persist to DB
 *   session/load       → restore session + replay history
 *   session/list       → list all sessions for this agent
 *   session/resume     → lightweight resume (no replay)
 *   session/prompt     → send message, stream session/update via NDJSON
 *   session/cancel     → abort in-flight prompt
 */

import type { Express, Request, Response } from "express";
import cloudbase from "@cloudbase/node-sdk";
import { HunyuanAgent } from "./hunyuan-agent.js";
import type { RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";

// ── DB ────────────────────────────────────────────────────────────────────────

const cbApp = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID ?? "" });
const db = cbApp.database();
const SESSIONS_COL = "acp_sessions";

async function genId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── In-flight cancellation registry ──────────────────────────────────────────

const abortControllers = new Map<string, AbortController>();

// ── Types ─────────────────────────────────────────────────────────────────────

interface AcpMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  id: string;
  timestamp: number;
}

interface AcpSession {
  sessionId: string;
  agentName: string;
  model: string;
  system: string;
  cwd: string;
  messages: AcpMessage[];
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

function ndjsonNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

// ── RPC Handlers ─────────────────────────────────────────────────────────────

async function handleInitialize(params: Record<string, unknown>) {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionList: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
    },
    agentInfo: {
      name: process.env.AGENT_NAME ?? "cloudbase-managed-agent",
      title: process.env.AGENT_TITLE ?? "CloudBase Managed Agent",
      version: "0.1.0",
    },
    authMethods: [],
  };
}

async function handleSessionNew(params: Record<string, unknown>, agentConfig: AgentConfig) {
  const sessionId = await genId("sess");
  const now = Math.floor(Date.now() / 1000);

  const session: AcpSession = {
    sessionId,
    agentName: agentConfig.model,
    model: agentConfig.model,
    system: agentConfig.system,
    cwd: String(params.cwd ?? "/"),
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(SESSIONS_COL).add(session);
  return { sessionId };
}

async function handleSessionList() {
  const result = await db.collection(SESSIONS_COL).get();
  return {
    sessions: (result.data as AcpSession[]).map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages?.length ?? 0,
    })),
  };
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
    return false;
  }

  const session = result.data[0] as AcpSession;

  // Set up NDJSON streaming for history replay
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Transfer-Encoding", "chunked");

  // Replay all messages as session/update notifications
  for (const msg of session.messages ?? []) {
    const updateType = msg.role === "user" ? "user_message_chunk" : "agent_message_chunk";
    res.write(
      ndjsonNotification("session/update", {
        sessionId,
        update: {
          sessionUpdate: updateType,
          content: { type: "text", text: msg.content },
        },
      })
    );
  }

  // Final response line
  res.write(JSON.stringify(rpcResult(id, { sessionId })) + "\n");
  res.end();
  return true; // handled
}

async function handleSessionResume(params: Record<string, unknown>, id: unknown) {
  const sessionId = String(params.sessionId ?? "");
  const result = await db.collection(SESSIONS_COL).where({ sessionId }).get();
  if (!result.data.length) throw new Error(`Session not found: ${sessionId}`);
  return { sessionId };
}

async function handleSessionPrompt(
  params: Record<string, unknown>,
  res: Response,
  id: unknown,
  agent: HunyuanAgent
): Promise<boolean> {
  const sessionId = String(params.sessionId ?? "");
  const promptBlocks = (params.prompt ?? []) as Array<{ type: string; text?: string }>;
  const userText = promptBlocks.find((b) => b.type === "text")?.text ?? "";

  // Load session
  const sessionResult = await db.collection(SESSIONS_COL).where({ sessionId }).get();
  if (!sessionResult.data.length) {
    res.json(rpcError(id, -32602, `Session not found: ${sessionId}`));
    return false;
  }

  const session = sessionResult.data[0] as AcpSession;

  // Append user message
  const userMsg: AcpMessage = {
    id: await genId("msg"),
    role: "user",
    content: userText,
    timestamp: Date.now(),
  };
  const messages = [...(session.messages ?? []), userMsg];

  await db.collection(SESSIONS_COL).where({ sessionId }).update({
    messages,
    updatedAt: Math.floor(Date.now() / 1000),
  });

  // Set up NDJSON streaming
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Transfer-Encoding", "chunked");

  const abortController = new AbortController();
  abortControllers.set(sessionId, abortController);

  // Build AG-UI RunAgentInput from session messages
  const aguiMessages: RunAgentInput["messages"] = messages.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const runId = await genId("run");
  const assistantContent: string[] = [];

  try {
    const stream$ = agent.run({
      threadId: sessionId,
      runId,
      messages: aguiMessages,
      tools: [],
      state: {},
    });

    await new Promise<void>((resolve, reject) => {
      stream$.subscribe({
        next: (event) => {
          if (abortController.signal.aborted) return;

          switch (event.type) {
            case EventType.TEXT_MESSAGE_CONTENT: {
              const delta = (event as { delta?: string }).delta ?? "";
              assistantContent.push(delta);
              res.write(
                ndjsonNotification("session/update", {
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: delta },
                  },
                })
              );
              break;
            }

            case EventType.TOOL_CALL_START: {
              const e = event as { toolCallName?: string; toolCallId?: string };
              res.write(
                ndjsonNotification("session/update", {
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCall: {
                      id: e.toolCallId,
                      name: e.toolCallName,
                      status: "pending",
                    },
                  },
                })
              );
              break;
            }

            case EventType.TOOL_CALL_RESULT: {
              const e = event as { toolCallId?: string; content?: string };
              res.write(
                ndjsonNotification("session/update", {
                  sessionId,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCall: {
                      id: e.toolCallId,
                      status: "completed",
                      result: e.content,
                    },
                  },
                })
              );
              break;
            }

            case EventType.RUN_ERROR: {
              const e = event as { message?: string };
              res.write(
                ndjsonNotification("session/update", {
                  sessionId,
                  update: { sessionUpdate: "error", message: e.message },
                })
              );
              break;
            }
          }
        },
        error: reject,
        complete: resolve,
      });
    });

    // Persist assistant reply
    const assistantMsg: AcpMessage = {
      id: await genId("msg"),
      role: "assistant",
      content: assistantContent.join(""),
      timestamp: Date.now(),
    };
    await db.collection(SESSIONS_COL).where({ sessionId }).update({
      messages: [...messages, assistantMsg],
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const stopReason = abortController.signal.aborted ? "cancelled" : "end_turn";

    // Final JSON-RPC response line
    res.write(
      JSON.stringify(rpcResult(id, { stopReason })) + "\n"
    );
  } catch (err) {
    res.write(
      JSON.stringify(rpcError(id, -32000, String(err))) + "\n"
    );
  } finally {
    abortControllers.delete(sessionId);
    res.end();
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
  // Notification — no response
}

// ── Mount function ────────────────────────────────────────────────────────────

interface AgentConfig {
  model: string;
  system: string;
}

export function mountAcpEndpoint(app: Express, agentConfig: AgentConfig) {
  const agent = new HunyuanAgent(agentConfig);

  // ── POST /acp — main JSON-RPC dispatcher ─────────────────────────────────
  app.post("/acp", async (req: Request, res: Response) => {
    const body = req.body as {
      jsonrpc: string;
      id?: unknown;
      method: string;
      params?: Record<string, unknown>;
    };

    if (body.jsonrpc !== "2.0") {
      return res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC version"));
    }

    const { id, method, params = {} } = body;

    try {
      switch (method) {
        case "initialize": {
          const result = await handleInitialize(params);
          return res.json(rpcResult(id, result));
        }

        case "session/new": {
          const result = await handleSessionNew(params, agentConfig);
          return res.json(rpcResult(id, result));
        }

        case "session/list": {
          const result = await handleSessionList();
          return res.json(rpcResult(id, result));
        }

        case "session/load": {
          const handled = await handleSessionLoad(params, res, id);
          if (!handled) return; // already responded
          return;
        }

        case "session/resume": {
          const result = await handleSessionResume(params, id);
          return res.json(rpcResult(id, result));
        }

        case "session/prompt": {
          const handled = await handleSessionPrompt(params, res, id, agent);
          if (!handled) return;
          return;
        }

        case "session/cancel": {
          handleSessionCancel(params);
          // Notification — no response expected, but return 200 OK
          return res.status(204).end();
        }

        default:
          return res.status(404).json(rpcError(id, -32601, `Method not found: ${method}`));
      }
    } catch (err) {
      console.error("[ACP] Error handling method:", method, err);
      if (!res.headersSent) {
        return res.status(500).json(rpcError(id, -32000, String(err)));
      }
    }
  });

  // ── GET /acp/sessions — convenience REST endpoint ────────────────────────
  app.get("/acp/sessions", async (_req: Request, res: Response) => {
    try {
      const result = await handleSessionList();
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /acp/sessions/:id — get single session with full history ─────────
  app.get("/acp/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const result = await db.collection(SESSIONS_COL).where({ sessionId }).get();
      if (!result.data.length) return res.status(404).json({ error: "Session not found" });
      return res.json(result.data[0]);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE /acp/sessions/:id ─────────────────────────────────────────────
  app.delete("/acp/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      await db.collection(SESSIONS_COL).where({ sessionId }).remove();
      return res.json({ sessionId, deleted: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  console.log("[ACP] Endpoints mounted: POST /acp, GET /acp/sessions");
}
