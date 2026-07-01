/**
 * AGS (Agent Sandbox) API layer — tool CRUD, instance lifecycle, handle construction.
 * Pure functions, no class state. Extracted from orchestrator.ts for clarity.
 */

import {
  resolveHarnessToolName,
  type HarnessEnvVar,
  type HarnessEngine,
  engineToDataPlaneSlug,
  type DataPlaneEngineSlug,
} from "../../config.js";
import {
  resolveCamControlPlaneCredentials,
  resolveHarnessSandboxImage,
  resolveHarnessToolRoleArn,
} from "../harness-env.js";
import { harnessTrace, harnessOutboundCorrelationHeaders } from "../observability/logging.js";
import { injectOutboundTraceHeaders } from "../telemetry/telemetry.js";
import {
  buildCosStorageMounts,
  type HarnessCosConfig,
} from "./cos-mount.js";
import {
  buildAgsSandboxResources,
  resolveSandboxAgsAuthMode,
  resolveSandboxImageRegistryType,
  type ResolvedSandboxConfig,
} from "./sandbox-config.js";

const TRW_SERVICE_PORT = 9000;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 3000;
const TOOL_WARMUP_POLL_MS = 10_000;
const TOOL_WARMUP_POLL_MAX = 6;
const HEALTH_TIMEOUT_MS = 5000;

// ─── Errors ─────────────────────────────────────────────────

export class SandboxOrchestratorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SandboxOrchestratorError";
    if (cause) (this as Error & { cause?: unknown }).cause = cause;
  }
}

// ─── Types ──────────────────────────────────────────────────

export interface ResolvedCredentials {
  apiKey: string;
  secretId: string;
  secretKey: string;
  sessionToken?: string;
  image: string;
  toolRoleArn: string;
  defaultTimeout: string;
  gatewayBaseUrl?: string;
  harnessToolId?: string;
}

export interface HarnessSandboxHandle {
  instanceId: string;
  toolId: string;
  baseUrl: string;
  headers: Record<string, string>;
  instanceAccessToken?: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  refreshInstanceAccessToken(): Promise<string | undefined>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resumeIfPaused(): Promise<void>;
}

export interface SandboxInstanceRow {
  instanceId: string;
  status: string;
  toolId?: string;
}

// ─── Credential / URL resolution ────────────────────────────

export function resolveCredentials(opts: {
  apiKey?: string;
  secretId?: string;
  secretKey?: string;
  sessionToken?: string;
  image?: string;
  toolRoleArn?: string;
  defaultTimeout?: string;
  gatewayBaseUrl?: string;
  harnessToolId?: string;
}): ResolvedCredentials {
  const apiKey = opts.apiKey ?? process.env.CLOUDBASE_APIKEY ?? "";
  const cam = resolveCamControlPlaneCredentials();
  const secretId = opts.secretId ?? cam.secretId;
  const secretKey = opts.secretKey ?? cam.secretKey;
  const sessionToken = opts.sessionToken ?? cam.sessionToken;

  if (!secretId || !secretKey) {
    throw new SandboxOrchestratorError(
      "AgsStatefulSandboxOrchestrator requires TCB_SECRET_ID / TCB_SECRET_KEY for control plane",
    );
  }

  return {
    apiKey,
    secretId,
    secretKey,
    sessionToken,
    image: opts.image ?? resolveHarnessSandboxImage(),
    toolRoleArn: opts.toolRoleArn ?? process.env.HARNESS_TOOL_ROLE_ARN?.trim() ?? "",
    defaultTimeout: opts.defaultTimeout ?? "30m",
    gatewayBaseUrl: opts.gatewayBaseUrl,
    harnessToolId: opts.harnessToolId ?? process.env.HARNESS_TOOL_ID,
  };
}

export function resolveGatewayUrl(envId: string, override?: string): string {
  if (override) return override.replace(/\/$/, "");
  return `https://${envId}.api.tcloudbasegateway.com/v1/sandbox/-`;
}

function resolveImageRegistryType(sandbox: ResolvedSandboxConfig): string {
  return resolveSandboxImageRegistryType(sandbox);
}

// ─── AGS API caller ─────────────────────────────────────────

