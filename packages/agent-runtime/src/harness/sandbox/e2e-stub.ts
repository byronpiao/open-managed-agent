/**
 * In-process stub sandbox for harness e2e.
 * Enabled when AgentConfig.metadata.harnessE2eStub === "1" (e2e child only).
 */

import type { HarnessSandboxHandle } from "./orchestrator.js";

const openPrompts = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
const HITL_MARKER = "HITL_E2E";
const HITL_TOOL_CALL_ID = "tu-hitl-stub-1";

export const HARNESS_E2E_STUB_METADATA_KEY = "harnessE2eStub";

export function isE2eStubSandboxEnabled(config?: {
  metadata?: Record<string, string>;
}): boolean {
  return config?.metadata?.[HARNESS_E2E_STUB_METADATA_KEY] === "1";
}

function sseData(enc: TextEncoder, payload: Record<string, unknown>): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => String((b as { text?: string }).text ?? ""))
    .join("");
}

function hasPermissionDecision(prompt: unknown): { tool_use_id: string; decision: string } | null {
  if (!Array.isArray(prompt)) return null;
  for (const b of prompt) {
    if (!b || typeof b !== "object") continue;
    const block = b as { type?: string; tool_use_id?: string; decision?: string };
    if (block.type === "permission_decision" && block.tool_use_id && block.decision) {
      return { tool_use_id: block.tool_use_id, decision: block.decision };
    }
  }
  return null;
}

export function createE2eStubSandboxHandle(acpSessionId: string): HarnessSandboxHandle {
  const enc = new TextEncoder();
  return {
    instanceId: "e2e-stub-instance",
    toolId: "e2e-stub-tool",
    baseUrl: "stub://e2e",
    headers: {},
    request(path: string, init?: RequestInit) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const method = body.method as string | undefined;

      if (method === "session/new") {
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { sessionId: `engine-stub-${acpSessionId.slice(0, 8)}` },
          }),
        );
      }

      if (method === "session/prompt") {
        const params = (body.params ?? {}) as { prompt?: unknown };
        const perm = hasPermissionDecision(params.prompt);
        if (perm) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                sseData(enc, {
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "HITL_OK" },
                    },
                  },
                }),
              );
              controller.enqueue(
                sseData(enc, {
                  jsonrpc: "2.0",
                  id: body.id,
                  result: { stopReason: "end_turn" },
                }),
              );
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              headers: { "Content-Type": "text/event-stream" },
            }),
          );
        }

        const text = promptText(params.prompt);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            openPrompts.set(acpSessionId, controller);
            controller.enqueue(enc.encode(": stub keepalive\n\n"));
            if (text.includes(HITL_MARKER)) {
              controller.enqueue(
                sseData(enc, {
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    update: {
                      sessionUpdate: "permission_request",
                      toolCallId: HITL_TOOL_CALL_ID,
                      toolName: "bash",
                      options: [
                        { optionId: "allow-once", name: "Allow once" },
                        { optionId: "reject-once", name: "Reject" },
                      ],
                    },
                  },
                }),
              );
            }
          },
          cancel() {
            openPrompts.delete(acpSessionId);
          },
        });
        return Promise.resolve(
          new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      }

      if (method === "session/cancel") {
        const ctrl = openPrompts.get(acpSessionId);
        if (ctrl) {
          try {
            ctrl.close();
          } catch {
            // already closed
          }
          openPrompts.delete(acpSessionId);
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      return Promise.resolve(
        Response.json(
          { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `stub: ${method}` } },
          { status: 404 },
        ),
      );
    },
    async stop() {},
    async pause() {},
    async resumeIfPaused() {},
  };
}

/** Test helper */
export function resetE2eStubSandboxForTests(): void {
  for (const ctrl of openPrompts.values()) {
    try {
      ctrl.close();
    } catch {
      // ignore
    }
  }
  openPrompts.clear();
}
