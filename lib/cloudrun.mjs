// ── Cloud Run helpers ─────────────────────────────────────────────────────────
// We bypass `tcb cloudrun deploy` entirely on the create path because the cli
// becomes interactive on update (asks for traffic strategy) and silently hangs
// when piped a non-TTY stdin. Instead we drive the same three OpenAPI calls
// the cli would make ourselves: build-service upload URL → PUT zip →
// CreateCloudRunServer. This stays fully non-interactive end-to-end.

import { createRequire } from "module";
import {
  applyHarnessRuntimeEnv,
} from "./harness-deploy.mjs";
import { pinnedHarnessToolId } from "./harness-env-file.mjs";
import { callTcbCloudApi } from "./api.mjs";
import { hydrateCloudEnvFromCli } from "./env.mjs";
import { acpCall } from "./acp.mjs";
import { dim } from "./ui.mjs";

const _require = createRequire(import.meta.url);

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

/**
 * Poll DescribeCloudRunServerDetail until the online version exposes an
 * ImageUrl (the linux/amd64 image the cloud CD just built). Returns the URI
 * string, or "" if it never appears within maxWaitMs.
 */
export async function getCloudRunImageUrl(envId, serviceName, { maxWaitMs = 2 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const detail = await callTcbCloudApi({
        action: "DescribeCloudRunServerDetail",
        payload: { EnvId: envId, ServerName: serviceName },
        service: "tcbr",
        version: "2022-02-17",
      });
      const uri = detail.OnlineVersionInfos?.[0]?.ImageUrl;
      if (uri) return uri;
    } catch {
      // transient — retry
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return "";
}

/**
 * Build a linux/amd64 image in the cloud via TCBR CloudRun CD, bypassing local
 * `docker build` entirely (arm64 Macs can't cross-build x86 without slow QEMU).
 *
 * Mirrors the upload+build front half of handleCloudrunCreate, but uses a
 * dedicated throwaway-but-reused service (MinNum=0 so it never keeps pods warm)
 * purely to produce an image, then reads back OnlineVersionInfos[0].ImageUrl.
 *
 * @returns {Promise<{ imageUri: string }>}
 */
export async function buildImageViaCloudRun({ envId, code, serviceName }) {
  const fs = _require("fs");
  const path = _require("path");
  const { execSync } = _require("child_process");

  // ── Stage deploy dir (same contract as handleCloudrunCreate) ────────────
  const deployDir = path.resolve(code, ".deploy-imgbuild");
  execSync(`rm -rf "${deployDir}" && mkdir -p "${deployDir}"`, { encoding: "utf-8" });

  const required = ["Dockerfile", "dist", "package.json"];
  const optional = ["package-lock.json", ".dockerignore", "vendor", "agent.yaml", "skills"];
  for (const f of required) {
    const src = path.resolve(code, f);
    if (!fs.existsSync(src)) {
      execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" });
      throw new Error(`Required file/dir missing in ${code}: ${f}`);
    }
    execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
  }
  for (const f of optional) {
    const src = path.resolve(code, f);
    if (fs.existsSync(src)) execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
  }
  fs.writeFileSync(
    path.resolve(deployDir, "cloudbaserc.json"),
    JSON.stringify({
      version: "2.0",
      envId,
      $schema: "https://framework-1258016615.tcloudbaseapp.com/schema/latest.json",
      cloudrun: { name: serviceName },
    }, null, 2),
  );

  // ── Upload code package ─────────────────────────────────────────────────
  process.stdout.write(dim("  uploading code package... "));
  let packageName, packageVersion;
  try {
    const { UploadUrl, UploadHeaders, PackageName, PackageVersion } =
      await describeBuildService(envId, serviceName);
    const zip = await zipDir(deployDir);
    await uploadZipBuffer({ uploadUrl: UploadUrl, headers: UploadHeaders, buffer: zip });
    packageName = PackageName;
    packageVersion = PackageVersion;
    console.log(`OK (${(zip.length / 1024).toFixed(1)} KiB)`);
  } finally {
    try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch { /* noop */ }
  }

  // ── Trigger cloud build (CreateCloudRunServer is upsert for an existing svc) ─
  // MinNum=0/MaxNum=1: this service exists only to produce an image, never to
  // serve traffic, so we don't want it keeping pods warm.
  process.stdout.write(dim("  building image in cloud (CD)... "));
  await callTcbCloudApi({
    action: "CreateCloudRunServer",
    payload: {
      EnvId: envId,
      ServerName: serviceName,
      DeployInfo: {
        DeployType: "package",
        PackageName: packageName,
        PackageVersion: packageVersion,
      },
      Items: [
        { Key: "Port",           IntValue:   8080 },
        { Key: "Dockerfile",     Value:      "Dockerfile" },
        { Key: "HasDockerfile",  BoolValue:  true },
        { Key: "AccessTypes",    ArrayValue: ["OA"] },
        { Key: "InternalAccess", Value:      "close" },
        { Key: "CpuSpecs",       FloatValue: 1 },
        { Key: "MemSpecs",       FloatValue: 2 },
        { Key: "LogPath",        Value:      "stdout" },
        { Key: "OperationMode",  Value:      "alwaysScale" },
        { Key: "MinNum",         IntValue:   0 },
        { Key: "MaxNum",         IntValue:   1 },
        { Key: "PolicyDetails",  PolicyDetails: [] },
        { Key: "Cmd",            ArrayValue: [] },
        { Key: "EntryPoint",     ArrayValue: [] },
      ],
      VpcInfo: {},
    },
    service: "tcbr",
    version: "2022-02-17",
  });

  const lastStatus = await waitForCloudRunDeploy(envId, serviceName);
  if (!lastStatus || lastStatus === "creating" || lastStatus === "deploying") {
    throw new Error(`cloud build still ${lastStatus || "starting"} after timeout`);
  }
  if (lastStatus !== "normal") {
    console.log(`build status=${lastStatus}, attempting to read image anyway...`);
  } else {
    console.log("ready");
  }

  // ── Read back the built image URI ───────────────────────────────────────
  process.stdout.write(dim("  fetching built image URI... "));
  const imageUri = await getCloudRunImageUrl(envId, serviceName);
  if (!imageUri) {
    throw new Error(
      `Could not read OnlineVersionInfos[0].ImageUrl for service ${serviceName}. ` +
      `Check build status in the CloudBase console.`,
    );
  }
  console.log("OK");
  return { imageUri };
}

// Build the EnvParam map that ships into a cloudrun (tcbr) container. Used by
// both cloudrun:create (initial deploy) and agent:update on tcbr agents
// (re-pushed via SubmitServerConfigChangeDiff). Pulls the agent config from
// the caller, then layers on CloudBase creds from the operator's shell env.
//
// Credential resolution order:
//   1. CLOUDBASE_APIKEY already in env → use directly
//   2. TCB_SECRET_ID + TCB_SECRET_KEY in env → use them (permanent CAM creds)
//   3. Neither → interactively resolve/create a permanent API key
//
// Contract: every env update has to re-supply these via the operator's shell
// because TCBR replaces (not merges) EnvParam on each config-change.
//
// Model credentials (apiKey/apiBaseUrl) belong in agent.yaml's `model`
// ModelSpec — they ride inside AGENT_CONFIG_B64 and don't need separate env.
export async function buildCloudRunEnvParam({ envId, configB64, config = null }) {
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
  // Credential resolution for the container env:
  //   1. If CLOUDBASE_APIKEY is set in the local env → use it directly
  //   2. If TCB_SECRET_ID + TCB_SECRET_KEY are set in the local env → use them
  //      (user-configured permanent CAM creds, NOT short-lived tcb-login STS)
  //   3. Neither configured → interactively resolve/create a permanent API key
  const hasApiKey = !!process.env.CLOUDBASE_APIKEY?.trim();
  const hasSecretPair =
    !!process.env.TCB_SECRET_ID?.trim() && !!process.env.TCB_SECRET_KEY?.trim();

  if (hasApiKey) {
    // @cloudbase/node-sdk reads CLOUDBASE_APIKEY for FlexDB access (Bearer auth).
    envMap.CLOUDBASE_APIKEY = process.env.CLOUDBASE_APIKEY.trim();
  }
  if (hasSecretPair) {
    envMap.TCB_SECRET_ID = process.env.TCB_SECRET_ID.trim();
    envMap.TCB_SECRET_KEY = process.env.TCB_SECRET_KEY.trim();
    if (process.env.TCB_TOKEN?.trim()) envMap.TCB_TOKEN = process.env.TCB_TOKEN.trim();
  }

  if (!hasApiKey && !hasSecretPair) {
    const { ensureTcbApiKey } = await import("./ensure-tcb-api-key.mjs");
    await ensureTcbApiKey(envId);
    if (process.env.CLOUDBASE_APIKEY) {
      envMap.CLOUDBASE_APIKEY = process.env.CLOUDBASE_APIKEY;
    }
  }

  // Sandbox is controlled by `sandbox.enabled` in the yaml + CLOUDBASE_APIKEY
  // prerequisite check at runtime (toKernelAgentConfig).

  // Do NOT fall back to tcb-login STS (~2h) — it expires and causes
  // SIGN_PARAM_INVALID.  The TCBR execution role auto-injects
  // TENCENTCLOUD_SECRETID/SECRETKEY at runtime for FlexDB access.

  if (isHarness) {
    const callbackBase = process.env.CLOUDBASE_SERVER_URL ?? "";
    applyHarnessRuntimeEnv(envMap, config, {
      harnessToolId: pinnedHarnessToolId() || undefined,
      clientToolCallbackBase: callbackBase,
    });
  }

  return { envMap, credsSource: "" };
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
