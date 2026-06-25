/**
 * After AGS re-acquire, warm claude-agent-acp in-memory session via session/load (SDK resume + store load).
 */

import type { AgentConfig } from "../../../config.js";
import { resolveRuntime } from "../../../config.js";
import { buildHarnessAcpMcpServers, DEFAULT_HARNESS_SANDBOX_CWD } from "../../deploy.js";
import { harnessLog } from "../../observability/logging.js";
import type { HarnessSandboxHandle } from "../../sandbox/orchestrator.js";
import { getSandboxOrchestrator } from "../../sandbox/orchestrator.js";

function harnessCallbackBase(): string {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");
  const port = process.env.PORT ?? 9000;
  return `http://127.0.0.1:${port}`;
}

async function drainAcpResponseBody(res: globalThis.Response): Promise<Record<string, unknown>[]> {
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
        // skip
      }
    }
    return messages;
  }
  if (text.trim()) {
    try {
      messages.push(JSON.parse(text) as Record<string, unknown>);
    } catch {
      // ignore
    }
  }
  return messages;
}

/** Best-effort: resume Claude SDK session in fresh sidecar (no client SSE replay). */
export async function warmClaudeEngineSession(args: {
  handle: HarnessSandboxHandle;
  config: AgentConfig;
  acpSessionId: string;
  engineSessionId: string;
}): Promise<{ ok: boolean }> {
  const wl = harnessLog({
    lane: "claude_session",
    operation: "warm",
    acpSessionId: args.acpSessionId,
    engineSessionId: args.engineSessionId,
    instanceId: args.handle.instanceId,
  });
  const startedAt = Date.now();
  const { engine } = resolveRuntime(args.config);
  if (engine !== "claude") {
    wl.emit({ status: "skip", reason: "not_claude", durationMs: Date.now() - startedAt });
    return { ok: false };
  }

  const mcpServers = buildHarnessAcpMcpServers({
    config: args.config,
    clientToolCallbackBase: harnessCallbackBase(),
    acpSessionId: args.acpSessionId,
  });

  const orchestrator = getSandboxOrchestrator();
  const path = orchestrator.acpPathForEngine(engine);
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "session/load",
    params: {
      sessionId: args.engineSessionId,
      cwd: DEFAULT_HARNESS_SANDBOX_CWD,
      replay: false,
      mcpServers,
    },
  };

  try {
    const res = await args.handle.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    const messages = await drainAcpResponseBody(res);
    for (const msg of messages) {
      if (msg.error) {
        const err = msg.error as { message?: string };
        throw new Error(err.message ?? "session/load warm failed");
      }
    }
    wl.emit({
      status: res.ok ? "ok" : "http_error",
      httpStatus: res.status,
      durationMs: Date.now() - startedAt,
    });
    return { ok: res.ok };
  } catch (err) {
    wl.error(err);
    wl.emit({ status: "error", durationMs: Date.now() - startedAt });
    return { ok: false };
  }
}
