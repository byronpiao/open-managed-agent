/**
 * Minimal JSON-RPC MCP HTTP handler for managed-agent-client (tools/list, tools/call).
 */

import type { Request, Response } from "express";
import {
  buildManagedAgentClientTools,
  customToolsToMcpToolSchemas,
} from "../deploy.js";
import type { AgentConfig } from "../../config.js";
import { invokeClientToolFromSandbox } from "./client-tool-bridge.js";
import { rpcError, rpcResult } from "../../acp-shared.js";
import { harnessLog } from "../observability/logging.js";
import { withActiveSpan } from "../telemetry/telemetry.js";

export function mountHarnessMcpGateway(app: import("express").Express, config: AgentConfig) {
  const handler = async (req: Request, res: Response) => {
    const body = req.body as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (!body?.jsonrpc || body.jsonrpc !== "2.0") {
      return res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC"));
    }
    const { id, method, params = {} } = body;
    const sessionId = String(
      params.sessionId ?? req.headers["x-acp-session-id"] ?? req.query.sessionId ?? "",
    );
    if (!sessionId) {
      return res.status(400).json(rpcError(id, -32602, "sessionId required (param or X-Acp-Session-Id)"));
    }

    try {
      switch (method) {
        case "initialize":
          return res.json(
            rpcResult(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "managed-agent-client", version: "0.1.0" },
            }),
          );

        case "tools/list": {
          const tools = customToolsToMcpToolSchemas(buildManagedAgentClientTools(config));
          return res.json(
            rpcResult(id, {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            }),
          );
        }

        case "tools/call": {
          const name = String(params.name ?? "");
          const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
          const mcpLog = harnessLog({
            lane: "mcp",
            operation: "mcp.call",
            acpSessionId: sessionId,
            toolName: name,
          });
          mcpLog.phase("mcp.call");
          const startedAt = Date.now();
          try {
            const out = await withActiveSpan(
              `bridge.${name}`,
              { acpSessionId: sessionId, tool: name },
              async () =>
                invokeClientToolFromSandbox({
                  acpSessionId: sessionId,
                  toolName: name,
                  input: toolArgs,
                }),
            );
            mcpLog.emit({ status: "ok", durationMs: Date.now() - startedAt });
            return res.json(
              rpcResult(id, {
                content: [{ type: "text", text: String(out.content ?? "") }],
                isError: out.isError ?? false,
              }),
            );
          } catch (err) {
            mcpLog.error(err);
            mcpLog.emit({ status: "error", durationMs: Date.now() - startedAt });
            throw err;
          }
        }

        default:
          return res.status(404).json(rpcError(id, -32601, `Method not found: ${method}`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json(rpcError(id, -32000, message));
    }
  };

  app.post("/internal/harness/mcp", handler);
  harnessLog({ lane: "mcp", operation: "mount" }).emit({ status: "ok" });
}
