/**
 * FlexDB collections for Managed Agents Layer A (protocol events).
 * Layer B engine SoR remains harness_sync_events / harness_claude_*.
 */

export const MANAGED_AGENTS_AGENTS_COLLECTION = "managed_agents_agents";
export const MANAGED_AGENTS_ENVIRONMENTS_COLLECTION = "managed_agents_environments";
export const MANAGED_AGENTS_SESSIONS_COLLECTION = "managed_agents_sessions";
export const MANAGED_AGENTS_SESSION_EVENTS_COLLECTION = "managed_agents_session_events";

/** FlexDB page size for event list / watch polling. */
export const MANAGED_AGENTS_SESSION_EVENTS_PAGE_SIZE = 100;

/** SSE watch poll interval when no live subscriber pushes (SCF multi-instance). */
export const MANAGED_AGENTS_SSE_POLL_MS = 800;
