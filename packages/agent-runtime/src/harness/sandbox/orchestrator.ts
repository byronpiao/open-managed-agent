/**
 * AgsStatefulSandboxOrchestrator — harness sandbox orchestration.
 * AGS API layer extracted to sandbox-ags.ts.
 */

import type {
  AgentConfig,
  HarnessEnvVar,
  HarnessEngine,
  DataPlaneEngineSlug,
} from "../../config.js";
import { buildHarnessInstanceEnv, engineToDataPlaneSlug } from "../../config.js";
import { fetchGatewayAccessToken } from "../tcb-gateway-token.js";
import { generateHarnessSecretMasterKey } from "../session-secrets.js";
import { harnessLog, harnessTrace } from "../observability/logging.js";
import { withActiveSpan } from "../telemetry/telemetry.js";
import { recordHarnessAcquireDuration } from "../observability/metrics.js";
import {
  resolveCredentials,
  resolveGatewayUrl,
  callAgsApi,
  ensureHarnessTool,
  startInstanceWithRetry,
  acquireInstanceToken,
  waitForReady,
  buildDataPlaneHeaders,
  buildHarnessSandboxHandle,
  mergeSandboxDataPlaneHeaders,
  syncHarnessToolConfiguration,
  describeInstanceStatus,
  SANDBOX_TRW_SERVICE_PORT,
  SANDBOX_TOOL_WARMUP_POLL_MS,
  SANDBOX_TOOL_WARMUP_POLL_MAX,
  type ResolvedCredentials,
  type HarnessSandboxHandle,
  type SandboxInstanceRow,
  SandboxOrchestratorError,
} from "./sandbox-ags.js";
import {
  buildCosMountOptions,
  ensureCosSubPath,
  mergeCosInstanceEnv,
  resolveHarnessCosConfig,
} from "./cos-mount.js";
import {
  assertSandboxAcquireAllowed,
  resolveSandboxConfig,
  resolveSandboxImage,
  resolveSandboxTimeout,
  type ResolvedSandboxConfig,
} from "./sandbox-config.js";

export type { ResolvedCredentials, HarnessSandboxHandle, SandboxInstanceRow, SandboxOrchestratorError };

export interface OrchestratorOptions {
  apiKey?: string;
  secretId?: string;
  secretKey?: string;
  sessionToken?: string;
  image?: string;
  toolRoleArn?: string;
  defaultTimeout?: string;
  gatewayBaseUrl?: string;
  harnessToolId?: string;
}

export interface AcquireHarnessSandboxArgs {
  envId: string;
  agentConfig: AgentConfig;
  engine: HarnessEngine;
  instanceEnv?: HarnessEnvVar[];
  acpSessionId?: string;
  onProgress?: (msg: { phase: string; message: string }) => void;
}

export class AgsStatefulSandboxOrchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions = {}) {
    this.options = options;
  }

  async acquire(args: AcquireHarnessSandboxArgs): Promise<HarnessSandboxHandle> {
    return withActiveSpan(
      "harness.acquire",
      {
        engine: args.engine,
        envId: args.envId,
        ...(args.acpSessionId ? { acpSessionId: args.acpSessionId } : {}),
      },
      async (span) => this.acquireInner(args, span),
    );
  }

  private async acquireInner(
    args: AcquireHarnessSandboxArgs,
    rootSpan?: import("@opentelemetry/api").Span,
  ): Promise<HarnessSandboxHandle> {
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
      "tool.ensure", "cos.ensure_subpath", "instance_start", "token.acquire", "template_warmup",
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
      const ensured = await withActiveSpan(
        "harness.acquire.tool_ensure",
        { envId: args.envId, engine: args.engine },
        async () => ensureHarnessTool(args.envId, cred, sandbox, cos, onProgress),
      );
      toolId = ensured.toolId;
      wl.set({
        toolId,
        toolJustCreated: ensured.justCreated,
        ...(cos ? { cosSubPath: cos.subPath, cosMount: cos.mountName } : {}),
      });

      if (cos) {
        onProgress({ phase: "cos.ensure_subpath", message: `COS subpath ${cos.subPath} under ${cos.bucketPath}` });
        await ensureCosSubPath(cos, {
          secretId: cred.secretId, secretKey: cred.secretKey, sessionToken: cred.sessionToken,
        });
      }

      if (ensured.justCreated) {
        for (let round = 1; round <= SANDBOX_TOOL_WARMUP_POLL_MAX; round++) {
          onProgress({ phase: "template_warmup", message: `tool image warmup (${round}/${SANDBOX_TOOL_WARMUP_POLL_MAX})...` });
          await new Promise((r) => setTimeout(r, SANDBOX_TOOL_WARMUP_POLL_MS));
        }
      }

      onProgress({ phase: "instance_start", message: "starting sandbox instance..." });
      instanceId = await withActiveSpan(
        "harness.acquire.instance_start",
        { envId: args.envId, engine: args.engine },
        async () => {
          const id = await startInstanceWithRetry({
            toolId, cred, envId: args.envId, instanceEnv, cos, sandbox, onProgress,
          });
          wl.set({ instanceId: id });
          wl.milestone("token.acquire");
          accessToken = await acquireInstanceToken(id, cred, args.envId, sandbox);
          headers = buildDataPlaneHeaders({
            apiKey: cred.apiKey, instanceId: id, port: SANDBOX_TRW_SERVICE_PORT, accessToken,
          });
          wl.phase("health.wait");
          await waitForReady({ baseUrl, headers, onProgress });
          return id;
        },
      );

      wl.phase("harness.init");
      await withActiveSpan(
        "harness.acquire.workspace_init",
        { envId: args.envId, engine: args.engine },
        async (span) => {
          const initStartedAt = Date.now();
          if (span) {
            span.setAttribute("instance_id", instanceId);
            span.setAttribute("tool_id", toolId);
          }
          await this.trwWorkspaceInit(baseUrl, headers, instanceEnv, wl);
          if (span) span.setAttribute("duration_ms", Date.now() - initStartedAt);
        },
      );

      const durationMs = Date.now() - startedAt;
      wl.emit({ status: "ok", durationMs });
      recordHarnessAcquireDuration(durationMs, { engine: args.engine, status: "ok" });
      if (rootSpan) {
        rootSpan.setAttribute("sandbox_id", instanceId);
        rootSpan.setAttribute("acquire_outcome", ensured.justCreated ? "created" : "reused");
      }
    } catch (err) {
      wl.error(err);
      const durationMs = Date.now() - startedAt;
      wl.emit({ status: "error", durationMs });
      recordHarnessAcquireDuration(durationMs, { engine: args.engine, status: "error" });
      throw err;
    }

    return buildHarnessSandboxHandle({
      instanceId, toolId, baseUrl, apiKey: cred.apiKey, accessToken,
      cred, envId: args.envId, sandbox, orchestrator: this,
    });
  }

  async trwWorkspaceInit(
    baseUrl: string,
    headers: Record<string, string>,
    instanceEnv: HarnessEnvVar[],
    parentLog?: ReturnType<typeof harnessLog>,
  ): Promise<void> {
    const envMap: Record<string, string> = {};
    for (const { Name, Value } of instanceEnv) envMap[Name] = Value;
    let skills: unknown[] | undefined;
    const skillsRaw = envMap.HARNESS_SKILLS_JSON;
    if (skillsRaw) {
      try {
        const parsed = JSON.parse(skillsRaw) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) skills = parsed;
      } catch { /* ignore */ }
    }
    try {
      const res = await fetch(`${baseUrl}/api/workspace/init`, {
        method: "POST",
        headers: mergeSandboxDataPlaneHeaders(headers, { "Content-Type": "application/json" }),
        body: JSON.stringify({ env: envMap, ...(skills ? { skills } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        parentLog?.set({ workspaceInitHttpStatus: res.status, workspaceInitBody: body });
        harnessTrace("orchestrator.harness.trw_init", { httpStatus: res.status, body });
        throw new SandboxOrchestratorError(`POST /api/workspace/init failed HTTP ${res.status}: ${body}`);
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

  async pauseInstance(instanceId: string, cred: ResolvedCredentials, envId: string): Promise<void> {
    await callAgsApi("PauseSandboxInstance", { InstanceId: instanceId }, cred, envId);
  }

  async stopInstance(instanceId: string, cred: ResolvedCredentials, envId: string): Promise<void> {
    await callAgsApi("StopSandboxInstance", { InstanceId: instanceId }, cred, envId);
  }

  async stopInstanceForEnv(instanceId: string, envId: string): Promise<void> {
    const cred = resolveCredentials(this.options);
    await this.stopInstance(instanceId, cred, envId);
  }

  async connectToInstance(
    instanceId: string,
    envId: string,
    toolId?: string,
    instanceEnv?: HarnessEnvVar[],
  ): Promise<HarnessSandboxHandle> {
    const cred = resolveCredentials(this.options);
    if (!cred.apiKey?.trim()) cred.apiKey = await fetchGatewayAccessToken(envId);
    const baseUrl = resolveGatewayUrl(envId, cred.gatewayBaseUrl);
    const sandbox = resolveSandboxConfig({});
    const accessToken = await acquireInstanceToken(instanceId, cred, envId, sandbox);
    const headers = buildDataPlaneHeaders({
      apiKey: cred.apiKey, instanceId, port: SANDBOX_TRW_SERVICE_PORT, accessToken,
    });
    await waitForReady({ baseUrl, headers });
    if (instanceEnv?.length) {
      const wl = harnessLog({
        lane: "orchestrator",
        operation: "instance.reconnect.init",
        instanceId,
      });
      await this.trwWorkspaceInit(baseUrl, headers, instanceEnv, wl);
    }
    return buildHarnessSandboxHandle({
      instanceId,
      toolId: toolId ?? cred.harnessToolId ?? "",
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
        "DescribeSandboxInstanceList", { Offset: offset, Limit: 100 }, cred, envId,
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
          instanceId: row.instanceId, status: row.status, error: (err as Error).message,
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

// ─── Singleton + handle cache ───────────────────────────────

let _orchestrator: AgsStatefulSandboxOrchestrator | null = null;

export function getSandboxOrchestrator(): AgsStatefulSandboxOrchestrator {
  if (!_orchestrator) _orchestrator = new AgsStatefulSandboxOrchestrator();
  return _orchestrator;
}

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

export function getHarnessSandboxCacheStats(): { cachedHandles: number } {
  return { cachedHandles: handleBySession.size };
}

// ─── CLI sync-tool helper ───────────────────────────────────

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
