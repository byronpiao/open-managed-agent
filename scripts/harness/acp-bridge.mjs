#!/usr/bin/env node
/**
 * ACP stdio bridge → harness runtime HTTP (for Zed / any ACP client).
 *
 * Usage:
 *   node scripts/harness/acp-bridge.mjs [baseURL]
 *
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const DEFAULT_ACP_BASE = "http://127.0.0.1:9000";

const baseURL = (process.argv[2] ?? DEFAULT_ACP_BASE).replace(/\/$/, "");

let rpcId = 0;
const nextId = () => ++rpcId;

async function httpRpc(method, params) {
  const res = await fetch(`${baseURL}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message ?? JSON.stringify(data.error));
  }
  return data.result;
}

async function* parseAcpStream(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      let payload = line.trim();
      if (payload.startsWith("data:")) payload = payload.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // skip heartbeats
      }
    }
  }
}

function mapStopReason(raw) {
  const allowed = new Set([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ]);
  if (typeof raw === "string" && allowed.has(raw)) return raw;
  return "end_turn";
}

async function relaySessionUpdate(connection, params) {
  try {
    await connection.sessionUpdate(params);
  } catch (err) {
    process.stderr.write(
      `[harness-acp-bridge] sessionUpdate skipped: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

class HarnessAcpAgent {
  /** @param {acp.AgentSideConnection} connection */
  constructor(connection) {
    this.connection = connection;
  }

  async initialize(params) {
    return httpRpc("initialize", params);
  }

  async authenticate(params) {
    return httpRpc("authenticate", params).catch(() => ({}));
  }

  async newSession(params) {
    return httpRpc("session/new", params);
  }

  async listSessions(params) {
    return httpRpc("session/list", params ?? {});
  }

  async loadSession(params) {
    const id = nextId();
    const res = await fetch(`${baseURL}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session/load",
        params: { ...params, replay: true },
      }),
    });
    if (!res.ok) {
      throw new Error(`session/load HTTP ${res.status}`);
    }
    let stopReason = "end_turn";
    for await (const msg of parseAcpStream(res)) {
      if (msg.method === "session/update" && msg.params) {
        await relaySessionUpdate(this.connection, msg.params);
      } else if (msg.result) {
        stopReason = mapStopReason(msg.result.stopReason);
      } else if (msg.error) {
        throw new Error(msg.error.message ?? "session/load failed");
      }
    }
    return { stopReason };
  }

  async prompt(params) {
    const id = nextId();
    const res = await fetch(`${baseURL}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`session/prompt HTTP ${res.status}: ${text.slice(0, 400)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("event-stream") && !contentType.includes("ndjson")) {
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return { stopReason: mapStopReason(json.result?.stopReason) };
    }

    let stopReason = "end_turn";
    for await (const msg of parseAcpStream(res)) {
      if (msg.method === "session/update" && msg.params) {
        await relaySessionUpdate(this.connection, msg.params);
      } else if (msg.result !== undefined) {
        stopReason = mapStopReason(msg.result.stopReason);
      } else if (msg.error) {
        throw new Error(msg.error.message ?? "session/prompt failed");
      }
    }
    return { stopReason };
  }

  async cancel(params) {
    await fetch(`${baseURL}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params,
      }),
    });
  }

  async unstable_deleteSession(params) {
    await httpRpc("session/delete", params);
    return {};
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new HarnessAcpAgent(conn), stream);
