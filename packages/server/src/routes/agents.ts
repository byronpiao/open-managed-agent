import { db, generateId } from "../db.js";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";

const router: Router = createRouter();
const COLLECTION = "managed_agents";

// POST /agents
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, model, system, tools, metadata } = req.body as {
      name: string;
      model?: string;
      system?: string;
      tools?: unknown[];
      metadata?: Record<string, string>;
    };

    if (!name) return res.status(400).json({ error: "name is required" });

    const agent = {
      id: await generateId("agent"),
      object: "agent",
      name,
      model: model ?? "hunyuan-2.0-instruct-20251111",
      system: system ?? "",
      tools: tools ?? [{ type: "agent_toolset_20260401" }],
      metadata: metadata ?? {},
      created_at: Math.floor(Date.now() / 1000),
    };

    await db.collection(COLLECTION).add(agent);
    return res.status(201).json(agent);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  }
});

// GET /agents
router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await db.collection(COLLECTION).get();
    return res.json({
      object: "list",
      data: result.data,
      has_more: false,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /agents/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const result = await db
      .collection(COLLECTION)
      .where({ id: req.params.id })
      .get();
    if (!result.data.length) return res.status(404).json({ error: "Agent not found" });
    return res.json(result.data[0]);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// DELETE /agents/:id
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db.collection(COLLECTION).where({ id: req.params.id }).remove();
    return res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
