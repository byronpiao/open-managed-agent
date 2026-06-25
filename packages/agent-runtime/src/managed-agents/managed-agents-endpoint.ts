/**
 * Mount Claude Managed Agents HTTP routes on Express (Web Request/Response bridge).
 * Routes: /v1/* and /v1/aibot/bots/:botId/v1/* (CloudBase gateway prefix).
 */

import express, { type Express, type Request as ExpressRequest, type Response } from "express";
import type { AgentConfig } from "../config.js";
import { harnessLog } from "../harness/logging.js";
import { deleteHarnessAcpSession } from "../harness/acp-endpoint.js";
import {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  createCmaHttpHandler,
} from "./vendor/cma-http.js";
import { createHarnessManagedAgentsDispatcher } from "./dispatch/harness-dispatcher.js";
import { setManagedAgentsDeploymentConfig } from "./deployment-config.js";
import { getManagedAgentsStore } from "./store/managed-agents-store-factory.js";

const GATEWAY_BOT_PREFIX = /^\/v1\/aibot\/bots\/[^/]+(\/v1\/[^?]*)/;

/** Strip CloudBase bot prefix so vendor handler sees canonical /v1/* paths. */
function managedAgentsHttpPath(originalUrl: string): string {
  const [path, query = ""] = originalUrl.split("?", 2);
  const match = path.match(GATEWAY_BOT_PREFIX);
  const normalized = match?.[1] ?? path;
  return query ? `${normalized}?${query}` : normalized;
}

function expressRequestToWebRequest(req: ExpressRequest): globalThis.Request {
  const host = req.get("host") ?? "localhost";
  const protocol = req.protocol ?? "http";
  const url = `${protocol}://${host}${managedAgentsHttpPath(req.originalUrl)}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  return new Request(url, init);
}

async function webResponseToExpress(webRes: globalThis.Response, res: Response): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });

  if (!webRes.body) {
    res.end();
    return;
  }

  const reader = webRes.body.getReader();
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(Buffer.from(value));
    }
  };
  await pump();
}

// In SCF (behind tcloudbasegateway), the gateway already sets CORS headers;
// duplicating them causes browsers to reject "multiple values".
const isBehindGateway = !!process.env.TENCENTCLOUD_RUNENV;

function corsHandler(req: ExpressRequest, res: Response, next: () => void) {
  if (!isBehindGateway) {
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      `Content-Type, Authorization, ${CMA_DEFAULT_BETA_HEADER_NAME}, X-CloudBase-Env-Id`,
    );
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function mountManagedAgentsEndpoint(app: Express, agentConfig: AgentConfig): void {
  setManagedAgentsDeploymentConfig(agentConfig);
  const store = getManagedAgentsStore();
  const dispatchDriverCommand = createHarnessManagedAgentsDispatcher({ config: agentConfig, store });

  const handler = createCmaHttpHandler({
    store,
    dispatchDriverCommand,
    betaHeader: {
      name: CMA_DEFAULT_BETA_HEADER_NAME,
      value: CMA_DEFAULT_BETA_HEADER_VALUE,
    },
    authorize: ({ request }) => {
      const auth = request.headers.get("authorization");
      if (auth?.startsWith("Bearer ")) return;
      return new Response(
        JSON.stringify({
          error: { code: "CMA_UNAUTHORIZED", message: "Authorization required." },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    },
  });

  const httpMiddleware = async (req: ExpressRequest, res: Response) => {
    try {
      const webReq = expressRequestToWebRequest(req);
      const webRes = await handler(webReq);
      await webResponseToExpress(webRes, res);
    } catch (err) {
      harnessLog({ lane: "managed_agents", operation: "http", path: req.path }).error(err);
      if (!res.headersSent) {
        res.status(500).json({
          error: { code: "CMA_INTERNAL_ERROR", message: (err as Error).message },
        });
      }
    }
  };

  const jsonParser = express.json({ limit: "10mb" });
  const mountRoutes = (prefix: string) => {
    const base = prefix ? `${prefix}/v1` : "/v1";
    app.use(`${base}/agents`, corsHandler, jsonParser, httpMiddleware);
    app.use(`${base}/environments`, corsHandler, jsonParser, httpMiddleware);

    app.delete(`${base}/sessions/:sessionId`, corsHandler, async (req, res) => {
      try {
        const sessionId = String(req.params.sessionId ?? "");
        if (!sessionId) {
          res.status(400).json({
            error: { code: "MANAGED_AGENTS_INVALID_REQUEST", message: "sessionId required" },
          });
          return;
        }
        const auth = req.headers.authorization;
        if (!auth?.startsWith("Bearer ")) {
          res.status(401).json({
            error: { code: "MANAGED_AGENTS_UNAUTHORIZED", message: "Authorization required." },
          });
          return;
        }
        const beta = req.headers[CMA_DEFAULT_BETA_HEADER_NAME.toLowerCase()];
        if (beta !== CMA_DEFAULT_BETA_HEADER_VALUE) {
          res.status(400).json({
            error: { code: "MANAGED_AGENTS_BETA_HEADER_REQUIRED", message: "Beta header required." },
          });
          return;
        }
        const session = await store.getSession(sessionId);
        if (!session) {
          res.status(404).json({
            error: { code: "MANAGED_AGENTS_SESSION_NOT_FOUND", message: "Session not found." },
          });
          return;
        }
        await deleteHarnessAcpSession({ sessionId }, agentConfig);
        await store.appendDriverEvent(sessionId, {
          kind: "run.completed",
          payload: { stopReason: "session_delete", reason: "client_delete" },
        });
        res.json({ data: { id: sessionId, deleted: true } });
      } catch (err) {
        harnessLog({ lane: "managed_agents", operation: "session.delete", path: req.path }).error(
          err,
        );
        res.status(500).json({
          error: { code: "MANAGED_AGENTS_INTERNAL_ERROR", message: (err as Error).message },
        });
      }
    });

    app.use(`${base}/sessions`, corsHandler, jsonParser, httpMiddleware);
  };

  mountRoutes("");
  mountRoutes("/v1/aibot/bots/:botId");

  harnessLog({ lane: "managed_agents", operation: "mount" }).emit({
    status: "ok",
    betaHeader: CMA_DEFAULT_BETA_HEADER_VALUE,
  });
}
