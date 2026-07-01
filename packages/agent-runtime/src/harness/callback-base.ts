/**
 * Harness client-tool callback base URL (sandbox → agent MCP bridge).
 */

export function harnessGatewayBotBase(envId: string, agentId: string): string {
  return `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}`;
}

export interface ResolveHarnessCallbackBaseOpts {
  agentId?: string;
  /** Runtime default when bot URL is unknown (local dev). Deploy omits this. */
  loopbackDefault?: boolean;
}

/**
 * Resolve callback base for MCPORTER / client tools.
 * Priority: CLOUDBASE_SERVER_URL → gateway bot URL → loopback (runtime only) → "".
 */
export function resolveHarnessClientToolCallbackBase(
  envId?: string,
  opts: ResolveHarnessCallbackBaseOpts = {},
): string {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");

  const eid =
    envId?.trim() ??
    process.env.CLOUDBASE_ENV_ID?.trim() ??
    process.env.TCB_ENV_ID?.trim();
  const agentId = opts.agentId?.trim() ?? process.env.CLOUDBASE_AGENT_ID?.trim();
  if (eid && agentId) return harnessGatewayBotBase(eid, agentId);

  if (opts.loopbackDefault) {
    const port = process.env.PORT ?? 9000;
    return `http://127.0.0.1:${port}`;
  }
  return "";
}

/** Public URL the sandbox uses to reach agent /internal/harness/mcp. */
export function harnessCallbackBase(): string {
  return resolveHarnessClientToolCallbackBase(undefined, { loopbackDefault: true });
}
