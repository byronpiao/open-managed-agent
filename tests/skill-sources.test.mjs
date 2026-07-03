import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  mkdtempSync,
} from "fs";

import {
  parseSkillSource,
  normalizeGitUrl,
  findSkillDir,
  isValidSkillDir,
  scanForSkills,
  resolveLocalSource,
  resolveSkillArtifacts,
  copySkillDirToDeploy,
} from "../lib/skill-sources.mjs";
import {
  syncSkillsInDir,
  listSkillNamesInDir,
  skillsChanged,
  skillsNeedSync,
  computeSkillContentHashes,
} from "../lib/skills-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "skills-repo");
const TMP = join("/tmp", "oma-skill-sources-test");

function resetTmp() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

test("parseSkillSource prefixes", () => {
  assert.deepEqual(parseSkillSource("git:https://github.com/o/r.git"), {
    kind: "git",
    payload: "https://github.com/o/r.git",
  });
  assert.deepEqual(parseSkillSource("skills.sh:a/b/c"), {
    kind: "skillssh",
    payload: "a/b/c",
  });
  assert.deepEqual(parseSkillSource("file:./x"), { kind: "local", payload: "./x" });
  assert.throws(() => parseSkillSource("./x"), /protocol prefix/);
});

test("normalizeGitUrl hash subpath", () => {
  const r = normalizeGitUrl("https://github.com/o/r.git#tdd");
  assert.equal(r.cloneUrl, "https://github.com/o/r.git");
  assert.equal(r.subpath, "tdd");
});

test("findSkillDir nested fixture", () => {
  const nested = join(FIXTURES, "nested");
  const dir = findSkillDir(nested, { skillId: "tdd" });
  assert.ok(isValidSkillDir(dir));
  assert.match(dir, /tdd$/);
});

test("scanForSkills finds multiple", () => {
  const nested = join(FIXTURES, "nested");
  const found = scanForSkills(nested);
  assert.ok(found.length >= 2);
});

test("resolveLocalSource prefers cwd", () => {
  const skillDir = join(TMP, "local-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# x");
  const abs = resolveLocalSource(skillDir, { cwd: TMP, configDir: TMP });
  assert.equal(abs, skillDir);
});

test("syncSkillsInDir installs local directory", async () => {
  resetTmp();
  const src = join(TMP, "src", "demo");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "# Demo v1");
  writeFileSync(join(src, "helper.txt"), "keep");

  const deploySkills = join(TMP, "deploy", "skills");
  const configDir = join(TMP, "cfg");
  mkdirSync(configDir, { recursive: true });

  const result = await syncSkillsInDir(
    [{ source: `file:${src}` }],
    deploySkills,
    { configDir, cwd: TMP },
  );

  assert.ok(result.added.includes("demo"));
  assert.ok(existsSync(join(deploySkills, "demo", "SKILL.md")));
  assert.ok(existsSync(join(deploySkills, "demo", "helper.txt")));
  assert.ok(listSkillNamesInDir(deploySkills).includes("demo"));
});

test("syncSkillsInDir update and remove", async () => {
  resetTmp();
  const deploySkills = join(TMP, "deploy2", "skills");
  const src = join(TMP, "src2", "keep");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "# Keep");

  await syncSkillsInDir([{ source: `file:${src}` }], deploySkills, {
    configDir: TMP,
    cwd: TMP,
  });

  writeFileSync(join(src, "SKILL.md"), "# Keep v2");
  const updated = await syncSkillsInDir([{ source: `file:${src}` }], deploySkills, {
    configDir: TMP,
    cwd: TMP,
  });
  assert.ok(updated.updated.includes("keep"));

  const removed = await syncSkillsInDir([], deploySkills, { configDir: TMP, cwd: TMP });
  assert.ok(removed.removed.includes("keep"));
});

