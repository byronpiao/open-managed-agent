/**
 * SCF Web 函数：运行角色临时密钥除 process.env 外，还会经请求头
 * X-Scf-Secret-Id / X-Scf-Secret-Key / X-Scf-Session-Token 注入（见 SCF Web 函数文档）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ScfCamCredentials {
  secretId: string;
  secretKey: string;
  sessionToken?: string;
}

const scfCamStore = new AsyncLocalStorage<ScfCamCredentials | null>();

function headerOne(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

export function readScfCamFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): ScfCamCredentials | null {
  const secretId = headerOne(headers, "x-scf-secret-id");
  const secretKey = headerOne(headers, "x-scf-secret-key");
  const sessionToken = headerOne(headers, "x-scf-session-token") || undefined;
  if (!secretId || !secretKey) return null;
  return { secretId, secretKey, sessionToken };
}

export function getScfCamFromContext(): ScfCamCredentials | null {
  return scfCamStore.getStore() ?? null;
}

export async function runWithScfCamHeaders<T>(
  headers: Record<string, string | string[] | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const cred = readScfCamFromHeaders(headers);
  if (!cred) return fn();
  return scfCamStore.run(cred, fn);
}
