import { db, ai, generateId } from "../db.js";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { runAgentLoop } from "../agent-loop.js";

const router: Router = createRouter();
const SESSIONS_COL = "managed_sessions";
const AGENTS_COL = "managed_agents";

// POST /sessions
router.post("/", async (req: Request, res: Response) => {
  try {
    const { agent: agentId, environment_id, title } = req.body as {
      agent: string;
      environment_id?: string;
      title?: string;
    };
    if (!agentId) return res.status(400).json({ error: "agent is required" });

    const agentResult = await db.collection(AGENTS_COL).where({ id: agentId }).get();
    if (!agentResult.data.length) return res.status(404).json({ error: "Agent not found" });

    const session = {
      id: await generateId("sess"),
      object: "session",
      agent: agentId,
      environment_id: environment_id ?? null,
      title: title ?? "",
      status: "idle",
      events: [],
      created_at: Math.floor(Date.now() / 1000),
    };

    await db.collection(SESSIONS_COL).add(session);
    return res.status(201).json(session);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /sessions
router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await db.collection(SESSIONS_COL).get();
    return res.json({ object: "list", data: result.data, has_more: false });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /sessions/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const result = await db.collection(SESSIONS_COL).where({ id: req.params.id }).get();
    if (!result.data.length) return res.status(404).json({ error: "Session not found" });
    return res.json(result.data[0]);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// DELETE /sessions/:id
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db.collection(SESSIONS_COL).where({ id: req.params.id }).remove();
    return res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /sessions/:id/events/stream  — SSE
router.get("/:id/events/stream", async (req: Request, res: Response) => {
  const sessionId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: object) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Subscribe to events stored in DB (polling approach for simplicity)
  // In production, use CloudBase real-time DB listeners
  let lastCount = 0;
  let done = false;

  const poll = async () => {
    try {
      const result = await db.collection(SESSIONS_COL).where({ id: sessionId }).get();
      if (!result.data.length) {
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const session = result.data[0] as { events: object[]; status: string };
      const events = session.events ?? [];

      for (let i = lastCount; i < events.length; i++) {
        send(events[i]);
      }
      lastCount = events.length;

      if (session.status === "idle" || session.status === "terminated") {
        done = true;
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
    } catch (err) {
      console.error("SSE poll error:", err);
    }

    if (!done) setTimeout(poll, 500);
  };

  req.on("close", () => { done = true; });
  poll();
});

// POST /sessions/:id/events  — send user events, trigger agent loop
router.post("/:id/events", async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  try {
    const { events } = req.body as { events: Array<{ type: string; content?: unknown[] }> };

    const sessionResult = await db.collection(SESSIONS_COL).where({ id: sessionId }).get();
    if (!sessionResult.data.length) return res.status(404).json({ error: "Session not found" });

    const session = sessionResult.data[0] as {
      id: string; agent: string; events: object[]; status: string;
    };

    // Append user events
    const userEvents = events.map((e) => ({ ...e, session_id: sessionId }));
    const allEvents = [...(session.events ?? []), ...userEvents];

    await db.collection(SESSIONS_COL).where({ id: sessionId }).update({
      events: allEvents,
      status: "running",
    });

    // Fire agent loop in background
    const agentResult = await db.collection(AGENTS_COL).where({ id: session.agent }).get();
    if (agentResult.data.length) {
      runAgentLoop(sessionId, agentResult.data[0] as {
        model: string; system: string; tools: unknown[];
      }, allEvents, db, ai).catch(console.error);
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
