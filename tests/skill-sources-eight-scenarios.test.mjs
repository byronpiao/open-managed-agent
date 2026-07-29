/**
 * Eight skill source scenarios (CI — no network).
 *
 * 1. file: local relative path
 * 2. file: local absolute path
 * 3. git: single skill (#subpath)
 * 4. git: whole-repo bundle scan
 * 5. skillhub: slug shorthand
 * 6. skillhub: full page URL
 * 7. skills.sh: shorthand
 * 8. skills.sh: full page URL
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, mkdtempSync } from "fs";

import {
  parseSkillSource,
  parseSkillhubSlug,
  parseSkillsShPayload,
  resolveSkillArtifacts,
  readInstallManifest,
  normalizeGitUrl,
} from "../lib/skill-sources.mjs";
import {
  syncSkillsInDir,
  listSkillNamesInDir,
} from "../lib/skills-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "skills-repo");
const TMP = join("/tmp", "oma-skill-eight-scenarios");

function resetTmp() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

/** Fake git clone → copy a fixture tree into a temp dir. */
function mockCloneFixture(fixtureRel) {
  return (_cloneUrl, _branch, tempParent) => {
    mkdirSync(tempParent, { recursive: true });
    const dest = mkdtempSync(join(tempParent, "mock-clone-"));
    cpSync(join(FIXTURES, fixtureRel), dest, { recursive: true });
    return dest;
  };
}

function mockSkillhubFetch(slug, markdown) {
  const metaPrefix = `https://api.skillhub.tencent.com/api/v1/skills/${slug}`;
  return async (url) => {
    if (url.includes("/file?")) {
      return { ok: true, text: async () => markdown };
    }
    if (url === metaPrefix || url.startsWith(`${metaPrefix}?`)) {
      return {
        ok: true,
        json: async () => ({
          latestVersion: { version: "1.0.0" },
        }),
      };
    }
    return { ok: false, status: 404 };
  };
}

function deployCtx(extra = {}) {
  return {
    configDir: join(TMP, "cfg"),
    cwd: join(TMP, "cwd"),
    ...extra,
  };
}

test("1. local relative path → skills/<name>/", async () => {
  resetTmp();
  const configDir = join(TMP, "cfg");
  const relSkill = join(configDir, "skills", "local-rel");
  mkdirSync(relSkill, { recursive: true });
  writeFileSync(join(relSkill, "SKILL.md"), "# local relative\nmarker: rel\n");

  const deploySkills = join(TMP, "d1", "skills");
  const result = await syncSkillsInDir(
    [{ source: "file:./skills/local-rel" }],
    deploySkills,
    deployCtx({ configDir, cwd: configDir }),
  );

  assert.ok(result.added.includes("local-rel"));
  const body = readFileSync(join(deploySkills, "local-rel", "SKILL.md"), "utf-8");
  assert.match(body, /marker: rel/);
});

test("2. local absolute path → skills/<name>/", async () => {
  resetTmp();
  const absSkill = join(TMP, "local-abs");
  mkdirSync(absSkill, { recursive: true });
  writeFileSync(join(absSkill, "SKILL.md"), "# local absolute\nmarker: abs\n");

  const deploySkills = join(TMP, "d2", "skills");
  const result = await syncSkillsInDir(
    [{ source: `file:${absSkill}` }],
    deploySkills,
    deployCtx({ configDir: TMP, cwd: TMP }),
  );

  assert.ok(result.added.includes("local-abs"));
  assert.match(
    readFileSync(join(deploySkills, "local-abs", "SKILL.md"), "utf-8"),
    /marker: abs/,
  );
});

test("3. git: single skill (#subpath)", async () => {
  resetTmp();
  const deploySkills = join(TMP, "d3", "skills");
  const cloneMock = mockCloneFixture("nested");

  const result = await syncSkillsInDir(
    [{
      source: "git:https://github.com/example/skills.git#tdd",
    }],
    deploySkills,
    deployCtx({ cloneGitRepo: cloneMock }),
  );

  assert.ok(result.added.includes("tdd"));
  assert.match(
    readFileSync(join(deploySkills, "tdd", "SKILL.md"), "utf-8"),
    /Codeword: beta/,
  );
});

test("4. git: whole-repo bundle scan + manifest", async () => {
  resetTmp();
  const deploySkills = join(TMP, "d4", "skills");
  const cloneMock = mockCloneFixture("nested");

  const bundleSource = "git:https://github.com/example/skills.git";
  const result = await syncSkillsInDir(
    [{ source: bundleSource }],
    deploySkills,
    deployCtx({ cloneGitRepo: cloneMock }),
  );

  const names = listSkillNamesInDir(deploySkills);
  assert.ok(names.includes("tdd"));
  assert.ok(names.includes("other-skill"));
  assert.ok(result.added.includes("tdd") || result.updated.includes("tdd"));

  const manifest = readInstallManifest(deploySkills);
  assert.ok(manifest.bundles?.[bundleSource]);
  assert.ok(manifest.bundles[bundleSource].installed.includes("tdd"));
});

test("4b. bundle row removed deletes manifest-installed skill dirs", async () => {
  resetTmp();
  const deploySkills = join(TMP, "d4b", "skills");
  const cloneMock = mockCloneFixture("nested");

  const bundleSource = "git:https://github.com/example/skills.git";
  await syncSkillsInDir(
    [{ source: bundleSource }],
    deploySkills,
    deployCtx({ cloneGitRepo: cloneMock }),
  );

  assert.ok(existsSync(join(deploySkills, "tdd", "SKILL.md")));
  assert.ok(existsSync(join(deploySkills, "other-skill", "SKILL.md")));

  const removed = await syncSkillsInDir([], deploySkills, deployCtx());

  assert.ok(removed.removed.includes("tdd"));
  assert.ok(removed.removed.includes("other-skill"));
  assert.equal(existsSync(join(deploySkills, "tdd")), false);
  assert.equal(existsSync(join(deploySkills, "other-skill")), false);
  const manifest = readInstallManifest(deploySkills);
  assert.equal(manifest.bundles?.[bundleSource], undefined);
});

