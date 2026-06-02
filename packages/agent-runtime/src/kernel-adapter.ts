/**
 * Kernel adapter — bridges open-agent-kernel's Session/SessionEvent to the
 * ACP wire protocol used by `acp-endpoint.ts`.
 *
 * Stop-and-resume model (no reverse-RPC, no in-memory pending state):
 *
 *   1. agent.yaml `type: custom` tools have no server-side implementation, so
 *      they are CLIENT-SIDE. When the model invokes one, the runtime emits an
 *      SSE `tool_call` frame, then ends the turn with stopReason='tool_use'
 *      and a `pendingToolUse` payload telling the client what to execute.
 *
 *   2. Client executes the tool locally and resumes by POSTing a fresh
 *      `session/prompt` whose prompt[] starts with a `tool_result` block.
 *      The server calls `session.send({ type: 'tool_result', ... })` — the
 *      kernel resumes the same conversation from its persisted transcript.
 *
 *   3. Permission requests follow the same pattern: SSE `permission_request`
 *      frame + stopReason='awaiting_permission' + `pendingPermission` payload;
 *      client resumes with a `permission_decision` block which we route to
 *      `session.respondApproval(...)`.
 *
 * No service-side state is held between requests. The same conversation can
 * resume on a different runtime instance (kernel session store is the SoR).
 */

import type { Response } from "express";
import { z } from "zod";
import {
  createAgent,
  type Agent as KernelAgent,
  type ApprovalDecision,
  type Session as KernelSession,
  type SessionEvent,
  type ToolDefinition,
} from "@cloudbase/open-agent-kernel";

import { toKernelAgentConfig, getCustomTools } from "./config.js";
import type { AgentConfig } from "./config.js";

// ── Singletons ───────────────────────────────────────────────────────────────

let _kernelAgent: KernelAgent | null = null;

/** Build (or return cached) kernel Agent for this process. */
export function getKernelAgent(config: AgentConfig): KernelAgent {
  if (_kernelAgent) return _kernelAgent;
  const customToolDefs = getCustomTools(config).map(makeClientSideToolDefinition);
  _kernelAgent = createAgent(toKernelAgentConfig(config, { customToolDefs }));
  console.log(`[KernelAdapter] kernel Agent created (id=${_kernelAgent.id})`);
  return _kernelAgent;
}

// ── Session pool ─────────────────────────────────────────────────────────────

const sessionPool = new Map<string, KernelSession>();

/**
 * Get a kernel `Session` for the given ACP sessionId, creating it (via
 * `startSession`) or resuming it (via `resumeSession`) on first access.
 */
export async function getOrCreateKernelSession(
  config: AgentConfig,
  acpSessionId: string,
  opts: { userId?: string; isNew?: boolean } = {},
): Promise<KernelSession> {
  const cached = sessionPool.get(acpSessionId);
  if (cached) return cached;

  const agent = getKernelAgent(config);
  const userId = opts.userId ?? "anonymous";

  let session: KernelSession;
  if (opts.isNew) {
    session = await agent.startSession({ userId, conversationId: acpSessionId });
  } else {
    // Try resume; fall back to start if the kernel has no record (e.g. a
    // brand-new acp session created before the kernel store existed).
    try {
      session = await agent.resumeSession(acpSessionId);
      console.log(`[KernelAdapter] resumeSession OK for ${acpSessionId}`);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.warn(`[KernelAdapter] resumeSession FAILED: ${msg} — starting fresh`);
      session = await agent.startSession({ userId, conversationId: acpSessionId });
    }
  }
  sessionPool.set(acpSessionId, session);
  return session;
}

export function dropKernelSession(acpSessionId: string): void {
  sessionPool.delete(acpSessionId);
}

/** Pre-populate the pool with a kernel session created externally. */
export function registerKernelSession(
  acpSessionId: string,
  session: KernelSession,
): void {
  sessionPool.set(acpSessionId, session);
}

// ── Approval decision mapping (used by acp-endpoint when resuming) ──────────

/** ACP-shaped permission outcome (per spec §session/request_permission). */
export type ApprovalOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export function outcomeToDecision(outcome: ApprovalOutcome): ApprovalDecision {
  if (outcome.outcome === "cancelled") {
    return { kind: "deny", reason: "User cancelled", interrupt: true };
  }
  switch (outcome.optionId) {
    case "allow-once":
      return { kind: "allow", scope: "once" };
    case "allow-always":
      return { kind: "allow", scope: "session" };
    case "reject-once":
      return { kind: "deny", scope: "once", reason: "User rejected" };
    case "reject-always":
      return { kind: "deny", scope: "session", reason: "User rejected (always)" };
    default:
      return { kind: "deny", reason: `Unknown optionId: ${outcome.optionId}` };
  }
}

// ── Client-side tool sentinel ───────────────────────────────────────────────
//
// When a client-side custom tool is invoked, our `execute()` throws a
// well-known error. The kernel/SDK wraps that into a `tool_result` event with
// isError=true and the error message as content. We embed a sentinel JSON in
// the message so `pumpEvents` can recognise it and intercept the flow before
// the model is allowed to keep reasoning over a fake error.

