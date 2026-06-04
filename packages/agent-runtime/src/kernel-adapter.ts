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
let _sessionStore: SessionStoreLike | null = null;

/**
 * Subset of CloudBaseSessionStore (declared via duck typing) we need at the
 * ACP layer for synchronous index writes. Kernel exposes the store as
 * `unknown` to avoid leaking SDK types into the public surface — we re-narrow
 * it here only for the single ACP code path that needs it.
 */
export interface SessionStoreLike {
  registerSession?: (args: {
    projectKey: string;
    sessionId: string;
    userId: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

/** Build (or return cached) kernel Agent for this process. */
export function getKernelAgent(config: AgentConfig): KernelAgent {
  if (_kernelAgent) return _kernelAgent;
  const customToolDefs = getCustomTools(config).map(makeClientSideToolDefinition);
  const kernelConfig = toKernelAgentConfig(config, { customToolDefs });
  // Stash the SessionStore reference so ACP can do synchronous index writes
  // (kernel's own registerSession is fire-and-forget — see
  // open-agent-kernel/src/public/create-agent.ts:332-346 — and gets dropped
  // when SCF/cloudrun recycles the instance before the write lands).
  _sessionStore = (kernelConfig.session?.store as SessionStoreLike | undefined) ?? null;
  console.log(
    `[KernelAdapter] sessionStore captured: type=${typeof _sessionStore}, ` +
    `hasRegisterSession=${typeof _sessionStore?.registerSession === "function"}`,
  );
  _kernelAgent = createAgent(kernelConfig);
  console.log(`[KernelAdapter] kernel Agent created (id=${_kernelAgent.id})`);
  return _kernelAgent;
}

/** Diagnostic: report whether the fix landed and the store hookup is live. */
export function getStoreDiag(): {
  agentInitialized: boolean;
  storeCaptured: boolean;
  hasRegisterSession: boolean;
  storeProto: string | null;
  lastSyncRegister: { sessionId: string; ok: boolean; error?: string; ts: number } | null;
} {
  return {
    agentInitialized: _kernelAgent !== null,
    storeCaptured: _sessionStore !== null,
    hasRegisterSession: typeof _sessionStore?.registerSession === "function",
    storeProto: _sessionStore ? Object.getPrototypeOf(_sessionStore)?.constructor?.name ?? "Object" : null,
    lastSyncRegister: _lastSyncRegister,
  };
}

let _lastSyncRegister:
  | { sessionId: string; ok: boolean; error?: string; ts: number }
  | null = null;

/**
 * Block on writing the session index row (oak_sessions) for the given
 * sessionId. Idempotent per the driver: where().limit(1).get() then update
 * OR add. Safe to call after every kernel startSession to close the race
 * against instance recycling on serverless.
 *
 * Returns false (and logs) when no store is configured or the store doesn't
 * implement registerSession — the caller should treat this as "best-effort,
 * not guaranteed visible in session/list yet".
 */
/**
 * Block on writing the session index row (oak_sessions) for the given
 * sessionId. Idempotent per the driver: where().limit(1).get() then update
 * OR add. Safe to call after every kernel startSession to close the race
 * against instance recycling on serverless.
 *
 * Returns false (and logs) when no store is configured or the store doesn't
 * implement registerSession — the caller should treat this as "best-effort,
 * not guaranteed visible in session/list yet".
 *
 * Outcome is recorded in `_lastSyncRegister` for the /healthz probe.
 */
export async function syncRegisterSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const ts = Date.now();
  if (!_sessionStore?.registerSession) {
    const reason =
      `_sessionStore=${_sessionStore === null ? "null" : typeof _sessionStore}, ` +
      `registerSession=${typeof _sessionStore?.registerSession}`;
    console.warn(`[KernelAdapter] syncRegisterSession SKIP: ${reason}`);
    _lastSyncRegister = { sessionId, ok: false, error: `skipped: ${reason}`, ts };
    return false;
  }
  // projectKey passed in here is ignored when CloudBaseSessionStore was
  // constructed with `projectKey: envId` (which we do — see config.ts:336-339).
  // The store's mapProjectKey() returns the fixed value regardless. Passing ""
  // is intentional and avoids re-reading env vars.
  try {
    await _sessionStore.registerSession({ projectKey: "", sessionId, userId });
    _lastSyncRegister = { sessionId, ok: true, ts };
    return true;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[KernelAdapter] syncRegisterSession FAIL sid=${sessionId}: ${msg}`);
    _lastSyncRegister = { sessionId, ok: false, error: msg, ts };
    throw err;
  }
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
      console.warn(`[KernelAdapter] resumeSession FAILED (${msg}) — starting fresh`);
      session = await agent.startSession({ userId, conversationId: acpSessionId });
      console.log(`[KernelAdapter] startSession OK for ${acpSessionId}`);
    }
  }
  sessionPool.set(acpSessionId, session);
  return session;
}

export function dropKernelSession(acpSessionId: string): void {
  sessionPool.delete(acpSessionId);
}

export async function abortKernelSession(acpSessionId: string): Promise<boolean> {
  const session = sessionPool.get(acpSessionId);
  if (session && typeof session.abort === "function") {
    try {
      await session.abort();
      return true;
    } catch { /* best-effort */ }
  }
  return false;
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

      case "tool_use_required": {
        // PR #7.1 client-side tool flow. Kernel's PreToolUse hook denied
        // a custom tool with the client-tool sentinel; turn ends and the
        // host (this runtime → SDK consumer) must execute the tool.
        // We push a hint frame so the SSE consumer sees it inline, then
        // end the turn with stopReason='tool_use' + pendingToolUse.
        ctx.sse.write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: ctx.acpSessionId,
            update: {
              sessionUpdate: "tool_use_request",
              toolCallId: e.toolUseId,
              toolName: e.toolName,
              input: e.input,
            },
          },
        });
        return {
          stopReason: "tool_use",
          pendingToolUse: {
            toolUseId: e.toolUseId,
            toolName: e.toolName,
            input: e.input,
          },
        };
      }

      case "session_idle": {
        if (e.reason === "completed") return { stopReason: "end_turn" };
        if (e.reason === "aborted") return { stopReason: "cancelled" };
        if (e.reason === "error") return { stopReason: "error" };
        // 'requires_action' — the approval / tool_use_required branches
        // above already returned. Reaching here would be a kernel ordering
        // anomaly; treat as cancelled.
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
// server-side implementation. The kernel's PreToolUse hook (PR #7.1) detects
// these by name and intercepts the call before execute() runs:
//   - turn 1: hook denies with the client-tool sentinel → SDK emits a
//     synthetic tool_result(is_error) with the sentinel; event-translator
//     swallows it and yields `tool_use_required` instead. execute() never runs.
//   - turn 2 (after session.respondToolUse): hook allows + injects the host
//     result via updatedInput.__oak_client_tool_result__; the wrapped MCP
//     stub recognises the magic key and returns the result directly.
//
// The execute() body below is therefore only a defensive fallback for the
// case where the hook isn't wired (kernel without PR #7.1, or misconfigured
// runtime). It returns a clear error string instead of throwing, so the
// model gets a useful failure message rather than an unhandled exception.

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
    execute: async (_input: Record<string, unknown>, _ctx) => {
      return (
        `[oak-runtime] Tool '${tool.name}' is declared as client-side in agent.yaml ` +
        `but the kernel's PreToolUse hook did not intercept it before execute() ran. ` +
        `This indicates a runtime / kernel version mismatch. Please ensure the kernel ` +
        `vendor bundle includes PR #7.1 (client-side tool flow).`
      );
    },
  };
}
