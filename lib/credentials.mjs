// ── Authentication & credentials ─────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { getNodeExecutable, getTcbScript } from "./tcb.mjs";

const _require = createRequire(import.meta.url);

// In-memory cache for access_token fetched via AK/SK/Token signing.
// Map<cacheKey, { token: string, expiresAt: number }>
const _tokenCache = new Map();

export async function fetchAccessTokenViaSign({ envId, secretId, secretKey, token }) {
  const cacheKey = `${envId}:${secretId}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  // Lazy-load the signature library (only needed in the fallback path).
  const { sign } = _require("@cloudbase/signature-nodejs");

  const host = `${envId}.api.tcloudbasegateway.com`;
  const url = `https://${host}/auth/v1/token/clientCredential`;
  const method = "POST";
  const headers = {
    "Content-Type": "application/json",
    Host: host,
  };
  const data = { grant_type: "client_credentials" };

  const { authorization, timestamp } = sign({
    secretId,
    secretKey,
    method,
    url,
    headers,
    params: data,
    timestamp: Math.floor(Date.now() / 1000) - 1,
    withSignedParams: false,
    isCloudApi: true,
  });

  headers["Authorization"] = `${authorization}, Timestamp=${timestamp}${token ? `, Token=${token}` : ""}`;
  headers["X-Signature-Expires"] = "600";
  headers["X-Timestamp"] = String(timestamp);

  const res = await fetch(url, { method, headers, body: JSON.stringify(data) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch access_token (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  const accessToken = body?.access_token;
  const expiresIn   = body?.expires_in ?? 0;
  if (!accessToken) throw new Error(`No access_token in response: ${JSON.stringify(body).slice(0, 200)}`);

  _tokenCache.set(cacheKey, {
    token: accessToken,
    // Cache for half the TTL, like the reference implementation.
    expiresAt: Date.now() + (expiresIn * 1000) / 2,
  });
  return accessToken;
}

// Read tcb CLI login credentials from ~/.config/.cloudbase/auth.json.
// tcb stores temporary STS credentials there after `tcb login`.
// If the credentials are within 10 minutes of expiry (or already expired),
// we fire `tcb env apikey list` in the background to let the tcb CLI
// refresh its internal token. The refreshed file is re-read once.
export function readTcbLoginCredential({ allowRefresh = true } = {}) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const authPath = resolve(home, ".config/.cloudbase/auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8"));
    const c = raw?.credential;
    if (!c) return null;
    if (!c.tmpSecretId || !c.tmpSecretKey) return null;
    const expiredMs = Number(c.tmpExpired) || 0;
    const msLeft = expiredMs - Date.now();
    // Trigger a silent refresh if within 10 min of expiry or already expired.
    if (allowRefresh && msLeft < 10 * 60 * 1000) {
      try {
        // `tcb env apikey list` hits the CloudBase API which causes the CLI
        // to silently refresh its STS token before returning. Use --json to
        // suppress interactive output and pick any env known to the user.
        const envId = process.env.CLOUDBASE_ENV_ID ?? "";
        spawnSync(
          getNodeExecutable(),
          [getTcbScript(), "env", "apikey", "list", ...(envId ? ["-e", envId] : []), "--json"],
          { encoding: "utf-8", timeout: 15000, stdio: "ignore" },
        );
        // Re-read the file after refresh and return the updated credential.
        return readTcbLoginCredential({ allowRefresh: false });
      } catch {
        // refresh failed — fall through and use the stale cred (or null below)
      }
    }
    if (expiredMs && Date.now() >= expiredMs) return null;
    return {
      secretId:  c.tmpSecretId,
      secretKey: c.tmpSecretKey,
      token:     c.tmpToken ?? "",
    };
  } catch {
    return null;
  }
}

export async function getAcpHeaders() {
  const envId     = process.env.CLOUDBASE_ENV_ID     ?? "";
  let   accessKey = process.env.CLOUDBASE_ACCESS_KEY ?? "";

  // Fallback: derive access_token via signed request, using credentials from
  // the current `tcb login` session (~/.config/.cloudbase/auth.json).
  if (!accessKey && envId) {
    const cred = readTcbLoginCredential();
    if (cred) {
      accessKey = await fetchAccessTokenViaSign({ envId, ...cred });
    }
  }

  return {
    "Content-Type": "application/json",
    ...(accessKey ? { Authorization: `Bearer ${accessKey}` } : {}),
    ...(envId     ? { "X-CloudBase-Env-Id": envId }         : {}),
  };
}
