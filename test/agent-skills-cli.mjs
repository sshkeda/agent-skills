import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CLI = join(ROOT, "bin/agent-skills.mjs");
const ALPHA = join(ROOT, "test/fixtures/alpha-skill");
const BETA = join(ROOT, "test/fixtures/beta-skill");

function makeSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`);
}

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "agent-skills-test-"));
  const home = join(dir, "home");
  const agentSkillsDir = join(dir, ".agents/skills");
  const piSkillsDir = join(home, ".pi/agent/skills");
  mkdirSync(agentSkillsDir, { recursive: true });
  makeSkill(join(agentSkillsDir, "imported-skill"), "imported-skill");
  makeSkill(join(agentSkillsDir, "ignored-skill"), "ignored-skill");
  const config = {
    piSkillsDir,
    agentSkillsDir,
    importAgentSkills: true,
    ignoredAgentSkills: ["ignored-skill"],
    localSkills: [
      { name: "alpha-skill", source: ALPHA },
      { name: "beta-skill", source: BETA },
    ],
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { dir, home, agentSkillsDir, piSkillsDir, configPath };
}

function run(args, configPath, options = {}) {
  const home = configPath.startsWith(ROOT) ? process.env.HOME : resolve(configPath, "../home");
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_SKILLS_CONFIG: configPath, HOME: home },
    ...options,
  });
}

test("list/check validate local skills and imported agent skills", () => {
  const t = tempConfig();
  try {
    const list = run(["list"], t.configPath);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /Local skills/);
    assert.match(list.stdout, /alpha-skill/);
    assert.match(list.stdout, /Imported .* entries: imported-skill/);
    assert.doesNotMatch(list.stdout, /Imported .*ignored-skill/);

    const bad = run(["check"], t.configPath);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /missing; run agent-skills apply/);

    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);

    const check = run(["check"], t.configPath);
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /2 local skills, 1 imported agent skills, 1 ignored agent skills/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("apply rebuilds ~/.pi/agent/skills as managed symlink dir", () => {
  const t = tempConfig();
  try {
    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
    assert.equal(lstatSync(t.piSkillsDir).isDirectory(), true);
    assert.equal(lstatSync(t.piSkillsDir).isSymbolicLink(), false);
    assert.equal(lstatSync(join(t.piSkillsDir, "alpha-skill")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(t.piSkillsDir, "beta-skill")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(t.piSkillsDir, "imported-skill")).isSymbolicLink(), true);
    assert.throws(() => lstatSync(join(t.piSkillsDir, "ignored-skill")));
    assert.equal(resolve(readlinkSync(join(t.piSkillsDir, "alpha-skill"))), ALPHA);
    assert.equal(resolve(readlinkSync(join(t.piSkillsDir, "imported-skill"))), join(t.agentSkillsDir, "imported-skill"));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("check rejects legacy config keys", () => {
  const t = tempConfig();
  try {
    const config = JSON.parse(readFileSync(t.configPath, "utf8"));
    config.globalSkills = [{ name: "alpha-skill", source: ALPHA }];
    config.disabledGlobalSkills = ["old-skill"];
    writeFileSync(t.configPath, JSON.stringify(config, null, 2));
    const check = run(["check"], t.configPath);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /unsupported legacy config keys: globalSkills, disabledGlobalSkills/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("check catches name mismatches", () => {
  const t = tempConfig();
  try {
    const config = JSON.parse(readFileSync(t.configPath, "utf8"));
    config.localSkills = [{ name: "wrong-name", source: ALPHA }];
    writeFileSync(t.configPath, JSON.stringify(config, null, 2));
    const check = run(["check"], t.configPath);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /SKILL.md declares name alpha-skill/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("patch applies exact local skill text patches and check verifies them", () => {
  const t = tempConfig();
  try {
    const skillDir = join(ROOT, "test/fixtures/patch-target-skill");
    const skillFile = join(skillDir, "SKILL.md");
    const patchesFile = join(t.dir, "skill-patches.json");
    const original = "---\nname: patch-target-skill\ndescription: patch target\n---\n# Patch Target\n\nOriginal line.\n";
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, original);
    writeFileSync(patchesFile, JSON.stringify([
      {
        id: "patch-target-local-note",
        file: "test/fixtures/patch-target-skill/SKILL.md",
        intent: "Prove local skill patches are replayable.",
        find: "Original line.\n",
        replace: "Original line.\nLocal patched line.\n",
        verify: "Local patched line.",
        occurrences: 1,
      },
    ], null, 2));
    const config = JSON.parse(readFileSync(t.configPath, "utf8"));
    config.skillPatchesFile = patchesFile;
    writeFileSync(t.configPath, JSON.stringify(config, null, 2));

    const before = run(["patch", "--check"], t.configPath);
    assert.equal(before.status, 1);
    assert.match(before.stdout, /would patch test\/fixtures\/patch-target-skill\/SKILL\.md/);

    const apply = run(["patch"], t.configPath);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
    assert.match(readFileSync(skillFile, "utf8"), /Local patched line\./);

    const after = run(["patch", "--check"], t.configPath);
    assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`);
    assert.match(after.stdout, /ok test\/fixtures\/patch-target-skill\/SKILL\.md patches applied/);
  } finally {
    rmSync(join(ROOT, "test/fixtures/patch-target-skill"), { recursive: true, force: true });
    rmSync(t.dir, { recursive: true, force: true });
  }
});

