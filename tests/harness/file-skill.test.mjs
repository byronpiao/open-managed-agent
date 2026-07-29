/**
 * Harness file: skill resolver + resolveSkills integration.
 * Run: node --test tests/harness/file-skill.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseFileSkillSource,
  resolveHarnessSkillDocSync,
  resolveHarnessSkillDoc,
} from "../../packages/agent-runtime/dist/harness/file-skill.js";
import { loadAgentConfig, resolveSkills } from "../../packages/agent-runtime/dist/config.js";
import { buildSkillsManifestEnv } from "../../packages/agent-runtime/dist/harness/deploy.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("parseFileSkillSource rejects non-file sources", () => {
  assert.equal(parseFileSkillSource("git:https://x"), null);
  assert.equal(parseFileSkillSource(""), null);
});

test("parseFileSkillSource strips .md from label", () => {
  assert.deepEqual(parseFileSkillSource("file:./skills/demo.md"), {
    payload: "./skills/demo.md",
    label: "demo",
  });
});

test("resolveHarnessSkillDocSync finds skills/<label>/SKILL.md", () => {
  const base = tempDir("oma-fs-dir-");
  const skillDir = join(base, "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# dir layout");

  const r = resolveHarnessSkillDocSync(base, "file:./skills/demo");
  assert.deepEqual(r, { label: "demo", srcPath: join(skillDir, "SKILL.md") });
  rmSync(base, { recursive: true, force: true });
});

test("resolveHarnessSkillDocSync finds flat skills/<label>.md", () => {
  const base = tempDir("oma-fs-flat-");
  mkdirSync(join(base, "skills"), { recursive: true });
  const flat = join(base, "skills", "bar.md");
  writeFileSync(flat, "# flat");

  const r = resolveHarnessSkillDocSync(base, "file:./skills/bar.md");
  assert.deepEqual(r, { label: "bar", srcPath: flat });
  rmSync(base, { recursive: true, force: true });
});

test("resolveHarnessSkillDocSync resolves direct relative file path", () => {
  const base = tempDir("oma-fs-direct-");
  const skillDir = join(base, "custom", "nested");
  mkdirSync(skillDir, { recursive: true });
  const doc = join(skillDir, "SKILL.md");
  writeFileSync(doc, "# nested");

  const r = resolveHarnessSkillDocSync(base, "file:./custom/nested");
  assert.deepEqual(r, { label: "nested", srcPath: doc });
  rmSync(base, { recursive: true, force: true });
});

test("resolveHarnessSkillDoc async matches sync for directory layout", async () => {
  const base = tempDir("oma-fs-async-");
  const skillDir = join(base, "skills", "async-demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# async");

  const sync = resolveHarnessSkillDocSync(base, "file:./skills/async-demo");
  const async = await resolveHarnessSkillDoc(base, "file:./skills/async-demo");
  assert.deepEqual(async, sync);
  rmSync(base, { recursive: true, force: true });
});

test("buildSkillsManifestEnv packs flat .md via file-skill resolver", () => {
  const base = tempDir("oma-fs-manifest-");
  mkdirSync(join(base, "skills"), { recursive: true });
  writeFileSync(join(base, "skills", "flat.md"), "# flat manifest");

  const env = buildSkillsManifestEnv(
    {
      name: "t",
      model: "m",
      system: "s",
      skills: [{ source: "file:./skills/flat.md" }],
    },
    base,
  );
  assert.ok(env);
  const parsed = JSON.parse(env.Value);
  assert.equal(parsed[0].name, "flat");
  assert.match(parsed[0].content, /flat manifest/);
  rmSync(base, { recursive: true, force: true });
});

test("resolveSkills injects harness file: skills into system prompt", async () => {
  const base = tempDir("oma-fs-resolve-");
  const skillDir = join(base, "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "harness skill body");
  writeFileSync(
    join(base, "agent.yaml"),
    [
      "name: harness-skills",
      "runtime: harness",
      "model: test",
      "system: base prompt",
      "skills:",
      "  - source: file:./skills/demo",
    ].join("\n"),
    "utf-8",
  );

  const prevCwd = process.cwd();
  const prevConfig = process.env.AGENT_CONFIG;
  delete process.env.AGENT_CONFIG;
  process.chdir(base);

  try {
    const loaded = await loadAgentConfig();
    const resolved = await resolveSkills(loaded);
    assert.match(resolved.system, /base prompt/);
    assert.match(resolved.system, /# Skill: demo/);
    assert.match(resolved.system, /harness skill body/);
  } finally {
    process.chdir(prevCwd);
    if (prevConfig === undefined) delete process.env.AGENT_CONFIG;
    else process.env.AGENT_CONFIG = prevConfig;
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveSkills no-op for managed runtime", async () => {
  const config = {
    name: "m",
    model: "x",
    system: "only base",
    runtime: "managed",
    skills: [{ source: "file:./skills/x" }],
  };
  const out = await resolveSkills(config);
  assert.equal(out.system, "only base");
});
