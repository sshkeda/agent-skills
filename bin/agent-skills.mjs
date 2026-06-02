#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultConfigPath = path.join(os.homedir(), ".agent-skills", "config.json");
const legacyConfigPath = path.join(os.homedir(), ".pi-skills", "config.json");
const exampleConfigPath = path.join(repoRoot, "config.example.json");
const defaultSkillPatchesFile = path.join(repoRoot, "skill-patches.json");
const defaultPiSkillsDir = path.join(os.homedir(), ".pi", "agent", "skills");
const registryPath = process.env.AGENT_SKILLS_CONFIG
  ? expandPath(process.env.AGENT_SKILLS_CONFIG)
  : process.env.PI_SKILLS_CONFIG
    ? expandPath(process.env.PI_SKILLS_CONFIG)
  : fs.existsSync(defaultConfigPath)
    ? defaultConfigPath
    : fs.existsSync(legacyConfigPath)
      ? legacyConfigPath
    : exampleConfigPath;

function usage() {
  console.log(`agent-skills

Config: ${registryPath}

Usage:
  agent-skills list
  agent-skills check
  agent-skills install-bin [--dry-run] [--force]
  agent-skills install-config [--dry-run] [--force]
  agent-skills apply [--dry-run]
  agent-skills patch [--dry-run] [--check]
  agent-skills update [--dry-run] [--check] [--skip-npx]

Notes:
  apply rebuilds ~/.pi/agent/skills as a managed directory of symlinks.
  localSkills are linked into ~/.pi/agent/skills so Pi can discover them.
  importAgentSkills imports non-ignored entries from ~/.agents/skills.
  syncLocalSkillsToAgentSkills can publish localSkills into ~/.agents/skills.
`);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function expandPath(input) {
  let p = input
    .replace(/^~(?=$|\/)/, os.homedir())
    .replaceAll("${HOME}", os.homedir())
    .replaceAll("${GITHUB}", path.join(os.homedir(), "GitHub"));
  if (p.startsWith("./") || p === ".") p = path.resolve(repoRoot, p);
  return p;
}

function registry() {
  const cfg = readJson(registryPath);
  const legacyKeys = ["skillDirectory", "piSkillDirectorySymlink", "globalSkills", "disabledGlobalSkills"].filter((key) => Object.hasOwn(cfg, key));
  return {
    legacyKeys,
    piSkillsDir: expandPath(cfg.piSkillsDir ?? "~/.pi/agent/skills"),
    claudeSkillsDir: cfg.claudeSkillsDir == null ? undefined : expandPath(cfg.claudeSkillsDir),
    codexSkillsDir: cfg.codexSkillsDir == null ? undefined : expandPath(cfg.codexSkillsDir),
    agentSkillsDir: expandPath(cfg.agentSkillsDir ?? "~/.agents/skills"),
    skillPatchesFile: expandPath(cfg.skillPatchesFile ?? defaultSkillPatchesFile),
    importAgentSkills: cfg.importAgentSkills !== false,
    syncLocalSkillsToAgentSkills: cfg.syncLocalSkillsToAgentSkills === true,
    ignoredAgentSkills: cfg.ignoredAgentSkills ?? [],
    localSkills: (cfg.localSkills ?? [])
      .filter((s) => s.enabled !== false)
      .map((s) => ({ ...s, source: expandPath(s.source) })),
  };
}

const STATE_FILE = ".agent-skills.json";
const LEGACY_STATE_FILE = ".pi-skills.json";

function claudeStatePath(cfg) { return cfg.claudeSkillsDir ? path.join(cfg.claudeSkillsDir, STATE_FILE) : undefined; }
function codexStatePath(cfg) { return cfg.codexSkillsDir ? path.join(cfg.codexSkillsDir, STATE_FILE) : undefined; }
function agentStatePath(cfg) { return path.join(cfg.agentSkillsDir, STATE_FILE); }
function legacyStatePath(file) { return file ? path.join(path.dirname(file), LEGACY_STATE_FILE) : undefined; }

function readManagedState(file) {
  if (!file) return { version: 1, managedNames: [] };
  const stateFile = fs.existsSync(file) ? file : legacyStatePath(file);
  if (!stateFile || !fs.existsSync(stateFile)) return { version: 1, managedNames: [] };
  try {
    const data = readJson(stateFile);
    return {
      version: typeof data.version === "number" ? data.version : 1,
      managedNames: Array.isArray(data.managedNames) ? data.managedNames.filter((n) => typeof n === "string") : [],
    };
  } catch {
    return { version: 1, managedNames: [] };
  }
}

function readClaudeState(cfg) { return readManagedState(claudeStatePath(cfg)); }
function readCodexState(cfg) { return readManagedState(codexStatePath(cfg)); }
function readAgentState(cfg) { return readManagedState(agentStatePath(cfg)); }

function writeManagedState(file, managedNames) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, { version: 1, managedNames: [...managedNames].sort() });
}