function tempConfigWithClaude(opts = {}) {
  const t = tempConfig();
  const claudeSkillsDir = join(t.home, ".claude/skills");
  if (opts.preExistingClaudeSkills) {
    mkdirSync(claudeSkillsDir, { recursive: true });
    for (const name of opts.preExistingClaudeSkills) {
      makeSkill(join(claudeSkillsDir, name), name);
    }
  }
  const config = JSON.parse(readFileSync(t.configPath, "utf8"));
  config.claudeSkillsDir = claudeSkillsDir;
  writeFileSync(t.configPath, JSON.stringify(config, null, 2));
  return { ...t, claudeSkillsDir };
}

test("apply syncs agent-managed skills as symlinks into claudeSkillsDir without rebuilding the directory", () => {
  const t = tempConfigWithClaude({ preExistingClaudeSkills: ["claude-own-skill"] });
  try {
    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);

    for (const name of ["alpha-skill", "beta-skill", "imported-skill"]) {
      const dest = join(t.claudeSkillsDir, name);
      assert.equal(lstatSync(dest).isSymbolicLink(), true, `${name} should be a symlink in claude dir`);
    }
    assert.equal(resolve(readlinkSync(join(t.claudeSkillsDir, "alpha-skill"))), ALPHA);

    const ownEntry = join(t.claudeSkillsDir, "claude-own-skill");
    assert.equal(lstatSync(ownEntry).isDirectory(), true, "pre-existing claude skill must survive apply");
    assert.equal(lstatSync(ownEntry).isSymbolicLink(), false);

    const stateFile = join(t.claudeSkillsDir, ".agent-skills.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(state.managedNames, ["alpha-skill", "beta-skill", "imported-skill"]);
    assert.equal(state.version, 1);

    const list = run(["list"], t.configPath);
    assert.match(list.stdout, /Claude skills dir/);
    assert.match(list.stdout, /managed: alpha-skill, beta-skill, imported-skill/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("apply removes claude symlinks for skills dropped from config (state-tracked)", () => {
  const t = tempConfigWithClaude();
  try {
    assert.equal(run(["apply"], t.configPath).status, 0);
    assert.equal(existsSync(join(t.claudeSkillsDir, "beta-skill")), true);

    const config = JSON.parse(readFileSync(t.configPath, "utf8"));
    config.localSkills = config.localSkills.filter((s) => s.name !== "beta-skill");
    writeFileSync(t.configPath, JSON.stringify(config, null, 2));

    const second = run(["apply"], t.configPath);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(existsSync(join(t.claudeSkillsDir, "beta-skill")), false, "dropped skill must be unlinked from claude dir");
    assert.equal(existsSync(join(t.claudeSkillsDir, "alpha-skill")), true);

    const state = JSON.parse(readFileSync(join(t.claudeSkillsDir, ".agent-skills.json"), "utf8"));
    assert.ok(!state.managedNames.includes("beta-skill"));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("apply refuses to overwrite a foreign symlink or real directory in claudeSkillsDir", () => {
  const t = tempConfigWithClaude();
  try {
    mkdirSync(t.claudeSkillsDir, { recursive: true });
    const foreign = join(t.dir, "foreign-target");
    makeSkill(foreign, "alpha-skill");
    symlinkSync(foreign, join(t.claudeSkillsDir, "alpha-skill"));

    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 1, `${apply.stdout}\n${apply.stderr}`);
    assert.match(apply.stderr, /claude:alpha-skill: .* foreign symlink/);

    assert.equal(resolve(readlinkSync(join(t.claudeSkillsDir, "alpha-skill"))), foreign);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("check flags unmanaged symlinks in claudeSkillsDir but leaves harness-owned real directories alone", () => {
  const t = tempConfigWithClaude({ preExistingClaudeSkills: ["claude-own-skill"] });
  try {
    assert.equal(run(["apply"], t.configPath).status, 0);
    assert.equal(run(["check"], t.configPath).status, 0, "real-directory claude-own-skill must not fail check");

    const bypass = join(t.dir, "bypass-target");
    makeSkill(bypass, "bypass-skill");
    symlinkSync(bypass, join(t.claudeSkillsDir, "bypass-skill"));

    const check = run(["check"], t.configPath);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /claude:bypass-skill: unmanaged symlink .* register its source in localSkills/);
    assert.doesNotMatch(check.stderr, /claude-own-skill/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

function tempConfigWithAgentExport(opts = {}) {
  const t = tempConfig();
  if (opts.preExistingAgentSkills) {
    mkdirSync(t.agentSkillsDir, { recursive: true });
    for (const name of opts.preExistingAgentSkills) {
      makeSkill(join(t.agentSkillsDir, name), name);
    }
  }
  const config = JSON.parse(readFileSync(t.configPath, "utf8"));
  config.syncLocalSkillsToAgentSkills = true;
  writeFileSync(t.configPath, JSON.stringify(config, null, 2));
  return t;
}

test("apply exports local skills into agentSkillsDir without rebuilding npx skills", () => {
  const t = tempConfigWithAgentExport({ preExistingAgentSkills: ["agent-own-skill"] });
  try {
    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);

    for (const name of ["alpha-skill", "beta-skill"]) {
      const dest = join(t.agentSkillsDir, name);
      assert.equal(lstatSync(dest).isSymbolicLink(), true, `${name} should be a symlink in agent dir`);
    }
    assert.equal(resolve(readlinkSync(join(t.agentSkillsDir, "alpha-skill"))), ALPHA);
    assert.equal(resolve(readlinkSync(join(t.piSkillsDir, "imported-skill"))), join(t.agentSkillsDir, "imported-skill"));

    const ownEntry = join(t.agentSkillsDir, "agent-own-skill");
    assert.equal(lstatSync(ownEntry).isDirectory(), true, "pre-existing agent skill must survive apply");
    assert.equal(lstatSync(ownEntry).isSymbolicLink(), false);

    const stateFile = join(t.agentSkillsDir, ".agent-skills.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(state.managedNames, ["alpha-skill", "beta-skill"]);
    assert.equal(state.version, 1);

    const list = run(["list"], t.configPath);
    assert.match(list.stdout, /Export local skills to ~\/\.agents\/skills: yes/);
    assert.match(list.stdout, /Agent skills dir/);
    assert.match(list.stdout, /managed: alpha-skill, beta-skill/);

    const check = run(["check"], t.configPath);
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /agent=.*\.agents\/skills/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("apply removes agent symlinks for local skills dropped from config", () => {
  const t = tempConfigWithAgentExport();
  try {
    assert.equal(run(["apply"], t.configPath).status, 0);
    assert.equal(existsSync(join(t.agentSkillsDir, "beta-skill")), true);

    const config = JSON.parse(readFileSync(t.configPath, "utf8"));
    config.localSkills = config.localSkills.filter((s) => s.name !== "beta-skill");
    writeFileSync(t.configPath, JSON.stringify(config, null, 2));

    const second = run(["apply"], t.configPath);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(existsSync(join(t.agentSkillsDir, "beta-skill")), false, "dropped skill must be unlinked from agent dir");
    assert.equal(existsSync(join(t.agentSkillsDir, "alpha-skill")), true);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("apply refuses to overwrite an existing agent skill with the same local skill name", () => {
  const t = tempConfigWithAgentExport({ preExistingAgentSkills: ["alpha-skill"] });
  try {
    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 1, `${apply.stdout}\n${apply.stderr}`);
    assert.match(apply.stderr, /agent:alpha-skill: .* exists and is not an agent-skills symlink/);
    assert.equal(lstatSync(join(t.agentSkillsDir, "alpha-skill")).isSymbolicLink(), false);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("check reports a missing claude install and a state-tracked stale entry", () => {
  const t = tempConfigWithClaude();
  try {
    const checkBeforeApply = run(["check"], t.configPath);
    assert.equal(checkBeforeApply.status, 1);
    assert.match(checkBeforeApply.stderr, /claude: .* missing; run agent-skills apply/);

    assert.equal(run(["apply"], t.configPath).status, 0);
    const okCheck = run(["check"], t.configPath);
    assert.equal(okCheck.status, 0, `${okCheck.stdout}\n${okCheck.stderr}`);
    assert.match(okCheck.stdout, /claude=.*\.claude\/skills/);

    const state = JSON.parse(readFileSync(join(t.claudeSkillsDir, ".agent-skills.json"), "utf8"));
    state.managedNames.push("ghost-skill");
    writeFileSync(join(t.claudeSkillsDir, ".agent-skills.json"), JSON.stringify(state, null, 2));
    symlinkSync(ALPHA, join(t.claudeSkillsDir, "ghost-skill"));

    const stale = run(["check"], t.configPath);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /claude:ghost-skill: previously managed but still present/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

function tempConfigWithCodex(opts = {}) {
  const t = tempConfig();
  const codexSkillsDir = join(t.home, ".codex/skills");
  if (opts.preExistingCodexSkills) {
    mkdirSync(codexSkillsDir, { recursive: true });
    for (const name of opts.preExistingCodexSkills) {
      makeSkill(join(codexSkillsDir, name), name);
    }
  }
  const config = JSON.parse(readFileSync(t.configPath, "utf8"));
  config.codexSkillsDir = codexSkillsDir;
  writeFileSync(t.configPath, JSON.stringify(config, null, 2));
  return { ...t, codexSkillsDir };
}

test("apply syncs agent-managed skills as symlinks into codexSkillsDir without disturbing codex-owned skills", () => {
  const t = tempConfigWithCodex({ preExistingCodexSkills: ["codex-own-skill"] });
  try {
    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);

    for (const name of ["alpha-skill", "beta-skill", "imported-skill"]) {
      const dest = join(t.codexSkillsDir, name);
      assert.equal(lstatSync(dest).isSymbolicLink(), true, `${name} should be a symlink in codex dir`);
    }
    assert.equal(resolve(readlinkSync(join(t.codexSkillsDir, "alpha-skill"))), ALPHA);

    const ownEntry = join(t.codexSkillsDir, "codex-own-skill");
    assert.equal(lstatSync(ownEntry).isDirectory(), true, "pre-existing codex skill must survive apply");
    assert.equal(lstatSync(ownEntry).isSymbolicLink(), false);

    const stateFile = join(t.codexSkillsDir, ".agent-skills.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.deepEqual(state.managedNames, ["alpha-skill", "beta-skill", "imported-skill"]);

    const list = run(["list"], t.configPath);
    assert.match(list.stdout, /Codex skills dir/);
    assert.match(list.stdout, /managed: alpha-skill, beta-skill, imported-skill/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("update --check verifies local yc-office-hours mirrors upstream gstack rename", () => {
  const t = tempConfig();
  try {
    const config = {
      piSkillsDir: t.piSkillsDir,
      agentSkillsDir: t.agentSkillsDir,
      importAgentSkills: false,
      ignoredAgentSkills: [],
      localSkills: [{ name: "yc-office-hours", source: join(ROOT, "skills/yc-office-hours") }],
    };
    writeFileSync(t.configPath, JSON.stringify(config, null, 2));
    const apply = run(["apply"], t.configPath);
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
    const result = run(["update", "--check", "--skip-npx"], t.configPath, { timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /yc-office-hours\/SKILL\.md/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