export async function callAgsApi(
  action: string,
  param: Record<string, unknown>,
  cred: ResolvedCredentials,
  envId: string,
): Promise<Record<string, unknown>> {
  let managerModule: unknown;
  let managerUtilsModule: unknown;
  try {
    managerModule = await import("@cloudbase/manager-node");
    managerUtilsModule = await import(
      // @ts-expect-error manager-node utils subpath has no .d.ts
      "@cloudbase/manager-node/lib/utils/index.js"
    );
  } catch (err) {
    throw new SandboxOrchestratorError("Requires @cloudbase/manager-node", err);
  }

  type CloudBaseCtor = new (config: Record<string, unknown>) => { context: unknown };
  type CloudServiceCtor = new (
    ctx: unknown,
    service: string,
    version: string,
  ) => {
    request(action: string, param: Record<string, unknown>): Promise<Record<string, unknown>>;
  };

  const mm = managerModule as { default?: unknown } & Record<string, unknown>;
  const um = managerUtilsModule as {
    default?: { CloudService?: unknown };
    CloudService?: unknown;
  };
  const CloudBase = (mm.default ?? mm) as unknown as CloudBaseCtor;
  const CloudService = (um.CloudService ?? um.default?.CloudService) as unknown as CloudServiceCtor;

  const app = new CloudBase({
    secretId: cred.secretId,
    secretKey: cred.secretKey,
    token: cred.sessionToken,
    envId,
  });
  const ags = new CloudService(app.context, "ags", "2025-09-20");
  return ags.request(action, param);
}

// ─── AGS Tool CRUD ──────────────────────────────────────────

function extractToolSet(resp: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = resp.SandboxToolSet;
  if (Array.isArray(direct)) return direct;
  const nested = (resp.data as Record<string, unknown> | undefined)?.SandboxToolSet;
  return Array.isArray(nested) ? nested : [];
}

export async function findToolByName(
  toolName: string,
  cred: ResolvedCredentials,
  envId: string,
): Promise<{ toolId: string; toolName: string; storageMounts: Array<Record<string, unknown>> } | null> {
  const toRef = (t: Record<string, unknown>) => {
    if (typeof t.ToolId !== "string") return null;
    const mounts = t.StorageMounts;
    return {
      toolId: t.ToolId,
      toolName,
      storageMounts: Array.isArray(mounts) ? (mounts as Array<Record<string, unknown>>) : [],
    };
  };
  try {
    const resp = await callAgsApi(
      "DescribeSandboxToolList",
      { Filters: [{ Name: "ToolName", Values: [toolName] }], Limit: 20 },
      cred,
      envId,
    );
    const set = extractToolSet(resp);
    const hit = set.find((t) => t.ToolName === toolName && typeof t.ToolId === "string");
    const ref = hit ? toRef(hit as Record<string, unknown>) : null;
    if (ref) return ref;
  } catch {
    // fall through to paginated scan
  }

  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const resp = await callAgsApi(
      "DescribeSandboxToolList",
      { Offset: offset, Limit: 100 },
      cred,
      envId,
    );
    const set = extractToolSet(resp);
    const hit = set.find((t) => t.ToolName === toolName && typeof t.ToolId === "string");
    const ref = hit ? toRef(hit as Record<string, unknown>) : null;
    if (ref) return ref;
    if (set.length < 100) break;
    offset += 100;
  }
  return null;
}

export async function deleteHarnessTool(
  toolId: string,
  cred: ResolvedCredentials,
  envId: string,
): Promise<void> {
  await callAgsApi("DeleteSandboxTool", { ToolId: toolId }, cred, envId);
}

export async function createHarnessTool(
  envId: string,
  toolName: string,
  cred: ResolvedCredentials,
  sandbox: ResolvedSandboxConfig,
  storageMounts?: Array<Record<string, unknown>>,
): Promise<string> {
  const roleArn = cred.toolRoleArn || resolveHarnessToolRoleArn();
  const resp = await callAgsApi(
    "CreateSandboxTool",
    {
      ToolName: toolName,
      ToolType: "custom",
      RoleArn: roleArn,
      CustomConfiguration: {
        Image: cred.image,
        ImageRegistryType: resolveImageRegistryType(sandbox),
        Command: ["/init"],
        Resources: buildAgsSandboxResources(sandbox.resources),
        Ports: [
          { Name: "trw", Protocol: "TCP", Port: TRW_SERVICE_PORT },
          { Name: "envd", Protocol: "TCP", Port: 49983 },
        ],
        Probe: {
          HttpGet: { Path: "/health", Port: TRW_SERVICE_PORT, Scheme: "HTTP" },
          ReadyTimeoutMs: 25_000,
          ProbeTimeoutMs: 5000,
          ProbePeriodMs: 3000,
          SuccessThreshold: 1,
          FailureThreshold: 7,
        },
      },
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      DefaultTimeout: cred.defaultTimeout,
      Description: storageMounts?.length
        ? `open-managed-agent harness COS tool for env ${envId}`
        : `open-managed-agent harness tool for env ${envId}`,
      ...(storageMounts?.length ? { StorageMounts: storageMounts } : {}),
    },
    cred,
    envId,
  );
  const toolId =
    (resp?.ToolId as string) ||
    ((resp?.data as Record<string, unknown> | undefined)?.ToolId as string) ||
    "";
  if (!toolId) {
    throw new SandboxOrchestratorError(
      `CreateSandboxTool returned no ToolId: ${JSON.stringify(resp).slice(0, 300)}`,
    );
  }
  return toolId;
}

function isSandboxToolNameConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("already exists");
}

async function createHarnessToolOrReuseExisting(
  envId: string,
  toolName: string,
  cred: ResolvedCredentials,
  sandbox: ResolvedSandboxConfig,
  storageMounts?: Array<Record<string, unknown>>,
): Promise<{ toolId: string; justCreated: boolean }> {
  try {
    const toolId = await createHarnessTool(envId, toolName, cred, sandbox, storageMounts);
    return { toolId, justCreated: true };
  } catch (err) {
    if (!isSandboxToolNameConflict(err)) throw err;
    const existing = await findToolByName(toolName, cred, envId);
    if (!existing) throw err;
    return { toolId: existing.toolId, justCreated: false };
  }
}

export async function syncHarnessToolConfiguration(
  toolId: string,
  cred: ResolvedCredentials,
  sandbox: ResolvedSandboxConfig,
  envId: string,
): Promise<void> {
  await callAgsApi(
    "UpdateSandboxTool",
    {
      ToolId: toolId,
      CustomConfiguration: {
        Image: cred.image,
        ImageRegistryType: resolveImageRegistryType(sandbox),
        Resources: buildAgsSandboxResources(sandbox.resources),
      },
    },
    cred,
    envId,
  );
}

export async function ensureHarnessTool(
  envId: string,
  cred: ResolvedCredentials,
  sandbox: ResolvedSandboxConfig,
  cos: HarnessCosConfig | null,
  onProgress?: (msg: { phase: string; message: string }) => void,
): Promise<{ toolId: string; justCreated: boolean }> {
  if (cred.harnessToolId) {
    return { toolId: cred.harnessToolId, justCreated: false };
  }

  const toolName = resolveHarnessToolName(envId);
  const storageMounts = cos ? buildCosStorageMounts(cos) : undefined;
  const existing = await findToolByName(toolName, cred, envId);
  if (existing) {
    if (cos && storageMounts?.length && !existing.storageMounts.length) {
      onProgress?.({
        phase: "tool_recreate",
        message: `recreating harness tool ${toolName} with COS StorageMounts (~30s)`,
      });
      await deleteHarnessTool(existing.toolId, cred, envId);
      const { toolId } = await createHarnessToolOrReuseExisting(
        envId, toolName, cred, sandbox, storageMounts,
      );
      return { toolId, justCreated: true };
    }
    try {
      await syncHarnessToolConfiguration(existing.toolId, cred, sandbox, envId);
    } catch (err) {
      harnessTrace("orchestrator.tool.sync", {
        toolId: existing.toolId,
        error: (err as Error).message,
      });
    }
    return { toolId: existing.toolId, justCreated: false };
  }

  onProgress?.({
    phase: "tool_create",
    message: `creating harness tool ${toolName} (first run, ~30s)`,
  });
  const { toolId, justCreated } = await createHarnessToolOrReuseExisting(
    envId, toolName, cred, sandbox, storageMounts,
  );
  return { toolId, justCreated };
}

// ─── Instance lifecycle ─────────────────────────────────────

function pickStartCustomConfiguration(env: HarnessEnvVar[]): Record<string, unknown> {
  if (!env.length) return {};
  return { Env: env };
}

