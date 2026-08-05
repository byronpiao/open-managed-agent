/**
 * Kernel adapter — bridges open-agent-kernel's AcpStreamMessage stream to
 * the ACP wire protocol used by `./acp-endpoint.ts`.
 *
 * Since kernel v0.1.0-beta.8+, session.send() / respondApproval() /
 * respondToolUse() return `AsyncIterable<AcpStreamMessage>`. The kernel's
 * built-in AcpStreamAdapter envelopes EVERY yielded item as a JSON-RPC
 * message:
 *
 *   - plain Claude SDK messages  → `session/update` NOTIFICATION
 *       ({ jsonrpc, method:"session/update", params:{ sessionId, update } })
 *   - client tool / AskUserQuestion → `client/<ToolName>` JSON-RPC REQUEST
 *       ({ jsonrpc, id:"<sessionId>:<toolCallId>", method:"client/<Name>",
 *          params:{...input}, _meta:{ sessionId, toolCallId, assistantMessageId } })
 *   - HITL permission interrupt → `session/request_permission` JSON-RPC REQUEST
 *       ({ jsonrpc, id:"<sessionId>:<toolCallId>", method:"session/request_permission",
 *          params:{ sessionId, toolCall:{...}, options:[...] } })
 *
 * This module is a thin pass-through: it forwards each frame to the SSE sink
 * verbatim (only normalizing `sessionId`), and watches for the two stop-and-
 * resume triggers (request_permission / client tool) to end the turn with the
 * right stopReason. We NEVER re-wrap a frame — the kernel already envelopes.
 *
 * Stop-and-resume model (no reverse-RPC, no in-memory pending state):
 *
 *   1. `session/request_permission` request → turn paused, stopReason=
 *      "awaiting_permission". Client resumes via a fresh `session/prompt`
 *      with a `permission_decision` block → `session.respondApproval()`.
 *
 *   2. `client/<ToolName>` request (client tool / AskUserQuestion) → turn
 *      paused, stopReason="tool_use". Client resumes with a `tool_result`
 *      block → `session.respondToolUse()`.
 *
 *   3. `session/update` carrying `agent_phase: idle` → turn complete,
 *      stopReason="end_turn".
 *
 * Note on AskUserQuestion: the kernel's `AcpSessionUpdate` d.ts marks the
 * `ask_user` variant `@deprecated ... now flows through request_permission`,
 * but that comment is stale — the beta.14 dist de-specializes AskUserQuestion
 * into an ordinary client-tool (`isAskUserQuestion = bareToolName ===
 * "AskUserQuestion"`, emitted via `client/AskUserQuestion`), and the `ask_user`
 * variant is fully removed (0 occurrences in dist). So AskUserQuestion pauses
 * with `stopReason="tool_use"` and resumes via `respondToolUse`, exactly like a
 * custom client tool — NOT via `request_permission`/`respondApproval`.
 *
 * No service-side state is held between requests. The same conversation can
 * resume on a different runtime instance (kernel session store is the SoR).
 */

import type { Response } from "express";
import { z } from "zod";
import {
  createAgent,
  type Agent as KernelAgent,
  type AcpSessionUpdate,
  type AcpStreamMessage,
  type ApprovalDecision,
  type PermissionOption,
  type Session as KernelSession,
  type ToolDefinition,
} from "@cloudbase/open-agent-kernel";

import { toKernelAgentConfig } from "./config.js";
import { getCustomTools } from "../config.js";
import type { AgentConfig } from "../config.js";

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

  // When we explicitly set session.store (before kernel auto-resolution),
  // capture it for ACP's synchronous index writes. If kernel auto-creates
  // the store internally, we won't have access here — syncRegisterSession
  // will gracefully skip (kernel's own registerSession is fire-and-forget).
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
 *
 * Outcome is recorded in `_lastSyncRegister` for the /healthz probe.
 */
