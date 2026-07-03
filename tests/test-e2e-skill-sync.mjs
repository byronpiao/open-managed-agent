import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";

import {
  syncSkillsInDir,
  skillsChanged,
  applySkillsToDeployDir,
} from "../lib/skills-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join("/tmp", "magent-e2e-skill-sync");

function reset() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

test("add new skill directory", async () => {
  reset();
  const deployedSkillsDir = join(TEST_DIR, "deployed", "skills");
  const localSkill = join(TEST_DIR, "local", "skills", "new-skill");
  mkdirSync(deployedSkillsDir, { recursive: true });
  mkdirSync(join(deployedSkillsDir, "existing"), { recursive: true });
  writeFileSync(join(deployedSkillsDir, "existing", "SKILL.md"), "# Existing");

  mkdirSync(localSkill, { recursive: true });
  writeFileSync(join(localSkill, "SKILL.md"), "# New Skill");

  const configDir = join(TEST_DIR, "local");
  const result = await syncSkillsInDir(
    [
      { source: `file:${join(deployedSkillsDir, "existing")}` },
      { source: `file:${localSkill}` },
    ],
    deployedSkillsDir,
    { configDir, cwd: configDir },
  );

  assert.ok(result.added.includes("new-skill"));
  assert.ok(existsSync(join(deployedSkillsDir, "new-skill", "SKILL.md")));
});

test("remove skill directory", async () => {
  reset();
  const deployedSkillsDir = join(TEST_DIR, "rm", "skills");
  mkdirSync(join(deployedSkillsDir, "old"), { recursive: true });
  writeFileSync(join(deployedSkillsDir, "old", "SKILL.md"), "# Old");

  const result = await syncSkillsInDir([], deployedSkillsDir, {
    configDir: TEST_DIR,
    cwd: TEST_DIR,
  });
  assert.ok(result.removed.includes("old"));
  assert.equal(existsSync(join(deployedSkillsDir, "old")), false);
});

test("update skill content", async () => {
  reset();
  const deployedSkillsDir = join(TEST_DIR, "upd", "skills");
  const src = join(TEST_DIR, "upd-src", "demo");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "# v1");

  await syncSkillsInDir([{ source: `file:${src}` }], deployedSkillsDir, {
    configDir: TEST_DIR,
    cwd: TEST_DIR,
  });

  writeFileSync(join(src, "SKILL.md"), "# v2");
  const result = await syncSkillsInDir([{ source: `file:${src}` }], deployedSkillsDir, {
    configDir: TEST_DIR,
    cwd: TEST_DIR,
  });

  assert.ok(result.updated.includes("demo"));
  assert.match(readFileSync(join(deployedSkillsDir, "demo", "SKILL.md"), "utf-8"), /v2/);
});

test("skillsChanged", () => {
  assert.equal(
    skillsChanged([{ source: "file:./a" }], [{ source: "file:./b" }]),
    true,
  );
  assert.equal(
    skillsChanged([{ source: "file:./x" }], [{ source: "file:./x" }]),
    false,
  );
  assert.equal(skillsChanged([], [], { forceSync: true }), true);
});

test("applySkillsToDeployDir", async () => {
  reset();
  const deployDir = join(TEST_DIR, "bundle");
  const src = join(TEST_DIR, "bundle-src", "hello");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "# Hello");

  const agentYaml = join(TEST_DIR, "agent.yaml");
  writeFileSync(agentYaml, "name: t\nskills: []\n");

  const result = await applySkillsToDeployDir(
    deployDir,
    [{ source: `file:${src}` }],
    { configFile: agentYaml },
  );

  assert.ok(result.added.includes("hello"));
  assert.ok(existsSync(join(deployDir, "skills", "hello", "SKILL.md")));
});
