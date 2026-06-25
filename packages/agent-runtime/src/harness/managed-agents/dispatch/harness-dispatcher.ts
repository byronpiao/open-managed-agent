import type { AgentConfig } from "../../../config.js";
import { deleteHarnessAcpSession } from "../../acp-endpoint.js";
import type { CmaHttpDriverCommandDispatchInput } from "../vendor/cma-http.js";
import type { CmaStore } from "../vendor/cma-store-types.js";
import type { RuntimeCommandResult } from "../vendor/runtime-command-types.js";
import { resolveManagedAgentsSessionConfig } from "../resolve-session-agent-config.js";
import {
  cancelHarnessManagedAgentsPrompt,
  executeHarnessManagedAgentsMcp,
  resolveHarnessManagedAgentsPermission,
  runHarnessManagedAgentsPrompt,
} from "./harness-prompt-runner.js";

export function createHarnessManagedAgentsDispatcher(args: {
  config: AgentConfig;
  store: CmaStore;
}): (input: CmaHttpDriverCommandDispatchInput) => Promise<RuntimeCommandResult | void> {
  const { config: deploymentConfig, store } = args;

  const configForSession = (sessionId: string) =>
    resolveManagedAgentsSessionConfig(deploymentConfig, store, sessionId);

  return async (input) => {
    const { command, session } = input;
    const sessionId = session.id;
    const config = await configForSession(sessionId);

    switch (command.kind) {
      case "input.start": {
        return runHarnessManagedAgentsPrompt({ config, store, sessionId, command });
      }
      case "turn.cancel": {
        cancelHarnessManagedAgentsPrompt(sessionId);
        return null;
      }
      case "permission.resolve": {
        await resolveHarnessManagedAgentsPermission({ config, store, sessionId, command });
        return null;
      }
      case "mcp.execute": {
        const { outputText } = await executeHarnessManagedAgentsMcp({
          config,
          store,
          sessionId,
          command,
        });
        return {
          requestId: command.requestId,
          serverId: command.serverId,
          toolName: command.toolName,
          outputText,
        };
      }
      case "session.stop": {
        await deleteHarnessAcpSession({ sessionId }, config);
        await store.appendDriverEvent(sessionId, {
          kind: "run.completed",
          payload: { stopReason: "session_stop", reason: command.reason },
        });
        return null;
      }
      default:
        return null;
    }
  };
}
