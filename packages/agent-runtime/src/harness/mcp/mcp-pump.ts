/**
 * Polls TRW /api/harness/mcp-poll during an active prompt so sandbox MCP tools/call
 * can reach the gateway client-tool bridge when HARNESS_RUNTIME_CALLBACK_URL is loopback.
 */

import type { AgentConfig } from "../../config.js";
import { getCustomTools } from "../../config.js";
import {
  isLoopbackHarnessCallback,
  SANDBOX_TRW_MCP_COMPLETE_PATH,
  SANDBOX_TRW_MCP_POLL_PATH,
} from "../deploy.js";
import { invokeClientToolFromSandbox } from "./client-tool-bridge.js";
import type { HarnessSandboxHandle } from "../sandbox/orchestrator.js";
import { isE2eStubSandboxEnabled } from "../sandbox/e2e-stub.js";
import { harnessLog, harnessTrace } from "../observability/logging.js";

const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 28_000;

interface PumpHandle {
  stop: () => void;
}

export function shouldRunSandboxMcpPump(
  config: AgentConfig,
  callbackBase: string,
): boolean {
  if (isE2eStubSandboxEnabled(config)) return false;
  if (!isLoopbackHarnessCallback(callbackBase)) return false;
  return getCustomTools(config).length > 0;
}

export function startSandboxMcpPump(args: {
  handle: HarnessSandboxHandle;
  acpSessionId: string;
  config: AgentConfig;
  callbackBase: string;
  signal?: AbortSignal;
}): PumpHandle {
  if (!shouldRunSandboxMcpPump(args.config, args.callbackBase)) {
    return { stop: () => {} };
  }

  const abort = new AbortController();
  const onParentAbort = () => abort.abort();
  args.signal?.addEventListener("abort", onParentAbort);

  const pumpLog = harnessLog({
    lane: "mcp",
    operation: "mcp.pump",
    acpSessionId: args.acpSessionId,
  });
  pumpLog.milestone("mcp.pump.start");

  let stopped = false;
  const loop = async () => {
    while (!stopped && !abort.signal.aborted) {
      try {
        const pollUrl = `${SANDBOX_TRW_MCP_POLL_PATH}?sessionId=${encodeURIComponent(args.acpSessionId)}`;
        const res = await args.handle.request(pollUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (res.status === 204 || abort.signal.aborted) {
          await sleep(POLL_INTERVAL_MS, abort.signal);
          continue;
        }
        if (!res.ok) {
          harnessTrace("mcp.pump.poll_error", {
            acpSessionId: args.acpSessionId,
            status: res.status,
          });
          await sleep(POLL_INTERVAL_MS, abort.signal);
          continue;
        }
        const pending = (await res.json()) as {
          callId?: string;
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (!pending.callId || !pending.name) {
          await sleep(POLL_INTERVAL_MS, abort.signal);
          continue;
        }

        const callLog = harnessLog({
          lane: "mcp",
          operation: "mcp.call",
          acpSessionId: args.acpSessionId,
          toolName: pending.name,
          callId: pending.callId,
        });
        const startedAt = Date.now();
        let result: { content: unknown; isError?: boolean };
        try {
          result = await invokeClientToolFromSandbox({
            acpSessionId: args.acpSessionId,
            toolName: pending.name,
            input: pending.arguments ?? {},
          });
          callLog.emit({ status: "ok", durationMs: Date.now() - startedAt });
        } catch (err) {
          callLog.error(err);
          callLog.emit({ status: "error", durationMs: Date.now() - startedAt });
          result = {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }

        await args.handle.request(SANDBOX_TRW_MCP_COMPLETE_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: args.acpSessionId,
            callId: pending.callId,
            result: {
              content: [{ type: "text", text: String(result.content ?? "") }],
              isError: result.isError ?? false,
            },
          }),
        });
      } catch (err) {
        if (abort.signal.aborted) break;
        harnessTrace("mcp.pump.loop", {
          acpSessionId: args.acpSessionId,
          error: (err as Error).message,
        });
        await sleep(POLL_INTERVAL_MS, abort.signal);
      }
    }
    pumpLog.emit({ status: "stopped" });
  };

  void loop();

  return {
    stop: () => {
      stopped = true;
      abort.abort();
      args.signal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Test helper */
export function resetSandboxMcpPumpForTests(): void {
  // stateless pump — no global state
}