function writeClaudeState(cfg, managedNames) {
  const file = claudeStatePath(cfg);
  if (!file) return;
  writeManagedState(file, managedNames);
}

function writeCodexState(cfg, managedNames) {
  const file = codexStatePath(cfg);
  if (!file) return;
  writeManagedState(file, managedNames);
}

function writeAgentState(cfg, managedNames) { writeManagedState(agentStatePath(cfg), managedNames); }

function rel(p) { return p.replace(os.homedir(), "~"); }
function pathExists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function validName(name) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name); }
function currentEntries(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith(".")) : []; }
function linkTarget(link) { try { return path.resolve(path.dirname(link), fs.readlinkSync(link)); } catch { return null; } }
function canonicalPath(p) {
  if (!p) return "";
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}
function samePath(a, b) { return canonicalPath(a) === canonicalPath(b); }

function skillFileName(source) {
  const skillFile = path.join(source, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  const match = fs.readFileSync(skillFile, "utf8").match(/^name:\s*([^\n]+)\s*$/m);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
}

function validateSkill(name, source, issues) {
  if (!validName(name)) issues.push(`invalid skill name: ${name}`);
  if (!fs.existsSync(source)) {
    issues.push(`${name}: source missing: ${source}`);
    return;
  }
  const skillFile = path.join(source, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    issues.push(`${name}: missing SKILL.md at ${skillFile}`);
    return;
  }
  const declaredName = skillFileName(source);
  if (declaredName && declaredName !== name) issues.push(`${name}: SKILL.md declares name ${declaredName}`);
}

function importedAgentSkills(cfg) {
  if (!cfg.importAgentSkills) return [];
  const ignored = new Set(cfg.ignoredAgentSkills);
  const local = new Set(cfg.localSkills.map((s) => s.name));
  const managedAgent = cfg.syncLocalSkillsToAgentSkills
    ? new Set(readAgentState(cfg).managedNames)
    : new Set();
  return currentEntries(cfg.agentSkillsDir)
    .filter((name) => !ignored.has(name))
    .filter((name) => !local.has(name))
    .filter((name) => !managedAgent.has(name))
    .map((name) => ({ name, source: path.join(cfg.agentSkillsDir, name), imported: true }));
}

function expectedSkills(cfg) {
  const map = new Map();
  for (const skill of importedAgentSkills(cfg)) map.set(skill.name, skill);
  for (const skill of cfg.localSkills) map.set(skill.name, skill);
  return map;
}

function validateConfig(cfg) {
  const issues = [];
  if (cfg.legacyKeys.length) issues.push(`unsupported legacy config keys: ${cfg.legacyKeys.join(", ")}`);
  const names = new Set();
  for (const skill of cfg.localSkills) {
    if (names.has(skill.name)) issues.push(`duplicate configured local skill: ${skill.name}`);
    names.add(skill.name);
    validateSkill(skill.name, skill.source, issues);
  }
  for (const skill of importedAgentSkills(cfg)) validateSkill(skill.name, skill.source, issues);
  return issues;
}

function loadSkillPatches(cfg) {
  if (!fs.existsSync(cfg.skillPatchesFile)) return [];
  const raw = readJson(cfg.skillPatchesFile);
  const patches = Array.isArray(raw) ? raw : raw.patches;
  if (!Array.isArray(patches)) throw new Error(`${cfg.skillPatchesFile} must contain an array or { "patches": [...] }`);
  return patches.map((patch) => ({ occurrences: 1, ...patch }));
}

function validateSkillPatch(patch) {
  const missing = ["id", "file", "find", "replace", "verify"].filter((key) => typeof patch[key] !== "string");
  if (missing.length) throw new Error(`skill patch ${patch.id ?? "<unknown>"} missing string field(s): ${missing.join(", ")}`);
  if (!validName(patch.id)) throw new Error(`skill patch id must be kebab-case: ${patch.id}`);
  if (path.isAbsolute(patch.file) || patch.file.includes("..")) throw new Error(`skill patch ${patch.id} file must be repo-relative: ${patch.file}`);
  if (!Number.isInteger(patch.occurrences) || patch.occurrences < 1) throw new Error(`skill patch ${patch.id} occurrences must be a positive integer`);
}

function applySkillPatchesToText(text, relativePath, patches) {
  let output = text;
  let changed = false;
  for (const patch of patches.filter((entry) => entry.file === relativePath)) {
    validateSkillPatch(patch);
    if (output.includes(patch.verify)) continue;
    const count = output.split(patch.find).length - 1;
    if (count !== patch.occurrences) {
      throw new Error(`skill patch ${patch.id} target mismatch in ${relativePath}: expected ${patch.occurrences}, found ${count}`);
    }
    output = output.replaceAll(patch.find, patch.replace);
    if (!output.includes(patch.verify)) throw new Error(`skill patch ${patch.id} verify string missing after apply in ${relativePath}`);
    changed = true;
  }
  return { text: output, changed };
}

function patchedSkillText(cfg, relativePath, text) {
  return applySkillPatchesToText(text, relativePath, loadSkillPatches(cfg)).text;
}

function patchSkills(args) {
  const dryRun = args.includes("--dry-run") || args.includes("--check");
  const checkOnly = args.includes("--check");
  const cfg = registry();
  const patches = loadSkillPatches(cfg);
  const files = [...new Set(patches.map((patch) => {
    validateSkillPatch(patch);
    return patch.file;
  }))].sort();
  let changed = false;

  for (const relativePath of files) {
    const file = path.join(repoRoot, relativePath);
    if (!fs.existsSync(file)) {
      console.error(`ERROR skill patch target missing: ${relativePath}`);
      return 1;
    }
    const current = fs.readFileSync(file, "utf8");
    let next;
    try {
      next = applySkillPatchesToText(current, relativePath, patches).text;
    } catch (error) {
      console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (next === current) {
      console.log(`ok ${relativePath} patches applied`);
      continue;
    }
    changed = true;
    console.log(`${dryRun ? "would patch" : "patch"} ${relativePath}`);
    if (!dryRun) fs.writeFileSync(file, next);
  }

  if (checkOnly && changed) return 1;
  return 0;
}

function checkClaude(cfg, expected) {
  if (!cfg.claudeSkillsDir) return [];
  const issues = [];

  if (!pathExists(cfg.claudeSkillsDir)) {
    issues.push(`claude: ${cfg.claudeSkillsDir} missing; run agent-skills apply`);
    return issues;
  }
  const stat = fs.lstatSync(cfg.claudeSkillsDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    issues.push(`claude: ${cfg.claudeSkillsDir} is not a directory`);
    return issues;
  }

  for (const [name, skill] of expected) {
    const dest = path.join(cfg.claudeSkillsDir, name);
    if (!pathExists(dest)) { issues.push(`claude:${name}: not installed at ${dest}`); continue; }
    const entryStat = fs.lstatSync(dest);
    if (!entryStat.isSymbolicLink()) { issues.push(`claude:${name}: ${dest} is not a symlink (resolve manually or move aside)`); continue; }
    const target = linkTarget(dest);
    if (!samePath(target, skill.source)) issues.push(`claude:${name}: symlink target ${target}, expected ${skill.source}`);
  }

  const state = readClaudeState(cfg);
  for (const stale of state.managedNames) {
    if (expected.has(stale)) continue;
    const dest = path.join(cfg.claudeSkillsDir, stale);
    if (pathExists(dest)) issues.push(`claude:${stale}: previously managed but still present at ${dest}; run agent-skills apply to remove`);
  }
  return issues;
}

function checkCodex(cfg, expected) {
  if (!cfg.codexSkillsDir) return [];
  const issues = [];

  if (!pathExists(cfg.codexSkillsDir)) {
    issues.push(`codex: ${cfg.codexSkillsDir} missing; run agent-skills apply`);
    return issues;
  }
  const stat = fs.lstatSync(cfg.codexSkillsDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    issues.push(`codex: ${cfg.codexSkillsDir} is not a directory`);
    return issues;
  }

  for (const [name, skill] of expected) {
    const dest = path.join(cfg.codexSkillsDir, name);
    if (!pathExists(dest)) { issues.push(`codex:${name}: not installed at ${dest}`); continue; }
    const entryStat = fs.lstatSync(dest);
    if (!entryStat.isSymbolicLink()) { issues.push(`codex:${name}: ${dest} is not a symlink (resolve manually or move aside)`); continue; }
    const target = linkTarget(dest);
    if (!samePath(target, skill.source)) issues.push(`codex:${name}: symlink target ${target}, expected ${skill.source}`);
  }

  const state = readCodexState(cfg);
  for (const stale of state.managedNames) {
    if (expected.has(stale)) continue;
    const dest = path.join(cfg.codexSkillsDir, stale);
    if (pathExists(dest)) issues.push(`codex:${stale}: previously managed but still present at ${dest}; run agent-skills apply to remove`);
  }
  return issues;
}

function localSkillMap(cfg) {
  const map = new Map();
  for (const skill of cfg.localSkills) map.set(skill.name, skill);
  return map;
}

function checkAgentExports(cfg) {
  if (!cfg.syncLocalSkillsToAgentSkills) return [];
  const issues = [];
  const expected = localSkillMap(cfg);

  if (!pathExists(cfg.agentSkillsDir)) {
    issues.push(`agent: ${cfg.agentSkillsDir} missing; run agent-skills apply`);
    return issues;
  }
  const stat = fs.lstatSync(cfg.agentSkillsDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    issues.push(`agent: ${cfg.agentSkillsDir} is not a directory`);
    return issues;
  }

  for (const [name, skill] of expected) {
    const dest = path.join(cfg.agentSkillsDir, name);
    if (!pathExists(dest)) { issues.push(`agent:${name}: not installed at ${dest}`); continue; }
    const entryStat = fs.lstatSync(dest);
    if (!entryStat.isSymbolicLink()) { issues.push(`agent:${name}: ${dest} is not a symlink (resolve manually or move aside)`); continue; }
    const target = linkTarget(dest);
    if (!samePath(target, skill.source)) issues.push(`agent:${name}: symlink target ${target}, expected ${skill.source}`);
  }

  const state = readAgentState(cfg);
  for (const stale of state.managedNames) {
    if (expected.has(stale)) continue;
    const dest = path.join(cfg.agentSkillsDir, stale);
    if (pathExists(dest)) issues.push(`agent:${stale}: previously managed but still present at ${dest}; run agent-skills apply to remove`);
  }
  return issues;
}

function check() {
  const cfg = registry();
  const issues = validateConfig(cfg);
  const expected = expectedSkills(cfg);

  if (!pathExists(cfg.piSkillsDir)) {
    issues.push(`${cfg.piSkillsDir} missing; run agent-skills apply`);
  } else {
    const stat = fs.lstatSync(cfg.piSkillsDir);
    if (stat.isSymbolicLink()) issues.push(`${cfg.piSkillsDir} is a symlink; run agent-skills apply to replace it with a managed directory`);
    else if (!stat.isDirectory()) issues.push(`${cfg.piSkillsDir} is not a directory`);
  }

  if (pathExists(cfg.piSkillsDir) && !fs.lstatSync(cfg.piSkillsDir).isSymbolicLink()) {
    for (const [name, skill] of expected) {
      const dest = path.join(cfg.piSkillsDir, name);
      if (!pathExists(dest)) {
        issues.push(`${name}: not installed at ${dest}`);
        continue;
      }
      const stat = fs.lstatSync(dest);
      if (!stat.isSymbolicLink()) {
        issues.push(`${name}: installed path is not a symlink: ${dest}`);
        continue;
      }
      const target = linkTarget(dest);
      if (!samePath(target, skill.source)) issues.push(`${name}: symlink target ${target}, expected ${skill.source}`);
    }
    for (const name of cfg.ignoredAgentSkills) {
      const dest = path.join(cfg.piSkillsDir, name);
      if (pathExists(dest)) issues.push(`${name}: ignored agent skill installed at ${dest}`);
    }
    for (const name of currentEntries(cfg.piSkillsDir)) {
      if (!expected.has(name)) issues.push(`${name}: unmanaged entry in ${cfg.piSkillsDir}`);
    }
  }

  issues.push(...checkClaude(cfg, expected));
  issues.push(...checkCodex(cfg, expected));
  issues.push(...checkAgentExports(cfg));

  if (issues.length) {
    for (const issue of issues) console.error(`ERROR ${issue}`);
    return 1;
  }
  const claudeSummary = cfg.claudeSkillsDir ? `, claude=${rel(cfg.claudeSkillsDir)}` : "";
  const codexSummary = cfg.codexSkillsDir ? `, codex=${rel(cfg.codexSkillsDir)}` : "";
  const agentSummary = cfg.syncLocalSkillsToAgentSkills ? `, agent=${rel(cfg.agentSkillsDir)}` : "";
  console.log(`OK ${rel(cfg.piSkillsDir)}${claudeSummary}${codexSummary}${agentSummary} (${cfg.localSkills.length} local skills, ${importedAgentSkills(cfg).length} imported agent skills, ${cfg.ignoredAgentSkills.length} ignored agent skills)`);
  return 0;
}

function list() {
  const cfg = registry();
  if (cfg.localSkills.length) {
    console.log("Local skills:");
    for (const skill of cfg.localSkills) console.log(`  ${skill.name} -> ${rel(skill.source)}`);
  }
  if (cfg.ignoredAgentSkills.length) console.log(`Ignored agent skills: ${cfg.ignoredAgentSkills.join(", ")}`);
  const imported = importedAgentSkills(cfg);
  if (imported.length) console.log(`Imported ~/.agents/skills entries: ${imported.map((s) => s.name).sort().join(", ")}`);
  console.log(`Import ~/.agents/skills: ${cfg.importAgentSkills ? "yes" : "no"}`);
  console.log(`Export local skills to ~/.agents/skills: ${cfg.syncLocalSkillsToAgentSkills ? "yes" : "no"}`);
  console.log(`Pi discovery dir: ${rel(cfg.piSkillsDir)} ${pathExists(cfg.piSkillsDir) ? "exists" : "missing"}`);
  if (cfg.syncLocalSkillsToAgentSkills) {
    const managed = readAgentState(cfg).managedNames;
    console.log(`Agent skills dir: ${rel(cfg.agentSkillsDir)} ${pathExists(cfg.agentSkillsDir) ? "exists" : "missing"}${managed.length ? ` (managed: ${managed.sort().join(", ")})` : ""}`);
  }
  if (cfg.claudeSkillsDir) {
    const managed = readClaudeState(cfg).managedNames;
    console.log(`Claude skills dir: ${rel(cfg.claudeSkillsDir)} ${pathExists(cfg.claudeSkillsDir) ? "exists" : "missing"}${managed.length ? ` (managed: ${managed.sort().join(", ")})` : ""}`);
  }
  if (cfg.codexSkillsDir) {
    const managed = readCodexState(cfg).managedNames;
    console.log(`Codex skills dir: ${rel(cfg.codexSkillsDir)} ${pathExists(cfg.codexSkillsDir) ? "exists" : "missing"}${managed.length ? ` (managed: ${managed.sort().join(", ")})` : ""}`);
  }
}

function rmAny(p) {
  const stat = fs.lstatSync(p);
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true });
  else fs.unlinkSync(p);
}

