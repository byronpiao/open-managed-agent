/**
 * Internal: derive gateway Bearer for AGS + CloudBase AI from CAM (clientCredential).
 * Sets process.env.TCB_API_KEY when needed — OAK reads that name; users only configure CAM.
 */
import { fetchAccessTokenViaSign, readTcbLoginCredential } from "./credentials.mjs";

export async function resolveTcbApiKey(options = {}) {
  const envId =
    options.envId?.trim() ||
    process.env.CLOUDBASE_ENV_ID?.trim() ||
    process.env.TCB_ENV_ID?.trim();
  const pinned = process.env.TCB_API_KEY?.trim();
  if (pinned) return pinned;

  const sessionToken =
    process.env.TCB_SESSION_TOKEN?.trim() ||
    process.env.TENCENTCLOUD_TOKEN?.trim() ||
    "";
  let secretId = process.env.TCB_SECRET_ID?.trim();
  let secretKey = process.env.TCB_SECRET_KEY?.trim();
  let token = sessionToken;

  if (!secretId || !secretKey) {
    const cred = readTcbLoginCredential();
    if (cred) {
      secretId = cred.secretId;
      secretKey = cred.secretKey;
      token = cred.token || token;
    }
  }

  if (!envId || !secretId || !secretKey) {
    throw new Error(
      "Cannot derive gateway token — set CLOUDBASE_ENV_ID and TCB_SECRET_ID / TCB_SECRET_KEY (or magent login).",
    );
  }

  return fetchAccessTokenViaSign({ envId, secretId, secretKey, token });
}

/** Set process.env.TCB_API_KEY when unset, using CAM-derived gateway token. */
export async function ensureTcbApiKeyInProcess(options = {}) {
  if (process.env.TCB_API_KEY?.trim()) return process.env.TCB_API_KEY.trim();
  const key = await resolveTcbApiKey(options);
  process.env.TCB_API_KEY = key;
  return key;
}
