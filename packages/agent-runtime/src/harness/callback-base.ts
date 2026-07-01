/**
 * Harness client-tool callback base URL (sandbox → agent MCP bridge).
 * Keep in sync with resolveHarnessClientToolCallbackBase() in lib/harness-deploy.mjs.
 */

export function harnessGatewayBotBase(envId: string, agentId: string): string {
  return `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}`;
}

/** Public URL the sandbox uses to reach agent /internal/harness/mcp. */
export function harnessCallbackBase(): string {
  const fromUrl = process.env.CLOUDBASE_SERVER_URL?.trim();
  if (fromUrl) return fromUrl.replace(/\/$/, "");

  const envId = process.env.CLOUDBASE_ENV_ID?.trim() ?? process.env.TCB_ENV_ID?.trim();
  const agentId = process.env.CLOUDBASE_AGENT_ID?.trim();
  if (envId && agentId) return harnessGatewayBotBase(envId, agentId);

  const port = process.env.PORT ?? 9000;
  return `http://127.0.0.1:${port}`;
}
