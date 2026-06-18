/**
 * Gateway ACP client for cloud harness verify / db-pressure.
 */
import { fetchAccessTokenViaSign, readTcbLoginCredential } from "../../lib/credentials.mjs";

export function gatewayAcpUrl(envId, agentId) {
  return `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}/acp`;
}

export async function getCloudAuthHeaders(envId) {
  const sessionToken =
    process.env.TCB_SESSION_TOKEN?.trim() ||
    process.env.TENCENTCLOUD_TOKEN?.trim() ||
    "";
  const secretId = process.env.TCB_SECRET_ID?.trim();
  const secretKey = process.env.TCB_SECRET_KEY?.trim();
  let accessKey = "";

  if (secretId && secretKey) {
    accessKey = await fetchAccessTokenViaSign({
      envId,
      secretId,
      secretKey,
      token: sessionToken,
    });
  } else {
    const cred = readTcbLoginCredential();
    if (cred) {
      accessKey = await fetchAccessTokenViaSign({ envId, ...cred });
    }
  }

  if (!accessKey) {
    accessKey = process.env.CLOUDBASE_APIKEY?.trim() ?? "";
  }
  if (!accessKey) {
    throw new Error(
      "No gateway access token — set TCB_SECRET_ID/TCB_SECRET_KEY in .env.harness or run magent login",
    );
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessKey}`,
    "X-CloudBase-Env-Id": envId,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function extractSseText(body) {
  let text = "";
  for (const line of body.split("\n")) {
    let payload = line.trim();
    if (payload.startsWith("data:")) payload = payload.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      const u = j.params?.update ?? j.result?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        text += u.content.text ?? "";
      }
      if (j.result?.stopReason) break;
    } catch {
      // skip
    }
  }
  return text;
}

export function createCloudAcpClient(envId, agentId) {
  const acpUrl = gatewayAcpUrl(envId, agentId);

  async function acpCall(method, params) {
    const headers = await getCloudAuthHeaders(envId);
    const res = await fetch(acpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }

  async function promptSse(sessionId, text, rpcId = 200) {
    const headers = await getCloudAuthHeaders(envId);
    const res = await fetch(acpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text }],
        },
      }),
    });
    const body = await res.text();
    if (res.status !== 200 || body.includes("504")) {
      throw new Error(`session/prompt HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    if (body.includes('"code":-32000')) {
      throw new Error(`session/prompt rpc error: ${body.slice(0, 400)}`);
    }
    return body;
  }

  async function sessionLoadReplay(sessionId) {
    const headers = await getCloudAuthHeaders(envId);
    const res = await fetch(acpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "session/load",
        params: { sessionId, replay: true },
      }),
    });
    const body = await res.text();
    if (body.includes('"code":-32000')) {
      throw new Error(`session/load failed: ${body.slice(0, 400)}`);
    }
    return body;
  }

  async function waitSandboxReady(sessionId, maxMs = 5 * 60_000) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const st = await acpCall("session/status", { sessionId });
      if (st.sandboxReady && st.instanceId) return st.instanceId;
      await sleep(2000);
    }
    throw new Error(`sandbox not ready for ${sessionId} after ${maxMs}ms`);
  }

  return { acpUrl, acpCall, promptSse, sessionLoadReplay, waitSandboxReady };
}
