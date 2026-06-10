/**
 * Runtime command types used by CMA HTTP + store contracts.
 * Vendored subset from mosoo-agent-driver runtime-command.
 */

export type PrimitiveValue = string | number | boolean | null;
export type PrimitiveRecord = Record<string, PrimitiveValue>;

export interface RuntimeCommandInput {
  readonly attachmentIds?: string[] | undefined;
  readonly text: string;
}

export interface TurnCancelCommand {
  readonly commandId: string;
  readonly kind: "turn.cancel";
  readonly reason?: string | undefined;
}

export interface InputStartCommand {
  readonly commandId: string;
  readonly input: RuntimeCommandInput;
  readonly kind: "input.start";
  readonly requestId: string;
  readonly runId: string;
}

export interface SessionStopCommand {
  readonly commandId: string;
  readonly kind: "session.stop";
  readonly reason: string;
}

export interface McpExecuteCommand {
  readonly argumentsJson: string;
  readonly commandId: string;
  readonly kind: "mcp.execute";
  readonly requestId: string;
  readonly serverId: string;
  readonly toolName: string;
}

export interface PermissionResolveCommand {
  readonly commandId: string;
  readonly decision: "allow_once" | "reject_once";
  readonly kind: "permission.resolve";
  readonly requestId: string;
}

export type RuntimeCommand =
  | InputStartCommand
  | McpExecuteCommand
  | PermissionResolveCommand
  | SessionStopCommand
  | TurnCancelCommand;

export interface InputStartCommandResult {
  readonly requestId: string;
}

export interface McpExecuteCommandResult {
  readonly outputText: string;
  readonly requestId: string;
  readonly serverId: string;
  readonly toolName: string;
}

export type RuntimeCommandResult =
  | InputStartCommandResult
  | McpExecuteCommandResult
  | null;
