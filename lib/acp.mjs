// ── ACP (Agent Client Protocol) — JSON-RPC 2.0 over HTTP + NDJSON streaming ──
// Used by `run` and `repl` commands to talk directly to the agent.

import { yellow, red, green, dim } from "./ui.mjs";
import { getAcpHeaders } from "./credentials.mjs";

let _acpId = 0;

export function getAcpUrl(args) {
  const envId   = args.env   ?? process.env.CLOUDBASE_ENV_ID   ?? "";
  const agentId = args.agent ?? process.env.CLOUDBASE_AGENT_ID ?? "";
  if (!envId)   throw new Error("-e / --env is required (or set CLOUDBASE_ENV_ID)");
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  return `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}/acp`;
}

/** Build playground URL for browser-based ACP testing. */
export function buildPlaygroundUrl(acpEndpoint, token) {
  const u = new URL("https://tcb.cloud.tencent.com/ai/agent/acp-playground/");
  u.searchParams.set("endpoint", acpEndpoint);
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

/** Harness: poll session/status until sandbox prewarm finishes. */
export async function waitForHarnessSandboxReady(acpUrl, sessionId, initResult) {
  if (initResult?.agentConfig?.runtime !== "harness") return;
  const maxMs = Number(process.env.MAGENT_SANDBOX_WARMUP_MS) || 5 * 60 * 1000;
  const startedAt = Date.now();
  process.stdout.write(dim("Warming sandbox... "));
  while (Date.now() - startedAt < maxMs) {
    const st = await acpCall(acpUrl, "session/status", { sessionId });
    if (st?.sandboxReady) {
      console.log(green("ready"));
      return;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(yellow("timeout — sending prompt anyway"));
}

export async function acpCall(url, method, params = {}) {
  const res = await fetch(url, {
    method:  "POST",
    headers: await getAcpHeaders(),
    body:    JSON.stringify({ jsonrpc: "2.0", id: ++_acpId, method, params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text.includes("Cannot POST") || text.includes("<!DOCTYPE")) {
      throw new Error(`Agent ACP endpoint not found (HTTP ${res.status}). Is the agent deployed with open-managed-agent runtime?`);
    }
    throw new Error(`ACP HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`ACP error: ${data.error.message ?? JSON.stringify(data.error)}`);
  return data.result;
}

export async function* acpStream(url, method, params = {}) {
  const res = await fetch(url, {
    method:  "POST",
    headers: await getAcpHeaders(),
    body:    JSON.stringify({ jsonrpc: "2.0", id: ++_acpId, method, params }),
  });
  if (!res.ok || !res.body) throw new Error(`ACP stream error: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf      = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Strip SSE "data:" prefix if present. The server sends text/event-stream
      // (lines like `data: {...}\n\n`); we also tolerate plain NDJSON.
      let payload = trimmed;
      if (payload.startsWith("data:")) payload = payload.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const msg = JSON.parse(payload);
        if ("method" in msg && "id" in msg && msg.id !== null && msg.id !== undefined) {
          // Reverse JSON-RPC request (agent → client). E.g. session/request_permission.
          yield { type: "reverse_request", data: msg };
        } else if ("method" in msg) {
          // Notification — stream event (no id)
          yield { type: "notification", data: msg };
        } else if (msg.error) {
          throw new Error(`ACP error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        } else if ("result" in msg) {
          yield { type: "result", data: msg.result };
        }
      } catch (e) {
        if (e.message.startsWith("ACP error:")) throw e;
        // ignore parse errors for partial lines
      }
    }
  }
}

// ── Reverse JSON-RPC handling (HITL approvals) ────────────────────────────────
//
// When the server-side agent emits a `tool_approval_required`, our agent-runtime
// wraps it into a JSON-RPC *request* (with id + method) sent over the SSE
// channel as a `data: {...}\n\n` frame. The client must respond by POSTing back
// a JSON-RPC *response* with the same id and a `result.outcome` payload.
//
// optionId:
//   allow-once | allow-always | reject-once | reject-always
//
// outcome shape (per ACP spec):
//   selected:  { outcome: { outcome: 'selected', optionId } }
//   cancelled: { outcome: { outcome: 'cancelled' } }

async function sendReverseResponse(url, id, outcome) {
  const res = await fetch(url, {
    method:  "POST",
    headers: await getAcpHeaders(),
    body:    JSON.stringify({ jsonrpc: "2.0", id, result: { outcome } }),
  });
  // 204 No Content is the success path; we don't read the body.
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    console.error(red(`[permission] response failed: HTTP ${res.status} ${text.slice(0, 120)}`));
  }
}

export async function handleReverseRequest(url, msg, autoApprove) {
  if (msg.method !== "session/request_permission") {
    // Ignore unknown reverse methods (forward compat). No response = no error
    // path on the agent side; the agent will time out if it really needed one.
    return;
  }
  const params = msg.params ?? {};
  const toolName = params.toolCall?.toolName ?? "?";

  if (autoApprove) {
    console.log(yellow(`\n🔐 [permission] tool=${toolName} → auto-approve (allow-once)`));
    await sendReverseResponse(url, msg.id, { outcome: "selected", optionId: "allow-once" });
  } else {
    console.log(red(`\n🔐 [permission] tool=${toolName} → no --auto-approve, sending cancelled`));
    await sendReverseResponse(url, msg.id, { outcome: "cancelled" });
  }
}