test("5. skillhub: slug shorthand (poster)", async () => {
  resetTmp();
  const deploySkills = join(TMP, "d5", "skills");
  const slug = "poster";
  const fullUrl = "https://skillhub.cn/skills/poster";
  assert.equal(parseSkillhubSlug(slug), slug);
  assert.equal(parseSkillhubSlug(fullUrl), slug);

  const result = await syncSkillsInDir(
    [{ source: `skillhub:${slug}` }],
    deploySkills,
    deployCtx({
      fetchImpl: mockSkillhubFetch(slug, "# skillhub poster\nmarker: hub-slug\n"),
    }),
  );

  assert.ok(result.added.includes("poster"));
  assert.match(
    readFileSync(join(deploySkills, "poster", "SKILL.md"), "utf-8"),
    /marker: hub-slug/,
  );
});

test("6. skillhub: full page URL (canonical)", async () => {
  resetTmp();
  const deploySkills = join(TMP, "d6", "skills");
  const url = "https://skillhub.cn/skills/academic-pre-review-committee";
  const slug = "academic-pre-review-committee";
  assert.equal(parseSkillhubSlug(url), slug);

  const result = await syncSkillsInDir(
    [{ source: `skillhub:${url}` }],
    deploySkills,
    deployCtx({
      fetchImpl: mockSkillhubFetch(slug, "# skillhub canonical\nmarker: hub-url\n"),
    }),
  );

  assert.ok(result.added.includes("academic-pre-review-committee"));
  assert.match(
    readFileSync(join(deploySkills, "academic-pre-review-committee", "SKILL.md"), "utf-8"),
    /marker: hub-url/,
  );
});

test("7. skills.sh: shorthand (edit-article)", async () => {
  resetTmp();
  const deploySkills = join(TMP, "d7", "skills");
  const shorthand = "mattpocock/skills/edit-article";
  const fullUrl = "https://www.skills.sh/mattpocock/skills/edit-article";
  assert.deepEqual(parseSkillsShPayload(shorthand), {
    owner: "mattpocock",
    skillId: "edit-article",
  });
  assert.deepEqual(parseSkillsShPayload(fullUrl), {
    owner: "mattpocock",
    skillId: "edit-article",
  });

  const result = await syncSkillsInDir(
    [{ source: `skills.sh:${shorthand}` }],
    deploySkills,
    deployCtx({ cloneGitRepo: mockCloneFixture("nested") }),
  );

  assert.ok(result.added.includes("edit-article"));
  assert.ok(existsSync(join(deploySkills, "edit-article", "SKILL.md")));
});

test("8. skills.sh: full page URL (canonical tdd)", async () => {
  resetTmp();
  const deploySkills = join(TMP, "d8", "skills");
  const url = "https://www.skills.sh/mattpocock/skills/tdd";
  assert.deepEqual(parseSkillsShPayload(url), {
    owner: "mattpocock",
    skillId: "tdd",
  });

  const result = await syncSkillsInDir(
    [{ source: `skills.sh:${url}` }],
    deploySkills,
    deployCtx({ cloneGitRepo: mockCloneFixture("nested") }),
  );

  assert.ok(result.added.includes("tdd"));
  assert.match(
    readFileSync(join(deploySkills, "tdd", "SKILL.md"), "utf-8"),
    /Codeword: beta/,
  );
});

test("normalizeGitUrl real tree URLs", () => {
  const whole = normalizeGitUrl(
    "https://github.com/RealAlexandreAI/public-skills/tree/main",
  );
  assert.equal(whole.branch, "main");
  assert.equal(whole.cloneUrl, "https://github.com/RealAlexandreAI/public-skills.git");

  const single = normalizeGitUrl(
    "https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff",
  );
  assert.equal(single.subpath, "skills/productivity/handoff");
});

test("parseSkillSource covers all prefix kinds", () => {
  assert.equal(parseSkillSource("git:u").kind, "git");
  assert.equal(parseSkillSource("skillhub:x").kind, "skillhub");
  assert.equal(parseSkillSource("skills.sh:a/b/c").kind, "skillssh");
  assert.equal(parseSkillSource("file:./local").kind, "local");
  assert.throws(() => parseSkillSource("./local"), /protocol prefix/);
});

test("resolveSkillArtifacts git single vs bundle artifact shapes", async () => {
  const cloneMock = mockCloneFixture("nested");
  const gitSingle = "git:https://github.com/x/r.git#tdd";
  const single = await resolveSkillArtifacts(
    { source: gitSingle },
    { cwd: TMP, configDir: TMP, cloneGitRepo: cloneMock, tempParent: join(TMP, "art") },
  );
  assert.equal(single.length, 1);
  assert.equal(single[0].bundleKey, undefined);

  const gitBundle = "git:https://github.com/x/r.git";
  const bundle = await resolveSkillArtifacts(
    { source: gitBundle },
    { cwd: TMP, configDir: TMP, cloneGitRepo: cloneMock, tempParent: join(TMP, "art2") },
  );
  assert.ok(bundle.length >= 2);
  assert.ok(bundle.every((a) => a.bundleKey === gitBundle));
});