function applyClaude(cfg, expected, dryRun) {
  if (!cfg.claudeSkillsDir) return { issues: [], applied: true };
  const issues = [];
  const previous = new Set(readClaudeState(cfg).managedNames);
  const next = new Set();

  if (samePath(cfg.claudeSkillsDir, cfg.piSkillsDir)) {
    issues.push(`claude: claudeSkillsDir must differ from piSkillsDir (${cfg.piSkillsDir})`);
    return { issues, applied: false };
  }
  if (!pathExists(cfg.claudeSkillsDir)) {
    console.log(`${dryRun ? "would create" : "create"} ${rel(cfg.claudeSkillsDir)}`);
    if (!dryRun) fs.mkdirSync(cfg.claudeSkillsDir, { recursive: true });
  } else if (!fs.lstatSync(cfg.claudeSkillsDir).isDirectory() || fs.lstatSync(cfg.claudeSkillsDir).isSymbolicLink()) {
    issues.push(`claude: ${cfg.claudeSkillsDir} is not a real directory`);
    return { issues, applied: false };
  }

  for (const [name, skill] of expected) {
    const dest = path.join(cfg.claudeSkillsDir, name);
    next.add(name);
    if (pathExists(dest)) {
      const entryStat = fs.lstatSync(dest);
      if (entryStat.isSymbolicLink()) {
        const target = linkTarget(dest);
        if (samePath(target, skill.source)) { console.log(`claude ok ${name} -> ${rel(skill.source)}`); continue; }
        if (!previous.has(name)) {
          issues.push(`claude:${name}: ${dest} is a foreign symlink to ${target}; resolve manually`);
          next.delete(name);
          continue;
        }
        console.log(`${dryRun ? "would relink" : "relink"} claude ${name} -> ${rel(skill.source)}`);
        if (!dryRun) fs.unlinkSync(dest);
      } else {
        issues.push(`claude:${name}: ${dest} exists and is not an agent-skills symlink; move it aside first`);
        next.delete(name);
        continue;
      }
    } else {
      console.log(`${dryRun ? "would link" : "link"} claude ${name} -> ${rel(skill.source)}`);
    }
    if (!dryRun) fs.symlinkSync(skill.source, dest, "dir");
  }

  for (const stale of previous) {
    if (next.has(stale)) continue;
    const dest = path.join(cfg.claudeSkillsDir, stale);
    if (!pathExists(dest)) continue;
    const entryStat = fs.lstatSync(dest);
    if (!entryStat.isSymbolicLink()) {
      issues.push(`claude:${stale}: previously managed but now non-symlink at ${dest}; leaving alone`);
      continue;
    }
    console.log(`${dryRun ? "would remove stale" : "remove stale"} claude ${stale}`);
    if (!dryRun) fs.unlinkSync(dest);
  }

  if (!dryRun) writeClaudeState(cfg, next);
  return { issues, applied: true };
}

