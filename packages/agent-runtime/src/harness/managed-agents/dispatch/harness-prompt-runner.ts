/**
 * Run harness ACP session/prompt for Managed Agents input.start — Layer A + Layer B hooks.
 */

import type { AgentConfig } from "../../../config.js";
import {
  buildHarnessAcpMcpServers,
  DEFAULT_HARNESS_SANDBOX_CWD,
} from "../../deploy.js";
import { startSandboxMcpPump } from "../../mcp-pump.js";
import {
  deliverClientToolResult,
  getPendingToolUseIdForSession,
  registerActivePrompt,
  unregisterActivePrompt,
} from "../../client-tool-bridge.js";
import { harnessLog } from "../../logging.js";
import { persistOpencodeSyncForSession } from "../../opencode-sync.js";
import { probeClaudeSessionStoreAfterPrompt } from "../../claude-session-health.js";
import {
  ensureEngineSessionOnSandbox,
  ensureSandboxForSession,
  forwardAcpToSandbox,
} from "../../acp-endpoint.js";
import { getCachedSandboxHandle } from "../../sandbox/orchestrator.js";
import { getHarnessSessionStore } from "../../sandbox/session-store.js";
import { touchSandboxActivity } from "../../sandbox/sandbox-prewarm.js";
import type { CmaStore } from "../vendor/cma-store-types.js";
import type {
  InputStartCommand,
  McpExecuteCommand,
  PermissionResolveCommand,
} from "../vendor/runtime-command-types.js";
import { acpSessionUpdateToDriverEvents } from "../bridge/acp-to-driver-event.js";

function harnessCallbackBase(): string {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");
  const port = process.env.PORT ?? 9000;
  return `http://127.0.0.1:${port}`;
}

function envId(): string {
  return process.env.CLOUDBASE_ENV_ID ?? process.env.TCB_ENV_ID ?? "default";
}

async function ingestEngineSessionId(
  payload: Record<string, unknown>,
  acpSessionId: string,
): Promise<void> {
  if (!payload.result || typeof payload.result !== "object") return;
  const result = payload.result as Record<string, unknown>;
  if (typeof result.sessionId !== "string") return;
  await getHarnessSessionStore(envId()).setEngineSessionId(acpSessionId, result.sessionId);
}