export async function startInstance(
  toolId: string,
  cred: ResolvedCredentials,
  envId: string,
  instanceEnv: HarnessEnvVar[],
  cos: HarnessCosConfig | null,
  sandbox: ResolvedSandboxConfig,
): Promise<string> {
  const customConfiguration = pickStartCustomConfiguration(instanceEnv);
  const authMode = resolveSandboxAgsAuthMode(sandbox);
  const resp = await callAgsApi(
    "StartSandboxInstance",
    {
      ToolId: toolId,
      Timeout: cred.defaultTimeout,
      AuthMode: authMode,
      ...(cos ? { MountOptions: buildCosMountOptions(cos) } : {}),
      ...(Object.keys(customConfiguration).length
        ? { CustomConfiguration: customConfiguration }
        : {}),
    },
    cred,
    envId,
  );
  const data = resp?.data as Record<string, unknown> | undefined;
  const inst = resp?.Instance as Record<string, unknown> | undefined;
  const instanceId =
    String(resp?.InstanceId || inst?.InstanceId || data?.InstanceId || "") || "";
  if (!instanceId) {
    throw new SandboxOrchestratorError(
      `StartSandboxInstance returned no InstanceId: ${JSON.stringify(resp).slice(0, 300)}`,
    );
  }
  return instanceId;
}

function isAgsRetryableError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return (
    /is not active/i.test(msg) ||
    /CREATING/i.test(msg) ||
    /internal error has occurred/i.test(msg) ||
    /ResourceInsufficient/i.test(msg)
  );
}

export async function startInstanceWithRetry(args: {
  toolId: string;
  cred: ResolvedCredentials;
  envId: string;
  instanceEnv: HarnessEnvVar[];
  cos: HarnessCosConfig | null;
  sandbox: ResolvedSandboxConfig;
  onProgress?: (msg: { phase: string; message: string }) => void;
}): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TOOL_WARMUP_POLL_MAX; attempt++) {
    try {
      return await startInstance(
        args.toolId, args.cred, args.envId, args.instanceEnv, args.cos, args.sandbox,
      );
    } catch (err) {
      lastErr = err;
      if (!isAgsRetryableError(err) || attempt >= TOOL_WARMUP_POLL_MAX) throw err;
      args.onProgress?.({
        phase: "instance_start_retry",
        message: `instance start retry ${attempt}/${TOOL_WARMUP_POLL_MAX}`,
      });
      await new Promise((r) => setTimeout(r, TOOL_WARMUP_POLL_MS));
    }
  }
  throw lastErr;
}

export async function acquireInstanceToken(
  instanceId: string,
  cred: ResolvedCredentials,
  envId: string,
  sandbox: ResolvedSandboxConfig,
  options?: { required?: boolean },
): Promise<string | undefined> {
  if (resolveSandboxAgsAuthMode(sandbox) === "NONE") return undefined;

  try {
    const resp = await callAgsApi(
      "AcquireSandboxInstanceToken",
      { InstanceId: instanceId },
      cred,
      envId,
    );
    const data = resp?.data as Record<string, unknown> | undefined;
    const token = String(resp?.Token || data?.Token || "").trim();
    if (!token && options?.required !== false) {
      throw new SandboxOrchestratorError(
        `AcquireSandboxInstanceToken returned no Token for ${instanceId}`,
      );
    }
    return token || undefined;
  } catch (err) {
    if (options?.required === false) {
      harnessTrace("orchestrator.token.acquire", { error: (err as Error).message });
      return undefined;
    }
    throw err instanceof SandboxOrchestratorError
      ? err
      : new SandboxOrchestratorError(
          `AcquireSandboxInstanceToken failed for ${instanceId}`,
          err,
        );
  }
}

export async function describeInstanceStatus(
  instanceId: string,
  cred: ResolvedCredentials,
  envId: string,
): Promise<string> {
  const resp = await callAgsApi(
    "DescribeSandboxInstanceList",
    { InstanceIds: [instanceId], Limit: 1 },
    cred,
    envId,
  );
  const data = resp?.data as Record<string, unknown> | undefined;
  const rows = (resp?.InstanceSet || data?.InstanceSet || []) as Array<Record<string, unknown>>;
  const hit = rows.find((r) => r.InstanceId === instanceId);
  return hit ? String(hit.Status || "") : "";
}

// ─── Handle construction ────────────────────────────────────

export function buildDataPlaneHeaders(args: {
  apiKey: string;
  instanceId: string;
  port: number;
  accessToken?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Cloudbase-Authorization": `Bearer ${args.apiKey}`,
    "E2b-Sandbox-Id": args.instanceId,
    "E2b-Sandbox-Port": String(args.port),
    "Accept-Encoding": "identity",
  };
  if (args.accessToken) {
    headers["X-Access-Token"] = args.accessToken;
  }
  return headers;
}