function applyCodex(cfg, expected, dryRun) {
  if (!cfg.codexSkillsDir) return { issues: [], applied: true };
  const issues = [];
  const previous = new Set(readCodexState(cfg).managedNames);
  const next = new Set();

  if (samePath(cfg.codexSkillsDir, cfg.piSkillsDir)) {
    issues.push(`codex: codexSkillsDir must differ from piSkillsDir (${cfg.piSkillsDir})`);
    return { issues, applied: false };
  }
  if (!pathExists(cfg.codexSkillsDir)) {
    console.log(`${dryRun ? "would create" : "create"} ${rel(cfg.codexSkillsDir)}`);
    if (!dryRun) fs.mkdirSync(cfg.codexSkillsDir, { recursive: true });
  } else if (!fs.lstatSync(cfg.codexSkillsDir).isDirectory() || fs.lstatSync(cfg.codexSkillsDir).isSymbolicLink()) {
    issues.push(`codex: ${cfg.codexSkillsDir} is not a real directory`);
    return { issues, applied: false };
  }

  for (const [name, skill] of expected) {
    const dest = path.join(cfg.codexSkillsDir, name);
    next.add(name);
    if (pathExists(dest)) {
      const entryStat = fs.lstatSync(dest);
      if (entryStat.isSymbolicLink()) {
        const target = linkTarget(dest);
        if (samePath(target, skill.source)) { console.log(`codex ok ${name} -> ${rel(skill.source)}`); continue; }
        if (!previous.has(name)) {
          issues.push(`codex:${name}: ${dest} is a foreign symlink to ${target}; resolve manually`);
          next.delete(name);
          continue;
        }
        console.log(`${dryRun ? "would relink" : "relink"} codex ${name} -> ${rel(skill.source)}`);
        if (!dryRun) fs.unlinkSync(dest);
      } else {
        issues.push(`codex:${name}: ${dest} exists and is not an agent-skills symlink; move it aside first`);
        next.delete(name);
        continue;
      }
    } else {
      console.log(`${dryRun ? "would link" : "link"} codex ${name} -> ${rel(skill.source)}`);
    }
    if (!dryRun) fs.symlinkSync(skill.source, dest, "dir");
  }

  for (const stale of previous) {
    if (next.has(stale)) continue;
    const dest = path.join(cfg.codexSkillsDir, stale);
    if (!pathExists(dest)) continue;
    const entryStat = fs.lstatSync(dest);
    if (!entryStat.isSymbolicLink()) {
      issues.push(`codex:${stale}: previously managed but now non-symlink at ${dest}; leaving alone`);
      continue;
    }
    console.log(`${dryRun ? "would remove stale" : "remove stale"} codex ${stale}`);
    if (!dryRun) fs.unlinkSync(dest);
  }

  if (!dryRun) writeCodexState(cfg, next);
  return { issues, applied: true };
}

