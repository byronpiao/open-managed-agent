import { db, generateId } from "../db.js";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";

const router: Router = createRouter();
const SESSIONS_COL = "managed_sessions";
const ENV_ID = process.env.CLOUDBASE_ENV_ID ?? "";

// Resolve Agent's send-message endpoint
function agentEndpoint(agentId: string): string {
  return (
    process.env[`AGENT_${agentId.toUpperCase()}_URL`] ??
    `https://${ENV_ID}.service.tcloudbase.com/v1/aibot/bots/${agentId}/send-message`
  );
}

// ── POST /sessions ────────────────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  try {
    const { agent, environment_id, title } = req.body as {
      agent: string;
      environment_id?: string;
      title?: string;
    };
    if (!agent) return res.status(400).json({ error: "agent is required" });

    const session = {
      id:             await generateId("sess"),
      object:         "session",
      agent,
      environment_id: environment_id ?? null,
      title:          title ?? "",
      status:         "idle",
      thread_id:      await generateId("thread"), // AG-UI threadId
      messages:       [] as object[],             // AG-UI message history
      created_at:     Math.floor(Date.now() / 1000),
    };

    await db.collection(SESSIONS_COL).add(session);
    return res.status(201).json(session);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /sessions ─────────────────────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await db.collection(SESSIONS_COL).get();
    return res.json({ object: "list", data: result.data, has_more: false });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /sessions/:id ─────────────────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const result = await db.collection(SESSIONS_COL).where({ id: req.params.id }).get();
    if (!result.data.length) return res.status(404).json({ error: "Session not found" });
    return res.json(result.data[0]);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /sessions/:id ──────────────────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db.collection(SESSIONS_COL).where({ id: req.params.id }).remove();
    return res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /sessions/:id/events ─────────────────────────────────────────────────
// Receive user.message → forward to Agent's /send-message → stream AG-UI events back
router.post("/:id/events", async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  try {
    const { events } = req.body as {
      events: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    };

    // Load session
    const sessionResult = await db.collection(SESSIONS_COL).where({ id: sessionId }).get();
    if (!sessionResult.data.length) return res.status(404).json({ error: "Session not found" });

    const session = sessionResult.data[0] as {
      id: string; agent: string; thread_id: string;
      messages: Array<{ id: string; role: string; content: string }>;
    };

    // Extract text from user.message events
    const userMessages = events
      .filter((e) => e.type === "user.message")
      .map((e) => ({
        id:      `msg_${Date.now()}`,
        role:    "user",
        content: e.content?.find((b) => b.type === "text")?.text ?? "",
      }));

    const allMessages = [...(session.messages ?? []), ...userMessages];

    // Update session with new messages + running status
    await db.collection(SESSIONS_COL).where({ id: sessionId }).update({
      messages: allMessages,
      status: "running",
    });

    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (evt: object) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };

    // Build AG-UI RunAgentInput and forward to Agent cloud function
    const runId    = `run_${Date.now()}`;
    const endpoint = agentEndpoint(session.agent);

    const aguiResponse = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: session.thread_id,
        runId,
        messages: allMessages,
        tools:    [],
        state:    {},
      }),
    });

    if (!aguiResponse.ok || !aguiResponse.body) {
      const errText = await aguiResponse.text();
      sendEvent({ type: "session.status_terminated", session_id: sessionId, reason: errText });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Translate AG-UI events → our event format, accumulate assistant reply
    const reader    = aguiResponse.body.getReader();
    const dec       = new TextDecoder();
    let buf         = "";
    let currentText = "";
    let currentMsgId: string | null = null;
    const assistantMessages: Array<{ id: string; role: string; content: string }> = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          let aguiEvent: Record<string, unknown>;
          try { aguiEvent = JSON.parse(data); } catch { continue; }

          // Translate AG-UI → our event format
          switch (aguiEvent.type) {
            case "TEXT_MESSAGE_START":
              currentMsgId = aguiEvent.messageId as string;
              currentText = "";
              break;

            case "TEXT_MESSAGE_CONTENT":
              currentText += aguiEvent.delta as string;
              sendEvent({
                type:       "agent.message",
                session_id: sessionId,
                content:    [{ type: "text", text: aguiEvent.delta }],
              });
              break;

            case "TEXT_MESSAGE_END":
              if (currentMsgId) {
                assistantMessages.push({
                  id:      currentMsgId,
                  role:    "assistant",
                  content: currentText,
                });
              }
              break;

            case "TOOL_CALL_START":
              sendEvent({
                type:        "agent.tool_use",
                session_id:  sessionId,
                tool_use_id: aguiEvent.toolCallId,
                tool_name:   aguiEvent.toolCallName,
                input:       {},
              });
              break;

            case "TOOL_CALL_ARGS":
              // args are streamed as delta; accumulate if needed
              break;

            case "TOOL_CALL_RESULT":
              sendEvent({
                type:        "agent.tool_result",
                session_id:  sessionId,
                tool_use_id: aguiEvent.toolCallId,
                content:     [{ type: "text", text: aguiEvent.content }],
                is_error:    false,
              });
              break;

            case "RUN_ERROR":
              sendEvent({
                type:       "session.status_terminated",
                session_id: sessionId,
                reason:     aguiEvent.message,
              });
              break;

            case "RUN_FINISHED": {
              // Persist assistant messages back to session
              const finalMessages = [...allMessages, ...assistantMessages];
              await db.collection(SESSIONS_COL).where({ id: sessionId }).update({
                messages: finalMessages,
                status:   "idle",
              });
              sendEvent({ type: "session.status_idle", session_id: sessionId });
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    sendEvent({ type: "session.status_idle", session_id: sessionId });
    res.write("data: [DONE]\n\n");
    res.end();

  } catch (err) {
    console.error(err);
    if (!res.headersSent) return res.status(500).json({ error: String(err) });
    res.write(`data: ${JSON.stringify({ type: "session.status_terminated", reason: String(err) })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ── GET /sessions/:id/events/stream ── legacy SSE (reads stored messages) ─────
router.get("/:id/events/stream", async (req: Request, res: Response) => {
  const sessionId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({
    type: "session.status_idle",
    session_id: sessionId,
    note: "Use POST /sessions/:id/events to send messages and receive streamed events",
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

export default router;