async function appendAcpFrameToStore(
  store: CmaStore,
  acpSessionId: string,
  frame: unknown,
): Promise<void> {
  if (!frame || typeof frame !== "object") return;
  const payload = frame as Record<string, unknown>;
  await ingestEngineSessionId(payload, acpSessionId);
  for (const ev of acpSessionUpdateToDriverEvents(payload)) {
    if (ev.kind === "permission.requested") {
      const p = isRecord(ev.payload) ? ev.payload : {};
      const toolCall = isRecord(p.toolCall) ? p.toolCall : {};
      const toolCallId =
        typeof toolCall.toolCallId === "string"
          ? toolCall.toolCallId
          : typeof p.requestId === "string"
            ? p.requestId
            : "";
      const requestId = typeof p.requestId === "string" ? p.requestId : toolCallId;
      if (requestId && toolCallId) {
        registerManagedAgentsPermissionRequest({ requestId, sessionId: acpSessionId, toolCallId });
      }
    }
    await store.appendDriverEvent(acpSessionId, ev);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pipeSandboxSseToManagedAgentsStore(args: {
  upstream: globalThis.Response;
  acpSessionId: string;
  config: AgentConfig;
  store: CmaStore;
}): Promise<void> {
  const { upstream, acpSessionId, config, store } = args;
  const sandboxHandle = getCachedSandboxHandle(acpSessionId);
  const mcpPump =
    sandboxHandle &&
    startSandboxMcpPump({
      handle: sandboxHandle,
      acpSessionId,
      config,
      callbackBase: harnessCallbackBase(),
    });

  try {
    await store.appendDriverEvent(acpSessionId, {
      kind: "run.started",
      payload: { acpSessionId },
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      await store.appendDriverEvent(acpSessionId, {
        kind: "run.failed",
        payload: { message: text.slice(0, 500), httpStatus: upstream.status },
      });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const body = upstream.body;
    if (!body || !contentType.includes("text/event-stream")) {
      const text = await upstream.text();
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        await appendAcpFrameToStore(store, acpSessionId, json);
      } catch {
        await store.appendDriverEvent(acpSessionId, {
          kind: "diagnostic.reported",
          payload: { raw: text.slice(0, 500) },
        });
      }
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payloadRaw = trimmed.slice(6).trim();
        if (payloadRaw === "[DONE]") continue;
        try {
          const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
          await appendAcpFrameToStore(store, acpSessionId, payload);
        } catch {
          // skip malformed frames
        }
      }
    }

    await store.appendDriverEvent(acpSessionId, {
      kind: "run.completed",
      payload: { stopReason: "end_turn" },
    });
  } finally {
    mcpPump?.stop();
    unregisterActivePrompt(acpSessionId);
    touchSandboxActivity(acpSessionId);
    void persistOpencodeSyncForSession({
      acpSessionId,
      config,
      reason: "prompt_end",
    }).catch((err) => {
      harnessLog({
        lane: "opencode_sync",
        operation: "persist.prompt_end",
        acpSessionId,
      }).error(err);
    });
    void probeClaudeSessionStoreAfterPrompt({ acpSessionId, config }).catch((err) => {
      harnessLog({
        lane: "claude_session",
        operation: "probe.prompt_end",
        acpSessionId,
      }).error(err);
    });
  }
}

const activePrompts = new Map<string, AbortController>();
const permissionRequestById = new Map<string, { sessionId: string; toolCallId: string }>();

export function registerManagedAgentsPermissionRequest(args: {
  requestId: string;
  sessionId: string;
  toolCallId: string;
}): void {
  permissionRequestById.set(args.requestId, {
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
  });
}

async function runSandboxPrompt(args: {
  config: AgentConfig;
  store: CmaStore;
  sessionId: string;
  prompt: Array<Record<string, unknown>>;
  commandId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { config, store, sessionId, prompt, commandId, signal } = args;
  const { handle, record } = await ensureSandboxForSession(config, sessionId);
  if (!record) throw new Error(`Session not found: ${sessionId}`);
  const engineSessionId = await ensureEngineSessionOnSandbox(
    config,
    sessionId,
    handle,
    record,
    getHarnessSessionStore(envId()),
  );

  const mcpServers = buildHarnessAcpMcpServers({
    config,
    clientToolCallbackBase: harnessCallbackBase(),
    acpSessionId: sessionId,
  });

  const upstream = await forwardAcpToSandbox({
    handle,
    config,
    method: "session/prompt",
    params: {
      sessionId: engineSessionId,
      prompt,
      cwd: DEFAULT_HARNESS_SANDBOX_CWD,
      mcpServers,
    },
    id: commandId,
    acpSessionId: sessionId,
    signal,
  });

  registerActivePrompt(sessionId, (frame) => {
    void appendAcpFrameToStore(store, sessionId, frame);
    const payload = frame as Record<string, unknown>;
    const update = (payload.params as { update?: Record<string, unknown> } | undefined)?.update;
    if (update?.sessionUpdate === "permission_request" && typeof update.toolCallId === "string") {
      const requestId =
        typeof update.requestId === "string" ? update.requestId : String(update.toolCallId);
      registerManagedAgentsPermissionRequest({
        requestId,
        sessionId,
        toolCallId: update.toolCallId,
      });
    }
  });
  await pipeSandboxSseToManagedAgentsStore({ upstream, acpSessionId: sessionId, config, store });
}

/** Background harness prompt for Managed Agents user.message (input.start). */
export async function runHarnessManagedAgentsPrompt(args: {
  config: AgentConfig;
  store: CmaStore;
  sessionId: string;
  command: InputStartCommand;
}): Promise<{ requestId: string }> {
  const { config, store, sessionId, command } = args;
  const abortController = new AbortController();
  activePrompts.set(sessionId, abortController);

  const run = async () => {
    try {
      await runSandboxPrompt({
        config,
        store,
        sessionId,
        prompt: [{ type: "text", text: command.input.text }],
        commandId: command.commandId,
        signal: abortController.signal,
      });
    } catch (err) {
      await store.appendDriverEvent(sessionId, {
        kind: "run.failed",
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
      harnessLog({ lane: "managed_agents", operation: "prompt", acpSessionId: sessionId }).error(err);
    } finally {
      activePrompts.delete(sessionId);
    }
  };

  void run();
  return { requestId: command.requestId };
}

export async function resolveHarnessManagedAgentsPermission(args: {
  config: AgentConfig;
  store: CmaStore;
  sessionId: string;
  command: PermissionResolveCommand;
}): Promise<void> {
  const { config, store, sessionId, command } = args;
  cancelHarnessManagedAgentsPrompt(sessionId);
  const mapped =
    permissionRequestById.get(command.requestId) ??
    (() => {
      const toolUseId = getPendingToolUseIdForSession(sessionId);
      return toolUseId ? { sessionId, toolCallId: toolUseId } : undefined;
    })();
  const toolCallId = mapped?.toolCallId;
  if (!toolCallId) {
    throw new Error(`No pending permission for request ${command.requestId}`);
  }
  const decision = command.decision === "allow_once" ? "allow-once" : "reject-once";
  permissionRequestById.delete(command.requestId);

  const abortController = new AbortController();
  activePrompts.set(sessionId, abortController);
  try {
    await runSandboxPrompt({
      config,
      store,
      sessionId,
      prompt: [
        {
          type: "permission_decision",
          tool_use_id: toolCallId,
          decision,
        },
      ],
      commandId: command.commandId,
      signal: abortController.signal,
    });
  } finally {
    activePrompts.delete(sessionId);
  }
}

export async function executeHarnessManagedAgentsMcp(args: {
  config: AgentConfig;
  store: CmaStore;
  sessionId: string;
  command: McpExecuteCommand;
}): Promise<{ outputText: string }> {
  const { sessionId, command } = args;
  const toolUseId = getPendingToolUseIdForSession(sessionId);
  if (toolUseId) {
    const consumed = deliverClientToolResult({
      acpSessionId: sessionId,
      toolUseId,
      content: command.argumentsJson,
      isError: false,
    });
    if (consumed) {
      return { outputText: command.argumentsJson };
    }
  }
  return { outputText: "" };
}

export function cancelHarnessManagedAgentsPrompt(sessionId: string): void {
  activePrompts.get(sessionId)?.abort();
  activePrompts.delete(sessionId);
}