const CLIENT_TOOL_SENTINEL = "__OAK_CLIENT_TOOL_PENDING__";

interface ClientToolPendingPayload {
  [CLIENT_TOOL_SENTINEL]: true;
  toolUseId: string;
  toolName: string;
  input: unknown;
}

class ClientToolPendingError extends Error {
  constructor(public readonly payload: ClientToolPendingPayload) {
    super(`${CLIENT_TOOL_SENTINEL}:${JSON.stringify(payload)}`);
    this.name = "ClientToolPendingError";
  }
}

function tryParseClientToolPending(output: unknown): ClientToolPendingPayload | null {
  // SDK content may be a string OR an array of {type:'text', text}. Extract
  // the first text-like fragment we can find.
  const text = typeof output === "string"
    ? output
    : Array.isArray(output)
      ? output
          .map((b) =>
            b && typeof b === "object" && "text" in b && typeof (b as { text?: unknown }).text === "string"
              ? (b as { text: string }).text
              : "",
          )
          .join("")
      : "";
  if (!text || !text.includes(CLIENT_TOOL_SENTINEL)) return null;
  // Extract `{ ... }` JSON after the sentinel marker.
  const idx = text.indexOf(CLIENT_TOOL_SENTINEL);
  const colon = text.indexOf(":", idx);
  if (colon < 0) return null;
  const jsonStart = text.indexOf("{", colon);
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(jsonStart)) as ClientToolPendingPayload;
    return parsed?.[CLIENT_TOOL_SENTINEL] ? parsed : null;
  } catch {
    return null;
  }
}

// ── Stream pump ──────────────────────────────────────────────────────────────

interface SseSink {
  write: (frame: unknown) => void;
  flush?: () => void;
  getAll?: () => string;
}

interface StreamCtx {
  sse: SseSink;
  rpcId: unknown;          // the original session/prompt request id
  acpSessionId: string;
}

export type StopReason =
  | "end_turn"
  | "cancelled"
  | "error"
  | "tool_use"
  | "awaiting_permission";

export interface PendingToolUse {
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface PendingPermission {
  toolUseId: string;
  toolName: string;
  args: unknown;
  options: ApprovalOption[];
  hints?: {
    displayName?: string;
    description?: string;
    suggestedScopes?: Array<"once" | "session" | "forever">;
  };
}

export interface PumpResult {
  stopReason: StopReason;
  pendingToolUse?: PendingToolUse;
  pendingPermission?: PendingPermission;
}

/**
 * Pump kernel events into ACP SSE frames. Returns the final stopReason and,
 * when the turn was paused for an external action, a pendingToolUse or
 * pendingPermission payload describing what the client must do to resume.
 */
export async function pumpEvents(
  events: AsyncIterable<SessionEvent>,
  _session: KernelSession,
  ctx: StreamCtx,
): Promise<PumpResult> {
  let pendingClientTool: PendingToolUse | undefined;
  let eventCount = 0;

  for await (const e of events) {
    eventCount++;
    // Write diagnostic log as SSE event so it's visible in magent run output.
    if (e.type !== "message_delta") {
      ctx.sse.write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: ctx.acpSessionId,
          update: { sessionUpdate: "log", level: "debug", message: `[pumpEvents] #${eventCount} type=${e.type}`, timestamp: Date.now() },
        },
      });
    }
    switch (e.type) {
      case "message_delta": {
        ctx.sse.write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: ctx.acpSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: e.text },
            },
          },
        });
        break;
      }

      case "tool_call": {
        ctx.sse.write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: ctx.acpSessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: e.toolUseId,
              title: e.toolName,
              kind: "function",
              status: "in_progress",
              rawInput: e.input,
            },
          },
        });
        break;
      }

      case "tool_result": {
        // Intercept client-side tool sentinel — don't surface as failed; the
        // turn will end with stopReason='tool_use' and a pendingToolUse hint.
        const sentinel = tryParseClientToolPending(e.output);
        if (sentinel) {
          pendingClientTool = {
            toolUseId: sentinel.toolUseId,
            toolName: sentinel.toolName,
            input: sentinel.input,
          };
          break;
        }
        ctx.sse.write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: ctx.acpSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: e.toolUseId,
              status: e.isError ? "failed" : "completed",
              result: typeof e.output === "string" ? e.output : JSON.stringify(e.output),
            },
          },
        });
        break;
      }

      case "tool_approval_required": {
        // Surface as a permission_request session update; the turn ends here.
        // The client decides and resumes by POSTing a fresh session/prompt
        // with a permission_decision block — see acp-endpoint.handleSessionPrompt.
        const options = buildApprovalOptions(e.hints?.suggestedScopes);
        ctx.sse.write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: ctx.acpSessionId,
            update: {
              sessionUpdate: "permission_request",
              toolCallId: e.toolUseId,
              toolName: e.toolName,
              args: e.input,
              options,
              hints: e.hints,
            },
          },
        });
        return {
          stopReason: "awaiting_permission",
          pendingPermission: {
            toolUseId: e.toolUseId,
            toolName: e.toolName,
            args: e.input,
            options,
            hints: e.hints,
          },
        };
      }

      case "session_idle": {
        // If we intercepted a client-tool sentinel earlier, the SDK has
        // already finished the turn (it treats our throw as a tool error).
        // Override with stopReason='tool_use' so the client can resume.
        if (pendingClientTool) {
          return { stopReason: "tool_use", pendingToolUse: pendingClientTool };
        }
        if (e.reason === "completed") return { stopReason: "end_turn" };
        if (e.reason === "aborted") return { stopReason: "cancelled" };
        if (e.reason === "error") return { stopReason: "error" };
        // 'requires_action' — the approval branch above already returned.
        // Reaching here would be a kernel ordering anomaly; treat as cancelled.
        return { stopReason: "cancelled" };
      }

      case "error": {
        // Surface as much context as possible — Claude Agent SDK errors often
        // bury the actual cause (failed spawn, missing binary, network) in
        // .cause / .stack. Forward the full picture so the client can see it.
        const err = e.error as Error & { cause?: unknown };
        const causeText =
          err?.cause instanceof Error
            ? `${err.cause.name}: ${err.cause.message}`
            : err?.cause
              ? typeof err.cause === "string"
                ? err.cause
                : JSON.stringify(err.cause).slice(0, 500)
              : undefined;
        const detail = [err?.message, causeText, err?.stack].filter(Boolean).join("\n");
        // Also dump to container stdout so cloudrun instance logs capture it.
        console.error("[ACP] kernel error event:", detail);
        ctx.sse.write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: ctx.acpSessionId,
            update: {
              sessionUpdate: "log",
              level: "error",
              message: detail,
              timestamp: Date.now(),
            },
          },
        });
        return { stopReason: "error" };
      }

      // 'message_complete' / 'handoff' — not surfaced to ACP
      default:
        break;
    }
  }
  console.log(`[KernelAdapter] pumpEvents done: total=${eventCount} textChunks=${eventCount - (eventCount > 0 ? 1 : 0)}`);
  if (pendingClientTool) {
    return { stopReason: "tool_use", pendingToolUse: pendingClientTool };
  }
  return { stopReason: "end_turn" };
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

