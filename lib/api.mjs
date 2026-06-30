// ── HTTP helpers & Tencent Cloud OpenAPI ─────────────────────────────────────

import { createRequire } from "module";
import { readTcbLoginCredential } from "./credentials.mjs";

const _require = createRequire(import.meta.url);

const BASE_URL = process.env.CLOUDBASE_SERVER_URL ?? "http://localhost:3000";

// ── HTTP helpers (for environment management API) ──────────────────────────────
// Headers are computed dynamically so that early env propagation is reflected.

function getHeaders() {
  const envId = process.env.CLOUDBASE_ENV_ID ?? "";
  return {
    "Content-Type": "application/json",
    ...(envId ? { "X-CloudBase-Env-Id": envId } : {}),
  };
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

export const get  = (path)       => api("GET",    path);
export const post = (path, body) => api("POST",   path, body);
export const del  = (path)       => api("DELETE", path);

// Call a Tencent Cloud OpenAPI action (V3 TC3-HMAC-SHA256 signing) using the
// current tcb login credentials. Used to invoke `tcb` service actions like
// `CreateAgent` that the tcb CLI doesn't expose as a subcommand.
export async function callTcbCloudApi({
  action,
  payload,
  region = "ap-shanghai",
  service = "tcb",
  version = "2018-06-08",
  endpoint,
  noThrow = false,   // when true, returns raw Response (including Error) instead of throwing
}) {
  const cred = readTcbLoginCredential();
  if (!cred) {
    throw new Error(
      "No tcb login credentials found. Run `tcb login` first " +
      "(or set CLOUDBASE_API_KEY for direct gateway access).",
    );
  }
  const { sign } = _require("@cloudbase/signature-nodejs");

  const host = endpoint ?? `${service}.tencentcloudapi.com`;
  const url = `https://${host}/`;
  const method = "POST";
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": version,
    "X-TC-Region": region,
    ...(cred.token ? { "X-TC-Token": cred.token } : {}),
  };
  const timestamp = Math.floor(Date.now() / 1000) - 1;
  const { authorization } = sign({
    secretId: cred.secretId,
    secretKey: cred.secretKey,
    method,
    url,
    headers,
    params: payload,
    timestamp,
    withSignedParams: false,
    isCloudApi: true,
    service,
  });
  headers["Authorization"] = authorization;
  headers["X-TC-Timestamp"] = String(timestamp);

  const res = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Tencent Cloud API ${action} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!noThrow && body?.Response?.Error) {
    const e = body.Response.Error;
    throw new Error(`Tencent Cloud API ${action} ${e.Code}: ${e.Message} (RequestId=${body.Response.RequestId})`);
  }
  return body?.Response ?? body;
}
