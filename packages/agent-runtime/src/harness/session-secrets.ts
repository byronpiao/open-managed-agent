/**
 * Per-session TRW SECRET_MASTER_KEY (harness_sessions.secretMasterKey).
 * Binds box secrets to ACP session so re-acquire keeps the same vault.
 */

import { randomBytes } from "node:crypto";

export function generateHarnessSecretMasterKey(): string {
  return randomBytes(32).toString("hex");
}
