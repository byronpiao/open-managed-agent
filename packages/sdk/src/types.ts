// ============================================================
// OpenManagedAgent SDK - Type Definitions
// Mirrors @anthropic-ai/sdk beta.agents interface
// ============================================================

export interface Agent {
  id: string;
  object: "agent";
  name: string;
  model: string;
  system?: string;
  tools: AgentTool[];
  metadata?: Record<string, string>;
  created_at: number;
}

export interface CreateAgentParams {
  name: string;
  model?: string;
  system?: string;
  tools?: AgentTool[];
  metadata?: Record<string, string>;
}

export interface AgentTool {
  type: "agent_toolset_20260401" | "bash_20250124" | "text_editor_20250429" | "custom";
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface Environment {
  id: string;
  object: "environment";
  name: string;
  config: EnvironmentConfig;
  created_at: number;
}

export interface CreateEnvironmentParams {
  name: string;
  config?: EnvironmentConfig;
}

export interface EnvironmentConfig {
  type: "cloud" | "local";
  networking?: {
    type: "unrestricted" | "restricted";
  };
}

export interface Session {
  id: string;
  object: "session";
  agent: string;
  environment_id?: string;
  title?: string;
  status: "idle" | "running" | "terminated";
  created_at: number;
}

export interface CreateSessionParams {
  agent?: string;
  environment_id?: string;
  title?: string;
  cwd?: string;          // working directory, passed to ACP session/new
}

// ============================================================
// Event Types
// ============================================================

export type AgentEventType =
  | "agent.message"
  | "agent.thinking"
  | "agent.tool_use"
  | "agent.tool_result"
  | "agent.custom_tool_use"
  | "session.status_idle"
  | "session.status_terminated"
  | "user.message"
  | "user.interrupt"
  | "user.custom_tool_result"
  | "user.tool_confirmation";

export interface BaseEvent {
  type: AgentEventType;
  session_id: string;
}

export interface AgentMessageEvent extends BaseEvent {
  type: "agent.message";
  content: ContentBlock[];
}

export interface AgentThinkingEvent extends BaseEvent {
  type: "agent.thinking";
  thinking: string;
}

export interface AgentToolUseEvent extends BaseEvent {
  type: "agent.tool_use";
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultEvent extends BaseEvent {
  type: "agent.tool_result";
  tool_use_id: string;
  content: ContentBlock[];
  is_error: boolean;
}

export interface AgentCustomToolUseEvent extends BaseEvent {
  type: "agent.custom_tool_use";
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface SessionStatusIdleEvent extends BaseEvent {
  type: "session.status_idle";
}

export interface SessionStatusTerminatedEvent extends BaseEvent {
  type: "session.status_terminated";
  reason?: string;
}

export interface UserMessageEvent extends BaseEvent {
  type: "user.message";
  content: ContentBlock[];
}

export interface UserInterruptEvent extends BaseEvent {
  type: "user.interrupt";
}

export interface UserCustomToolResultEvent extends BaseEvent {
  type: "user.custom_tool_result";
  tool_use_id: string;
  content: ContentBlock[];
  is_error?: boolean;
}

export interface UserToolConfirmationEvent extends BaseEvent {
  type: "user.tool_confirmation";
  tool_use_id: string;
  decision: "allow" | "deny";
}

export type AgentEvent =
  | AgentMessageEvent
  | AgentThinkingEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentCustomToolUseEvent
  | SessionStatusIdleEvent
  | SessionStatusTerminatedEvent
  | UserMessageEvent
  | UserInterruptEvent
  | UserCustomToolResultEvent
  | UserToolConfirmationEvent;

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  image?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface SendEventsParams {
  events: Omit<AgentEvent, "session_id">[];
}

export interface ManagedAgentsConfig {
  /** CloudBase 环境 ID */
  envId: string;
  /** Agent ID */
  agentId: string;
  /** Access Key (JWT Token) */
  accessKey?: string;
  /** 自定义 base URL（可选，默认根据 envId + agentId 自动生成） */
  baseURL?: string;
}

/** @deprecated Use ManagedAgentsConfig */
export type CloudbaseAgentsConfig = ManagedAgentsConfig;

export interface ListResponse<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}
