import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInteractiveMock, script, text } from "../../pi-mock/dist/index.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CLI = join(ROOT, "bin/agent-skills.mjs");
const TIMEOUT = 30_000;
const ALPHA = join(ROOT, "test/fixtures/alpha-skill");
const BETA = join(ROOT, "test/fixtures/beta-skill");

function makeSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill.\n---\n# ${name}\n`);
}

function skillArgs(baseDir, names) {
  return names.flatMap((name) => ["--skill", join(baseDir, name, "SKILL.md")]);
}

function buildTempSkillHome() {
  const dir = mkdtempSync(join(tmpdir(), "agent-skills-pi-mock-"));
  const home = join(dir, "home");
  const agentSkillsDir = join(home, ".agents/skills");
  const piSkillsDir = join(home, ".pi/agent/skills");
  mkdirSync(agentSkillsDir, { recursive: true });
  makeSkill(join(agentSkillsDir, "imported-skill"), "imported-skill");
  makeSkill(join(agentSkillsDir, "ignored-skill"), "ignored-skill");

  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    piSkillsDir,
    agentSkillsDir,
    importAgentSkills: true,
    ignoredAgentSkills: ["ignored-skill"],
    localSkills: [
      { name: "alpha-skill", source: ALPHA },
      { name: "beta-skill", source: BETA },
    ],
  }, null, 2));

  const apply = spawnSync(process.execPath, [CLI, "apply"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AGENT_SKILLS_CONFIG: configPath },
  });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  return { dir, home, piSkillsDir };
}

test("pi-mock loads every temp skill from agent-skills generated symlink fanout", async () => {
  const { dir, home, piSkillsDir } = buildTempSkillHome();
  const expectedSkills = ["alpha-skill", "beta-skill", "imported-skill"];
  const mock = await createInteractiveMock({
    brain: script(text("unused")),
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-20250514",
    env: { HOME: home },
    piArgs: skillArgs(piSkillsDir, expectedSkills),
    startupTimeoutMs: 20_000,
    terminal: { cols: 160, rows: 45 },
  });

  try {
    for (const skill of expectedSkills) await mock.waitForOutput(skill, TIMEOUT);
    assert.doesNotMatch(mock.output, /ignored-skill/);
    assert.doesNotMatch(mock.output, /Skill conflicts|collision|office-hours/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pi-mock loads every real generated skill and excludes ignored office-hours", async () => {
  const apply = spawnSync(process.execPath, [CLI, "apply"], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);

  const expectedSkills = [
    "agentvibe",
    "zcouncil",
    "yc-office-hours",
    "pi-mock",
    "agent-skills",
    "agent-browser",
    "agent-recall",
    "agents-sdk",
    "ai-sdk",
    "better-auth-best-practices",
    "convex",
    "kernel-cli",
    "streamdown",
    "turborepo",
    "use-railway",
    "wrangler",
  ];

  const mock = await createInteractiveMock({
    brain: script(text("unused")),
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-20250514",
    piArgs: skillArgs(join(process.env.HOME, ".pi/agent/skills"), expectedSkills),
    startupTimeoutMs: 20_000,
    terminal: { cols: 180, rows: 45 },
  });

  try {
    for (const skill of expectedSkills) await mock.waitForOutput(skill, TIMEOUT);
    assert.doesNotMatch(mock.output, /(^|[\s,])office-hours(?=[\s,]|$)/m);
    assert.doesNotMatch(mock.output, /Skill conflicts|collision/);
  } finally {
    await mock.close();
  }
});
