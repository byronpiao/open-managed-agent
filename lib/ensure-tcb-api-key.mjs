/**
 * Resolve a permanent CloudBase API key for TCBR / SCF deploy.
 *
 * TCBR containers need a long-lived CLOUDBASE_APIKEY for:
 *   - Model access (CloudBase AI TokenHub)
 *   - AGS Sandbox (when sandbox.enabled=true)
 *
 * Short-lived STS creds (~2h) must NOT be forwarded — they expire and cause
 * SIGN_PARAM_INVALID. Instead we ensure a permanent API key is available.
 *
 * Resolution order:
 *   1. process.env.CLOUDBASE_APIKEY already set → use it
 *   2. List existing keys → retrieve plaintext via DescribeApiKeyTokens API
 *   3. No usable existing key → create one via `tcb env apikey create`
 */

import { spawnSync } from "child_process";
import { getNodeExecutable, getTcbScript } from "./tcb.mjs";
import { callTcbCloudApi } from "./api.mjs";
import { readTcbLoginCredential } from "./credentials.mjs";
import { green, dim, yellow } from "./ui.mjs";

/**
 * List API keys for an environment via `tcb env apikey list`.
 * Returns array of { keyId, name } or empty array on failure.
 */
function listApiKeys(envId) {
  try {
    const result = spawnSync(
      getNodeExecutable(),
      [getTcbScript(), "env", "apikey", "list", "-e", envId, "--json"],
      { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const out = result.stdout ?? "";
    const json = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const list = json?.data?.Data;
    if (!Array.isArray(list)) return [];
    return list.filter((k) => k?.KeyId).map((k) => ({ keyId: k.KeyId, name: k.Name || "" }));
  } catch {
    return [];
  }
}

/**
 * Retrieve the plaintext of an existing API key via DescribeApiKeyTokens.
 * Returns the plaintext key string, or null on failure.
 */
async function getApiKeyPlaintext(envId, keyId) {
  try {
    const resp = await callTcbCloudApi({
      action: "DescribeApiKeyTokens",
      payload: { EnvId: envId, KeyIdList: [keyId] },
      service: "lowcode",
      version: "2021-01-08",
    });
    const data = resp?.Data;
    if (Array.isArray(data) && data[0]?.ApiKey) return data[0].ApiKey;
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a new API key via `tcb env apikey create`.
 * Returns the plaintext API key string, or null on failure.
 */
function createApiKey(envId, name) {
  try {
    const result = spawnSync(
      getNodeExecutable(),
      [getTcbScript(), "env", "apikey", "create", name, "-e", envId, "--json"],
      { encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const out = result.stdout ?? "";
    const json = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const apiKey = json?.data?.ApiKey || json?.ApiKey;
    return typeof apiKey === "string" && apiKey ? apiKey : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a permanent CLOUDBASE_APIKEY is available for TCBR/SCF deploy.
 *
 * @param {string} envId - CloudBase environment ID
 * @returns {string} The permanent API key (also set as process.env.CLOUDBASE_APIKEY)
 */
export async function ensureTcbApiKey(envId) {
  // 1. Already set in env → trust it
  const pinned = process.env.CLOUDBASE_APIKEY?.trim();
  if (pinned) return pinned;

  // 2. Try to reuse an existing key (retrieve plaintext via API)
  const keys = listApiKeys(envId);
  if (keys.length > 0) {
    process.stdout.write(dim(`  Found ${keys.length} existing API key(s), retrieving plaintext... `));
    for (const key of keys) {
      const plain = await getApiKeyPlaintext(envId, key.keyId);
      if (plain) {
        console.log(green("OK"));
        process.env.CLOUDBASE_APIKEY = plain;
        return plain;
      }
    }
    console.log(yellow("existing keys not readable, will create new one"));
  }

  // 3. Create a new key
  const name = `magent-${Date.now()}`;
  process.stdout.write(dim("  Creating API key for agent... "));
  const apiKey = createApiKey(envId, name);
  if (apiKey) {
    console.log(green("OK"));
    process.env.CLOUDBASE_APIKEY = apiKey;
    return apiKey;
  }

  throw new Error(
    "Failed to create API key. Set CLOUDBASE_APIKEY manually or check `magent login` status.\n" +
    "  Hint: tcb env apikey create my-key -e " + envId
  );
}
