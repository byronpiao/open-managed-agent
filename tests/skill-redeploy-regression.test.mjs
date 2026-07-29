import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { scfAgentCodeUpdateArgs, scfAgentFullUpdateArgs, SCF_DEPLOY_IGNORE } from "../lib/scf-bundle.mjs";
import { agentConfigMatchesDeployStamp } from "../lib/cloudrun.mjs";
import { hashSkillsInDeployDir } from "../lib/skills-sync.mjs";
import { mkdirSync, writeFileSync, rmSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_MJS = readFileSync(join(__dirname, "../lib/commands/agent.mjs"), "utf-8");

test("scfAgentCodeUpdateArgs uses agent update --code", () => {
  const args = scfAgentCodeUpdateArgs("test-env", "agent-abc", "/tmp/deploy");
  assert.deepEqual(args.slice(0, 4), ["agent", "update", "agent-abc", "--code"]);
  assert.equal(args[4], "/tmp/deploy");
  assert.equal(args[5], "--ignore");
  assert.equal(args[6], SCF_DEPLOY_IGNORE);
  assert.doesNotMatch(args.join(" "), /fn.*code.*update/i);
});

test("agent.mjs does not call tcb fn code update for skill redeploy", () => {
  assert.doesNotMatch(AGENT_MJS, /fn",\s*"code",\s*"update"/);
  assert.doesNotMatch(AGENT_MJS, /echo\s+"1\\n"\s*\|\s*tcb\s+fn\s+code\s+update/);
});

test("scfAgentFullUpdateArgs includes atomic env replace", () => {
  const args = scfAgentFullUpdateArgs("test-env", "agent-abc", "/tmp/deploy", "K=V::");
  assert.ok(args.includes("--env"));
  assert.ok(args.includes("K=V::"));
  assert.ok(args.includes("--code"));
});

test("agentConfigMatchesDeployStamp checks skill hashes", () => {
  const cfg = {
    metadata: {
      __deployedAt: "123",
      __skillHashes: { hello: "abc" },
    },
  };
  assert.equal(
    agentConfigMatchesDeployStamp(cfg, {
      deployedAt: "123",
      skillHashes: { hello: "abc" },
    }),
    true,
  );
  assert.equal(
    agentConfigMatchesDeployStamp(cfg, {
      deployedAt: "123",
      skillHashes: { hello: "old" },
    }),
    false,
  );
});

test("hashSkillsInDeployDir tracks skill content", () => {
  const root = join("/tmp", `magent-hash-${Date.now()}`);
  const skillDir = join(root, "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# v1");
  const h1 = hashSkillsInDeployDir(root, ["demo"]);
  writeFileSync(join(skillDir, "SKILL.md"), "# v2");
  const h2 = hashSkillsInDeployDir(root, ["demo"]);
  assert.notEqual(h1.demo, h2.demo);
  rmSync(root, { recursive: true, force: true });
});

test("agent.mjs skill redeploy uses atomic scfAgentFullUpdateArgs", () => {
  assert.match(AGENT_MJS, /scfAgentFullUpdateArgs/);
});
