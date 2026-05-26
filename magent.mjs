#!/usr/bin/env node
/**
 * magent - OpenManagedAgent CLI
 *
 * Usage:
 *   magent <command> [options]
 *
 * Commands:
 *   login                                     Login to CloudBase (proxied to tcb)
 *
 *   agent:create   -n <name> [options]
 *   agent:list     [-e <envId>]
 *   agent:get      [-i <agent-id>]
 *   agent:delete   [-i <agent-id>]
 *   agent:update   [-i <id>] [options]
 *
 *   env:list                                  List CloudBase environments (proxied to tcb)
 *
 *   session:create -a <agent-id> [--title <title>]
 *   session:list
 *   session:get    -i <session-id>
 *   session:delete -i <session-id>
 *
 *   chat           -s <session-id> -m <text>
 *   run            -a <agent-id>   -m <text>  (one-shot: create session + chat + stream)
 *   repl           -a <agent-id>              (interactive REPL)
 *
 *   <anything else>                           Transparently proxied to tcb CLI
 */

import { createInterface } from "readline";
import { execSync, spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Load .env file ──────────────────────────────────────────────────────────
const envFile = new URL(".env", import.meta.url).pathname;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val; // don't override existing
  }
}

const BASE_URL = process.env.CLOUDBASE_SERVER_URL ?? "http://localhost:3000";

// ── tcb bin resolver ─────────────────────────────────────────────────────────
// Uses spawnSync (inherits parent PATH, nvm-safe) to locate tcb.
// Falls back to bundled node_modules/.bin/tcb, then bare "tcb".

let _tcbBin = null;
function getTcbBin() {
  if (_tcbBin) return _tcbBin;
  // spawnSync inherits process.env.PATH directly — works with nvm
  const probe = spawnSync("tcb", ["--version"], { encoding: "utf-8", stdio: "ignore" });
  if (!probe.error) return (_tcbBin = "tcb");
  const bundled = new URL("./node_modules/.bin/tcb", import.meta.url).pathname;
  if (existsSync(bundled)) return (_tcbBin = bundled);
  return (_tcbBin = "tcb"); // will error naturally if missing
}

// ── runTcb — spawnSync wrapper (no shell, captures output) ──────────────────
// Replaces execSync(`"${tcb}" ...`) so nvm PATH is always honoured.

function runTcb(args, opts = {}) {
  const { input, allowFail, ...rest } = opts;
  const result = spawnSync(getTcbBin(), args, {
    encoding: "utf-8",
    env:      process.env,
    stdio:    input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input,
    ...rest,
  });
  if (result.error) throw result.error;
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  if (!allowFail && result.status !== 0) {
    throw new Error(out.trim() || `tcb ${args[0]} exited with code ${result.status}`);
  }
  return result.stdout ?? "";
}

// ── Short-flag map ────────────────────────────────────────────────────────────

const SHORT_FLAGS = {
  e: "env",
  a: "agent",
  i: "id",
  m: "message",
  s: "session",
  f: "file",
  n: "name",
};

// ── Arg parser (supports --key value and -k value) ────────────────────────────

