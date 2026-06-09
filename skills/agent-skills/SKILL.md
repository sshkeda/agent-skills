---
name: agent-skills
description: Manage the machine-local agent skill source registry and the generated skill directories (~/.pi/agent/skills, ~/.claude/skills, ~/.codex/skills, ~/.agents/skills). Use when adding, removing, inspecting, debugging, or reconciling ~/.agent-skills/config.json, any generated skills directory, or the agent-skills repo. Never hand-symlink a skill into a harness skills directory; register it here instead.
---

# agent-skills

The source of truth is:

```txt
~/.agent-skills/config.json
```

`agent-skills apply` fans the registry out to every harness:

```txt
~/.pi/agent/skills   (Pi; fully rebuilt)
~/.claude/skills     (Claude Code; tracked symlinks added/removed)
~/.codex/skills      (Codex; tracked symlinks added/removed)
~/.agents/skills     (cross-agent dir; localSkills exported as tracked symlinks)
```

Codex also discovers `~/.agents/skills` natively, so a registered skill
reaches every harness. Harness-owned real directories (`npx skills` installs,
codex `.system` skills) are never touched.

Never symlink a skill into one of these directories by hand — that exposes it
to one harness only and bypasses the registry. Add it to `localSkills` and run
`agent-skills apply`; `agent-skills check` fails on any unmanaged symlink it
finds in a generated directory.

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

## Forward-testing with agent-dogfeed

After registering or changing a skill, forward-test it with the
`agent-dogfeed` skill: `agent-dogfeed codex|claude --skill <name> ...` resolves
named skills from the generated `~/.codex/skills` / `~/.claude/skills`, so a
skill must be registered and applied here before a probe can load it by name
(paths work without registration). Dogfeed probes hide `~/.agents/skills` from
the fresh agent; only skills passed with `--skill` are present.
