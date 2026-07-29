/**
 * HITL e2e 回归测试 —— 对运行中的 OAK runtime 跑四条 HITL 流并断言结果。
 *
 * 覆盖 stateless（SCF）请求边界下的 stop-and-resume：
 *   1. multi-turn      —— session transcript 持久化（跨请求记忆）
 *   2. bash approval   —— session/request_permission REQUEST → permission_decision → 真实执行
 *   3. client-tool     —— client/<Name> REQUEST → tool_result 回填 → 模型使用结果
 *   4. AskUserQuestion —— client/AskUserQuestion REQUEST → tool_result resume
 *
 * Kernel v0.1.0-beta.14+ envelopes every stream item: plain updates become
 * `session/update` notifications; HITL permission becomes a
 * `session/request_permission` JSON-RPC REQUEST; client tools (incl.
 * AskUserQuestion) become `client/<ToolName>` REQUESTs. This parser captures
 * BOTH the notification (`params.update`) and REQUEST forms so the test also
 * works against legacy bare-update kernels.
 *
 * 前置：
 *   - OAK runtime 已在 BASE_URL（默认 http://localhost:3199）运行
 *   - agent.yaml 含 getClientInfo 自定义工具 + Bash requireApproval
 *
 * 用法：
 *   pnpm tsx scripts/hitl-regression.ts
 *   BASE_URL=http://host:port pnpm tsx scripts/hitl-regression.ts
 *
 * 退出码：0 = 全部通过；1 = 有失败（CI 友好）。
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3199";
const ACP = `${BASE_URL}/acp`;
const PROMPT_TIMEOUT_MS = 90_000;

type Json = Record<string, unknown>;

let nextId = 1;

async function rpc(method: string, params: Json): Promise<Response> {
  return fetch(ACP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS),
  });
}

async function newSession(): Promise<string> {
  const res = await rpc("session/new", { cwd: "/tmp", mcpServers: [] });
  const body = (await res.json()) as { result?: { sessionId?: string } };
  const sid = body.result?.sessionId;
  if (!sid) throw new Error(`session/new failed: ${JSON.stringify(body)}`);
  return sid;
}

interface PromptResult {
  /** 拼接后的 agent_message_chunk 文本 */
  text: string;
  /** 最后一个 stopReason */
  stopReason: string | null;
  /** 所有 session/update 通知里的 update 载荷（裸 update） */
  updates: Json[];
  /** 所有 JSON-RPC REQUEST 帧（session/request_permission、client/<Name>） */
  requests: Json[];
}

/** 发一轮 prompt，消费 SSE 直到结束，聚合文本 / stopReason / updates。 */
async function prompt(sessionId: string, promptBlocks: Json[]): Promise<PromptResult> {
  const res = await rpc("session/prompt", { sessionId, prompt: promptBlocks });
  if (!res.body) throw new Error("no SSE body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let stopReason: string | null = null;
  const updates: Json[] = [];
  const requests: Json[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice("data: ".length).trim();
      if (data === "[DONE]") continue;
      let msg: Json;
      try {
        msg = JSON.parse(data) as Json;
      } catch {
        continue;
      }
      const method = msg.method as string | undefined;
      const params = (msg.params ?? {}) as Json;
      // session/update notification → 裸 update 载荷
      if (method === "session/update") {
        const update = params.update as Json | undefined;
        if (update) {
          updates.push(update);
          if (update.sessionUpdate === "agent_message_chunk") {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === "text" && typeof content.text === "string") text += content.text;
          }
        }
      } else if (method === "session/request_permission" || (method && method.startsWith("client/"))) {
        // JSON-RPC REQUEST 帧（HITL 权限 / 客户端工具）— 新内核不再放进 params.update
        requests.push(msg);
      }
      // JSON-RPC result（带 stopReason）
      const result = msg.result as { stopReason?: string } | undefined;
      if (result?.stopReason) stopReason = result.stopReason;
    }
  }
  return { text, stopReason, updates, requests };
}

/**
 * 从 updates（裸 update）+ requests（REQUEST 帧）里找指定 title/name 的
 * request_permission / client/<Name> / tool_call 的 toolCallId。
 * 同时兼容新内核（REQUEST 形式）与旧内核（update 形式）。
 */
function findToolCallId(updates: Json[], requests: Json[], title: string): string | null {
  // 新内核：REQUEST 帧
  for (const r of requests) {
    const method = r.method as string;
    if (method === "session/request_permission") {
      const tc = (r.params as { toolCall?: { toolCallId?: string; title?: string } })?.toolCall;
      if (tc?.title === title && tc.toolCallId) return tc.toolCallId;
    }
    if (method?.startsWith("client/")) {
      const name = method.slice("client/".length);
      const tid = (r._meta as { toolCallId?: string })?.toolCallId;
      if (name === title && tid) return tid;
    }
  }
  // 旧内核：update 形式
  for (const u of updates) {
    if (u.sessionUpdate === "request_permission") {
      const tc = u.toolCall as { toolCallId?: string; title?: string } | undefined;
      if (tc?.title === title && tc.toolCallId) return tc.toolCallId;
    }
    if (u.sessionUpdate === "tool_call" && u.title === title && typeof u.toolCallId === "string") {
      return u.toolCallId;
    }
  }
  return null;
}