function parseFlags(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const val = next && !next.startsWith("-") ? argv[++i] : true;
      args[key] = val;
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = SHORT_FLAGS[arg[1]] ?? arg[1];
      const next = argv[i + 1];
      const val = next && !next.startsWith("-") ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

// ── requireEnvId helper ───────────────────────────────────────────────────────
// Exits with an error + tcb env:list hint when no envId can be found.

function requireEnvId(args) {
  const envId = args.env ?? process.env.CLOUDBASE_ENV_ID ?? "";
  if (!envId) {
    console.error(red("Error: -e <envId> is required (or set CLOUDBASE_ENV_ID)"));
    console.error(dim("\nAvailable CloudBase environments:"));
    spawnSync(getTcbBin(), ["env:list"], { stdio: "inherit" });
    process.exit(1);
  }
  return envId;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
// Headers are computed dynamically so that early env propagation is reflected.

function getHeaders() {
  const envId = process.env.CLOUDBASE_ENV_ID ?? "";
  return {
    "Content-Type": "application/json",
    ...(envId ? { "X-CloudBase-Env-Id": envId } : {}),
  };
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const get  = (path)       => api("GET",    path);
const post = (path, body) => api("POST",   path, body);
const del  = (path)       => api("DELETE", path);

// ── SSE stream helper ─────────────────────────────────────────────────────────

async function* streamEvents(sessionId) {
  const envId = process.env.CLOUDBASE_ENV_ID ?? "";
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/events/stream`, {
    headers: {
      Accept: "text/event-stream",
      ...(envId ? { "X-CloudBase-Env-Id": envId } : {}),
    },
  });
  if (!res.ok || !res.body) throw new Error(`Stream connect failed: ${res.status}`);

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

// ── Alias generation ──────────────────────────────────────────────────────────
// tcb requires alias to be ASCII; convert Unicode/CJK names to a stable slug.
function toAlias(name) {
  const ascii = name
    .toLowerCase()
    .replace(/[一-鿿㐀-䶿]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const hasCJK = /[一-鿿㐀-䶿]/.test(name);
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
  const suffix = (hash >>> 0).toString(36).slice(0, 6);

  const base = ascii || "agent";
  return hasCJK ? `${base ? base + "-" : ""}${suffix}` : base;
}

// ── Pretty printers ───────────────────────────────────────────────────────────

const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

function printAgent(a) {
  console.log(`  ${bold(a.id)}`);
  console.log(`    name   : ${a.name}`);
  console.log(`    model  : ${a.model}`);
  console.log(`    system : ${dim(a.system?.slice(0, 80) ?? "(none)")}`);
  console.log(`    created: ${dim(new Date(a.created_at * 1000).toLocaleString())}`);
}

function printSession(s) {
  console.log(`  ${bold(s.id)}`);
  console.log(`    title  : ${s.title || dim("(untitled)")}`);
  console.log(`    agent  : ${s.agent}`);
  console.log(`    status : ${s.status === "idle" ? green(s.status) : s.status === "running" ? yellow(s.status) : red(s.status)}`);
  console.log(`    created: ${dim(new Date(s.created_at * 1000).toLocaleString())}`);
}

function printEnv(e) {
  console.log(`  ${bold(e.id)}`);
  console.log(`    name   : ${e.name}`);
  console.log(`    type   : ${e.config?.type ?? "-"}`);
  console.log(`    network: ${e.config?.networking?.type ?? "-"}`);
}

// ── Event renderer (for chat / run) ──────────────────────────────────────────

function renderEvent(event) {
  switch (event.type) {
    case "agent.thinking":
      console.log(dim(`\n💭 ${event.thinking}`));
      break;

    case "agent.message":
      for (const block of event.content ?? []) {
        if (block.type === "text") process.stdout.write(block.text ?? "");
      }
      process.stdout.write("\n");
      break;

    case "agent.tool_use":
      console.log(yellow(`\n🔧 Tool: ${event.tool_name}`));
      console.log(dim(`   ${JSON.stringify(event.input)}`));
      break;

    case "agent.tool_result":
      if (event.is_error) {
        console.log(red(`   ❌ ${event.content?.[0]?.text ?? "error"}`));
      } else {
        console.log(dim(`   ✓ ${event.content?.[0]?.text?.slice(0, 120) ?? ""}`));
      }
      break;

    case "agent.custom_tool_use":
      console.log(cyan(`\n🔌 Custom tool: ${event.tool_name} (tool_use_id: ${event.tool_use_id})`));
      console.log(dim(`   ${JSON.stringify(event.input)}`));
      break;

    case "session.status_idle":
      console.log(green("\n✅ Done."));
      break;

    case "session.status_terminated":
      console.log(red(`\n❌ Terminated: ${event.reason ?? "unknown"}`));
      break;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
// Each handler receives (args, rest) where:
//   args = parsed key/value flags object
//   rest = raw argv tokens after the command (for passthrough)

const COMMANDS = {

  // ─── Login (proxy to tcb) ─────────────────────────────────────────────────

  "login": async (args, rest) => {
    spawnSync(getTcbBin(), ["login", ...rest], { stdio: "inherit" });
  },

  // ─── Agent ────────────────────────────────────────────────────────────────

  "agent:create": async (args) => {
    const { name, model, system } = args;
    if (!name) throw new Error("-n / --name is required");
    const envId   = requireEnvId(args);
    const code    = args.code    ?? "./packages/agent-runtime";
    const runtime = args.runtime ?? "Nodejs20.19";

    // Build initial config
    const config = {
      name,
      model:  model  ?? "hunyuan-t1-latest",
      system: system ?? "You are a helpful assistant.",
    };

    // If --file provided, load full config from YAML/JSON
    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        let fileConfig;
        if (content.trim().startsWith("{")) {
          fileConfig = JSON.parse(content);
        } else {
          const { parse } = await import("yaml");
          fileConfig = parse(content);
        }
        Object.assign(config, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file: ${err.message}`);
      }
    }

    // Explicit CLI args override file config
    if (name)   config.name   = name;
    if (model)  config.model  = model;
    if (system) config.system = system;

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");
    const envVars   = `CLOUDBASE_ENV_ID=${envId},AGENT_CONFIG_B64=${configB64}`;

    console.log(bold("Creating agent..."));
    console.log(dim(`  name:    ${config.name}`));
    console.log(dim(`  model:   ${config.model}`));
    console.log(dim(`  code:    ${code}`));
    console.log(dim(`  runtime: ${runtime}`));
    console.log();

    // Prepare deploy directory: copy build + install deps
    const deployDir = resolve(code, ".deploy");
    try {
      execSync(`rm -rf "${deployDir}" && mkdir -p "${deployDir}"`, { encoding: "utf-8" });

      const filesToCopy = ["dist", "package.json", "scf_bootstrap"];
      if (existsSync(resolve(code, "agent.yaml"))) filesToCopy.push("agent.yaml");
      if (existsSync(resolve(code, "skills")))     filesToCopy.push("skills");
      for (const f of filesToCopy) {
        const src = resolve(code, f);
        if (existsSync(src)) execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
      }

      process.stdout.write(dim("  Installing dependencies... "));
      execSync("npm install --production --silent 2>/dev/null", {
        cwd: deployDir, encoding: "utf-8", timeout: 120000,
      });
      console.log(green("OK"));
    } catch (err) {
      console.log(yellow(`  Warning: deploy prep failed, using code dir directly: ${err.message?.split("\n")[0]}`));
    }

    const actualCode = existsSync(resolve(deployDir, "node_modules")) ? deployDir : code;

    try {
      const alias  = toAlias(name);
      const raw    = runTcb([
        "agent", "create",
        "--name",        alias,
        "--runtime",     runtime,
        "--code",        actualCode,
        "--timeout",     "7200",
        "--memory-size", "256",
        "--env",         envVars,
        "-e",            envId,
        "--json",
      ], { timeout: 300000 });
      const data   = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      if (data.data?.agentId) {
        console.log(green(`✅ Agent created: ${data.data.agentId}`));
        console.log(dim(`  name:    ${name}`));
        console.log(dim(`  runtime: ${runtime}`));
        console.log();
        console.log("Next steps:");
        console.log(dim(`  1. Wait for ready: magent agent:get -i ${data.data.agentId} -e ${envId}`));
        console.log(dim(`  2. Update config:  magent agent:update -i ${data.data.agentId} -f agent.yaml -e ${envId}`));
        console.log(dim(`  3. Start chatting: magent run -a ${data.data.agentId} -m "Hello"`));
      } else {
        console.log(yellow("Agent creation submitted. Check status with: magent agent:list"));
      }
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
    } catch (err) {
      try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
      throw new Error(`Failed to create agent: ${err.message}`);
    }
  },

  "agent:list": async (args) => {
    const envId = requireEnvId(args);
    const result = runTcb(["agent", "list", "-e", envId], { timeout: 30000 });
    console.log(result);
  },

  "agent:get": async (args) => {
    const agentId = args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
    if (!agentId) throw new Error("-i / --id is required (or set CLOUDBASE_AGENT_ID)");
    const envId  = requireEnvId(args);
    const result = runTcb(["agent", "detail", agentId, "-e", envId], { timeout: 30000 });
    console.log(result);
  },

  "agent:delete": async (args) => {
    const agentId = args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
    if (!agentId) throw new Error("-i / --id is required (or set CLOUDBASE_AGENT_ID)");
    const envId = requireEnvId(args);
    runTcb(["agent", "delete", agentId, "-e", envId], { input: "Y\n", timeout: 60000 });
    console.log(green(`✅ Agent ${agentId} deleted.`));
  },

  // ─── Agent Update (config via env var) ───────────────────────────────────

  "agent:update": async (args) => {
    const agentId = args.id ?? process.env.CLOUDBASE_AGENT_ID ?? "";
    if (!agentId) throw new Error("-i / --id is required (or set CLOUDBASE_AGENT_ID)");
    const envId  = requireEnvId(args);
    const apiKey = args["api-key"] ?? process.env.CLOUDBASE_ACCESS_KEY ?? "";

    // Fetch current config from running agent
    let currentConfig = {};
    const agentUrl = args.url ??
      `https://${envId}.api.tcloudbasegateway.com/v1/aibot/bots/${agentId}/acp`;

    try {
      process.stdout.write(dim("Fetching current config... "));
      const initRes  = await fetch(agentUrl, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "magent", version: "0.1.0" } },
        }),
      });
      const initData = await initRes.json();
      if (initData.result?.agentConfig) {
        currentConfig = initData.result.agentConfig;
        if (initData.result.agentInfo?.name)  currentConfig.name        = initData.result.agentInfo.name;
        if (initData.result.agentInfo?.title) currentConfig.description = initData.result.agentInfo.title;
      }
      console.log(green("OK"));
    } catch {
      console.log(yellow("(could not fetch, starting fresh)"));
    }

    // Collect updates
    const updates = {};
    if (args.name)            updates.name        = args.name;
    if (args.model)           updates.model       = args.model;
    if (args.system)          updates.system      = args.system;
    if (args.description)     updates.description = args.description;
    if (args.tools)           updates.tools       = JSON.parse(args.tools);
    if (args["mcp-servers"])  updates.mcp_servers = JSON.parse(args["mcp-servers"]);
    if (args.skills)          updates.skills      = JSON.parse(args.skills);

    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
        let fileConfig;
        if (content.trim().startsWith("{")) {
          fileConfig = JSON.parse(content);
        } else {
          const { parse } = await import("yaml");
          fileConfig = parse(content);
        }
        Object.assign(updates, fileConfig);
      } catch (err) {
        throw new Error(`Failed to load config file ${args.file}: ${err.message}`);
      }
    }

    if (Object.keys(updates).length === 0) {
      console.log(yellow("No updates specified. Use --system, --model, --tools, -f <file>, etc."));
      return;
    }

    const merged = { ...currentConfig, ...updates };
    if (!merged.name)   merged.name   = "open-managed-agent";
    if (!merged.model)  merged.model  = "hunyuan-t1-latest";
    if (!merged.system) merged.system = "You are a helpful assistant.";

    const configJson = JSON.stringify(merged);

    console.log(dim(`\nUpdated config (${configJson.length} bytes):`));
    console.log(dim(`  name:        ${merged.name}`));
    console.log(dim(`  model:       ${merged.model}`));
    console.log(dim(`  system:      ${merged.system?.slice(0, 60)}${merged.system?.length > 60 ? "..." : ""}`));
    console.log(dim(`  tools:       ${merged.tools?.length ?? 0} items`));
    console.log(dim(`  mcp_servers: ${merged.mcp_servers?.length ?? 0} items`));
    console.log(dim(`  skills:      ${merged.skills?.length ?? 0} items`));
    console.log();

    process.stdout.write("Applying via tcb agent update... ");
    try {
      const configBase64 = Buffer.from(configJson).toString("base64");
      const envStr       = `CLOUDBASE_ENV_ID=${envId},AGENT_CONFIG_B64=${configBase64}`;
      const raw          = runTcb(
        ["agent", "update", agentId, "--env", envStr, "-e", envId, "--json"],
        { timeout: 120000 },
      );
      const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      console.log(green("OK"));
      if (data.data?.elapsedTime) {
        console.log(dim(`  Elapsed: ${Math.round(data.data.elapsedTime / 1000)}s`));
      }
      console.log(green(`\n✅ Agent ${agentId} updated successfully.`));
    } catch (err) {
      throw new Error(`tcb agent update failed: ${err.message}`);
    }
  },

  // ─── Environment ──────────────────────────────────────────────────────────
  // env:list proxies to `tcb env:list` (CloudBase environments, not SDK concept)

  "env:list": async (args, rest) => {
    spawnSync(getTcbBin(), ["env:list", ...rest], { stdio: "inherit" });
  },

  "env:create": async (args) => {
    if (!args.name) throw new Error("--name is required");
    const env = await post("/environments", {
      name:   args.name,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    console.log(green("✅ Environment created:"));
    printEnv(env);
  },

  "env:delete": async (args) => {
    if (!args.id) throw new Error("-i / --id is required");
    await del(`/environments/${args.id}`);
    console.log(green(`✅ Environment ${args.id} deleted.`));
  },

  // ─── Session ──────────────────────────────────────────────────────────────

  "session:create": async (args) => {
    if (!args.agent) throw new Error("-a / --agent is required");
    const session = await post("/sessions", {
      agent:          args.agent,
      environment_id: args.env ?? undefined,
      title:          args.title ?? "",
    });
    console.log(green("✅ Session created:"));
    printSession(session);
  },

  "session:list": async () => {
    const { data } = await get("/sessions");
    if (!data.length) return console.log(dim("No sessions found."));
    console.log(bold(`Sessions (${data.length}):`));
    data.forEach(printSession);
  },

  "session:get": async (args) => {
    if (!args.id) throw new Error("-i / --id is required");
    const session = await get(`/sessions/${args.id}`);
    printSession(session);
  },

  "session:delete": async (args) => {
    if (!args.id) throw new Error("-i / --id is required");
    await del(`/sessions/${args.id}`);
    console.log(green(`✅ Session ${args.id} deleted.`));
  },

  // ─── Chat (send message to existing session, stream response) ─────────────

  "chat": async (args) => {
    if (!args.session) throw new Error("-s / --session is required");
    if (!args.message) throw new Error("-m / --message is required");

    const streamGen = streamEvents(args.session);
    await post(`/sessions/${args.session}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: args.message }] }],
    });

    console.log(dim(`\n[Session ${args.session}]`));
    console.log(dim(`You: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const event of streamGen) {
      renderEvent(event);
    }
  },

  // ─── Run (one-shot: create session + send + stream + cleanup) ─────────────

  "run": async (args) => {
    if (!args.agent)   throw new Error("-a / --agent is required");
    if (!args.message) throw new Error("-m / --message is required");

    process.stdout.write(dim("Creating session... "));
    const session = await post("/sessions", {
      agent: args.agent,
      title: args.message.slice(0, 60),
    });
    console.log(dim(`${session.id}\n`));

    const streamGen = streamEvents(session.id);

    await post(`/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: args.message }] }],
    });

    console.log(dim(`You: ${args.message}\n`));
    console.log(bold("Agent:"));

    for await (const event of streamGen) {
      renderEvent(event);
      if (event.type === "session.status_idle" || event.type === "session.status_terminated") break;
    }

    if (!args["keep-session"]) {
      await del(`/sessions/${session.id}`).catch(() => {});
    } else {
      console.log(dim(`\nSession kept: ${session.id}`));
    }
  },

  // ─── Interactive REPL ─────────────────────────────────────────────────────

  "repl": async (args) => {
    if (!args.agent) throw new Error("-a / --agent is required");

    console.log(bold("\n🤖 OpenManagedAgent REPL"));
    console.log(dim("Type your message, press Enter. Ctrl+C to exit.\n"));

    process.stdout.write(dim("Creating session... "));
    const session = await post("/sessions", {
      agent: args.agent,
      title: "REPL session",
    });
    console.log(green(session.id));
    console.log();

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = () => {
      rl.question(cyan("You: "), async (message) => {
        if (!message.trim()) return ask();
        try {
          const streamGen = streamEvents(session.id);
          await post(`/sessions/${session.id}/events`, {
            events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
          });
          process.stdout.write(bold("\nAgent: "));
          for await (const event of streamGen) {
            renderEvent(event);
            if (event.type === "session.status_idle" || event.type === "session.status_terminated") break;
          }
          console.log();
        } catch (err) {
          console.error(red(`Error: ${err.message}`));
        }
        ask();
      });
    };

    rl.on("close", async () => {
      console.log(dim("\nCleaning up..."));
      await del(`/sessions/${session.id}`).catch(() => {});
      process.exit(0);
    });

    ask();
  },
};

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${bold("magent")} — OpenManagedAgent CLI

${bold("USAGE")}
  magent <command> [options]

${bold("ENVIRONMENT")}
  CLOUDBASE_ENV_ID       CloudBase environment ID (required for most commands)
  CLOUDBASE_AGENT_ID     Default agent ID (used when -i is omitted)
  CLOUDBASE_ACCESS_KEY   API key for agent access

${bold("AUTHENTICATION")}
  login [options]              Login to CloudBase
                               Proxied to: tcb login [options]

${bold("AGENT COMMANDS")}
  agent:create  -n <name> [options]           Create and deploy a new agent
    -n, --name <name>           Agent name (required)
        --model <model>         Model (default: hunyuan-t1-latest)
        --system <prompt>       System prompt
    -f, --file <path>           Load config from YAML/JSON file
        --code <path>           Code directory (default: ./packages/agent-runtime)
        --runtime <rt>          Runtime (default: Nodejs20.19)
    -e, --env <envId>           CloudBase environment ID

  agent:update  [-i <id>] [options]           Update agent config (~8s, no redeploy)
        --system <prompt>       Update system prompt
        --model <model>         Update model
    -n, --name <name>           Update agent name
        --tools <json>          Replace tools array (JSON)
        --mcp-servers <json>    Replace mcp_servers array (JSON)
        --skills <json>         Replace skills array (JSON)
    -f, --file <path>           Load full config from YAML/JSON file
    -e, --env <envId>           CloudBase environment ID

  agent:list    [-e <envId>]                  List all agents
  agent:get     [-i <id>]                     Get agent details
  agent:delete  [-i <id>]                     Delete an agent

${bold("CLOUDBASE ENVIRONMENT COMMANDS")}
  env:list [options]           List CloudBase environments
                               Proxied to: tcb env:list [options]

${bold("SESSION COMMANDS")}
  session:create  -a <agent-id> [--title <title>] [-e <env-id>]
  session:list
  session:get     -i <session-id>
  session:delete  -i <session-id>

${bold("MESSAGING COMMANDS")}
  run    -a <id> -m <text>                    One-shot (auto-creates and cleans up session)
           [--keep-session]                   Keep session after run
  chat   -s <id> -m <text>                    Send message to an existing session
  repl   -a <id>                              Interactive REPL

${bold("SHORT FLAGS")}
  -e <envId>     Same as --env       (CloudBase environment ID)
  -a <agentId>   Same as --agent
  -i <id>        Same as --id
  -m <text>      Same as --message
  -s <sessionId> Same as --session
  -f <path>      Same as --file
  -n <name>      Same as --name

${bold("TCB PASSTHROUGH")}
  Any command not listed above is forwarded transparently to the tcb CLI.
  Example:
    magent functions:list -e myenv   →  tcb functions:list -e myenv
    magent storage:list              →  tcb storage:list

${bold("EXAMPLES")}
  # First-time setup
  magent login
  magent env:list

  # Create and deploy an agent
  magent agent:create -n "Coder" --system "You are a coding assistant" -e my-env-id

  # List agents (error shows available envs if -e is missing)
  magent agent:list -e my-env-id

  # Update config without redeploying
  magent agent:update --system "You are a strict code reviewer" -e my-env-id
  magent agent:update -f ./agent.yaml -e my-env-id
  magent agent:update --model deepseek-v3.2 -e my-env-id

  # One-shot task
  magent run -a agent_xxx -m "Write a bubble sort in Python"

  # Multi-turn conversation
  magent session:create -a agent_xxx --title "My project"
  magent chat -s sess_xxx -m "Hello"
  magent chat -s sess_xxx -m "Now add error handling"

  # Interactive REPL
  magent repl -a agent_xxx
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...rest] = process.argv;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  // Parse flags — supports both --key value and -k value
  const args = parseFlags(rest);

  // Early env propagation: -e / --env → CLOUDBASE_ENV_ID so all downstream
  // code (including tcb commands) picks up the override automatically.
  if (args.env) {
    process.env.CLOUDBASE_ENV_ID = args.env;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    // Transparently proxy all unrecognized commands to the tcb CLI
    const result = spawnSync(getTcbBin(), [cmd, ...rest], { stdio: "inherit" });
    process.exit(result.status ?? 0);
    return;
  }

  try {
    await handler(args, rest);
  } catch (err) {
    console.error(red(`\nError: ${err.message}`));
    process.exit(1);
  }
}

main();
