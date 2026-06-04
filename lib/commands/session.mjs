// ── Session commands ──────────────────────────────────────────────────────────

import { requireEnvId } from "../env.mjs";
import { getAcpUrl, acpCall } from "../acp.mjs";
import { green, dim, bold } from "../ui.mjs";
import { printAcpSession } from "../ui.mjs";

export const sessionCommands = {

  "session:create": async (args) => {
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) {
      throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    }
    requireEnvId(args);
    const acpUrl = getAcpUrl(args);
    const { sessionId, hasHistory } = await acpCall(acpUrl, "session/new", {
      cwd: "/", mcpServers: [],
    });
    console.log(green("✅ Session created:"));
    printAcpSession({
      sessionId,
      title: args.title ?? "",
      _meta: { status: "idle", createdAt: Math.floor(Date.now() / 1000) },
    });
    if (hasHistory) console.log(dim("  (resumed existing session — has history)"));
  },

  "session:list": async (args) => {
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) {
      throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    }
    requireEnvId(args);
    const acpUrl = getAcpUrl(args);
    const { sessions } = await acpCall(acpUrl, "session/list", {});
    if (!sessions?.length) return console.log(dim("No sessions found."));
    console.log(bold(`Sessions (${sessions.length}):`));
    sessions.forEach(printAcpSession);
  },

  "session:get": async (args) => {
    if (!args.id) throw new Error("-i / --id is required (session ID)");
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) {
      throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    }
    requireEnvId(args);
    const acpUrl = getAcpUrl(args);
    const result = await acpCall(acpUrl, "session/load", {
      sessionId: args.id, cwd: "/", mcpServers: [], replay: false,
    });
    printAcpSession({ sessionId: result.sessionId, title: "" });
  },

  "session:delete": async (args) => {
    if (!args.id) throw new Error("-i / --id is required (session ID)");
    if (!args.agent && !process.env.CLOUDBASE_AGENT_ID) {
      throw new Error("-a / --agent is required (or set CLOUDBASE_AGENT_ID)");
    }
    requireEnvId(args);
    const acpUrl = getAcpUrl(args);
    const { deleted } = await acpCall(acpUrl, "session/delete", { sessionId: args.id });
    if (deleted) console.log(green(`✅ Session ${args.id} deleted.`));
    else console.log(dim(`(session ${args.id} was already gone)`));
  },
};
