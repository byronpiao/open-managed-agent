#!/usr/bin/env node
/**
 * magent - OpenManagedAgent CLI
 *
 * Usage:
 *   magent <command> [options]
 *
 * Commands:
 *   login                                     Login to CloudBase (proxied to tcb)
 *
 *   agent:create   -n <name> [options]
 *   agent:list     [-e <envId>]
 *   agent:get      [-i <agent-id>]
 *   agent:delete   [-i <agent-id>]
 *   agent:update   [-i <id>] [options]
 *
 *   env:list                                  List CloudBase environments (proxied to tcb)
 *
 *   session:create -a <agent-id> [--title <title>]
 *   session:list
 *   session:get    -i <session-id>
 *   session:delete -i <session-id>
 *
 *   chat           -s <session-id> -m <text>
 *   run            -a <agent-id>   -m <text>  (one-shot: create session + chat + stream)
 *   repl           -a <agent-id>              (interactive REPL)
 *
 *   <anything else>                           Transparently proxied to tcb CLI
 */

import { createInterface } from "readline";
import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

// ── Load .env file ──────────────────────────────────────────────────────────
const envFile = new URL(".env", import.meta.url).pathname;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val; // don't override existing
  }
}

const BASE_URL = process.env.CLOUDBASE_SERVER_URL ?? "http://localhost:3000";

// ── tcb script resolver ──────────────────────────────────────────────────────
// Resolves the @cloudbase/cli entry script using Node.js module resolution —
// completely PATH-independent. We then spawn it as:
//   spawnSync(process.execPath, [tcbScript, ...args])
// using the absolute node binary path (process.execPath).
//
// Resolution order:
//   1. Local node_modules (present after `npm install`) — preferred
//   2. Global nvm install beside process.execPath — always available when
//      magent itself was installed via the same nvm node

const TCB_SCRIPT_REL = ["@cloudbase", "cli", "dist", "standalone", "cli.js"].join("/");

// ── Runtime detection ────────────────────────────────────────────────────────
// Bun compiled binaries: process.versions.bun is set, process.versions.v8 is not.
// process.execPath points to the compiled binary itself — NOT a node/bun interpreter.
// We must find a node or bun interpreter separately to run @cloudbase/cli scripts.

const IS_BUN_COMPILED =
  typeof Bun !== "undefined" && !!process.versions?.bun && !process.versions?.v8;

let _nodeExec = null;

/** Return the Node.js / Bun executable to use when spawning @cloudbase/cli.
 *
 *  - Normal Node.js script:  process.execPath  (absolute, no PATH needed)
 *  - Bun script (not compiled): process.execPath  (absolute bun binary)
 *  - Compiled Bun binary: process.execPath IS the compiled app — search PATH
 *    for `node` or `bun` instead.
 */
function getNodeExecutable() {
  if (_nodeExec) return _nodeExec;
  if (!IS_BUN_COMPILED) return (_nodeExec = process.execPath);

  // Compiled Bun binary: find node or bun in PATH
  const sep     = process.platform === "win32" ? ";" : ":";
  const exts    = process.platform === "win32" ? [".exe", ""] : [""];
  const dirs    = (process.env.PATH ?? "").split(sep).filter(Boolean);

  for (const candidate of ["node", "bun"]) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = resolve(dir, candidate + ext);
        if (existsSync(full)) return (_nodeExec = full);
      }
    }
  }
  throw new Error(
    "node or bun not found in PATH.\n" +
    "Install Node.js (https://nodejs.org) and run: npm install -g @cloudbase/cli"
  );
}

let _tcbScript = null;
function getTcbScript() {
  if (_tcbScript) return _tcbScript;
  // 1. Local install — require.resolve uses Node module resolution (no PATH)
  try {
    return (_tcbScript = _require.resolve(TCB_SCRIPT_REL));
  } catch {}
  // 2. Global install relative to process.execPath (nvm: <execPath>/../../lib/node_modules/...)
  const execRelScript = resolve(
    process.execPath, "..", "..",
    "lib", "node_modules", "@cloudbase", "cli", "dist", "standalone", "cli.js"
  );
  if (existsSync(execRelScript)) return (_tcbScript = execRelScript);
  // 3. Compiled Bun binary: try relative to the node/bun interpreter found in PATH
  if (IS_BUN_COMPILED) {
    try {
      const nodeExec = getNodeExecutable();
      const nodeRelScript = resolve(
        nodeExec, "..", "..",
        "lib", "node_modules", "@cloudbase", "cli", "dist", "standalone", "cli.js"
      );
      if (existsSync(nodeRelScript)) return (_tcbScript = nodeRelScript);
    } catch {}
  }
  throw new Error(
    "@cloudbase/cli not found. Run `npm install` in the magent project, " +
    "or install globally: npm install -g @cloudbase/cli"
  );
}

// ── runTcb — invoke @cloudbase/cli programmatically ─────────────────────────
// Spawns:  <node> <tcbScript> <args>
// Both paths are absolute — no PATH dependency at runtime.

function runTcb(args, opts = {}) {
  const { input, allowFail, ...rest } = opts;
  const result = spawnSync(getNodeExecutable(), [getTcbScript(), ...args], {
    encoding: "utf-8",
    env:      process.env,
    stdio:    input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input,
    ...rest,
  });
  if (result.error) throw result.error;
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  if (!allowFail && result.status !== 0) {
    throw new Error(out.trim() || `tcb ${args[0]} exited with code ${result.status}`);
  }
  return result.stdout ?? "";
}

// ── Short-flag map ────────────────────────────────────────────────────────────

const SHORT_FLAGS = {
  e: "env",
  a: "agent",
  i: "id",
  m: "message",
  s: "session",
  f: "file",
  n: "name",
  o: "output",
};

// ── Arg parser (supports --key value and -k value) ────────────────────────────

