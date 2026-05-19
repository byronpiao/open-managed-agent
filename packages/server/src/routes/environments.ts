import { db, generateId } from "../db.js";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";

const router: Router = createRouter();
const COLLECTION = "managed_environments";

router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, config } = req.body as {
      name: string;
      config?: { type: string; networking?: { type: string } };
    };
    if (!name) return res.status(400).json({ error: "name is required" });

    const env = {
      id: await generateId("env"),
      object: "environment",
      name,
      config: config ?? { type: "cloud", networking: { type: "unrestricted" } },
      created_at: Math.floor(Date.now() / 1000),
    };

    await db.collection(COLLECTION).add(env);
    return res.status(201).json(env);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await db.collection(COLLECTION).get();
    return res.json({ object: "list", data: result.data, has_more: false });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const result = await db.collection(COLLECTION).where({ id: req.params.id }).get();
    if (!result.data.length) return res.status(404).json({ error: "Environment not found" });
    return res.json(result.data[0]);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await db.collection(COLLECTION).where({ id: req.params.id }).remove();
    return res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
