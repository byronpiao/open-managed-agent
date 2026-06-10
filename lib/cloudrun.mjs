// ── Cloud Run helpers ─────────────────────────────────────────────────────────
// We bypass `tcb cloudrun deploy` entirely on the create path because the cli
// becomes interactive on update (asks for traffic strategy) and silently hangs
// when piped a non-TTY stdin. Instead we drive the same three OpenAPI calls
// the cli would make ourselves: build-service upload URL → PUT zip →
// CreateCloudRunServer. This stays fully non-interactive end-to-end.

import { createRequire } from "module";
import {
  applyHarnessRuntimeEnv,
  resolveHarnessSandboxImage,
} from "open-managed-agent-runtime/harness";
import { pinnedHarnessToolId } from "./harness-env-file.mjs";
import { callTcbCloudApi } from "./api.mjs";
import { readTcbLoginCredential } from "./credentials.mjs";
import { hydrateCloudEnvFromCli } from "./env.mjs";
import { acpCall } from "./acp.mjs";
import { dim } from "./ui.mjs";

const _require = createRequire(import.meta.url);

/** Forward TCB_SECRET_* from shell or `tcb login` STS into deploy env maps. */
export function forwardTcbDeployCreds(envMap) {
  if (process.env.TCB_SECRET_ID?.trim() && process.env.TCB_SECRET_KEY?.trim()) {
    envMap.TCB_SECRET_ID = process.env.TCB_SECRET_ID.trim();
    envMap.TCB_SECRET_KEY = process.env.TCB_SECRET_KEY.trim();
    if (process.env.TCB_TOKEN?.trim()) envMap.TCB_TOKEN = process.env.TCB_TOKEN.trim();
    return "shell";
  }
  const sts = readTcbLoginCredential();
  if (sts) {
    envMap.TCB_SECRET_ID = sts.secretId;
    envMap.TCB_SECRET_KEY = sts.secretKey;
    if (sts.token) envMap.TCB_TOKEN = sts.token;
    return "sts";
  }
  return "";
}

/** Zip a directory into a Buffer using the same archiver settings tcb uses. */
export async function zipDir(dir) {
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
export async function describeBuildService(envId, serviceName) {
  return callTcbCloudApi({
    action: "DescribeCloudBaseBuildService",
    payload: { EnvId: envId, ServiceName: serviceName },
    service: "tcb",
    version: "2018-06-08",
  });
}

/** PUT the zip buffer to the build service's pre-signed URL. */
export async function uploadZipBuffer({ uploadUrl, headers, buffer }) {
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
export function buildCloudRunEnvParam({ envId, configB64, config = null }) {
  hydrateCloudEnvFromCli({ envId });
  const isHarness = config?.runtime === "harness";
  if (isHarness && !process.env.TCB_REGION?.trim()) {
    console.warn(
      dim(
        "Warning: TCB_REGION unset — FlexDB persistence may be disabled in cloud. " +
          "Set TCB_REGION or ensure `tcb env detail` works (see docs/harness-env.md#advanced-settings).",
      ),
    );
  }
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
  if (!hasTcbApiKey && !isHarness) envMap.OAK_DISABLE_SANDBOX = "1";

  // Pull DB credentials BEFORE deciding the memory-store flag. Order matters:
  // earlier we computed hasDbCreds from process.env alone, then injected
  // OAK_USE_MEMORY_STORE=1, then forwarded STS creds from `tcb login` to the
  // container. The flag stuck around forever even though valid creds were
  // present, forcing the runtime onto InMemoryDriver — registerSession would
  // succeed silently, listSessions would return empty (the driver writes to
  // sessionMeta but reads from sessions; two separate Maps inside the kernel).
  // Now we resolve creds first and treat STS as valid creds for this purpose.
  const credsSource = forwardTcbDeployCreds(envMap);

  // OAK_USE_MEMORY_STORE: fall back to in-process session storage when there
  // are no CloudBase DB credentials; avoids a MISSING_CREDENTIALS crash on
  // session create. Now considers BOTH shell-provided AND STS-derived creds —
  // anything that lands in envMap counts as "DB reachable from container".
  const hasDbCreds = !!(envMap.TCB_SECRET_ID && envMap.TCB_SECRET_KEY);
  // Explicit shell overrides still take precedence.
  if (process.env.OAK_DISABLE_SANDBOX !== undefined) envMap.OAK_DISABLE_SANDBOX = process.env.OAK_DISABLE_SANDBOX;
  if (process.env.OAK_USE_MEMORY_STORE !== undefined) envMap.OAK_USE_MEMORY_STORE = process.env.OAK_USE_MEMORY_STORE;
  else if (!hasDbCreds) envMap.OAK_USE_MEMORY_STORE = "1";

  if (isHarness) {
    const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "";
    applyHarnessRuntimeEnv(envMap, config, {
      sandboxImage: resolveHarnessSandboxImage(),
      harnessToolId: pinnedHarnessToolId() || undefined,
      clientToolCallbackBase: callbackBase,
    });
  }

  return { envMap, credsSource };
}

// Wait for a tcbr cloudrun service deploy to leave creating/deploying state.
// Returns the final status string (typically "normal" on success).
export async function waitForCloudRunDeploy(envId, serviceName, { maxWaitMs = 10 * 60 * 1000 } = {}) {
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
export async function waitForConfigLive({ agentUrl, expectedDeployedAt, maxWaitMs = 5 * 60 * 1000 }) {
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

// ── Agent-type dispatch helpers ───────────────────────────────────────────
// Look up the AgentType (scf | tcbr | baas) and underlying ServiceId for an
// agent. tcb agent detail doesn't expose ServiceId, so we hit DescribeAgentList
// directly. Returns { agentType, serviceId } or {} when not found.
export async function lookupAgent(envId, agentId) {
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