function buildApprovalOptions(
  scopes?: Array<"once" | "session" | "forever">,
): ApprovalOption[] {
  const out: ApprovalOption[] = [];
  const s = scopes ?? ["once", "session"];
  if (s.includes("once")) {
    out.push({ optionId: "allow-once", name: "本次允许", kind: "allow_once" });
    out.push({ optionId: "reject-once", name: "本次拒绝", kind: "reject_once" });
  }
  if (s.includes("session")) {
    out.push({ optionId: "allow-always", name: "本会话内总是允许", kind: "allow_always" });
    out.push({ optionId: "reject-always", name: "本会话内总是拒绝", kind: "reject_always" });
  }
  if (out.length === 0) {
    // safety fallback
    out.push({ optionId: "allow-once", name: "Allow once", kind: "allow_once" });
    out.push({ optionId: "reject-once", name: "Reject", kind: "reject_once" });
  }
  return out;
}

// ── SSE sink helpers (used by acp-endpoint) ─────────────────────────────────

export function makeSseSink(res: Response): SseSink {
  // Buffer all SSE frames in memory and flush them all at once when the
  // response ends. SCF web-function gateway buffers the HTTP response and
  // only delivers the last `res.write()` to the client — so streaming
  // individual frames would silently drop every frame except the last one.
  // By collecting first and flushing in one `res.end()` call we ensure the
  // gateway sees a complete, well-formed SSE body.
  const frames: string[] = [];
  return {
    write: (frame) => {
      frames.push(`data: ${JSON.stringify(frame)}\n\n`);
    },
    getAll: () => frames.join(""),
    flush: () => {
      if (frames.length > 0) {
        res.write(frames.join(""));
        frames.length = 0;
      }
    },
  };
}

// ── Client-side tool definition ──────────────────────────────────────────────
//
// All `type: custom` tools in agent.yaml are client-side: they have no
// server-side implementation. When the model calls one, we throw a sentinel
// error; pumpEvents intercepts it and ends the turn with stopReason='tool_use'
// so the client can execute the tool and POST back a tool_result.

export function makeClientSideToolDefinition(
  tool: { name: string; description: string; input_schema: Record<string, unknown> },
): ToolDefinition {
  // YAML supplies a plain JSON Schema. The kernel expects Zod, but the actual
  // validation happens on the client — pass a permissive passthrough.
  const inputSchema = z.record(z.string(), z.unknown());

  return {
    name: tool.name,
    description: tool.description,
    parameters: inputSchema,
    execute: async (input: Record<string, unknown>, ctx) => {
      // Throwing here causes the SDK to emit a tool_result with isError=true.
      // pumpEvents detects the sentinel in the result content and rewrites
      // the final stopReason to 'tool_use'.
      throw new ClientToolPendingError({
        [CLIENT_TOOL_SENTINEL]: true,
        toolUseId: ctx.toolUseId,
        toolName: tool.name,
        input,
      });
    },
  };
}