function parseFlags(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const val = next && !next.startsWith("-") ? argv[++i] : true;
      args[key] = val;
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = SHORT_FLAGS[arg[1]] ?? arg[1];
      const next = argv[i + 1];
      const val = next && !next.startsWith("-") ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

// ── requireEnvId helper ───────────────────────────────────────────────────────
// Exits with an error + tcb env:list hint when no envId can be found.

function requireEnvId(args) {
  const envId = args.env ?? process.env.CLOUDBASE_ENV_ID ?? "";
  if (!envId) {
    console.error(red("Error: -e <envId> is required (or set CLOUDBASE_ENV_ID)"));
    console.error(dim("\nAvailable CloudBase environments:"));
    spawnSync(getNodeExecutable(), [getTcbScript(), "env:list"], { stdio: "inherit" });
    process.exit(1);
  }
  return envId;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
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

const get  = (path)       => api("GET",    path);
const post = (path, body) => api("POST",   path, body);
const del  = (path)       => api("DELETE", path);

// ── SSE stream helper ─────────────────────────────────────────────────────────

async function* streamEvents(sessionId) {
  const envId = process.env.CLOUDBASE_ENV_ID ?? "";
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/events/stream`, {
    headers: {
      Accept: "text/event-stream",
      ...(envId ? { "X-CloudBase-Env-Id": envId } : {}),
    },
  });
  if (!res.ok || !res.body) throw new Error(`Stream connect failed: ${res.status}`);

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

// ── ACP (Agent Client Protocol) — JSON-RPC 2.0 over HTTP + NDJSON streaming ──
// Used by `run` and `repl` commands to talk directly to the agent.

let _acpId = 0;

function getAcpUrl(args) {
  const envId   = args.env   ?? process.env.CLOUDBASE_ENV_ID   ?? "";
  const agentId = args.agent ?? process.env.CLOUDBASE_AGENT_ID ?? "";
  if (!envId)   throw new Error("-e / --env is required (or set CLOUDBASE_ENV_ID)");
  if (!agentId) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  return `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}/acp`;
}

// In-memory cache for access_token fetched via AK/SK/Token signing.
// Map<cacheKey, { token: string, expiresAt: number }>
const _tokenCache = new Map();

async function fetchAccessTokenViaSign({ envId, secretId, secretKey, token }) {
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
function readTcbLoginCredential({ allowRefresh = true } = {}) {
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

// Call a Tencent Cloud OpenAPI action (V3 TC3-HMAC-SHA256 signing) using the
// current tcb login credentials. Used to invoke `tcb` service actions like
// `CreateAgent` that the tcb CLI doesn't expose as a subcommand.
async function callTcbCloudApi({
  action,
  payload,
  region = "ap-shanghai",
  service = "tcb",
  version = "2018-06-08",
  endpoint,
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
  if (body?.Response?.Error) {
    const e = body.Response.Error;
    throw new Error(`Tencent Cloud API ${action} ${e.Code}: ${e.Message} (RequestId=${body.Response.RequestId})`);
  }
  return body?.Response ?? body;
}

// ── Cloud Run helpers (capi) ─────────────────────────────────────────────────
// We bypass `tcb cloudrun deploy` entirely on the create path because the cli
// becomes interactive on update (asks for traffic strategy) and silently hangs
// when piped a non-TTY stdin. Instead we drive the same three OpenAPI calls
// the cli would make ourselves: build-service upload URL → PUT zip →
// CreateCloudRunServer. This stays fully non-interactive end-to-end.

/** Zip a directory into a Buffer using the same archiver settings tcb uses. */
async function zipDir(dir) {
  const archiver = _require("archiver");
  const fs = _require("fs");
  const path = _require("path");
  const archive = archiver("zip", { zlib: { level: 1 } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    archive.on("data", (c) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
  });

  async function addDir(absDir, relDir = "") {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(absDir, e.name);
      const rel  = path.join(relDir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === "logs") continue;
        await addDir(full, rel);
      } else {
        archive.file(full, { name: rel });
      }
    }
  }
  await addDir(path.resolve(dir));
  await archive.finalize();
  return done;
}

/** Get an upload URL for a brand-new cloudrun service. */
async function describeBuildService(envId, serviceName) {
  return callTcbCloudApi({
    action: "DescribeCloudBaseBuildService",
    payload: { EnvId: envId, ServiceName: serviceName },
    service: "tcb",
    version: "2018-06-08",
  });
}

/** PUT the zip buffer to the build service's pre-signed URL. */
async function uploadZipBuffer({ uploadUrl, headers, buffer }) {
  const headerMap = {
    "Content-Type": "application/x-zip-compressed",
  };
  for (const h of headers ?? []) {
    if (h?.Key && h?.Value !== undefined) headerMap[h.Key] = h.Value;
  }
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: headerMap,
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Build package upload failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

async function getAcpHeaders() {
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

// ── Agent-type dispatch helpers ───────────────────────────────────────────
// Look up the AgentType (scf | tcbr | baas) and underlying ServiceId for an
// agent. tcb agent detail doesn't expose ServiceId, so we hit DescribeAgentList
// directly. Returns { agentType, serviceId } or {} when not found.
async function lookupAgent(envId, agentId) {
  try {
    const resp = await callTcbCloudApi({
      action: "DescribeAgentList",
      payload: { EnvId: envId, AgentId: agentId },
    });
    const found = (resp.AgentList ?? []).find((a) => a.AgentId === agentId);
    if (!found) return {};
    return {
      agentType: found.AgentType ?? "",
      serviceId: found.ServiceId ?? "",
    };
  } catch {
    return {};
  }
}

// Build the EnvParam map that ships into a cloudrun (tcbr) container. Used by
// both cloudrun:create (initial deploy) and agent:update on tcbr agents
// (re-pushed via SubmitServerConfigChangeDiff). Pulls the agent config from
// the caller, then layers on OAK_* knobs and CloudBase creds (TCB_SECRET_*)
// from shell env or tcb-login STS.
//
// Contract: every env update has to re-supply these via the operator's shell
// because TCBR replaces (not merges) EnvParam on each config-change.
//
// Model credentials (apiKey/apiBaseUrl) belong in agent.yaml's `model`
// ModelSpec — they ride inside AGENT_CONFIG_B64 and don't need separate env.
function buildCloudRunEnvParam({ envId, configB64 }) {
  const envMap = {
    CLOUDBASE_ENV_ID: envId,
    AGENT_CONFIG_B64: configB64,
  };
  // Forward TCB_API_KEY when set — enables the AGS Sandbox (requires a
  // long-lived TokenHub JWT, not the STS creds used for DB access).
  if (process.env.TCB_API_KEY) envMap.TCB_API_KEY = process.env.TCB_API_KEY;

  // OAK_DISABLE_SANDBOX: when TCB_API_KEY is not available the runtime would
  // crash on first prompt ("AgsStatefulSandbox requires TCB_API_KEY"). Auto-
  // disable sandbox so the agent is reachable without a TokenHub key.
  // The operator can override by explicitly setting TCB_API_KEY before deploy.
  const hasTcbApiKey = !!(process.env.TCB_API_KEY);
  if (!hasTcbApiKey) envMap.OAK_DISABLE_SANDBOX = "1";
  // OAK_USE_MEMORY_STORE: fall back to in-process session storage when there
  // are no CloudBase DB credentials; avoids a MISSING_CREDENTIALS crash on
  // session create. Overridden to "0" if TCB_SECRET_ID is available.
  const hasDbCreds = !!(process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY);
  // Explicit shell overrides still take precedence.
  if (process.env.OAK_DISABLE_SANDBOX !== undefined) envMap.OAK_DISABLE_SANDBOX = process.env.OAK_DISABLE_SANDBOX;
  if (process.env.OAK_USE_MEMORY_STORE !== undefined) envMap.OAK_USE_MEMORY_STORE = process.env.OAK_USE_MEMORY_STORE;
  else if (!hasDbCreds) envMap.OAK_USE_MEMORY_STORE = "1";
  let credsSource = "";
  if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
    envMap.TCB_SECRET_ID = process.env.TCB_SECRET_ID;
    envMap.TCB_SECRET_KEY = process.env.TCB_SECRET_KEY;
    if (process.env.TCB_TOKEN) envMap.TCB_TOKEN = process.env.TCB_TOKEN;
    credsSource = "shell";
  } else {
    const sts = readTcbLoginCredential();
    if (sts) {
      envMap.TCB_SECRET_ID = sts.secretId;
      envMap.TCB_SECRET_KEY = sts.secretKey;
      if (sts.token) envMap.TCB_TOKEN = sts.token;
      credsSource = "sts";
    }
  }
  return { envMap, credsSource };
}

// Wait for a tcbr cloudrun service deploy to leave creating/deploying state.
// Returns the final status string (typically "normal" on success).
async function waitForCloudRunDeploy(envId, serviceName, { maxWaitMs = 10 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const detail = await callTcbCloudApi({
        action: "DescribeCloudRunDeployRecord",
        payload: { EnvId: envId, ServerName: serviceName },
        service: "tcbr",
        version: "2022-02-17",
      });
      const records = detail.DeployRecords ?? [];
      if (records.length > 0) {
        lastStatus = records[records.length - 1]?.Status ?? "";
        if (lastStatus && lastStatus !== "creating" && lastStatus !== "deploying") {
          return lastStatus;
        }
      }
    } catch {
      // transient — retry
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return lastStatus;
}

// Poll the agent's own `initialize` endpoint until its echoed
// agentConfig.metadata.__deployedAt matches the timestamp we stamped when
// building the new config. This is the most accurate "new config is
// actually serving traffic" signal — TCBR's deploy-pipeline status reaches
// "finished" before the LB has fully drained old pods (~90s gap), and
// comparing system prompt alone fails when the system prompt didn't change
// between updates. The __deployedAt timestamp is always unique per update.
async function waitForConfigLive({ agentUrl, expectedDeployedAt, maxWaitMs = 5 * 60 * 1000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const result = await acpCall(agentUrl, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "magent", version: "0.1.0" },
      });
      if (result?.agentConfig?.metadata?.__deployedAt === expectedDeployedAt) return true;
    } catch {
      // transient — agent might be in mid-roll, retry
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

async function acpCall(url, method, params = {}) {
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

async function* acpStream(url, method, params = {}) {
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

async function handleReverseRequest(url, msg, autoApprove) {
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

// ── Alias generation ──────────────────────────────────────────────────────────
// tcb requires alias to be ASCII; convert Unicode/CJK names to a stable slug.
function toAlias(name) {
  const ascii = name
    .toLowerCase()
    .replace(/[一-鿿㐀-䶿]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const hasCJK = /[一-鿿㐀-䶿]/.test(name);
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
  const suffix = (hash >>> 0).toString(36).slice(0, 6);

  const base = ascii || "agent";
  return hasCJK ? `${base ? base + "-" : ""}${suffix}` : base;
}

// ── Pretty printers ───────────────────────────────────────────────────────────

const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

function printAgent(a) {
  console.log(`  ${bold(a.id)}`);
  console.log(`    name   : ${a.name}`);
  console.log(`    model  : ${a.model}`);
  console.log(`    system : ${dim(a.system?.slice(0, 80) ?? "(none)")}`);
  console.log(`    created: ${dim(new Date(a.created_at * 1000).toLocaleString())}`);
}

function printSession(s) {
  console.log(`  ${bold(s.id)}`);
  console.log(`    title  : ${s.title || dim("(untitled)")}`);
  console.log(`    agent  : ${s.agent}`);
  console.log(`    status : ${s.status === "idle" ? green(s.status) : s.status === "running" ? yellow(s.status) : red(s.status)}`);
  console.log(`    created: ${dim(new Date(s.created_at * 1000).toLocaleString())}`);
}

function printEnv(e) {
  console.log(`  ${bold(e.id)}`);
  console.log(`    name   : ${e.name}`);
  console.log(`    type   : ${e.config?.type ?? "-"}`);
  console.log(`    network: ${e.config?.networking?.type ?? "-"}`);
}

// ── Event renderer (for chat / run) ──────────────────────────────────────────

function renderEvent(event) {
  switch (event.type) {
    case "agent.thinking":
      console.log(dim(`\n💭 ${event.thinking}`));
      break;

    case "agent.message":
      for (const block of event.content ?? []) {
        if (block.type === "text") process.stdout.write(block.text ?? "");
      }
      process.stdout.write("\n");
      break;

    case "agent.tool_use":
      console.log(yellow(`\n🔧 Tool: ${event.tool_name}`));
      console.log(dim(`   ${JSON.stringify(event.input)}`));
      break;

    case "agent.tool_result":
      if (event.is_error) {
        console.log(red(`   ❌ ${event.content?.[0]?.text ?? "error"}`));
      } else {
        console.log(dim(`   ✓ ${event.content?.[0]?.text?.slice(0, 120) ?? ""}`));
      }
      break;

    case "agent.custom_tool_use":
      console.log(cyan(`\n🔌 Custom tool: ${event.tool_name} (tool_use_id: ${event.tool_use_id})`));
      console.log(dim(`   ${JSON.stringify(event.input)}`));
      break;

    case "session.status_idle":
      console.log(green("\n✅ Done."));
      break;

    case "session.status_terminated":
      console.log(red(`\n❌ Terminated: ${event.reason ?? "unknown"}`));
      break;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
// Each handler receives (args, rest) where:
//   args = parsed key/value flags object
//   rest = raw argv tokens after the command (for passthrough)

const COMMANDS = {

  // ─── Login (proxy to tcb) ─────────────────────────────────────────────────

  "login": async (args, rest) => {
    spawnSync(getNodeExecutable(), [getTcbScript(), "login", ...rest], { stdio: "inherit" });
  },

  // ─── Agent ────────────────────────────────────────────────────────────────

  "agent:create": async (args) => {
    const { name, model, system } = args;
    if (!name) throw new Error("-n / --name is required");
    const type = (args.type ?? "scf").toLowerCase();
    if (type !== "scf" && type !== "tcbr") {
      throw new Error(`--type must be 'scf' or 'tcbr' (got '${type}')`);
    }

    // Container-mode (TCBR cloudrun) — delegate to the cloudrun:create flow,
    // which builds an image from the agent-runtime Dockerfile, deploys it as
    // a CloudRun service, and registers it as a tcbr agent.
    if (type === "tcbr") {
      return COMMANDS["cloudrun:create"](args);
    }

    // SCF cloud function path (default).
    const envId   = requireEnvId(args);
    const code    = args.code    ?? "./packages/agent-runtime";
    const runtime = args.runtime ?? "Nodejs20.19";

    // Build initial config
    const config = {
      name,
      model:  model  ?? "hunyuan-t1-latest",
      system: system ?? "You are a helpful assistant.",
    };

    // If --file provided, load full config from YAML/JSON
    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        let fileConfig;
        if (content.trim().startsWith("{")) {
          fileConfig = JSON.parse(content);
        } else {
          const { parse } = await import("yaml");
          fileConfig = parse(content);
        }
        Object.assign(config, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file: ${err.message}`);
      }
    }

    // Explicit CLI args override file config
    if (name)   config.name   = name;
    if (model)  config.model  = model;
    if (system) config.system = system;

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");
    // Build env string for `tcb agent create --env`. Same OAK_* defaults as
    // buildCloudRunEnvParam: auto-disable sandbox when no TCB_API_KEY is set,
    // fall back to memory store when no DB creds are available.
    const scfEnvMap = {
      CLOUDBASE_ENV_ID: envId,
      AGENT_CONFIG_B64: configB64,
    };
    if (process.env.TCB_API_KEY) {
      scfEnvMap.TCB_API_KEY = process.env.TCB_API_KEY;
    } else {
      scfEnvMap.OAK_DISABLE_SANDBOX = "1";
    }
    // SCF functions get DB creds via the built-in role (TENCENTCLOUD_SECRETID
    // etc. auto-injected), so we don't need OAK_USE_MEMORY_STORE unless the
    // operator explicitly requests it.
    if (process.env.OAK_USE_MEMORY_STORE) scfEnvMap.OAK_USE_MEMORY_STORE = process.env.OAK_USE_MEMORY_STORE;
    const envVars = Object.entries(scfEnvMap).map(([k, v]) => `${k}=${v}`).join(",");

    console.log(bold("Creating agent..."));
    console.log(dim(`  name:    ${config.name}`));
    console.log(dim(`  model:   ${typeof config.model === "string" ? config.model : `${config.model?.id ?? "?"}${config.model?.apiBaseUrl ? ` @ ${config.model.apiBaseUrl}` : ""}`}`));
    console.log(dim(`  code:    ${code}`));
    console.log(dim(`  runtime: ${runtime}`));
    console.log();

    // Bundle node_modules locally so the SCF function has deps available
    // on cold start. The key pain point: claude-agent-sdk ships the native
    // claude binary as an optional platform package (linux-x64). npm skips
    // optionals on non-matching platforms, so we force-install it afterward.
    const deployDir = resolve(code, ".deploy");
    let actualCode = code;
    try {
      execSync(`rm -rf "${deployDir}" && mkdir -p "${deployDir}"`, { encoding: "utf-8" });
      const filesToCopy = ["dist", "package.json", "package-lock.json", "scf_bootstrap", "vendor"];
      // uid-shim.js is a plain JS file (not compiled TypeScript) that patches
      // process.getuid for SCF's root environment. Copy it alongside dist/.
      const uidShim = resolve(code, "src", "uid-shim.js");
      if (existsSync(uidShim)) {
        execSync(`cp "${uidShim}" "${deployDir}/uid-shim.js"`, { encoding: "utf-8" });
      }
      // agent.yaml is optional — only bundled if the user explicitly created one
      // (by copying agent.yaml.example). Without it, config is injected via AGENT_CONFIG_B64.
      if (existsSync(resolve(code, "agent.yaml"))) filesToCopy.push("agent.yaml");
      if (existsSync(resolve(code, "skills"))) filesToCopy.push("skills");
      for (const f of filesToCopy) {
        const src = resolve(code, f);
        if (existsSync(src)) execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
      }
      process.stdout.write(dim("  Installing dependencies... "));
      execSync("npm install --production --silent 2>/dev/null", {
        cwd: deployDir, encoding: "utf-8", timeout: 120000,
      });
      // Force-install the linux-x64 Claude SDK binary. npm refuses to install
      // cross-platform optional deps without --force on arm64/darwin.
      const sdkPkgPath = resolve(deployDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
      const sdkVersion = JSON.parse(readFileSync(sdkPkgPath, "utf-8")).version;
      execSync(
        `npm install --no-save --force --silent @anthropic-ai/claude-agent-sdk-linux-x64@${sdkVersion} 2>/dev/null`,
        { cwd: deployDir, encoding: "utf-8", timeout: 120000 },
      );
      console.log(green("OK"));
      actualCode = deployDir;
    } catch (err) {
      console.log(yellow(`  Warning: dep bundling failed: ${err.message?.split("\n")[0]}`));
      console.log(yellow("  Falling back to --install-dep (cloud-side install, slower cold start)"));
    }

    try {
      const alias = toAlias(name);
      const tcbArgs = [
        "agent", "create",
        "--name",        alias,
        "--runtime",     runtime,
        "--code",        actualCode,
        "--ignore",      ".git,node_modules,.DS_Store,.deploy,.deploy-cloudrun,logs",
        "--timeout",     "7200",
        "--memory-size", "256",
        "--env",         envVars,
        "-e",            envId,
        ...(actualCode === code ? ["--install-dep"] : []),  // fallback: cloud-side install
        "--json",
      ];
      const raw  = runTcb(tcbArgs, { timeout: 300000 });
      const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      if (data.data?.agentId) {
        console.log(green(`✅ Agent created: ${data.data.agentId}`));
        console.log(dim(`  name:    ${name}`));
        console.log(dim(`  runtime: ${runtime}`));
        console.log();
        console.log("Next steps:");
        console.log(dim(`  1. Wait for ready: magent agent:get -i ${data.data.agentId} -e ${envId}`));
        console.log(dim(`  2. Update config:  magent agent:update -i ${data.data.agentId} -f agent.yaml -e ${envId}`));
        console.log(dim(`  3. Start chatting: magent run -a ${data.data.agentId} -m "Hello"`));
      } else {
        console.log(yellow("Agent creation submitted. Check status with: magent agent:list"));
      }
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
    } catch (err) {
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
      throw new Error(`Failed to create agent: ${err.message}`);
    }
  },

  "agent:list": async (args) => {
    const envId = requireEnvId(args);
    const result = runTcb(["agent", "list", "-e", envId], { timeout: 30000 });
    console.log(result);
  },

  "agent:get": async (args) => {
    const agentId = args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
    if (!agentId) throw new Error("-i / --id is required (or set CLOUDBASE_AGENT_ID)");
    const envId  = requireEnvId(args);
    const result = runTcb(["agent", "detail", agentId, "-e", envId], { timeout: 30000 });
    console.log(result);
  },

  // ─── Agent Export (live config → YAML) ───────────────────────────────────

  "agent:export": async (args) => {
    const agentId = args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
    if (!agentId) throw new Error("-i / --id is required (or set CLOUDBASE_AGENT_ID)");
    requireEnvId(args);
    const agentUrl = args.url ?? getAcpUrl({ ...args, agent: agentId });

    process.stdout.write(dim("Fetching config from agent... "));
    let cfg;
    try {
      const result = await acpCall(agentUrl, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "magent", version: "0.1.0" },
      });
      if (!result?.agentConfig) throw new Error("initialize returned no agentConfig");
      cfg = { ...result.agentConfig };
      if (result.agentInfo?.name)  cfg.name        = result.agentInfo.name;
      if (result.agentInfo?.title) cfg.description = result.agentInfo.title;
    } catch (err) {
      console.log(red("FAILED"));
      throw err;
    }
    console.log(green("OK"));

    // Strip internal deployment stamp injected by agent:update so the
    // exported YAML is clean and idempotent when fed back to agent:update -f.
    if (cfg.metadata?.__deployedAt) {
      cfg = { ...cfg, metadata: { ...cfg.metadata } };
      delete cfg.metadata.__deployedAt;
      if (Object.keys(cfg.metadata).length === 0) delete cfg.metadata;
    }

    const { stringify } = await import("yaml");
    const yamlText = stringify(cfg, { lineWidth: 0 });

    const outPath = args.output;
    if (outPath) {
      writeFileSync(outPath, yamlText, "utf-8");
      console.log(green(`✅ Config written to ${outPath}`));
    } else {
      process.stdout.write(yamlText);
    }
  },

  "agent:delete": async (args) => {
    const agentId = args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
    if (!agentId) throw new Error("-i / --id is required (or set CLOUDBASE_AGENT_ID)");
    const envId = requireEnvId(args);

    // Phase 1: discover the underlying compute resource so we can clean it up
    // after the agent registration is removed. `tcb agent detail` doesn't
    // expose ServiceId, so we hit DescribeAgentList directly.
    const { agentType, serviceId } = await lookupAgent(envId, agentId);
    if (!agentType) {
      console.log(yellow(`⚠️  could not look up agent metadata; proceeding with registration delete only.`));
    }

    // Phase 2: remove the agent registration
    process.stdout.write(dim(`Deleting agent registration... `));
    runTcb(["agent", "delete", agentId, "-e", envId], { input: "Y\n", timeout: 60000 });
    console.log(green("OK"));

    // Phase 3: cascade-delete the underlying compute (cloudrun service or
    // SCF function). `baas` agents are built-in templates with no resource.
    if (!serviceId) {
      console.log(green(`✅ Agent ${agentId} deleted.`));
      return;
    }

    if (agentType === "tcbr") {
      process.stdout.write(dim(`Deleting cloudrun service '${serviceId}'... `));
      const r = spawnSync(
        getNodeExecutable(),
        [getTcbScript(), "cloudrun", "delete", "-s", serviceId, "-e", envId, "--force"],
        { encoding: "utf-8", timeout: 120000 },
      );
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (r.status === 0 && !/✖|error|failed/i.test(out)) {
        console.log(green("OK"));
      } else if (/not found/i.test(out)) {
        console.log(dim("(already gone)"));
      } else {
        console.log(yellow("FAILED"));
        console.log(dim(out.split("\n").filter((l) => /✖|error/i.test(l)).join("\n").trim() || out.trim().slice(-300)));
      }
    } else if (agentType === "scf") {
      process.stdout.write(dim(`Deleting cloud function '${serviceId}'... `));
      const r = spawnSync(
        getNodeExecutable(),
        [getTcbScript(), "fn", "delete", serviceId, "-e", envId],
        { encoding: "utf-8", timeout: 120000 },
      );
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (r.status === 0 && !/✖|error|failed/i.test(out)) {
        console.log(green("OK"));
      } else if (/not found|不存在|ResourceNotFound/i.test(out)) {
        console.log(dim("(already gone)"));
      } else {
        console.log(yellow("FAILED"));
        console.log(dim(out.split("\n").filter((l) => /✖|error/i.test(l)).join("\n").trim() || out.trim().slice(-300)));
      }
    } else if (agentType === "baas") {
      console.log(dim("(baas agent — no underlying compute to delete)"));
    } else if (agentType) {
      console.log(yellow(`⚠️  unknown agent type '${agentType}', skipping resource cleanup`));
    }

    console.log(green(`✅ Agent ${agentId} deleted.`));
  },

  // ─── Agent Update (config via env var) ───────────────────────────────────

  "agent:update": async (args) => {
    const agentId = args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
    if (!agentId) throw new Error("-i / --id is required (or set CLOUDBASE_AGENT_ID)");
    const envId  = requireEnvId(args);

    // Fetch current config from running agent. We need it so that partial
    // updates (e.g. --system foo with everything else preserved) don't blow
    // away unrelated fields. ACP `initialize` is the only public way to
    // read the config back; if it's down (e.g. mid-redeploy on tcbr), we
    // retry once and then refuse to proceed unless --file supplies a full
    // config — silently filling in 'open-managed-agent' / 'hunyuan-t1-latest'
    // would corrupt the agent's identity, which has bitten us before.
    let currentConfig = null;
    // getAcpUrl expects --agent; we have --id. Bridge with a fresh args copy.
    const agentUrl = args.url ?? getAcpUrl({ ...args, agent: agentId });
    const fetchCurrent = async () => {
      // Use acpCall so we pick up the same auth fallback as `magent run`
      // (Bearer from CLOUDBASE_ACCESS_KEY, else mint access_token via tcb
      // login STS). Without that, the gateway 401s and we'd silently treat
      // it as "no config".
      const result = await acpCall(agentUrl, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "magent", version: "0.1.0" },
      });
      if (!result?.agentConfig) return null;
      const cfg = { ...result.agentConfig };
      if (result.agentInfo?.name) cfg.name = result.agentInfo.name;
      if (result.agentInfo?.title) cfg.description = result.agentInfo.title;
      return cfg;
    };

    process.stdout.write(dim("Fetching current config... "));
    try {
      currentConfig = await fetchCurrent();
    } catch {
      // first attempt failed — pause and retry once
      await new Promise((r) => setTimeout(r, 5000));
      try { currentConfig = await fetchCurrent(); } catch { /* fall through */ }
    }
    if (currentConfig) {
      console.log(green("OK"));
    } else {
      console.log(yellow("not available"));
    }

    // Collect updates
    const updates = {};
    if (args.name)            updates.name        = args.name;
    if (args.model)           updates.model       = args.model;
    if (args.system)          updates.system      = args.system;
    if (args.description)     updates.description = args.description;
    if (args.tools)           updates.tools       = JSON.parse(args.tools);
    if (args["mcp-servers"])  updates.mcp_servers = JSON.parse(args["mcp-servers"]);
    if (args.skills)          updates.skills      = JSON.parse(args.skills);

    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        let fileConfig;
        if (content.trim().startsWith("{")) {
          fileConfig = JSON.parse(content);
        } else {
          const { parse } = await import("yaml");
          fileConfig = parse(content);
        }
        Object.assign(updates, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file ${args.file}: ${err.message}`);
      }
    }

    if (Object.keys(updates).length === 0) {
      console.log(yellow("No updates specified. Use --system, --model, --tools, -f <file>, etc."));
      return;
    }

    // Merge: file/CLI updates over current config. If we never got the
    // current config, the caller has to supply a full one via --file, or
    // the partial update will be missing required fields.
    const merged = { ...(currentConfig ?? {}), ...updates };
    const requireFullConfig = !currentConfig;
    if (requireFullConfig) {
      const missing = [];
      if (!merged.name) missing.push("name");
      if (!merged.model) missing.push("model");
      if (!merged.system) missing.push("system");
      if (missing.length > 0) {
        throw new Error(
          `Could not read the agent's current config (initialize failed). ` +
          `Cannot fall back to defaults — that would silently overwrite the ` +
          `agent's identity. Provide a full config via --file (must include ${missing.join(", ")}) ` +
          `or wait for the agent to come back online and retry.`,
        );
      }
    }

    const modelDisplay = typeof merged.model === "string"
      ? merged.model
      : `${merged.model?.id ?? "?"}${merged.model?.apiBaseUrl ? ` @ ${merged.model.apiBaseUrl}` : ""}`;
    const configJson = JSON.stringify(merged);

    console.log(dim(`\nUpdated config (${configJson.length} bytes):`));
    console.log(dim(`  name:        ${merged.name}`));
    console.log(dim(`  model:       ${modelDisplay}`));
    console.log(dim(`  system:      ${merged.system?.slice(0, 60)}${merged.system?.length > 60 ? "..." : ""}`));
    console.log(dim(`  tools:       ${merged.tools?.length ?? 0} items`));
    console.log(dim(`  mcp_servers: ${merged.mcp_servers?.length ?? 0} items`));
    console.log(dim(`  skills:      ${merged.skills?.length ?? 0} items`));
    console.log();

    // Dispatch by agent type. SCF agents go through `tcb agent update`
    // (~8s, no redeploy). TCBR cloudrun agents need a config-change diff
    // submitted to tcbr (~60-90s, full redeploy of the container) because
    // tcb agent update doesn't support tcbr (and there's no in-place env
    // mutation API on cloudrun).
    const { agentType, serviceId } = await lookupAgent(envId, agentId);

    if (agentType === "tcbr") {
      if (!serviceId) throw new Error(`tcbr agent ${agentId} has no ServiceId`);
      // Stamp a deployment timestamp into the config's metadata so that
      // waitForConfigLive has a unique marker even when the system prompt
      // hasn't changed between updates. Without this marker the poll exits
      // immediately (old pod has same system), falsely reporting "done" before
      // the new pod with updated EnvParam has even started.
      const configWithTs = { ...merged, metadata: { ...(merged.metadata ?? {}), __deployedAt: String(Date.now()) } };
      const configBase64 = Buffer.from(JSON.stringify(configWithTs)).toString("base64");
      const expectedDeployedAt = configWithTs.metadata.__deployedAt;
      const { envMap, credsSource } = buildCloudRunEnvParam({ envId, configB64: configBase64 });
      if (!credsSource) {
        console.log(yellow("⚠️  no TCB_SECRET_* found in shell or tcb login — agent may fail with MISSING_CREDENTIALS"));
      } else if (credsSource === "sts") {
        console.log(dim("(using short-lived tcb-login STS creds — they will expire in ~2h)"));
      }
      process.stdout.write(dim("Applying via SubmitServerConfigChangeDiff (tcbr)... "));
      let taskId;
      try {
        const submitResp = await callTcbCloudApi({
          action: "SubmitServerConfigChangeDiff",
          payload: {
            EnvId: envId,
            ServerName: serviceId,
            Items: [{ Key: "EnvParam", Value: JSON.stringify(envMap) }],
          },
          service: "tcbr",
          version: "2022-02-17",
        });
        taskId = submitResp.TaskId;
        console.log(green(`submitted (TaskId=${taskId})`));
      } catch (err) {
        throw new Error(`SubmitServerConfigChangeDiff failed: ${err.message}`);
      }

      process.stdout.write(dim("Waiting for new version to deploy... "));
      const finalStatus = await waitForCloudRunDeploy(envId, serviceId);
      if (finalStatus === "normal") {
        console.log(green("ready"));
      } else {
        console.log(yellow(`status=${finalStatus || "timeout"}, agent may still be coming up`));
      }

      // Wait until the new config is actually in effect on the live agent.
      // We stamp a __deployedAt timestamp into metadata so this comparison is
      // always unique — even when the system prompt is identical between updates.
      process.stdout.write(dim("Waiting for traffic switchover... "));
      const matched = await waitForConfigLive({
        agentUrl, expectedDeployedAt, maxWaitMs: 5 * 60 * 1000,
      });
      if (matched) {
        console.log(green("done"));
      } else {
        console.log(yellow("timeout — new config may still be rolling out"));
      }
      console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
      return;
    }

    // SCF (or unknown — fall through to legacy path). For SCF the config
    // is passed via env var directly; tcb agent update handles the deploy.
    const configBase64 = Buffer.from(configJson).toString("base64");
    const scfUpdateEnv = {
      CLOUDBASE_ENV_ID: envId,
      AGENT_CONFIG_B64: configBase64,
    };
    if (process.env.TCB_API_KEY) {
      scfUpdateEnv.TCB_API_KEY = process.env.TCB_API_KEY;
    } else {
      scfUpdateEnv.OAK_DISABLE_SANDBOX = "1";
    }
    if (process.env.OAK_USE_MEMORY_STORE) scfUpdateEnv.OAK_USE_MEMORY_STORE = process.env.OAK_USE_MEMORY_STORE;
    const envStr = Object.entries(scfUpdateEnv).map(([k, v]) => `${k}=${v}`).join(",");
    process.stdout.write("Applying via tcb agent update... ");
    try {
      const raw = runTcb(
        ["agent", "update", agentId, "--env", envStr, "-e", envId, "--json"],
        { timeout: 120000 },
      );
      const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      console.log(green("OK"));
      if (data.data?.elapsedTime) {
        console.log(dim(`  Elapsed: ${Math.round(data.data.elapsedTime / 1000)}s`));
      }
      console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
    } catch (err) {
      throw new Error(`tcb agent update failed: ${err.message}`);
    }
  },

  // ─── Cloud Run (container-mode agent) ─────────────────────────────────────
  // Internal commands — not advertised in `magent --help`. They power the
  // container deploy path and provide a fast local-build feedback loop.
  // Kept callable for ops/debugging but intentionally undocumented.
  //
  // Three-phase deploy, all driven via Tencent Cloud OpenAPIs (no `tcb cloudrun
  // deploy`). The runtime ships its own Dockerfile + .dockerignore under
  // packages/agent-runtime/, so the CLI just stages files — it never
  // generates Dockerfiles.
  //
  //   1. DescribeCloudBaseBuildService → upload the staged dir as a zip
  //      package to CloudBase build storage.
  //   2. CreateCloudRunServer (Items form) → atomically create the container
  //      service with Port=80, Dockerfile, EnvParam, scaling rules, etc.,
  //      then wait until DescribeCloudRunDeployRecord reports the first
  //      version `normal`.
  //   3. CreateAgent (Template=alreadyExitResource + ServiceId=<service>)
  //      → register the service as a TCBR agent. The API returns an
  //      `agent-<slug>-<rand>` ID, addressable via the same gateway path
  //      magent run uses for SCF agents.

  "cloudrun:create": async (args) => {
    const { name, model, system } = args;
    if (!name) throw new Error("-n / --name is required");
    const envId = requireEnvId(args);
    const code  = args.code ?? "./packages/agent-runtime";

    // ── Compose agent config (same flow as agent:create) ─────────────────
    const config = {
      name,
      model:  model  ?? "hunyuan-t1-latest",
      system: system ?? "You are a helpful assistant.",
    };
    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        const fileConfig = content.trim().startsWith("{")
          ? JSON.parse(content)
          : (await import("yaml")).parse(content);
        Object.assign(config, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file: ${err.message}`);
      }
    }
    if (name)   config.name   = name;
    if (model)  config.model  = model;
    if (system) config.system = system;

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    // ── Names ────────────────────────────────────────────────────────────
    // CloudRun service name: free-form. We use `<slug>-<rand>` for uniqueness.
    // Tencent Cloud will assign the agent ID itself; we suggest a base via
    // `AgentId: agent-<slug>` (the API appends a unique suffix).
    const slug = toAlias(name);
    const rand = Math.random().toString(36).slice(2, 8);
    const serviceName = args.service ?? `${slug}-${rand}`;
    const suggestedAgentId = `agent-${slug}`;

    console.log(bold("Creating cloud-run agent..."));
    console.log(dim(`  name:        ${config.name}`));
    console.log(dim(`  model:       ${typeof config.model === "string" ? config.model : `${config.model?.id ?? "?"}${config.model?.apiBaseUrl ? ` @ ${config.model.apiBaseUrl}` : ""}`}`));
    console.log(dim(`  service:     ${serviceName}`));
    console.log(dim(`  envId:       ${envId}`));
    console.log(dim(`  code:        ${code}`));
    console.log();

    // ── Stage deploy directory ───────────────────────────────────────────
    // Just copy what the project ships. The Dockerfile and .dockerignore
    // belong to the runtime project (committed alongside src/), so the CLI
    // never has to know how to build the container — only how to ship code.
    const deployDir = resolve(code, ".deploy-cloudrun");
    try {
      execSync(`rm -rf "${deployDir}" && mkdir -p "${deployDir}"`, { encoding: "utf-8" });

      const required = ["Dockerfile", "dist", "package.json"];
      const optional = ["package-lock.json", ".dockerignore", "vendor", "agent.yaml", "skills"];
      for (const f of required) {
        const src = resolve(code, f);
        if (!existsSync(src)) {
          throw new Error(`Required file/dir missing in ${code}: ${f}`);
        }
        execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
      }
      for (const f of optional) {
        const src = resolve(code, f);
        if (existsSync(src)) execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
      }

      // cloudbaserc.json — minimal, only what `tcb cloudrun deploy` actually
      // reads (envId + service name). EnvParams are pushed via a separate
      // UpdateCloudRunServerConfig API call after deploy, because the cli
      // doesn't honor cloudrun.envParams in cloudbaserc on the deploy path.
      writeFileSync(
        resolve(deployDir, "cloudbaserc.json"),
        JSON.stringify({
          version: "2.0",
          envId,
          $schema: "https://framework-1258016615.tcloudbaseapp.com/schema/latest.json",
          cloudrun: { name: serviceName },
        }, null, 2),
      );
    } catch (err) {
      throw new Error(`Deploy prep failed: ${err.message}`);
    }

    // ── Phase 1: upload code package ─────────────────────────────────────
    // We don't go through `tcb cloudrun deploy` because the cli prompts
    // interactively on update flows and silently hangs on a piped stdin.
    // Driving the same OpenAPIs ourselves keeps this fully non-interactive.
    process.stdout.write(dim("Phase 1/3: uploading code package... "));
    let packageName, packageVersion;
    try {
      const { UploadUrl, UploadHeaders, PackageName, PackageVersion } =
        await describeBuildService(envId, serviceName);
      const zip = await zipDir(deployDir);
      await uploadZipBuffer({ uploadUrl: UploadUrl, headers: UploadHeaders, buffer: zip });
      packageName = PackageName;
      packageVersion = PackageVersion;
      console.log(green(`OK (${(zip.length / 1024).toFixed(1)} KiB)`));
    } catch (err) {
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
      throw new Error(`upload failed: ${err.message}`);
    }
    try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}

    // ── Phase 2: create the cloudrun service ─────────────────────────────
    // CreateCloudRunServer takes Items (typed key/value list) which lets us
    // set EnvParam, Port, Dockerfile, access types, scaling, etc. all in one
    // call. The runtime listens on :80 (CloudBase's default container port).
    process.stdout.write(dim("Phase 2/3: creating cloudrun service... "));
    try {
      const { envMap, credsSource } = buildCloudRunEnvParam({ envId, configB64 });
      if (!credsSource) {
        console.log();
        console.log(yellow("⚠️  no TCB_SECRET_* found in shell or tcb login — agent may fail with MISSING_CREDENTIALS"));
        process.stdout.write(dim("            "));
      } else if (credsSource === "sts") {
        console.log();
        process.stdout.write(dim("            (warning: forwarded short-lived STS creds; will expire in ~2h)\n            "));
      }

      await callTcbCloudApi({
        action: "CreateCloudRunServer",
        payload: {
          EnvId: envId,
          ServerName: serviceName,
          DeployInfo: {
            DeployType:    "package",
            PackageName:   packageName,
            PackageVersion: packageVersion,
          },
          Items: [
            { Key: "Port",           IntValue:   8080 },
            { Key: "Dockerfile",     Value:      "Dockerfile" },
            { Key: "HasDockerfile",  BoolValue:  true },
            { Key: "EnvParam",       Value:      JSON.stringify(envMap) },
            { Key: "AccessTypes",    ArrayValue: ["OA", "PUBLIC", "MINIAPP"] },
            { Key: "InternalAccess", Value:      "close" },
            { Key: "CpuSpecs",       FloatValue: 1 },
            { Key: "MemSpecs",       FloatValue: 2 },
            { Key: "LogPath",        Value:      "stdout" },
            { Key: "OperationMode",  Value:      "alwaysScale" },
            { Key: "MinNum",         IntValue:   0 },
            { Key: "MaxNum",         IntValue:   5 },
            { Key: "PolicyDetails",  PolicyDetails: [] },
            { Key: "Cmd",            ArrayValue: [] },
            { Key: "EntryPoint",     ArrayValue: [] },
          ],
          VpcInfo: {},
        },
        service: "tcbr",
        version: "2022-02-17",
      });
      console.log(green("OK"));
    } catch (err) {
      throw new Error(`CreateCloudRunServer failed: ${err.message}`);
    }

    // Wait for the service to come up before registering the agent — agent
    // creation against a still-creating service tends to land in a bad state.
    process.stdout.write(dim("            waiting for build to finish... "));
    const lastStatus = await waitForCloudRunDeploy(envId, serviceName);
    if (!lastStatus || lastStatus === "creating" || lastStatus === "deploying") {
      throw new Error(`build still ${lastStatus || "starting"} after timeout`);
    }
    if (lastStatus !== "normal") {
      console.log(yellow(`build status=${lastStatus}, continuing anyway...`));
    } else {
      console.log(green("ready"));
    }

    // ── Phase 3: register the service as a TCBR agent ────────────────────
    process.stdout.write(dim("Phase 3/3: registering agent (CreateAgent API)... "));
    let createdAgentId;
    try {
      const resp = await callTcbCloudApi({
        action: "CreateAgent",
        payload: {
          EnvId:    envId,
          Name:     config.name,
          AgentId:  suggestedAgentId,
          Avatar:   "https://cloudcache.tencent-cloud.com/qcloud/ui/static/static_source_business/21235b0d-8db2-4e30-b946-3973e6f99c00.png",
          ServiceId: serviceName,
          EnvParams: "",
          AgentType: "tcbr",
          Template:  "alreadyExitResource",
          Source:    "",
        },
      });
      createdAgentId = resp.AgentId;
      console.log(green("OK"));
    } catch (err) {
      throw new Error(`CreateAgent API failed: ${err.message}`);
    }

    console.log();
    console.log(green(`✅ Agent created: ${createdAgentId}`));
    console.log(dim(`  service:    ${serviceName}`));
    console.log(dim(`  envId:      ${envId}`));
    console.log();
    console.log("Next steps (container build typically takes 2-5 minutes):");
    console.log(dim(`  1. Wait for ready: tcb agent detail ${createdAgentId} -e ${envId}`));
    console.log(dim(`  2. Start chatting: magent run -a ${createdAgentId} -e ${envId} -m "Hello"`));
  },

  "cloudrun:list": async (args) => {
    const envId = requireEnvId(args);
    spawnSync(
      getNodeExecutable(),
      [getTcbScript(), "cloudrun", "list", "-e", envId, "--serverType", "container"],
      { stdio: "inherit" },
    );
  },

  "cloudrun:delete": async (args) => {
    if (!args.name) throw new Error("-n / --name is required (the cloudrun service name)");
    const envId = requireEnvId(args);
    // Note: this only deletes the cloudrun service. Use `tcb agent delete <agentId>`
    // separately to remove the registered agent (or it will linger as a broken entry).
    spawnSync(
      getNodeExecutable(),
      [getTcbScript(), "cloudrun", "delete", "-s", args.name, "-e", envId, "--force"],
      { stdio: "inherit" },
    );
  },

  // ─── Environment ──────────────────────────────────────────────────────────
  // env:list proxies to `tcb env:list` (CloudBase environments, not SDK concept)

  "env:list": async (args, rest) => {
    spawnSync(getNodeExecutable(), [getTcbScript(), "env:list", ...rest], { stdio: "inherit" });
  },

  "env:create": async (args) => {
    if (!args.name) throw new Error("--name is required");
    const env = await post("/environments", {
      name:   args.name,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    console.log(green("✅ Environment created:"));
    printEnv(env);
  },

  "env:delete": async (args) => {
    if (!args.id) throw new Error("-i / --id is required");
    await del(`/environments/${args.id}`);
    console.log(green(`✅ Environment ${args.id} deleted.`));
  },

  // ─── Session ──────────────────────────────────────────────────────────────

  "session:create": async (args) => {
    if (!args.agent) throw new Error("-a / --agent is required");
    const session = await post("/sessions", {
      agent:          args.agent,
      environment_id: args.env ?? undefined,
      title:          args.title ?? "",
    });
    console.log(green("✅ Session created:"));
    printSession(session);
  },

  "session:list": async () => {
    const { data } = await get("/sessions");
    if (!data.length) return console.log(dim("No sessions found."));
    console.log(bold(`Sessions (${data.length}):`));
    data.forEach(printSession);
  },

  "session:get": async (args) => {
    if (!args.id) throw new Error("-i / --id is required");
    const session = await get(`/sessions/${args.id}`);
    printSession(session);
  },

  "session:delete": async (args) => {
    if (!args.id) throw new Error("-i / --id is required");
    await del(`/sessions/${args.id}`);
    console.log(green(`✅ Session ${args.id} deleted.`));
  },

  // ─── Chat (send message to existing session, stream response) ─────────────

  "chat": async (args) => {
    if (!args.session) throw new Error("-s / --session is required");
    if (!args.message) throw new Error("-m / --message is required");

    const streamGen = streamEvents(args.session);
    await post(`/sessions/${args.session}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: args.message }] }],
    });

    console.log(dim(`\n[Session ${args.session}]`));
    console.log(dim(`You: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const event of streamGen) {
      renderEvent(event);
    }
  },

  // ─── Run (one-shot: ACP session/new → session/prompt, no persistence) ─────

  "run": async (args) => {
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    if (!args.message) throw new Error("-m / --message is required");

    const acpUrl = getAcpUrl(args);

    process.stdout.write(dim("Connecting to agent... "));
    const initResult = await acpCall(acpUrl, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "magent-cli", version: "0.1.0" },
    });
    console.log(green(initResult.agentInfo?.name ?? "OK"));

    process.stdout.write(dim("Creating session... "));
    const { sessionId } = await acpCall(acpUrl, "session/new", { cwd: "/", mcpServers: [] });
    console.log(dim(sessionId));

    console.log(dim(`\nYou: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const item of acpStream(acpUrl, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: args.message }],
    })) {
      if (item.type === "reverse_request") {
        await handleReverseRequest(acpUrl, item.data, !!(args["auto-approve"] || args.y));
      } else if (item.type === "notification") {
        const update = item.data.params?.update;
        switch (update?.sessionUpdate) {
          case "agent_message_chunk":
            process.stdout.write(update.content?.text ?? "");
            break;
          case "tool_call":
            console.log(yellow(`\n🔧 Tool: ${update.title ?? update.toolCall?.name ?? "?"} [${update.status ?? update.toolCall?.status}]`));
            break;
          case "tool_call_update":
            if (update.result) console.log(dim(`   ${String(update.result).slice(0, 200)}`));
            else if (update.status) console.log(dim(`   [${update.status}]`));
            break;
          case "log":
            console.log(red(`\n❌ ${update.message ?? "unknown error"}`));
            break;
        }
      } else if (item.type === "result") {
        console.log(green(`\n\n✅ Done (${item.data.stopReason ?? "end_turn"})`));
      }
    }
  },

  // ─── Interactive REPL (ACP session, multi-turn) ───────────────────────────

  "repl": async (args) => {
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");

    const acpUrl = getAcpUrl(args);

    console.log(bold("\n🤖 OpenManagedAgent REPL"));
    console.log(dim("Type your message, press Enter. Ctrl+C to exit.\n"));

    process.stdout.write(dim("Connecting... "));
    const initResult = await acpCall(acpUrl, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "magent-cli", version: "0.1.0" },
    });
    console.log(green(initResult.agentInfo?.name ?? "OK"));

    process.stdout.write(dim("Creating session... "));
    const { sessionId } = await acpCall(acpUrl, "session/new", { cwd: "/", mcpServers: [] });
    console.log(green(sessionId));
    console.log();

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = () => {
      rl.question(cyan("You: "), async (message) => {
        if (!message.trim()) return ask();
        try {
          process.stdout.write(bold("\nAgent: "));
          for await (const item of acpStream(acpUrl, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: message }],
          })) {
            if (item.type === "reverse_request") {
              await handleReverseRequest(acpUrl, item.data, !!(args["auto-approve"] || args.y));
            } else if (item.type === "notification") {
              const update = item.data.params?.update;
              switch (update?.sessionUpdate) {
                case "agent_message_chunk":
                  process.stdout.write(update.content?.text ?? "");
                  break;
                case "tool_call":
                  console.log(yellow(`\n🔧 Tool: ${update.title ?? update.toolCall?.name ?? "?"} [${update.status ?? update.toolCall?.status}]`));
                  break;
                case "tool_call_update":
                  if (update.result) console.log(dim(`   ${String(update.result).slice(0, 200)}`));
                  else if (update.status) console.log(dim(`   [${update.status}]`));
                  break;
                case "log":
                  console.log(red(`\n❌ ${update.message ?? "unknown error"}`));
                  break;
              }
            } else if (item.type === "result") {
              console.log(green(`\n  (${item.data.stopReason ?? "end_turn"})`));
            }
          }
          console.log();
        } catch (err) {
          console.error(red(`\nError: ${err.message}`));
        }
        ask();
      });
    };

    rl.on("close", () => {
      console.log(dim("\nBye!"));
      process.exit(0);
    });

    ask();
  },
};

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${bold("magent")} — OpenManagedAgent CLI

