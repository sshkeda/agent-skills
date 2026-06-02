# agent-skills

Machine-local registry that generates Pi's skill discovery directory.

The real config is:

```txt
~/.agent-skills/config.json
```

`agent-skills apply` rebuilds:

```txt
~/.pi/agent/skills
```

as a managed directory of symlinks. When `claudeSkillsDir` is set it also keeps
matching symlinks in that directory (e.g. `~/.claude/skills`) so Claude Code can
discover every agent-managed skill — needed for the `pi-claude-code` flow.

`~/.agents/skills` remains the external skills directory managed by `npx skills update`.
If `syncLocalSkillsToAgentSkills` is enabled, agent-skills also adds tracked
symlinks for `localSkills` into `~/.agents/skills` without replacing any real
directories installed by `npx skills`.

## Config

```json
{
  "agentSkillsDir": "~/.agents/skills",
  "claudeSkillsDir": "~/.claude/skills",
  "codexSkillsDir": "~/.codex/skills",
  "skillPatchesFile": "./skill-patches.json",
  "importAgentSkills": true,
  "syncLocalSkillsToAgentSkills": false,
  "ignoredAgentSkills": ["office-hours"],
  "localSkills": [
    { "name": "example-product", "source": "~/gh/example-product/skills/example-product" },
    { "name": "agent-test", "source": "~/gh/agent-test/skills/agent-test" },
    { "name": "agent-skills", "source": "./skills/agent-skills" }
  ]
}
```

Fields:

- `localSkills`: named local skill source directories to symlink into `~/.pi/agent/skills`. `name` must match `SKILL.md`.
- `importAgentSkills`: whether to import non-ignored entries from `agentSkillsDir` into `~/.pi/agent/skills`.
- `syncLocalSkillsToAgentSkills`: whether to export configured `localSkills`
  back into `agentSkillsDir` as tracked symlinks. Only local skills are exported;
  imported `npx skills` entries are never rewritten. Existing real directories
  or foreign symlinks with the same name are treated as conflicts.
- `ignoredAgentSkills`: names from `agentSkillsDir` to exclude.
- `agentSkillsDir`: source directory for externally managed skills.
- `skillPatchesFile`: pi-patches-style manifest for local skill text patches.
  Patches run after mirrored upstream skill refreshes, so a skill can stay current
  while still carrying explicit local wording changes.
- `claudeSkillsDir` (optional): second target directory that gets the same skill
  set as `piSkillsDir`. Unlike `piSkillsDir` it is **not** rebuilt from scratch —
  agent-skills only adds/relinks/removes the names it has previously created (tracked
  in `<claudeSkillsDir>/.agent-skills.json`), leaving Claude Code's own skills alone.
- `codexSkillsDir` (optional): Codex skill target managed with the same
  state-tracked symlink behavior as `claudeSkillsDir`; existing Codex-only skills
  and `.system` are left alone.

## Canonical Skill Ownership

Use this repo as the registry and fanout mechanism, not as a default home for custom skill source files.

- Repo-specific skills live in the owning repository, for example `~/gh/example-product/skills/example-product`.
- Standalone skills live in their own repository, for example `~/gh/agent-test/skills/agent-test`.
- This repo contains only its own `agent-skills` skill and skills it explicitly mirrors or maintains locally, such as `yc-office-hours`.

To migrate a misplaced skill, preserve the current skill content in its owning repo, change its `localSkills` source in `~/.agent-skills/config.json`, run `agent-skills apply` and `agent-skills check`, and then remove the stale source from this repo.

Pi packages and `~/.pi/agent/settings.json` are intentionally out of scope.

## Commands

```bash
agent-skills list
agent-skills check
agent-skills patch --check
agent-skills patch
agent-skills apply
agent-skills update
```

`agent-skills update` runs `npx skills update -g -y`, refreshes the renamed `yc-office-hours` skill from `garrytan/gstack`, rebuilds `~/.pi/agent/skills`, and checks the registry.

## Development

Run the test suite:

```bash
npm test
```

CI runs the portable CLI test suite on every push and pull request.

The Pi integration tests require a sibling `pi-mock` checkout:

```bash
npm run test:pi-mock
```

## Skill Patches

Put local wording changes in `skill-patches.json` instead of hand-editing a
mirrored skill. Each entry uses exact `find`/`replace`/`verify` strings:

```json
[
  {
    "id": "yc-office-hours-local-note",
    "file": "skills/yc-office-hours/SKILL.md",
    "intent": "Add a local instruction that should survive upstream refreshes.",
    "find": "## Preamble (run first)\n",
    "replace": "## Local Override\n\nAdd the local instruction here.\n\n## Preamble (run first)\n",
    "verify": "Add the local instruction here.",
    "occurrences": 1
  }
]
```

Run `agent-skills patch --check` to prove all configured patches are already
applied, or `agent-skills patch` to apply them. `agent-skills update --check`
also applies the manifest to fetched upstream text before comparing files.

## License

MIT