function applyAgentExports(cfg, dryRun) {
  if (!cfg.syncLocalSkillsToAgentSkills) return { issues: [], applied: true };
  const issues = [];
  const expected = localSkillMap(cfg);
  const previous = new Set(readAgentState(cfg).managedNames);
  const next = new Set();

  if (samePath(cfg.agentSkillsDir, cfg.piSkillsDir)) {
    issues.push(`agent: agentSkillsDir must differ from piSkillsDir (${cfg.piSkillsDir})`);
    return { issues, applied: false };
  }
  if (!pathExists(cfg.agentSkillsDir)) {
    console.log(`${dryRun ? "would create" : "create"} ${rel(cfg.agentSkillsDir)}`);
    if (!dryRun) fs.mkdirSync(cfg.agentSkillsDir, { recursive: true });
  } else if (!fs.lstatSync(cfg.agentSkillsDir).isDirectory() || fs.lstatSync(cfg.agentSkillsDir).isSymbolicLink()) {
    issues.push(`agent: ${cfg.agentSkillsDir} is not a real directory`);
    return { issues, applied: false };
  }

  for (const [name, skill] of expected) {
    const dest = path.join(cfg.agentSkillsDir, name);
    next.add(name);
    if (pathExists(dest)) {
      const entryStat = fs.lstatSync(dest);
      if (entryStat.isSymbolicLink()) {
        const target = linkTarget(dest);
        if (samePath(target, skill.source)) { console.log(`agent ok ${name} -> ${rel(skill.source)}`); continue; }
        if (!previous.has(name)) {
          issues.push(`agent:${name}: ${dest} is a foreign symlink to ${target}; resolve manually`);
          next.delete(name);
          continue;
        }
        console.log(`${dryRun ? "would relink" : "relink"} agent ${name} -> ${rel(skill.source)}`);
        if (!dryRun) fs.unlinkSync(dest);
      } else {
        issues.push(`agent:${name}: ${dest} exists and is not an agent-skills symlink; move it aside first`);
        next.delete(name);
        continue;
      }
    } else {
      console.log(`${dryRun ? "would link" : "link"} agent ${name} -> ${rel(skill.source)}`);
    }
    if (!dryRun) fs.symlinkSync(skill.source, dest, "dir");
  }

  for (const stale of previous) {
    if (next.has(stale)) continue;
    const dest = path.join(cfg.agentSkillsDir, stale);
    if (!pathExists(dest)) continue;
    const entryStat = fs.lstatSync(dest);
    if (!entryStat.isSymbolicLink()) {
      issues.push(`agent:${stale}: previously managed but now non-symlink at ${dest}; leaving alone`);
      continue;
    }
    console.log(`${dryRun ? "would remove stale" : "remove stale"} agent ${stale}`);
    if (!dryRun) fs.unlinkSync(dest);
  }

  if (!dryRun) writeAgentState(cfg, next);
  return { issues, applied: true };
}