${bold("USAGE")}
  magent <command> [options]

${bold("ENVIRONMENT")}
  CLOUDBASE_ENV_ID       CloudBase environment ID (required for most commands)
  CLOUDBASE_AGENT_ID     Default agent ID (used when -i is omitted)
  CLOUDBASE_ACCESS_KEY   API key for agent access

${bold("AUTHENTICATION")}
  login [options]              Login to CloudBase
                               Proxied to: tcb login [options]

${bold("AGENT COMMANDS")}
  agent:create  -n <name> [options]           Create and deploy a new agent
    -n, --name <name>           Agent name (required)
        --type <scf|tcbr>       Compute backend (default: scf)
                                  scf  = SCF cloud function (~60-90s deploy)
                                  tcbr = CloudRun container (~3-5min deploy,
                                         needs Docker image, supports custom
                                         system libs)
        --model <model>         Model (default: hunyuan-t1-latest)
        --system <prompt>       System prompt
    -f, --file <path>           Load config from YAML/JSON file
        --code <path>           Code directory (default: ./packages/agent-runtime)
        --runtime <rt>          [scf only] Runtime (default: Nodejs20.19)
        --service <name>        [tcbr only] Override cloudrun service name
    -e, --env <envId>           CloudBase environment ID

  agent:update  [-i <id>] [options]           Update agent config
                                              (scf: ~8s no redeploy;
                                               tcbr: ~60-90s rolling redeploy)
        --system <prompt>       Update system prompt
        --model <model>         Update model
    -n, --name <name>           Update agent name
        --tools <json>          Replace tools array (JSON)
        --mcp-servers <json>    Replace mcp_servers array (JSON)
        --skills <json>         Replace skills array (JSON)
    -f, --file <path>           Load full config from YAML/JSON file
    -e, --env <envId>           CloudBase environment ID

  agent:list    [-e <envId>]                  List all agents
  agent:get     [-i <id>]                     Get agent details
  agent:export  [-i <id>] [-o <file>]         Export live agent config to YAML
                                              (round-trip safe; use with agent:update -f)
    -o, --output <path>     Output file path (omit to print to stdout)
    -e, --env <envId>       CloudBase environment ID
  agent:delete  [-i <id>]                     Delete an agent (also cleans up
                                              the underlying SCF function or
                                              CloudRun service)

