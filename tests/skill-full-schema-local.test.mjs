import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

import { applySkillsToDeployDir } from "../lib/skills-sync.mjs";
import { assertSkillMd } from "./skill-e2e-lib.mjs";

const TMP = join("/tmp", "oma-skill-full-schema-local");

function reset() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

test("local-only subset: file:relative + file:absolute in one deploy", async () => {
  reset();
  const absSkill = join(TMP, "abs-skill");
  mkdirSync(absSkill, { recursive: true });
  writeFileSync(join(absSkill, "SKILL.md"), "# abs\nmarker: abs\n");

  const relSkill = join(TMP, "skills", "rel-skill");
  mkdirSync(relSkill, { recursive: true });
  writeFileSync(join(relSkill, "SKILL.md"), "# rel\nmarker: rel\n");

  const agentYaml = join(TMP, "agent.yaml");
  writeFileSync(
    agentYaml,
    [
      "name: local-schema",
      "runtime: managed",
      "skills:",
      "  - source: file:./skills/rel-skill",
      `  - source: file:${absSkill}`,
    ].join("\n"),
    "utf-8",
  );

  const deployDir = join(TMP, "deploy");
  const result = await applySkillsToDeployDir(
    deployDir,
    [
      { source: "file:./skills/rel-skill" },
      { source: `file:${absSkill}` },
    ],
    { configFile: agentYaml },
  );

  assert.equal(result.added.length, 2);
  const skillsDir = join(deployDir, "skills");
  for (const name of ["rel-skill", "abs-skill"]) {
    assertSkillMd(skillsDir, name);
  }
});
