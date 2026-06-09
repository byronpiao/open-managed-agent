/**
 * Short-lived gateway JWT via CAM clientCredential (same as magent run / AGS data plane).
 */
import { createRequire } from "node:module";
import { resolveCamControlPlaneCredentials } from "./harness-env.js";

const require = createRequire(import.meta.url);

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function fetchGatewayAccessToken(envId: string): Promise<string> {
  const pinned = process.env.TCB_API_KEY?.trim();
  if (pinned) return pinned;

  const cam = resolveCamControlPlaneCredentials();
  if (!cam.secretId || !cam.secretKey) {
    throw new Error(
      "Missing CAM credentials (TCB_SECRET_ID/TCB_SECRET_KEY or magent login)",
    );
  }

  const cacheKey = `${envId}:${cam.secretId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const { sign } = require("@cloudbase/signature-nodejs") as {
    sign: (args: Record<string, unknown>) => { authorization: string; timestamp: number };
  };

  const host = `${envId}.api.tcloudbasegateway.com`;
  const url = `https://${host}/auth/v1/token/clientCredential`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: host,
  };
  const data = { grant_type: "client_credentials" };
  const { authorization, timestamp } = sign({
    secretId: cam.secretId,
    secretKey: cam.secretKey,
    method: "POST",
    url,
    headers,
    params: data,
    timestamp: Math.floor(Date.now() / 1000) - 1,
    withSignedParams: false,
    isCloudApi: true,
    token: cam.sessionToken,
  });

  headers.Authorization = `${authorization}, Timestamp=${timestamp}${
    cam.sessionToken ? `, Token=${cam.sessionToken}` : ""
  }`;
  headers["X-Signature-Expires"] = "600";
  headers["X-Timestamp"] = String(timestamp);

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(data) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gateway clientCredential failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  const accessToken = body.access_token?.trim();
  if (!accessToken) {
    throw new Error(`gateway clientCredential: no access_token in response`);
  }
  const expiresIn = body.expires_in ?? 7200;
  tokenCache.set(cacheKey, {
    token: accessToken,
    expiresAt: Date.now() + (expiresIn * 1000) / 2,
  });
  return accessToken;
}