interface Check {
  name: string;
  run: () => Promise<"skip" | void>;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 标记测试为 SKIP（不算失败）。 */
class SkipError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SkipError";
  }
}

const checks: Check[] = [
  {
    name: "multi-turn memory",
    run: async () => {
      const sid = await newSession();
      await prompt(sid, [{ type: "text", text: "Remember the number 42. Just say OK." }]);
      const turn2 = await prompt(sid, [{ type: "text", text: "What number did I ask you to remember?" }]);
      assert(turn2.text.includes("42"), `expected "42" in reply, got: ${turn2.text.slice(0, 120)}`);
    },
  },
  {
    name: "bash permission approval",
    run: async () => {
      const sid = await newSession();
      const ask = await prompt(sid, [{ type: "text", text: "Run the bash command: echo hello-from-bash" }]);
      // 没配 bash 审批 → 模型直接执行,end_turn。SKIP(不算失败)。
      if (ask.stopReason !== "awaiting_permission") {
        throw new SkipError(
          `bash not configured for approval (stopReason=${ask.stopReason}); ` +
            `set tools.agent_toolset.configs[].permission_policy=always_ask for bash to test approval`,
        );
      }
      const tid = findToolCallId(ask.updates, ask.requests, "Bash");
      assert(tid, "no Bash request_permission found");
      const resumed = await prompt(sid, [
        { type: "permission_decision", tool_use_id: tid, decision: "allow" },
      ]);
      const ran = resumed.updates.some((u) => JSON.stringify(u).includes("hello-from-bash"));
      assert(ran, `bash output not found after approval; final: ${resumed.text.slice(0, 120)}`);
    },
  },
  {
    name: "client-tool getClientInfo",
    run: async () => {
      const sid = await newSession();
      const ask = await prompt(sid, [
        { type: "text", text: "Call getClientInfo with query='username'." },
      ]);
      // 新内核：client-tool → client/<Name> REQUEST → stopReason=tool_use
      // （旧内核走 request_permission → awaiting_permission；二者都用 tool_result 恢复）
      assert(
        ask.stopReason === "tool_use" || ask.stopReason === "awaiting_permission",
        `expected tool_use or awaiting_permission, got ${ask.stopReason}`,
      );
      const tid = findToolCallId(ask.updates, ask.requests, "getClientInfo");
      assert(tid, "no getClientInfo request found");
      const resumed = await prompt(sid, [
        { type: "tool_result", tool_use_id: tid, content: JSON.stringify({ username: "alice_chen" }) },
      ]);
      assert(
        resumed.text.includes("alice_chen"),
        `expected alice_chen in reply, got: ${resumed.text.slice(0, 160)}`,
      );
    },
  },
  {
    name: "AskUserQuestion resume",
    run: async () => {
      const sid = await newSession();
      const ask = await prompt(sid, [
        { type: "text", text: "Use the AskUserQuestion tool to ask which color I prefer: red or blue." },
      ]);
      // AskUserQuestion 在新内核走 client/AskUserQuestion REQUEST → tool_use
      assert(
        ask.stopReason === "tool_use" || ask.stopReason === "awaiting_permission",
        `expected tool_use or awaiting_permission, got ${ask.stopReason}`,
      );
      const tid = findToolCallId(ask.updates, ask.requests, "AskUserQuestion");
      assert(tid, "no AskUserQuestion tool_call found");
      const resumed = await prompt(sid, [{ type: "tool_result", tool_use_id: tid, content: "Blue" }]);
      // 关键：模型必须确认 Blue，而不是重新提问
      assert(
        /blue/i.test(resumed.text),
        `expected the model to acknowledge Blue, got: ${resumed.text.slice(0, 160)}`,
      );
    },
  },
];

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[hitl-regression] target=${ACP}`);
  let failed = 0;
  let skipped = 0;
  for (const check of checks) {
    const t0 = Date.now();
    try {
      await check.run();
      // eslint-disable-next-line no-console
      console.log(`  PASS  ${check.name}  (${Date.now() - t0}ms)`);
    } catch (err) {
      if (err instanceof SkipError) {
        skipped++;
        // eslint-disable-next-line no-console
        console.log(`  SKIP  ${check.name}  (${Date.now() - t0}ms)`);
        // eslint-disable-next-line no-console
        console.log(`        ${err.message}`);
      } else {
        failed++;
        // eslint-disable-next-line no-console
        console.error(`  FAIL  ${check.name}  (${Date.now() - t0}ms)`);
        // eslint-disable-next-line no-console
        console.error(`        ${(err as Error).message}`);
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[hitl-regression] ${checks.length - failed - skipped}/${checks.length} passed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
