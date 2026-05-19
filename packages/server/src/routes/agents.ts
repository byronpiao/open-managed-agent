import { exec } from "child_process";
import { promisify } from "util";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";

const execAsync = promisify(exec);
const router: Router = createRouter();

const ENV_ID     = process.env.CLOUDBASE_ENV_ID ?? "";
const AGENT_CODE = process.env.AGENT_RUNTIME_PATH ??
  new URL("../../agent-runtime", import.meta.url).pathname;

// Helper: call tcb agent CLI and return parsed JSON
async function tcb(args: string): Promise<unknown> {
  const cmd = `tcb agent ${args} -e ${ENV_ID} --json`;
  const { stdout, stderr } = await execAsync(cmd);
  const output = stdout.trim() || stderr.trim();
  try { return JSON.parse(output); } catch { return { raw: output }; }
}

// ── POST /agents ─────────────────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      name,
      model   = "hunyuan-2.0-instruct-20251111",
      system  = "You are a helpful assistant.",
      timeout = 7200,
      memory  = 512,
    } = req.body as {
      name: string;
      model?: string;
      system?: string;
      timeout?: number;
      memory?: number;
    };

    if (!name) return res.status(400).json({ error: "name is required" });
    if (!ENV_ID) return res.status(500).json({ error: "CLOUDBASE_ENV_ID not set" });

    // Encode system prompt as env var (escape special chars)
    const envVars = [
      `AGENT_MODEL=${model}`,
      `AGENT_SYSTEM=${encodeURIComponent(system)}`,
      `CLOUDBASE_ENV_ID=${ENV_ID}`,
    ].join(",");

    const result = await tcb(
      `create --name ${name} --code ${AGENT_CODE} --runtime Nodejs20.19 ` +
      `--timeout ${timeout} --memory-size ${memory} --install-dep --env "${envVars}"`
    ) as { agentId?: string; id?: string };

    const agentId = result.agentId ?? result.id ?? name;

    return res.status(201).json({
      id:         agentId,
      object:     "agent",
      name,
      model,
      system,
      timeout,
      memory,
      created_at: Math.floor(Date.now() / 1000),
      endpoint:   `https://${ENV_ID}.service.tcloudbase.com/v1/aibot/bots/${agentId}`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /agents ──────────────────────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await tcb("list") as { agents?: unknown[]; data?: unknown[] };
    const agents = result.agents ?? result.data ?? [];
    return res.json({ object: "list", data: agents, has_more: false });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /agents/:id ──────────────────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const result = await tcb(`detail ${req.params.id}`);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /agents/:id ───────────────────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await tcb(`delete ${req.params.id} --yes`);
    return res.json({ id: req.params.id, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── PUT /agents/:id ── update config / code ──────────────────────────────────
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const { model, system, timeout, memory } = req.body as {
      model?: string;
      system?: string;
      timeout?: number;
      memory?: number;
    };

    const parts: string[] = [`update ${req.params.id}`];
    if (timeout)  parts.push(`--timeout ${timeout}`);
    if (memory)   parts.push(`--memory-size ${memory}`);

    // If model/system changed, update env vars + redeploy code
    if (model || system) {
      const envParts: string[] = [];
      if (model)  envParts.push(`AGENT_MODEL=${model}`);
      if (system) envParts.push(`AGENT_SYSTEM=${encodeURIComponent(system)}`);
      parts.push(`--code ${AGENT_CODE} --install-dep --env "${envParts.join(",")}"`);
    }

    const result = await tcb(parts.join(" "));
    return res.json({ id: req.params.id, updated: true, result });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
