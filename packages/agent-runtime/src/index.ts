/**
 * OpenManagedAgent — Runtime entry.
 *
 * 部署方式：
 *   tcb agent create --name my-agent --code ./packages/agent-runtime -e $ENV_ID
 *
 * 配置方式：
 *   1. AGENT_CONFIG / AGENT_CONFIG_B64 环境变量（magent agent:update 写入）
 *   2. agent.yaml 文件（随代码部署）
 *   3. 单独环境变量 AGENT_MODEL / AGENT_SYSTEM / AGENT_NAME（向后兼容）
 *
 * 暴露端点：
 *   POST /acp                              ACP JSON-RPC 2.0
 *   POST /v1/aibot/bots/:botId/acp         ACP via gateway proxy
 *   GET  /healthz                          Health check
 */

import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { createRequire } from "module";
import { mountAcpEndpoint } from "./acp-endpoint.js";
import { loadAgentConfig } from "./config.js";

const port = Number(process.env.PORT ?? 9000);
const nodeRequire = createRequire(import.meta.url);

async function main() {
  const config = await loadAgentConfig();

  console.log(`[Agent] Name: ${config.name}`);
  console.log(`[Agent] Model: ${config.model}`);
  console.log(`[Agent] Tools: ${config.tools?.length ?? 0} configured`);
  console.log(`[Agent] MCP Servers: ${config.mcp_servers?.length ?? 0} configured`);
  console.log(`[Agent] Skills: ${config.skills?.length ?? 0} configured`);

  const app = express();
  app.use(cors());
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: config.name, model: config.model });
  });

  // Diagnostic: try to locate + spawn the platform-specific Claude Code
  // binary the SDK uses. Captures stderr/stdout so we can see *why* the
  // child process exits 1 in opaque environments like CloudBase Cloud Run.
  app.get("/debug/spawn-claude", async (_req, res) => {
    const fs = await import("fs");
    const out: Record<string, unknown> = {
      platform: process.platform,
      arch: process.arch,
      libc: ((process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime) ?? null,
      cwd: process.cwd(),
      home: process.env.HOME,
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
      tmpdir: process.env.TMPDIR ?? "/tmp",
      nodeVersion: process.version,
    };

    // What's actually present under node_modules/@anthropic-ai/?
    try {
      out.anthropicDir = fs.readdirSync("/app/node_modules/@anthropic-ai");
    } catch (e) {
      out.anthropicDirError = (e as Error).message;
    }

    // Did npm leave a build log we can read?
    try {
      const candidates = [
        "/app/node_modules/.package-lock.json",
        "/app/package-lock.json",
      ];
      const packageLocks: Record<string, string> = {};
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          packageLocks[p] = fs.readFileSync(p, "utf8").length + " bytes";
        }
      }
      if (Object.keys(packageLocks).length > 0) {
        out.packageLocks = packageLocks;
      }
    } catch {/* ignore */}

    const candidates = [
      "@anthropic-ai/claude-agent-sdk-linux-x64",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-arm64",
      "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    ];
    let resolved: string | null = null;
    const resolveErrors: Record<string, string> = {};
    // Prefer resolving the package's package.json (works without a `main`
    // field), then derive the binary path from it. The SDK uses a similar
    // trick — see sdk.mjs around line 843298.
    for (const pkg of candidates) {
      try {
        const pkgJson = nodeRequire.resolve(`${pkg}/package.json`);
        const dir = pkgJson.replace(/\/package\.json$/, "");
        const bin = `${dir}/claude`;
        if (fs.existsSync(bin)) {
          resolved = bin;
          out.resolvedPkg = pkg;
          out.resolvedPath = resolved;
          out.binaryStat = (() => {
            const st = fs.statSync(bin);
            return { size: st.size, mode: st.mode.toString(8), mtime: st.mtime };
          })();
          break;
        } else {
          resolveErrors[pkg] = `package.json found but ${bin} missing`;
        }
      } catch (e) {
        resolveErrors[pkg] = (e as Error).message.split("\n")[0];
      }
    }
    out.resolveErrors = resolveErrors;

    if (!resolved) {
      res.json({ ok: false, error: "no-cli-resolvable", ...out });
      return;
    }

    const child = spawn(resolved, ["--version"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    const exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: string } =
      await new Promise((resolve) => {
        child.on("error", (err) => resolve({ code: null, signal: null, spawnError: err.message }));
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });

    // Second probe: spawn the binary the way the SDK actually does, with
    // stdin pipe + the same env vars + a real prompt. This catches issues
    // (missing libs, broken interactive init) that --version alone misses.
    const child2 = spawn(
      resolved,
      ["--print", "hi", "--model", "mimo-v2.5-pro", "--output-format", "json"],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout2 = "";
    let stderr2 = "";
    child2.stdout.on("data", (c) => (stdout2 += String(c)));
    child2.stderr.on("data", (c) => (stderr2 += String(c)));
    const exit2 = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>((resolve) => {
      child2.on("error", (err) => resolve({ code: null, signal: null, spawnError: err.message }));
      child2.on("exit", (code, signal) => resolve({ code, signal }));
      // Don't hang forever
      setTimeout(() => {
        try { child2.kill("SIGTERM"); } catch {}
        resolve({ code: -1, signal: null, spawnError: "probe timeout (15s)" });
      }, 15000);
    });

    // Third probe: spawn the binary the way the SDK does — stream-json IO,
    // stdin pipe, settingSources empty. This is the closest we can get to
    // the actual failing path without reimplementing the SDK's protocol.
    const child3 = spawn(
      resolved,
      [
        "--output-format", "stream-json",
        "--verbose",
        "--input-format", "stream-json",
        "--max-turns", "1",
        "--model", "mimo-v2.5-pro",
        "--permission-mode", "bypassPermissions",
      ],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout3 = "";
    let stderr3 = "";
    child3.stdout.on("data", (c) => (stdout3 += String(c)));
    child3.stderr.on("data", (c) => (stderr3 += String(c)));
    // Write the same control_request + user message the SDK writes.
    child3.stdin.write(JSON.stringify({
      request_id: "probe-1",
      type: "control_request",
      request: { subtype: "initialize", systemPrompt: { type: "default" } },
    }) + "\n");
    child3.stdin.write(JSON.stringify({
      type: "user",
      session_id: "",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      parent_tool_use_id: null,
    }) + "\n");
    const exit3 = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>((resolve) => {
      child3.on("error", (err) => resolve({ code: null, signal: null, spawnError: err.message }));
      child3.on("exit", (code, signal) => resolve({ code, signal }));
      setTimeout(() => {
        try { child3.kill("SIGTERM"); } catch {}
        resolve({ code: -1, signal: null, spawnError: "stream probe timeout (20s)" });
      }, 20000);
    });

    // Third probe: actually use the SDK's query() to run a turn — this is
    // the real path the kernel uses, including stdin-piped streaming mode,
    // MCP config, settingSources etc. Captures the full failure mode if
    // the SDK is the layer that fails (rather than the binary itself).
    type SdkResult = {
      ok: boolean;
      messages: Array<Record<string, unknown>>;
      error?: string;
      stderr?: string;
    };
    let sdkProbe: SdkResult;
    try {
      // Force stderr capture: DEBUG_CLAUDE_AGENT_SDK=1 makes the SDK pipe
      // the binary's stderr instead of swallowing it.
      process.env.DEBUG_CLAUDE_AGENT_SDK = "1";
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const sdkStderr: string[] = [];
      const stream = query({
        prompt: "hi",
        options: {
          model: "mimo-v2.5-pro",
          permissionMode: "bypassPermissions",
          settingSources: [],
          maxTurns: 1,
          stderr: (chunk: string) => { sdkStderr.push(chunk); },
        },
      });
      const messages: Array<Record<string, unknown>> = [];
      const sdkPromise = (async () => {
        for await (const m of stream as AsyncIterable<Record<string, unknown>>) {
          messages.push({
            type: m.type,
            ...(typeof m.subtype === "string" ? { subtype: m.subtype } : {}),
            ...(typeof m.is_error === "boolean" ? { is_error: m.is_error } : {}),
            ...(typeof m.result === "string" ? { result: String(m.result).slice(0, 400) } : {}),
            ...(m.message && typeof (m.message as { content?: unknown }).content !== "undefined"
              ? { content: JSON.stringify((m.message as { content?: unknown }).content).slice(0, 400) }
              : {}),
          });
          if (m.type === "result") break;
        }
        return null;
      })();
      const timeout = new Promise<Error>((res) =>
        setTimeout(() => res(new Error("sdk probe timeout (20s)")), 20000),
      );
      const raced = await Promise.race([sdkPromise, timeout]);
      sdkProbe = raced instanceof Error
        ? { ok: false, messages, error: raced.message, stderr: sdkStderr.join("").slice(0, 6000) } as SdkResult
        : { ok: true, messages, stderr: sdkStderr.join("").slice(0, 6000) } as SdkResult;
    } catch (err) {
      sdkProbe = {
        ok: false,
        messages: [],
        error:
          (err as Error).stack ?? (err as Error).message ?? String(err),
      };
    }

    res.json({
      ok: exit.code === 0,
      ...out,
      versionProbe: {
        exit,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
      },
      printProbe: {
        exit: exit2,
        stdout: stdout2.slice(0, 4000),
        stderr: stderr2.slice(0, 4000),
      },
      streamProbe: {
        exit: exit3,
        stdout: stdout3.slice(0, 4000),
        stderr: stderr3.slice(0, 4000),
      },
      sdkProbe,
    });
  });

  mountAcpEndpoint(app, config);

  app.listen(port, () => {
    console.log(`OpenManagedAgent Runtime listening on :${port}`);
    console.log(`  ACP   : POST /acp, POST /v1/aibot/bots/:botId/acp`);
    console.log(`  Health: GET  /healthz`);
    console.log(`  Debug : GET  /debug/spawn-claude`);
    console.log(`  Model : ${config.model}`);
  });
}

main().catch((err) => {
  console.error("[Fatal] Failed to start agent runtime:", err);
  process.exit(1);
});
