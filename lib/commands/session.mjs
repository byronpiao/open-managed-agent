// ── Session commands ──────────────────────────────────────────────────────────

import { requireEnvId } from "../env.mjs";
import { getAcpUrl, acpCall, acpStream } from "../acp.mjs";
import { green, dim, bold } from "../ui.mjs";
import { printAcpSession } from "../ui.mjs";

// Extract a printable one-line preview from a history_page message.
// Handles both runtime shapes:
//   - Managed:  { role, content: "<text>", parts: [{type:"text",text}, …] }
//   - Harness:  { role, content: [{type:"text",text}, …] }  (standard ACP)
function formatHistoryMessage(msg) {
  const role = msg.role ?? "?";
  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  } else if (Array.isArray(msg.parts)) {
    text = msg.parts.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  const preview = text.length > 200 ? text.slice(0, 200) + "…" : text || dim("(no text)");
  return `${role}: ${preview}`;
}

async function handleSessionEvents(options) {
  if (!options.id) throw new Error("-i / --id is required (session ID)");
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) {
    throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  }
  requireEnvId(options);
  const acpUrl = getAcpUrl(options);
  const jsonl = options.format === "jsonl";
  // Mirrors Anthropic `sessions events list`. replay=true streams the
  // session transcript as `history_page` updates over ACP session/load.
  // Works for both runtimes:
  //   - Managed: kernel session history from FlexDB (oak_* collections)
  //   - Harness: sandbox transcript replayed via harness_sessions store
  let printed = false;
  for await (const item of acpStream(acpUrl, "session/load", {
    sessionId: options.id, cwd: "/", mcpServers: [], replay: true,
  })) {
    if (item.type !== "notification") continue;
    const update = item.data?.params?.update;
    if (update?.sessionUpdate !== "history_page") continue;
    const messages = update.messages ?? [];
    if (jsonl) {
      for (const msg of messages) console.log(JSON.stringify(msg));
    } else if (!messages.length) {
      console.log(dim("(session exists but has no events)"));
    } else {
      if (!printed) console.log(bold(`Events (${messages.length}):`));
      for (const msg of messages) console.log(`  ${formatHistoryMessage(msg)}`);
    }
    printed = true;
  }
  if (!printed && !jsonl) console.log(dim("(no events)"));
}

export { handleSessionEvents };

async function handleSessionCreate(options) {
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) {
    throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  }
  requireEnvId(options);
  const acpUrl = getAcpUrl(options);
  const { sessionId, hasHistory } = await acpCall(acpUrl, "session/new", {
    cwd: "/", mcpServers: [],
  });
  console.log(green("✅ Session created:"));
  printAcpSession({
    sessionId,
    title: options.title ?? "",
    _meta: { status: "idle", createdAt: Math.floor(Date.now() / 1000) },
  });
  if (hasHistory) console.log(dim("  (resumed existing session — has history)"));
}

async function handleSessionList(options) {
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) {
    throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  }
  requireEnvId(options);
  const acpUrl = getAcpUrl(options);
  const { sessions } = await acpCall(acpUrl, "session/list", {});
  if (!sessions?.length) return console.log(dim("No sessions found."));
  console.log(bold(`Sessions (${sessions.length}):`));
  sessions.forEach(printAcpSession);
}

async function handleSessionGet(options) {
  if (!options.id) throw new Error("-i / --id is required (session ID)");
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) {
    throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  }
  requireEnvId(options);
  const acpUrl = getAcpUrl(options);
  const result = await acpCall(acpUrl, "session/load", {
    sessionId: options.id, cwd: "/", mcpServers: [], replay: false,
  });
  printAcpSession({ sessionId: result.sessionId, title: "", _meta: result._meta });
  console.log(dim("  (use `session:events:list -i <id>` to view conversation history)"));
}

async function handleSessionDelete(options) {
  if (!options.id) throw new Error("-i / --id is required (session ID)");
  if (!options.agent && !process.env.CLOUDBASE_AGENT_ID) {
    throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
  }
  requireEnvId(options);
  const acpUrl = getAcpUrl(options);
  const { deleted } = await acpCall(acpUrl, "session/delete", { sessionId: options.id });
  if (deleted) console.log(green(`✅ Session ${options.id} deleted.`));
  else console.log(dim(`(session ${options.id} was already gone)`));
}

export function registerSessionCommands(program) {
  program.command("session:create")
    .description("Create a new session")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--title <title>", "Session title")
    .action(handleSessionCreate);

  program.command("session:list")
    .description("List sessions for an agent")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleSessionList);

  program.command("session:get")
    .description("Get session details")
    .option("-i, --id <id>", "Session ID (required)")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleSessionGet);

  program.command("session:delete")
    .description("Delete a session")
    .option("-i, --id <id>", "Session ID (required)")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleSessionDelete);

  program.command("session:events:list")
    .description("View session conversation history")
    .option("-i, --id <id>", "Session ID (required)")
    .option("-a, --agent <id>", "Agent ID (or set CLOUDBASE_AGENT_ID)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--format <format>", "Output format: text (default) or jsonl")
    .action(handleSessionEvents);
}