export function mergeSandboxDataPlaneHeaders(
  base: Record<string, string>,
  initHeaders?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {
    ...base,
    ...harnessOutboundCorrelationHeaders(),
    ...(initHeaders ?? {}),
  };
  injectOutboundTraceHeaders(merged);
  return merged;
}

export function buildHarnessSandboxHandle(args: {
  instanceId: string;
  toolId: string;
  baseUrl: string;
  apiKey: string;
  accessToken?: string;
  cred: ResolvedCredentials;
  envId: string;
  sandbox: ResolvedSandboxConfig;
  orchestrator: { stopInstance(i: string, c: ResolvedCredentials, e: string): Promise<void>; pauseInstance(i: string, c: ResolvedCredentials, e: string): Promise<void> };
}): HarnessSandboxHandle {
  let headers = buildDataPlaneHeaders({
    apiKey: args.apiKey,
    instanceId: args.instanceId,
    port: TRW_SERVICE_PORT,
    accessToken: args.accessToken,
  });

  const self = args.orchestrator;
  const { instanceId, cred, envId, apiKey, sandbox } = args;

  return {
    instanceId: args.instanceId,
    toolId: args.toolId,
    baseUrl: args.baseUrl,
    headers,
    instanceAccessToken: args.accessToken,
    request(path: string, init?: RequestInit) {
      const p = path.startsWith("/") ? path : `/${path}`;
      const initHeaders = (init?.headers as Record<string, string> | undefined) ?? {};
      return fetch(`${args.baseUrl}${p}`, {
        ...init,
        headers: mergeSandboxDataPlaneHeaders(headers, initHeaders),
      });
    },
    async refreshInstanceAccessToken() {
      const token = await acquireInstanceToken(instanceId, cred, envId, sandbox);
      headers = buildDataPlaneHeaders({
        apiKey, instanceId, port: TRW_SERVICE_PORT, accessToken: token,
      });
      (this as HarnessSandboxHandle).instanceAccessToken = token;
      (this as HarnessSandboxHandle).headers = headers;
      return token;
    },
    async stop() {
      await self.stopInstance(instanceId, cred, envId);
    },
    async pause() {
      await self.pauseInstance(instanceId, cred, envId);
    },
    async resumeIfPaused() {
      const status = await describeInstanceStatus(instanceId, cred, envId);
      if (status === "PAUSED" || status === "RESUME_FAILED") {
        await callAgsApi("ResumeSandboxInstance", { InstanceId: instanceId }, cred, envId);
      }
      if (resolveSandboxAgsAuthMode(sandbox) === "TOKEN") {
        await (this as HarnessSandboxHandle).refreshInstanceAccessToken();
      }
    },
  };
}

// ─── Health check ───────────────────────────────────────────

export async function waitForReady(args: {
  baseUrl: string;
  headers: Record<string, string>;
  onProgress?: (msg: { phase: string; message: string }) => void;
}): Promise<void> {
  const { baseUrl, headers, onProgress } = args;
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < READY_TIMEOUT_MS) {
    attempt++;
    onProgress?.({
      phase: "warmup",
      message: `waiting for sandbox /health (attempt ${attempt})...`,
    });
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: mergeSandboxDataPlaneHeaders(headers),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (res.ok) {
        try {
          const body = (await res.json()) as { ok?: boolean; status?: string };
          if (body.ok === true && body.status === "ok") return;
        } catch {
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new SandboxOrchestratorError("Sandbox /health did not become ready in time");
}

// ─── Re-export from cos-mount (needed by orchestrator) ─────

export { buildCosMountOptions, ensureCosSubPath, mergeCosInstanceEnv, resolveHarnessCosConfig } from "./cos-mount.js";
export type { HarnessCosConfig } from "./cos-mount.js";

// ─── Constants (needed by orchestrator) ─────────────────────

export const SANDBOX_TRW_SERVICE_PORT = TRW_SERVICE_PORT;
export const SANDBOX_TOOL_WARMUP_POLL_MS = TOOL_WARMUP_POLL_MS;
export const SANDBOX_TOOL_WARMUP_POLL_MAX = TOOL_WARMUP_POLL_MAX;

// Import buildCosMountOptions for startInstance
import { buildCosMountOptions } from "./cos-mount.js";