function apply(args) {
  const dryRun = args.includes("--dry-run");
  const cfg = registry();
  const issues = validateConfig(cfg);
  if (issues.length) {
    for (const issue of issues) console.error(`ERROR ${issue}`);
    return 1;
  }

  if (pathExists(cfg.piSkillsDir)) {
    console.log(`${dryRun ? "would rebuild" : "rebuild"} ${rel(cfg.piSkillsDir)}`);
    if (!dryRun) rmAny(cfg.piSkillsDir);
  } else {
    console.log(`${dryRun ? "would create" : "create"} ${rel(cfg.piSkillsDir)}`);
  }
  if (!dryRun) fs.mkdirSync(cfg.piSkillsDir, { recursive: true });

  const expected = expectedSkills(cfg);
  for (const [name, skill] of expected) {
    console.log(`${dryRun ? "would link" : "link"} ${name} -> ${rel(skill.source)}`);
    if (!dryRun) fs.symlinkSync(skill.source, path.join(cfg.piSkillsDir, name), "dir");
  }

  const claude = applyClaude(cfg, expected, dryRun);
  if (claude.issues.length) {
    for (const issue of claude.issues) console.error(`ERROR ${issue}`);
    if (!dryRun) return 1;
  }

  const codex = applyCodex(cfg, expected, dryRun);
  if (codex.issues.length) {
    for (const issue of codex.issues) console.error(`ERROR ${issue}`);
    if (!dryRun) return 1;
  }

  const agent = applyAgentExports(cfg, dryRun);
  if (agent.issues.length) {
    for (const issue of agent.issues) console.error(`ERROR ${issue}`);
    if (!dryRun) return 1;
  }

  return dryRun ? 0 : check();
}