test("skillsChanged detects source edits", () => {
  assert.equal(
    skillsChanged([{ source: "file:./x" }], [{ source: "file:./y" }]),
    true,
  );
  assert.equal(
    skillsChanged([{ source: "file:./x" }], [{ source: "file:./x" }]),
    false,
  );
  assert.equal(skillsChanged([], [], { forceSync: true }), true);
});

test("copySkillDirToDeploy", () => {
  resetTmp();
  const src = join(FIXTURES, "single");
  const destRoot = join(TMP, "out", "skills");
  mkdirSync(destRoot, { recursive: true });
  copySkillDirToDeploy(src, destRoot, "single");
  assert.equal(
    readFileSync(join(destRoot, "single", "SKILL.md"), "utf-8").includes("alpha"),
    true,
  );
});

test("resolveSkillArtifacts local relative", async () => {
  resetTmp();
  const skillDir = join(TMP, "rel");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# rel");
  const arts = await resolveSkillArtifacts(
    { source: "file:./rel" },
    { cwd: TMP, configDir: TMP },
  );
  assert.equal(arts.length, 1);
  assert.ok(isValidSkillDir(arts[0].skillDir));
});

test("resolveSkillArtifacts rejects missing source", async () => {
  resetTmp();
  await assert.rejects(
    () => resolveSkillArtifacts({}, { cwd: TMP, configDir: TMP }),
    /requires source/,
  );
});

test("skillsNeedSync detects local content change with same yaml", async () => {
  resetTmp();
  const configDir = join(TMP, "cfg3");
  const skillDir = join(configDir, "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# v1");
  const agentYaml = join(configDir, "agent.yaml");
  writeFileSync(agentYaml, "name: t\nskills:\n  - source: file:./skills/demo\n");

  const skills = [{ source: "file:./skills/demo" }];
  const hashes = await computeSkillContentHashes(skills, { configDir });
  const currentConfig = { metadata: { __skillHashes: hashes } };

  assert.equal(
    await skillsNeedSync({
      currentSkills: skills,
      newSkills: skills,
      currentConfig,
      configFile: agentYaml,
    }),
    false,
  );

  writeFileSync(join(skillDir, "SKILL.md"), "# v2");
  assert.equal(
    await skillsNeedSync({
      currentSkills: skills,
      newSkills: skills,
      currentConfig,
      configFile: agentYaml,
    }),
    true,
  );
});

test("skillsNeedSync detects bundle child content change", async () => {
  resetTmp();
  const configDir = join(TMP, "bundle-cfg");
  mkdirSync(configDir, { recursive: true });
  const bundleSource = "git:https://github.com/example/skills.git";
  const agentYaml = join(configDir, "agent.yaml");
  writeFileSync(
    agentYaml,
    `name: t\nskills:\n  - source: ${bundleSource}\n`,
  );

  const skills = [{ source: bundleSource }];
  const mutableRepo = join(TMP, "mutable-repo");
  cpSync(join(FIXTURES, "nested"), mutableRepo, { recursive: true });
  const cloneMock = (_url, _branch, tempParent) => {
    mkdirSync(tempParent, { recursive: true });
    const dest = mkdtempSync(join(tempParent, "mock-clone-"));
    cpSync(mutableRepo, dest, { recursive: true });
    return dest;
  };

  const hashes = await computeSkillContentHashes(skills, { configDir, cloneGitRepo: cloneMock });
  assert.ok(hashes.tdd);
  assert.ok(hashes["other-skill"]);

  const currentConfig = { metadata: { __skillHashes: { ...hashes } } };
  assert.equal(
    await skillsNeedSync({
      currentSkills: skills,
      newSkills: skills,
      currentConfig,
      configFile: agentYaml,
      cloneGitRepo: cloneMock,
    }),
    false,
  );

  writeFileSync(join(mutableRepo, "tdd", "SKILL.md"), "# mutated bundle child\n");
  assert.equal(
    await skillsNeedSync({
      currentSkills: skills,
      newSkills: skills,
      currentConfig,
      configFile: agentYaml,
      cloneGitRepo: cloneMock,
    }),
    true,
  );
});
