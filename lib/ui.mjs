// ── Pretty printers ─────────────────────────────────────────────────────────

export const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
export const green  = (s) => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
export const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
export const red    = (s) => `\x1b[31m${s}\x1b[0m`;
export const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

export function printAgent(a) {
  console.log(`  ${bold(a.id)}`);
  console.log(`    name   : ${a.name}`);
  console.log(`    model  : ${a.model}`);
  console.log(`    system : ${dim(a.system?.slice(0, 80) ?? "(none)")}`);
  console.log(`    created: ${dim(new Date(a.created_at * 1000).toLocaleString())}`);
}

export function printSession(s) {
  console.log(`  ${bold(s.id)}`);
  console.log(`    title  : ${s.title || dim("(untitled)")}`);
  console.log(`    agent  : ${s.agent}`);
  console.log(`    status : ${s.status === "idle" ? green(s.status) : s.status === "running" ? yellow(s.status) : red(s.status)}`);
  console.log(`    created: ${dim(new Date(s.created_at * 1000).toLocaleString())}`);
}

// ACP session/list returns { sessionId, title, updatedAt, _meta: { status, createdAt } }
// Timestamps are MILLISECONDS in the kernel (driver upserts mtime: Date.now()),
// unlike the legacy REST shape which used seconds. Detect and pass through ms
// directly; treat anything < 1e12 as seconds for back-compat with mocks/tests.
export function printAcpSession(s) {
  const status = s._meta?.status ?? "idle";
  const rawCreated = s._meta?.createdAt ?? s.updatedAt ?? 0;
  const rawUpdated = s.updatedAt ?? rawCreated;
  const toMs = (t) => (t > 1e12 ? t : t * 1000);
  const createdAt = toMs(rawCreated);
  const updatedAt = toMs(rawUpdated);
  console.log(`  ${bold(s.sessionId)}`);
  console.log(`    title  : ${s.title || dim("(untitled)")}`);
  console.log(`    status : ${status === "idle" ? green(status) : status === "running" ? yellow(status) : dim(status)}`);
  if (createdAt) console.log(`    created: ${dim(new Date(createdAt).toLocaleString())}`);
  if (updatedAt && updatedAt !== createdAt) console.log(`    updated: ${dim(new Date(updatedAt).toLocaleString())}`);
}

export function printEnv(e) {
  console.log(`  ${bold(e.id)}`);
  console.log(`    name   : ${e.name}`);
  console.log(`    type   : ${e.config?.type ?? "-"}`);
  console.log(`    network: ${e.config?.networking?.type ?? "-"}`);
}

// ── Event renderer (for chat / run) ──────────────────────────────────────────

export function renderEvent(event) {
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
