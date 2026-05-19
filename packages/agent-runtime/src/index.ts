/**
 * CloudBase Managed Agent - Runtime
 *
 * 这是部署到 CloudBase Agent（云函数）的运行时代码。
 * 使用 @cloudbase/agent-server + 自定义 AbstractAgent 实现。
 *
 * 部署方式：
 *   tcb agent create --name my-agent --code ./packages/agent-runtime -e $ENV_ID
 */

import { run } from "@cloudbase/agent-server";
import { HunyuanAgent } from "./hunyuan-agent.js";

run({
  createAgent: (ctx) => {
    // 从环境变量读取 Agent 配置（由 tcb agent create --env 传入）
    const model  = process.env.AGENT_MODEL  ?? "hunyuan-2.0-instruct-20251111";
    const system = process.env.AGENT_SYSTEM ?? "You are a helpful assistant.";

    ctx.logger?.info({ model }, "Agent starting");

    return {
      agent: new HunyuanAgent({ model, system }),
    };
  },
  port: Number(process.env.PORT ?? 9000),
  cors: true,
});
