/**
 * Managed runtime config shell — re-exports the shared schema/loader.
 *
 * Managed uses the shared no-op `normalizeAgentConfig` (no sandbox placement),
 * so this is a pure re-export. Kept as a local file so the oak-runtime tree's
 * relative `../config.js` imports keep resolving unchanged.
 */
export * from "open-managed-agent-runtime-shared/config.js";
