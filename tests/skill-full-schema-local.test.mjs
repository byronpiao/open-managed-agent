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

test("local-only subset: scenarios 1/2/9/10 in one deploy", async () => {
  reset();
  const absSkill = join(TMP, "abs-skill");
  mkdirSync(absSkill, { recursive: true });
  writeFileSync(join(absSkill, "SKILL.md"), "# abs\nmarker: abs\n");

  const relSkill = join(TMP, "skills", "rel-skill");
  mkdirSync(relSkill, { recursive: true });
  writeFileSync(join(relSkill, "SKILL.md"), "# rel\nmarker: rel\n");

  mkdirSync(join(TMP, "skills", "nosrc-dir"), { recursive: true });
  writeFileSync(join(TMP, "skills", "nosrc-dir", "SKILL.md"), "# dir\nmarker: dir\n");

  writeFileSync(join(TMP, "skills", "nosrc-flat.md"), "# flat\nmarker: flat\n");

  const agentYaml = join(TMP, "agent.yaml");
  writeFileSync(
    agentYaml,
    [
      "name: local-schema",
      "runtime: managed",
      "skills:",
      "  - name: rel-skill",
      "    source: ./skills/rel-skill",
      `  - name: abs-skill`,
      `    source: ${absSkill}`,
      "  - name: nosrc-dir",
      "  - name: nosrc-flat",
    ].join("\n"),
    "utf-8",
  );

  const deployDir = join(TMP, "deploy");
  const result = await applySkillsToDeployDir(
    deployDir,
    [
      { name: "rel-skill", source: "./skills/rel-skill" },
      { name: "abs-skill", source: absSkill },
      { name: "nosrc-dir" },
      { name: "nosrc-flat" },
    ],
    { configFile: agentYaml },
  );

  assert.equal(result.added.length, 4);
  const skillsDir = join(deployDir, "skills");
  for (const name of ["rel-skill", "abs-skill", "nosrc-dir", "nosrc-flat"]) {
    assertSkillMd(skillsDir, name);
  }
});