function installOneBin(source, dest, { dryRun, force }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (pathExists(dest)) {
    const stat = fs.lstatSync(dest);
    const isCorrect = stat.isSymbolicLink() && path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === source;
    if (isCorrect) { console.log(`ok ${dest} -> ${source}`); return 0; }
    if (!force) { console.error(`refusing to replace existing ${dest}; rerun with --force after verifying it is safe`); return 1; }
    console.log(`${dryRun ? "would replace" : "replace"} ${dest}`);
    if (!dryRun) rmAny(dest);
  }
  console.log(`${dryRun ? "would link" : "link"} ${dest} -> ${source}`);
  if (!dryRun) fs.symlinkSync(source, dest);
  return 0;
}

function installBin(args) {
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const source = path.join(repoRoot, "bin", "agent-skills.mjs");
  for (const dest of [path.join(os.homedir(), ".local", "bin", "agent-skills"), path.join(os.homedir(), ".pi", "agent", "bin", "agent-skills")]) {
    const code = installOneBin(source, dest, { dryRun, force });
    if (code !== 0) return code;
  }
  return 0;
}

function installConfig(args) {
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  fs.mkdirSync(path.dirname(defaultConfigPath), { recursive: true });
  if (pathExists(defaultConfigPath)) {
    const stat = fs.lstatSync(defaultConfigPath);
    if (!stat.isSymbolicLink()) { console.log(`ok ${defaultConfigPath}`); return 0; }
    if (!force) { console.error(`refusing to replace symlink ${defaultConfigPath}; rerun with --force to make it a real machine-local file`); return 1; }
    console.log(`${dryRun ? "would replace symlink with file" : "replace symlink with file"} ${defaultConfigPath}`);
    if (!dryRun) fs.unlinkSync(defaultConfigPath);
  }
  console.log(`${dryRun ? "would copy" : "copy"} ${exampleConfigPath} -> ${defaultConfigPath}`);
  if (!dryRun) fs.copyFileSync(exampleConfigPath, defaultConfigPath);
  return 0;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "agent-skills" } });
  if (!response.ok) throw new Error(`fetch failed ${response.status} ${url}`);
  return response.text();
}

