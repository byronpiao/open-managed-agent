import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const runtimeRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "agent-runtime",
);

const { materializeManagedSkills } = await import(
  join(runtimeRoot, "dist", "managed", "skills.js")
);

const TMP = join("/tmp", "oma-managed-skills-test");

function reset() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

test("materializeManagedSkills copies skill directory", async () => {
  reset();
  const bundle = join(TMP, "bundle", "skills");
  const workspace = join(TMP, "workspace");
  mkdirSync(join(bundle, "foo"), { recursive: true });
  writeFileSync(join(bundle, "foo", "SKILL.md"), "# Foo skill");
  writeFileSync(join(bundle, "foo", "extra.txt"), "asset");

  const result = await materializeManagedSkills(["foo"], {
    bundleSkillsDir: bundle,
    workspaceCwd: workspace,
  });

  assert.deepEqual(result.materialized, ["foo"]);
  assert.deepEqual(result.skipped, []);
  const dest = join(workspace, ".claude", "skills", "foo", "SKILL.md");
  assert.ok(existsSync(dest));
  assert.equal(readFileSync(dest, "utf-8"), "# Foo skill");
  assert.ok(existsSync(join(workspace, ".claude", "skills", "foo", "extra.txt")));
});

test("materializeManagedSkills legacy flat md", async () => {
  reset();
  const bundle = join(TMP, "bundle2", "skills");
  const workspace = join(TMP, "workspace2");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "bar.md"), "# Bar legacy");

  const result = await materializeManagedSkills(["bar"], {
    bundleSkillsDir: bundle,
    workspaceCwd: workspace,
  });

  assert.deepEqual(result.materialized, ["bar"]);
  const dest = join(workspace, ".claude", "skills", "bar", "SKILL.md");
  assert.ok(existsSync(dest));
  assert.match(readFileSync(dest, "utf-8"), /Bar legacy/);
});

test("materializeManagedSkills skips missing", async () => {
  reset();
  const bundle = join(TMP, "bundle3", "skills");
  mkdirSync(bundle, { recursive: true });
  const result = await materializeManagedSkills(["missing"], {
    bundleSkillsDir: bundle,
    workspaceCwd: join(TMP, "ws3"),
  });
  assert.deepEqual(result.materialized, []);
  assert.deepEqual(result.skipped, ["missing"]);
});
