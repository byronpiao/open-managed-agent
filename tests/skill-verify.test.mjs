import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

import { waitForSkillPackageLive, hashSkillsInDeployDir, resolveDeployDownloadTarget } from "../lib/skills-sync.mjs";

const TMP = join("/tmp", "oma-skill-verify-unit");

function reset() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function writeSkill(deployDir, name, content) {
  const dir = join(deployDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

test("waitForSkillPackageLive succeeds when download matches expected hashes", async () => {
  reset();
  const expectedDir = join(TMP, "expected");
  writeSkill(expectedDir, "demo", "# demo v1\n");
  const expectedHashes = hashSkillsInDeployDir(expectedDir, ["demo"]);

  let calls = 0;
  const ok = await waitForSkillPackageLive({
    download: (dest) => {
      calls += 1;
      writeSkill(dest, "demo", "# demo v1\n");
    },
    expectedHashes,
    label: "unit-ok",
    intervalMs: 10,
    maxWaitMs: 500,
  });

  assert.equal(ok, true);
  assert.ok(calls >= 1);
});

test("waitForSkillPackageLive returns false on hash mismatch timeout", async () => {
  reset();
  const expectedDir = join(TMP, "expected-mismatch");
  writeSkill(expectedDir, "demo", "# expected\n");
  const expectedHashes = hashSkillsInDeployDir(expectedDir, ["demo"]);

  const ok = await waitForSkillPackageLive({
    download: (dest) => {
      writeSkill(dest, "demo", "# different content\n");
    },
    expectedHashes,
    label: "unit-fail",
    intervalMs: 10,
    maxWaitMs: 80,
  });

  assert.equal(ok, false);
});

test("waitForSkillPackageLive empty expectedHashes is immediate success", async () => {
  const ok = await waitForSkillPackageLive({
    download: () => {
      throw new Error("should not download");
    },
    expectedHashes: {},
  });
  assert.equal(ok, true);
});

test("resolveDeployDownloadTarget uses agentId for SCF and serviceId for TCBR", () => {
  assert.equal(resolveDeployDownloadTarget("scf", "agent-abc", "fn-other"), "agent-abc");
  assert.equal(resolveDeployDownloadTarget("tcbr", "agent-abc", "svc-1"), "svc-1");
  assert.throws(() => resolveDeployDownloadTarget("scf", "", "fn"), /agentId is required/);
  assert.throws(() => resolveDeployDownloadTarget("tcbr", "agent-abc", ""), /serviceId is required/);
});
