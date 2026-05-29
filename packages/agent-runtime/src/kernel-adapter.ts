/**
 * Kernel adapter — bridges open-agent-kernel's Session/SessionEvent to the
 * ACP wire protocol used by `acp-endpoint.ts`.
 *
 * Responsibilities:
 *  1. Lazy-construct the kernel `Agent` (one per process).
 *  2. Maintain a `Map<acpSessionId, Session>` to reuse warm kernel sessions.
 *  3. Translate kernel `SessionEvent` → ACP `session/update` SSE frames, and
 *     drive HITL via reverse JSON-RPC `session/request_permission` →
 *     `respondApproval()`.
 *
 * The adapter exposes a single entry point `streamPrompt()` consumed by
 * `acp-endpoint.ts` from `session/prompt`.
 */

import type { Response } from "express";
import {
  createAgent,
  type Agent as KernelAgent,
  type ApprovalDecision,
  type Session as KernelSession,
  type SessionEvent,
} from "@cloudbase/open-agent-kernel";

import { toKernelAgentConfig } from "./config.js";
import type { AgentConfig } from "./config.js";

// ── Singletons ───────────────────────────────────────────────────────────────

let _kernelAgent: KernelAgent | null = null;

/** Build (or return cached) kernel Agent for this process. */
export function getKernelAgent(config: AgentConfig): KernelAgent {
  if (_kernelAgent) return _kernelAgent;
  _kernelAgent = createAgent(toKernelAgentConfig(config));
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
    } catch (err) {
      console.warn(`[KernelAdapter] resumeSession failed (${err}); starting fresh`);
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

// ── Pending approvals (HITL) ─────────────────────────────────────────────────

interface PendingApproval {
  sessionId: string;
  toolUseId: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timeout: NodeJS.Timeout;
}

/** ACP-shaped permission outcome (per spec §session/request_permission). */
export type ApprovalOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** reverseRpcId → pending. */
const pendingApprovals = new Map<number, PendingApproval>();

/** Default 60s — HTTP-based reverse RPC must not hang sessions forever. */
const APPROVAL_TIMEOUT_MS = 60_000;

let _reverseIdCounter = 0;
function nextReverseId(): number {
  // Negative numbers to avoid colliding with the client's positive RPC ids.
  return --_reverseIdCounter;
}

/**
 * Called from `acp-endpoint.ts` POST handler when the request body is a
 * JSON-RPC *response* (has `result` or `error` and matches a pending id).
 * Resolves the corresponding waiter.
 *
 * @returns true iff the id matched a pending approval.
 */
export function tryResolvePendingApproval(id: number, body: unknown): boolean {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;
  pendingApprovals.delete(id);
  clearTimeout(pending.timeout);
  const outcome = extractOutcome(body) ?? { outcome: "cancelled" };
  pending.resolve(outcome);
  return true;
}

function extractOutcome(body: unknown): ApprovalOutcome | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { result?: { outcome?: unknown }; error?: unknown };
  if (b.error) return { outcome: "cancelled" };
  const o = b.result?.outcome;
  if (!o || typeof o !== "object") return null;
  const oo = o as { outcome?: string; optionId?: string };
  if (oo.outcome === "selected" && typeof oo.optionId === "string") {
    return { outcome: "selected", optionId: oo.optionId };
  }
  if (oo.outcome === "cancelled") return { outcome: "cancelled" };
  return null;
}

function outcomeToDecision(outcome: ApprovalOutcome): ApprovalDecision {
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

// ── Stream pump ──────────────────────────────────────────────────────────────

interface SseSink {
  write: (frame: unknown) => void;
  /** Reverse JSON-RPC request from agent to client. */
  writeRequest: (method: string, id: number, params: unknown) => void;
}

interface StreamCtx {
  sse: SseSink;
  rpcId: unknown;          // the original session/prompt request id
  acpSessionId: string;
}

/**
 * Pump kernel events into ACP SSE frames. Returns the final stopReason.
 */
export async function pumpEvents(
  events: AsyncIterable<SessionEvent>,
  session: KernelSession,
  ctx: StreamCtx,
): Promise<"end_turn" | "cancelled" | "error"> {
  for await (const e of events) {
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
        // 1) Send reverse JSON-RPC request to client over the SSE channel.
        const reverseId = nextReverseId();
        const options = buildApprovalOptions(e.hints?.suggestedScopes);
        const outcomePromise = new Promise<ApprovalOutcome>((resolve) => {
          const timeout = setTimeout(() => {
            if (pendingApprovals.delete(reverseId)) {
              console.warn(
                `[KernelAdapter] approval ${reverseId} timed out after ${APPROVAL_TIMEOUT_MS}ms`,
              );
              resolve({ outcome: "cancelled" });
            }
          }, APPROVAL_TIMEOUT_MS);
          pendingApprovals.set(reverseId, {
            sessionId: ctx.acpSessionId,
            toolUseId: e.toolUseId,
            resolve,
            timeout,
          });
        });

        ctx.sse.writeRequest("session/request_permission", reverseId, {
          sessionId: ctx.acpSessionId,
          toolCall: {
            toolCallId: e.toolUseId,
            toolName: e.toolName,
            args: e.input,
          },
          options,
          hints: e.hints,
        });

        // 2) Wait for client to POST a JSON-RPC result with this reverseId.
        const outcome = await outcomePromise;
        const decision = outcomeToDecision(outcome);

        // 3) Inject decision into kernel; recursively pump the new event stream.
        return pumpEvents(
          session.respondApproval({ toolUseId: e.toolUseId, decision }),
          session,
          ctx,
        );
      }

      case "session_idle": {
        if (e.reason === "completed") return "end_turn";
        if (e.reason === "aborted") return "cancelled";
        if (e.reason === "error") return "error";
        // 'requires_action' means we already pumped tool_approval_required
        // above and respondApproval consumed the next stream — should not reach
        // here normally. Treat as cancelled to be safe.
        return "cancelled";
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
        return "error";
      }

      // 'message_complete' / 'handoff' — not surfaced to ACP
      default:
        break;
    }
  }
  return "end_turn";
}

interface ApprovalOption {
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
  return {
    write: (frame) => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    },
    writeRequest: (method, id, params) => {
      res.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n\n`,
      );
    },
  };
}
