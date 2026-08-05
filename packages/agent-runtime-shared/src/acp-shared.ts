/**
 * Shared ACP wire helpers (JSON-RPC + SSE).
 * Used by managed gateway handlers and harness acp-endpoint (forwards to sandbox engine).
 */

import type { Response } from "express";

export function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

export function sseStart(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

export function sseWrite(res: Response, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  (res as Response & { flush?: () => void }).flush?.();
}

export function sseDone(res: Response, sse?: { getAll?: () => string }) {
  const all = sse?.getAll?.() ?? "";
  res.end(`${all}data: [DONE]\n\n`);
}

export function sseSessionUpdate(res: Response, sessionId: string, update: unknown) {
  sseWrite(res, {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

export const ACP_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAcpUuid(s: string): boolean {
  return ACP_UUID_RE.test(s);
}
