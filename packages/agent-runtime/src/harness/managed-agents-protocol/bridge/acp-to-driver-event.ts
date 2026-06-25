/**
 * Map ACP session/update SSE payloads to Driver-shaped events for CMA projection.
 */

import type { DriverEventInput } from "../vendor/driver-event-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert one ACP JSON-RPC frame (notification or method) to zero or more driver events. */
export function acpSessionUpdateToDriverEvents(payload: Record<string, unknown>): DriverEventInput[] {
  const events: DriverEventInput[] = [];

  if (payload.method === "session/update" || payload.method === undefined) {
    const params = isRecord(payload.params) ? payload.params : {};
    const update = isRecord(params.update) ? params.update : params;
    const sessionUpdate =
      typeof update.sessionUpdate === "string" ? update.sessionUpdate : undefined;

    switch (sessionUpdate) {
      case "agent_message_chunk":
      case "agent_message_delta": {
        events.push({
          kind: "message.delta",
          payload: update,
        });
        break;
      }
      case "agent_message":
      case "agent_message_complete": {
        events.push({
          kind: "message.completed",
          payload: update,
        });
        break;
      }
      case "agent_thought_chunk":
      case "agent_thought_delta": {
        events.push({
          kind: "thought.delta",
          payload: update,
        });
        break;
      }
      case "agent_thought": {
        events.push({
          kind: "thought.completed",
          payload: update,
        });
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        events.push({
          kind: "tool.call.updated",
          payload: update,
        });
        break;
      }
      case "permission_request": {
        events.push({
          kind: "permission.requested",
          payload: {
            details: update,
            requestId: update.toolCallId ?? update.requestId,
            title: update.title ?? "Permission required",
            toolCall: update,
          },
        });
        break;
      }
      default: {
        if (Object.keys(update).length > 0) {
          events.push({
            kind: "diagnostic.reported",
            payload: { sessionUpdate, update },
            visibility: "owner_debug",
          });
        }
      }
    }
  }

  if (payload.result !== undefined) {
    events.push({
      kind: "run.completed",
      payload: isRecord(payload.result) ? payload.result : { result: payload.result },
    });
  }

  if (payload.error !== undefined) {
    events.push({
      kind: "run.failed",
      payload: isRecord(payload.error) ? payload.error : { error: payload.error },
    });
  }

  return events;
}
