import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initManagedLogging,
  managedLog,
  runWithSkillSyncLog,
  skillSyncPhase,
  withSkillSyncContext,
} from "../lib/managed-logging.mjs";

test("managedLog exposes evlog handle API", () => {
  initManagedLogging();
  const wl = managedLog({ lane: "skill-sync", operation: "test" });
  assert.equal(typeof wl.phase, "function");
  assert.equal(typeof wl.milestone, "function");
  assert.equal(typeof wl.emit, "function");
  wl.phase("detect_skip", { skillCount: 0 });
  wl.emit({ outcome: "ok", durationMs: 1 });
});

test("runWithSkillSyncLog sets skillSyncPhase context", async () => {
  initManagedLogging();
  const seen = [];
  await runWithSkillSyncLog(
    { operation: "test-sync", agentId: "agent-test", skillCount: 1 },
    async () => {
      skillSyncPhase("install_start", { desiredCount: 1 });
      seen.push("inside");
      return { syncResult: { added: ["a"], updated: [], removed: [] } };
    },
  );
  assert.deepEqual(seen, ["inside"]);
});

test("withSkillSyncContext runs detect without terminal emit", async () => {
  initManagedLogging();
  await withSkillSyncContext({ operation: "detect" }, async () => {
    skillSyncPhase("detect_skip", { skillCount: 2 });
  });
});