function patchGstackOfficeHours(text) { return text.replace(/^name: office-hours$/m, "name: yc-office-hours"); }
function run(cmd, args, options = {}) { console.log(`$ ${[cmd, ...args].join(" ")}`); const result = spawnSync(cmd, args, { stdio: "inherit", ...options }); return result.status ?? 1; }

async function update(args) {
  const dryRun = args.includes("--dry-run") || args.includes("--check");
  const checkOnly = args.includes("--check");
  const skipNpx = args.includes("--skip-npx");
  if (!skipNpx) {
    if (dryRun) console.log("would run npx --yes skills update -g -y");
    else {
      const code = run("npx", ["--yes", "skills", "update", "-g", "-y"]);
      if (code !== 0) return code;
    }
  }
  const upstreamBase = "https://raw.githubusercontent.com/garrytan/gstack/main/office-hours";
  const updates = [["skills/yc-office-hours/SKILL.md", `${upstreamBase}/SKILL.md`], ["skills/yc-office-hours/SKILL.md.tmpl", `${upstreamBase}/SKILL.md.tmpl`]];
  const cfg = registry();
  let changed = false;
  for (const [relativePath, url] of updates) {
    const file = path.join(repoRoot, relativePath);
    let next;
    try {
      next = patchedSkillText(cfg, relativePath, patchGstackOfficeHours(await fetchText(url)));
    } catch (error) {
      console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current === next) { console.log(`ok ${relativePath} matches upstream gstack office-hours with local yc-office-hours rename and skill patches`); continue; }
    changed = true;
    console.log(`${dryRun ? "would update" : "update"} ${relativePath} from ${url}`);
    if (!dryRun) fs.writeFileSync(file, next);
  }
  if (checkOnly && changed) return 1;
  if (!dryRun) {
    const code = apply([]);
    if (code !== 0) return code;
  }
  return check();
}

const [cmd = "help", ...args] = process.argv.slice(2);
if (["help", "--help", "-h"].includes(cmd)) { usage(); process.exit(0); }
if (cmd === "list") process.exit(list() ?? 0);
if (cmd === "check") process.exit(check());
if (cmd === "install-bin") process.exit(installBin(args));
if (cmd === "install-config") process.exit(installConfig(args));
if (cmd === "apply") process.exit(apply(args));
if (cmd === "patch") process.exit(patchSkills(args));
if (cmd === "update") process.exit(await update(args));
console.error(`Unknown command: ${cmd}`);
usage();
process.exit(2);
