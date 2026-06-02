---
name: agent-skills
description: Manage the machine-local agent skill source registry and generated ~/.pi/agent/skills directory. Use when adding, removing, inspecting, debugging, or reconciling ~/.agent-skills/config.json, ~/.agents/skills, or the agent-skills repo.
---

# agent-skills

The source of truth is:

```txt
~/.agent-skills/config.json
```

`agent-skills apply` rebuilds Pi's discovery directory:

```txt
~/.pi/agent/skills
```

as symlinks to configured `localSkills` plus imported entries from `~/.agents/skills`.
When `syncLocalSkillsToAgentSkills` is true, it also exports configured
`localSkills` into `~/.agents/skills` as tracked symlinks while leaving
`npx skills`-managed real directories alone.

## Config

- `localSkills`: named local skill source directories to symlink into `~/.pi/agent/skills`.
- `importAgentSkills`: whether to import entries from `~/.agents/skills`.
- `syncLocalSkillsToAgentSkills`: whether to export configured `localSkills` into `~/.agents/skills`.
- `ignoredAgentSkills`: names in `~/.agents/skills` to exclude.

## Source Ownership

`agent-skills` is a registry and discovery fanout tool, not a holding repo for unrelated custom skills.

- A skill for a product or code repository belongs in that repository, conventionally `<repo>/skills/<skill-name>`.
- A standalone skill belongs in its own canonical repository.
- This repository may contain its own `agent-skills` skill and explicitly mirrored/maintained skills such as `yc-office-hours`.
- Register canonical source directories in `localSkills`; do not copy a repo-specific skill into this repository merely to expose it to agents.

When a misplaced skill is discovered, move its current content into the owning repo, update `~/.agent-skills/config.json`, run `agent-skills apply` and `agent-skills check`, then remove the obsolete copy.

## Commands

```bash
agent-skills list
agent-skills check
agent-skills apply
agent-skills update
```

Pi packages and `~/.pi/agent/settings.json` are intentionally out of scope.
