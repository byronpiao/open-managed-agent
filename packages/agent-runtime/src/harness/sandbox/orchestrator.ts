/**
 * AgsStatefulSandboxOrchestrator — harness sandbox control + data plane (D1/D4/D5).
 * Not the OAK vendor AgsStatefulSandbox class (OAK still defaults AuthMode NONE).
 */

import {
  buildHarnessInstanceEnv,
  resolveHarnessToolName,
  type AgentConfig,
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
import { fetchGatewayAccessToken } from "../tcb-gateway-token.js";
import { generateHarnessSecretMasterKey } from "../session-secrets.js";
import { harnessTrace, harnessLog, harnessOutboundCorrelationHeaders } from "../logging.js";
import { recordHarnessAcquireDuration } from "../metrics.js";
import {
  buildCosMountOptions,
  buildCosStorageMounts,
  ensureCosSubPath,
  mergeCosInstanceEnv,
  resolveHarnessCosConfig,
  type HarnessCosConfig,
} from "./cos-mount.js";
import {
  assertSandboxAcquireAllowed,
  buildAgsSandboxResources,
  resolveSandboxAgsAuthMode,
  resolveSandboxConfig,
  resolveSandboxImage,
  resolveSandboxImageRegistryType,
  resolveSandboxTimeout,
  type ResolvedSandboxConfig,
} from "./sandbox-config.js";

const TRW_SERVICE_PORT = 9000;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 3000;
const TOOL_WARMUP_POLL_MS = 10_000;
const TOOL_WARMUP_POLL_MAX = 6;
const HEALTH_TIMEOUT_MS = 5000;

export class SandboxOrchestratorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SandboxOrchestratorError";
    if (cause) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface OrchestratorOptions {
  apiKey?: string;
  secretId?: string;
  secretKey?: string;
  sessionToken?: string;
  image?: string;
  toolRoleArn?: string;
  defaultTimeout?: string;
  gatewayBaseUrl?: string;
  /** Skip ensureTool; use this ToolId (D4 one-off binding). */
  harnessToolId?: string;
}

interface ResolvedCredentials {
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
  /** sit_* instance access token (X-Access-Token); persisted on harness_sessions when bound. */
  instanceAccessToken?: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Re-fetch sit_* after pause/resume or before gateway calls if headers may be stale. */
  refreshInstanceAccessToken(): Promise<string | undefined>;
  /** Stop instance (releases RUNNING/PAUSED quota). Prefer over pause for harness e2e. */
  stop(): Promise<void>;
  pause(): Promise<void>;
  resumeIfPaused(): Promise<void>;
}

export interface SandboxInstanceRow {
  instanceId: string;
  status: string;
  toolId?: string;
}

export interface AcquireHarnessSandboxArgs {
  envId: string;
  agentConfig: AgentConfig;
  engine: HarnessEngine;
  instanceEnv?: HarnessEnvVar[];
  acpSessionId?: string;
  onProgress?: (msg: { phase: string; message: string }) => void;
}

function resolveCredentials(opts: OrchestratorOptions): ResolvedCredentials {
  const apiKey = opts.apiKey ?? process.env.TCB_API_KEY ?? "";
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

function resolveGatewayUrl(envId: string, override?: string): string {
  if (override) return override.replace(/\/$/, "");
  return `https://${envId}.api.tcloudbasegateway.com/v1/sandbox/-`;
}

function resolveImageRegistryType(sandbox: ResolvedSandboxConfig): string {
  const legacy = process.env.HARNESS_SANDBOX_IMAGE_REGISTRY_TYPE?.trim();
  if (
    !sandbox.imageRegistryType &&
    (legacy === "enterprise" || legacy === "personal")
  ) {
    return legacy;
  }
  return resolveSandboxImageRegistryType(sandbox);
}

async function callAgsApi(
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
    throw new SandboxOrchestratorError(
      "Requires @cloudbase/manager-node",
      err,
    );
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

function extractToolSet(resp: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = resp.SandboxToolSet;
  if (Array.isArray(direct)) return direct;
  const nested = (resp.data as Record<string, unknown> | undefined)?.SandboxToolSet;
  return Array.isArray(nested) ? nested : [];
}

async function findToolByName(
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

async function deleteHarnessTool(
  toolId: string,
  cred: ResolvedCredentials,
  envId: string,
): Promise<void> {
  await callAgsApi("DeleteSandboxTool", { ToolId: toolId }, cred, envId);
}

async function createHarnessTool(
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

async function syncHarnessToolConfiguration(
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

async function ensureHarnessTool(
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
      const toolId = await createHarnessTool(envId, toolName, cred, sandbox, storageMounts);
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
  const toolId = await createHarnessTool(envId, toolName, cred, sandbox, storageMounts);
  return { toolId, justCreated: true };
}

function pickStartCustomConfiguration(env: HarnessEnvVar[]): Record<string, unknown> {
  if (!env.length) return {};
  return { Env: env };
}

async function startInstance(
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

async function startInstanceWithRetry(args: {
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
        args.toolId,
        args.cred,
        args.envId,
        args.instanceEnv,
        args.cos,
        args.sandbox,
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

async function acquireInstanceToken(
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

function buildHarnessSandboxHandle(args: {
  instanceId: string;
  toolId: string;
  baseUrl: string;
  apiKey: string;
  accessToken?: string;
  cred: ResolvedCredentials;
  envId: string;
  sandbox: ResolvedSandboxConfig;
  orchestrator: AgsStatefulSandboxOrchestrator;
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
        headers: {
          ...headers,
          ...harnessOutboundCorrelationHeaders(),
          ...initHeaders,
        },
      });
    },
    async refreshInstanceAccessToken() {
      const token = await acquireInstanceToken(instanceId, cred, envId, sandbox);
      headers = buildDataPlaneHeaders({
        apiKey,
        instanceId,
        port: TRW_SERVICE_PORT,
        accessToken: token,
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

function buildDataPlaneHeaders(args: {
  apiKey: string;
  instanceId: string;
  port: number;
  accessToken?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Cloudbase-Authorization": `Bearer ${args.apiKey}`,
    "E2b-Sandbox-Id": args.instanceId,
    "E2b-Sandbox-Port": String(args.port),
    // AGS data-plane proxy may return malformed gzip; avoid auto-decompress failures.
    "Accept-Encoding": "identity",
  };
  if (args.accessToken) {
    headers["X-Access-Token"] = args.accessToken;
  }
  return headers;
}

async function waitForReady(args: {
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
        headers,
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

async function describeInstanceStatus(
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

export class AgsStatefulSandboxOrchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions = {}) {
    this.options = options;
  }

  async acquire(args: AcquireHarnessSandboxArgs): Promise<HarnessSandboxHandle> {
    const startedAt = Date.now();
    const wl = harnessLog({
      lane: "orchestrator",
      operation: "acquire",
      acpSessionId: args.acpSessionId,
      engine: args.engine,
      envId: args.envId,
    });
    const cred = resolveCredentials(this.options);
    const sandbox = resolveSandboxConfig(
      { sandbox: args.agentConfig.sandbox, engine: args.engine },
      args.engine,
    );
    assertSandboxAcquireAllowed(sandbox, args.engine);
    cred.image = resolveSandboxImage(sandbox, cred.image);
    cred.defaultTimeout = resolveSandboxTimeout(sandbox, cred.defaultTimeout);
    if (!cred.apiKey?.trim()) {
      cred.apiKey = await fetchGatewayAccessToken(args.envId);
    }
    wl.set({
      sandboxInfra: sandbox.infra,
      sandboxCpu: sandbox.resources.cpu,
      sandboxMemory: sandbox.resources.memory,
      sandboxImage: cred.image,
      harnessToolId: cred.harnessToolId,
    });
    const baseUrl = resolveGatewayUrl(args.envId, cred.gatewayBaseUrl);
    let instanceEnv =
      args.instanceEnv ?? buildHarnessInstanceEnv(args.agentConfig, args.engine);
    const secretMasterKey =
      instanceEnv.find((e) => e.Name === "SECRET_MASTER_KEY")?.Value ??
      generateHarnessSecretMasterKey();
    if (!instanceEnv.some((e) => e.Name === "SECRET_MASTER_KEY")) {
      instanceEnv = [...instanceEnv, { Name: "SECRET_MASTER_KEY", Value: secretMasterKey }];
    }
    const cos = resolveHarnessCosConfig({
      acpSessionId: args.acpSessionId,
      secretMasterKey,
    });
    if (cos) {
      instanceEnv = mergeCosInstanceEnv(instanceEnv, cos);
    }

    const milestonePhases = new Set([
      "tool.ensure",
      "cos.ensure_subpath",
      "instance_start",
      "token.acquire",
      "template_warmup",
    ]);
    const onProgress = (msg: { phase: string; message: string }) => {
      const fields = { detail: msg.message };
      if (milestonePhases.has(msg.phase)) wl.milestone(msg.phase, fields);
      else wl.phase(msg.phase, fields);
      args.onProgress?.(msg);
    };

    let toolId = "";
    let instanceId = "";
    let headers: Record<string, string> = {};
    let accessToken: string | undefined;

    try {
      wl.milestone("tool.ensure");
      const ensured = await ensureHarnessTool(args.envId, cred, sandbox, cos, onProgress);
      toolId = ensured.toolId;
      wl.set({
        toolId,
        toolJustCreated: ensured.justCreated,
        ...(cos ? { cosSubPath: cos.subPath, cosMount: cos.mountName } : {}),
      });

      if (cos) {
        onProgress({
          phase: "cos.ensure_subpath",
          message: `COS subpath ${cos.subPath} under ${cos.bucketPath}`,
        });
        await ensureCosSubPath(cos, {
          secretId: cred.secretId,
          secretKey: cred.secretKey,
          sessionToken: cred.sessionToken,
        });
      }

      if (ensured.justCreated) {
        for (let round = 1; round <= TOOL_WARMUP_POLL_MAX; round++) {
          onProgress({
            phase: "template_warmup",
            message: `tool image warmup (${round}/${TOOL_WARMUP_POLL_MAX})...`,
          });
          await new Promise((r) => setTimeout(r, TOOL_WARMUP_POLL_MS));
        }
      }

      onProgress({ phase: "instance_start", message: "starting sandbox instance..." });
      instanceId = await startInstanceWithRetry({
        toolId,
        cred,
        envId: args.envId,
        instanceEnv,
        cos,
        sandbox,
        onProgress,
      });
      wl.set({ instanceId });

      wl.milestone("token.acquire");
      accessToken = await acquireInstanceToken(instanceId, cred, args.envId, sandbox);
      headers = buildDataPlaneHeaders({
        apiKey: cred.apiKey,
        instanceId,
        port: TRW_SERVICE_PORT,
        accessToken,
      });

      wl.phase("health.wait");
      await waitForReady({ baseUrl, headers, onProgress });

      wl.phase("harness.init");
      await this.trwWorkspaceInit(baseUrl, headers, instanceEnv, wl);

      const durationMs = Date.now() - startedAt;
      wl.emit({ status: "ok", durationMs });
      recordHarnessAcquireDuration(durationMs, { engine: args.engine, status: "ok" });
    } catch (err) {
      wl.error(err);
      const durationMs = Date.now() - startedAt;
      wl.emit({ status: "error", durationMs });
      recordHarnessAcquireDuration(durationMs, { engine: args.engine, status: "error" });
      throw err;
    }

    return buildHarnessSandboxHandle({
      instanceId,
      toolId,
      baseUrl,
      apiKey: cred.apiKey,
      accessToken,
      cred,
      envId: args.envId,
      sandbox,
      orchestrator: this,
    });
  }

  /** TRW data-plane POST /api/workspace/init (path is TRW-owned). */
  async trwWorkspaceInit(
    baseUrl: string,
    headers: Record<string, string>,
    instanceEnv: HarnessEnvVar[],
    parentLog?: ReturnType<typeof harnessLog>,
  ): Promise<void> {
    const envMap: Record<string, string> = {};
    for (const { Name, Value } of instanceEnv) {
      envMap[Name] = Value;
    }
    let skills: unknown[] | undefined;
    const skillsRaw = envMap.HARNESS_SKILLS_JSON;
    if (skillsRaw) {
      try {
        const parsed = JSON.parse(skillsRaw) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) skills = parsed;
      } catch {
        // ignore malformed manifest
      }
    }
    try {
      const res = await fetch(`${baseUrl}/api/workspace/init`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          env: envMap,
          ...(skills ? { skills } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        parentLog?.set({ workspaceInitHttpStatus: res.status, workspaceInitBody: body });
        harnessTrace("orchestrator.harness.trw_init", { httpStatus: res.status, body });
        throw new SandboxOrchestratorError(
          `POST /api/workspace/init failed HTTP ${res.status}: ${body}`,
        );
      }
      parentLog?.set({ workspaceInitHttpStatus: res.status });
    } catch (err) {
      if (err instanceof SandboxOrchestratorError) throw err;
      const message = (err as Error).message;
      parentLog?.set({ workspaceInitError: message });
      harnessTrace("orchestrator.harness.trw_init", { error: message });
      throw new SandboxOrchestratorError(`POST /api/workspace/init failed: ${message}`);
    }
  }

  async pauseInstance(
    instanceId: string,
    cred: ResolvedCredentials,
    envId: string,
  ): Promise<void> {
    await callAgsApi("PauseSandboxInstance", { InstanceId: instanceId }, cred, envId);
  }

  async stopInstance(
    instanceId: string,
    cred: ResolvedCredentials,
    envId: string,
  ): Promise<void> {
    await callAgsApi("StopSandboxInstance", { InstanceId: instanceId }, cred, envId);
  }

  /** Stop a sandbox instance using orchestrator credentials (harness re-acquire path). */
  async stopInstanceForEnv(instanceId: string, envId: string): Promise<void> {
    const cred = resolveCredentials(this.options);
    await this.stopInstance(instanceId, cred, envId);
  }

  /** Attach to an already-running instance (diagnostics / export on live session). */
  async connectToInstance(instanceId: string, envId: string): Promise<HarnessSandboxHandle> {
    const cred = resolveCredentials(this.options);
    if (!cred.apiKey?.trim()) {
      cred.apiKey = await fetchGatewayAccessToken(envId);
    }
    const baseUrl = resolveGatewayUrl(envId, cred.gatewayBaseUrl);
    const sandbox = resolveSandboxConfig({});
    const accessToken = await acquireInstanceToken(instanceId, cred, envId, sandbox);
    const headers = buildDataPlaneHeaders({
      apiKey: cred.apiKey,
      instanceId,
      port: TRW_SERVICE_PORT,
      accessToken,
    });
    await waitForReady({ baseUrl, headers });
    return buildHarnessSandboxHandle({
      instanceId,
      toolId: cred.harnessToolId ?? "",
      baseUrl,
      apiKey: cred.apiKey,
      accessToken,
      cred,
      envId,
      sandbox,
      orchestrator: this,
    });
  }

  async listInstances(envId: string): Promise<SandboxInstanceRow[]> {
    const cred = resolveCredentials(this.options);
    const rows: SandboxInstanceRow[] = [];
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const resp = await callAgsApi(
        "DescribeSandboxInstanceList",
        { Offset: offset, Limit: 100 },
        cred,
        envId,
      );
      const data = resp?.data as Record<string, unknown> | undefined;
      const set = (resp?.InstanceSet || data?.InstanceSet || []) as Array<Record<string, unknown>>;
      for (const row of set) {
        if (typeof row.InstanceId === "string") {
          rows.push({
            instanceId: row.InstanceId,
            status: String(row.Status ?? ""),
            toolId: typeof row.ToolId === "string" ? row.ToolId : undefined,
          });
        }
      }
      if (set.length < 100) break;
      offset += 100;
    }
    return rows;
  }

  /** Stop every non-terminal instance in the env (harness e2e teardown). */
  async stopAllInstances(envId: string): Promise<string[]> {
    const cred = resolveCredentials(this.options);
    const stopped: string[] = [];
    const rows = await this.listInstances(envId);
    for (const row of rows) {
      const status = row.status.toUpperCase();
      if (status === "STOPPED" || status === "STOPPING") continue;
      try {
        await this.stopInstance(row.instanceId, cred, envId);
        stopped.push(row.instanceId);
      } catch (err) {
        harnessTrace("orchestrator.teardown.stop_failed", {
          instanceId: row.instanceId,
          status: row.status,
          error: (err as Error).message,
        });
      }
    }
    return stopped;
  }

  acpPathForEngine(engine: HarnessEngine): string {
    const slug: DataPlaneEngineSlug = engineToDataPlaneSlug(engine);
    return `/api/agents/${slug}/acp`;
  }
}

/** CLI sync-tool.mjs — align tool image with harness config. */
export async function syncHarnessAgsTool(options: {
  envId: string;
  toolId: string;
  image: string;
}): Promise<void> {
  const cred = resolveCredentials({ image: options.image });
  const sandbox = resolveSandboxConfig({});
  cred.image = resolveSandboxImage(sandbox, cred.image);
  cred.defaultTimeout = resolveSandboxTimeout(sandbox, cred.defaultTimeout);

  await syncHarnessToolConfiguration(options.toolId, cred, sandbox, options.envId);
}

let _orchestrator: AgsStatefulSandboxOrchestrator | null = null;

export function getSandboxOrchestrator(): AgsStatefulSandboxOrchestrator {
  if (!_orchestrator) {
    _orchestrator = new AgsStatefulSandboxOrchestrator();
  }
  return _orchestrator;
}

/** Per acpSessionId sandbox handle cache (1:1 session ↔ instance, D6). */
const handleBySession = new Map<string, HarnessSandboxHandle>();

export function getCachedSandboxHandle(acpSessionId: string): HarnessSandboxHandle | undefined {
  return handleBySession.get(acpSessionId);
}

export function cacheSandboxHandle(acpSessionId: string, handle: HarnessSandboxHandle): void {
  handleBySession.set(acpSessionId, handle);
}

export function dropCachedSandboxHandle(acpSessionId: string): void {
  handleBySession.delete(acpSessionId);
}

/** /healthz — cached sandbox handles per ACP session. */
export function getHarnessSandboxCacheStats(): { cachedHandles: number } {
  return { cachedHandles: handleBySession.size };
}