${bold("CLOUDBASE ENVIRONMENT COMMANDS")}
  env:list [options]           List CloudBase environments
                               Proxied to: tcb env:list [options]

${bold("SESSION COMMANDS")}
  session:create  -a <agent-id> [--title <title>] [-e <env-id>]
  session:list
  session:get     -i <session-id>
  session:delete  -i <session-id>

${bold("MESSAGING COMMANDS")}
  run    -a <id> -m <text>                    One-shot (auto-creates and cleans up session)
           [--keep-session]                   Keep session after run
  chat   -s <id> -m <text>                    Send message to an existing session
  repl   -a <id>                              Interactive REPL

${bold("SHORT FLAGS")}
  -e <envId>     Same as --env       (CloudBase environment ID)
  -a <agentId>   Same as --agent
  -i <id>        Same as --id
  -m <text>      Same as --message
  -s <sessionId> Same as --session
  -f <path>      Same as --file
  -n <name>      Same as --name

${bold("TCB PASSTHROUGH")}
  Any command not listed above is forwarded transparently to the tcb CLI.
  Example:
    magent functions:list -e myenv   →  tcb functions:list -e myenv
    magent storage:list              →  tcb storage:list

${bold("EXAMPLES")}
  # First-time setup
  magent login
  magent env:list

  # Create and deploy an agent
  magent agent:create -n "Coder" --system "You are a coding assistant" -e my-env-id

  # List agents (error shows available envs if -e is missing)
  magent agent:list -e my-env-id

  # Update config without redeploying
  magent agent:update --system "You are a strict code reviewer" -e my-env-id
  magent agent:update -f ./agent.yaml -e my-env-id
  magent agent:update --model deepseek-v3.2 -e my-env-id

  # Export live config to file (then edit and push back)
  magent agent:export -i agent_xxx -e my-env-id -o ./agent.yaml
  magent agent:update -f ./agent.yaml -e my-env-id

  # One-shot task
  magent run -a agent_xxx -m "Write a bubble sort in Python"

  # Multi-turn conversation
  magent session:create -a agent_xxx --title "My project"
  magent chat -s sess_xxx -m "Hello"
  magent chat -s sess_xxx -m "Now add error handling"

  # Interactive REPL
  magent repl -a agent_xxx
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...rest] = process.argv;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  // Parse flags — supports both --key value and -k value
  const args = parseFlags(rest);

  // Early env propagation: -e / --env → CLOUDBASE_ENV_ID so all downstream
  // code (including tcb commands) picks up the override automatically.
  if (args.env) {
    process.env.CLOUDBASE_ENV_ID = args.env;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    // Transparently proxy all unrecognized commands to the tcb CLI
    const result = spawnSync(getNodeExecutable(), [getTcbScript(), cmd, ...rest], { stdio: "inherit" });
    process.exit(result.status ?? 0);
    return;
  }

  try {
    await handler(args, rest);
  } catch (err) {
    console.error(red(`\nError: ${err.message}`));
    process.exit(1);
  }
}

main();