export async function syncRegisterSession(
  sessionId: string,
  userId: string,
  title?: string,
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
    await _sessionStore.registerSession({ projectKey: "", sessionId, userId, title });
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
  // optionId values match the kernel's buildPermissionOptions():
  //   "allow" → allow once, "allow_always" → allow session,
  //   "reject" → deny once
  switch (outcome.optionId) {
    case "allow":
      return { kind: "allow", scope: "once" };
    case "allow_always":
      return { kind: "allow", scope: "session" };
    case "reject":
      return { kind: "deny", scope: "once", reason: "User rejected" };
    // Legacy optionId values (hyphenated) from older clients — kept for
    // backward compat during the transition period.
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
  options: PermissionOption[];
}

export interface PumpResult {
  stopReason: StopReason;
  pendingToolUse?: PendingToolUse;
  pendingPermission?: PendingPermission;
}

/**
 * A single enveloped message yielded by the kernel (new enveloping kernel,
 * beta.14+): a JSON-RPC frame — either a `session/update` notification, or a
 * `client/<ToolName>` / `session/request_permission` REQUEST. Always carries
 * `jsonrpc`. Legacy bare-update kernels are not supported (see package.json).
 */
interface AcpStreamFrame {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Pump kernel AcpStreamMessage stream into ACP SSE frames.
 *
 * The kernel's AcpStreamAdapter already envelopes every item (see module
 * doc). We forward each frame verbatim — only normalizing `sessionId` inside
 * `params` — and break out of the loop on the two stop-and-resume triggers so
 * the caller can end the SSE stream with the right stopReason.
 *
 * Three frame shapes (new enveloping kernel only):
 *
 *   1. `session/update` NOTIFICATION — forwarded as-is; if its `update` is
 *      `agent_phase: idle`, the turn is complete → stopReason="end_turn".
 *
 *   2. `session/request_permission` REQUEST — forwarded as-is; turn paused →
 *      stopReason="awaiting_permission", pendingPermission from params.
 *
 *   3. `client/<ToolName>` REQUEST (client tool / AskUserQuestion) — forwarded
 *      as-is; turn paused → stopReason="tool_use", pendingToolUse from params.
 *
 * Double-wrapping is avoided: an already-enveloped frame is forwarded as-is,
 * never re-wrapped. The kernel always envelopes (beta.14), so every item is
 * a JSON-RPC frame — no bare-update fallback is needed.
 *
 * Returns the final stopReason and, when the turn was paused for an external
 * action, a pendingToolUse or pendingPermission payload describing what the
 * client must do to resume.
 */
export async function pumpEvents(
  events: AsyncIterable<AcpStreamMessage>,
  ctx: StreamCtx,
): Promise<PumpResult> {
  for await (const item of events) {
    if (!item || typeof item !== "object") continue;
    const raw = item as AcpStreamFrame;

    const method = typeof raw.method === "string" ? raw.method : "";
    // Forward verbatim, normalizing sessionId into params (the kernel's
    // sessionId equals ctx.acpSessionId — see getOrCreateKernelSession — so
    // this is a safe no-op normalization).
    const params: Record<string, unknown> = { ...(raw.params ?? {}), sessionId: ctx.acpSessionId };
    ctx.sse.write({ ...raw, params });

    // Case 2: HITL permission request → `session/request_permission` REQUEST.
    if (method === "session/request_permission") {
      const toolCall = (params.toolCall as Record<string, unknown> | undefined) ?? {};
      const options = (params.options as PermissionOption[]) ?? [];
      return {
        stopReason: "awaiting_permission",
        pendingPermission: {
          toolUseId: String(toolCall.toolCallId ?? ""),
          toolName: String(toolCall.title ?? "unknown"),
          args: toolCall.rawInput,
          options,
        },
      };
    }

    // Case 3: client tool / AskUserQuestion → `client/<ToolName>` REQUEST.
    if (method.startsWith("client/")) {
      const toolUseId = String(raw._meta?.toolCallId ?? "");
      const toolName = method.slice("client/".length);
      return {
        stopReason: "tool_use",
        pendingToolUse: {
          toolUseId,
          toolName,
          input: raw.params ?? {},
        },
      };
    }

    // Case 1: `session/update` notification — check for turn completion.
    if (method === "session/update") {
      const update = params.update as AcpSessionUpdate | undefined;
      if (update?.sessionUpdate === "agent_phase" && (update as { phase?: string }).phase === "idle") {
        return { stopReason: "end_turn" };
      }
    }
  }

  // Stream ended without an explicit idle signal — treat as end_turn.
  return { stopReason: "end_turn" };
}

// ── SSE sink helpers (used by acp-endpoint) ─────────────────────────────────

export function makeSseSink(res: Response): SseSink {
  // Stream each frame straight to the client as it arrives. SCF web-function
  // gateway delivers intermediate `res.write()` chunks (verified), so true
  // token-by-token streaming works without buffering the whole turn.
  return {
    write: (frame) => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
      (res as Response & { flush?: () => void }).flush?.();
    },
    getAll: () => "",
    flush: () => {},
  };
}

// ── Client-side tool definition ──────────────────────────────────────────────
//
// All `type: custom` tools in agent.yaml are client-side: they have no
// server-side implementation. The kernel's PreToolUse hook (PR #7.1) detects
// these by name and intercepts the call before execute() runs:
//   - turn 1: hook denies with the client-tool sentinel → AcpStreamAdapter
//     yields a `request_permission` update; agent-runtime ends the turn with
//     stopReason='awaiting_permission'. execute() never runs.
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
