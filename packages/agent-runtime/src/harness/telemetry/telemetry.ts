/**
 * Tracing helpers — re-exported from the shared runtime-agnostic shim.
 *
 * Single source of truth lives in open-managed-agent-runtime-shared/telemetry.js;
 * the harness OTel SDK init stays in ./telemetry-init.js. This module exists so
 * the harness tree's relative imports keep resolving unchanged.
 */
export * from "open-managed-agent-runtime-shared/telemetry.js";
