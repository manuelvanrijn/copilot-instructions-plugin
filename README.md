# @manuelvanrijn/copilot-instructions-plugin

[![npm version](https://img.shields.io/npm/v/@manuelvanrijn/copilot-instructions-plugin)](https://www.npmjs.com/package/@manuelvanrijn/copilot-instructions-plugin)

An [OpenCode](https://opencode.ai) plugin and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that loads `.github/instructions/` files into the AI agent's system prompt — following the same `applyTo:` convention as [GitHub Copilot custom instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot).

## Variants

This repo contains two plugin variants that share the same instruction source (`.github/instructions/*.md`):

| Variant | Target | Entry point |
|---|---|---|
| OpenCode plugin | [OpenCode](https://opencode.ai) | `src/index.ts` (npm package) |
| Claude Code plugin | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `.claude-plugin/` (hook-based) |

## How it works

- **`.github/copilot-instructions.md`** is always injected if it exists — this is the repository-level instructions file used by GitHub Copilot
- **Files with `applyTo:`** are injected on-demand when the agent reads, edits, or writes a file matching the glob pattern
- **Files without `applyTo:`** are always injected at the start of every session

This means you can keep your existing `.github/copilot-instructions.md` and `.github/instructions/` setup and it works in both Copilot and OpenCode without any duplication.

## Installation

```bash
opencode plugin @manuelvanrijn/copilot-instructions-plugin@0.2.0 --global
```

Or add it to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@manuelvanrijn/copilot-instructions-plugin@0.2.0"]
}
```

## Instruction file format

Same format as GitHub Copilot — YAML frontmatter with `applyTo:`:

```markdown
---
applyTo: "app/controllers/**"
---
# Controllers Guide

Your instructions here...
```

Multiple globs (comma-separated):

```markdown
---
applyTo: "app/models/**, test/**"
---
# Models
```

No frontmatter = always active:

```markdown
# General Rails Guidelines

Always use...
```

## Debugging

Enable verbose logging:

```bash
COPILOT_INSTRUCTIONS_DEBUG=1 opencode
```

## Tool: `list_injected_copilot_instructions`

The plugin exposes a tool the agent can call to report the current injection status:

```
list_injected_copilot_instructions
```

Output shows which files are injected, which are pending, and which file paths have been seen in the session.

## Releasing

Publishing to npm is fully automated via `.github/workflows/publish.yml`, triggered by pushing a `v*.*.*` tag.

Use the release script from a clean `main`:

```bash
git switch main && git pull
./scripts/release.sh patch   # or: minor | major
```

The script:

1. Verifies the working tree is clean.
2. Bumps the version in `package.json` (`npm version --no-git-tag-version`).
3. Updates `CHANGELOG.md`: renames `## Unreleased` to `## vX.Y.Z — YYYY-MM-DD` and adds a fresh `## Unreleased` section at the top.
4. Commits (`chore: release vX.Y.Z`), creates tag `vX.Y.Z`, and pushes both to `origin/main`.

The tag push then triggers the GitHub Actions workflow, which:

1. Verifies the tag matches `package.json` version.
2. Creates a GitHub Release with auto-generated notes.
3. Publishes to npm with `--provenance` (OIDC / sigstore).

## License

MIT

## Claude Code plugin

The `.claude-plugin/` directory contains a Claude Code plugin variant that uses Claude hooks for the same lazy instruction loading.

### How it works

- **SessionStart** injects always-active rules.
- **UserPromptSubmit** extracts file paths from prompts and activates matching conditional rules.
- **PreToolUse** (Read, Write, Edit, Glob, Grep) tracks accessed files and activates matching rules.
- **PreCompact** preserves context paths across compaction.

All four events re-evaluate rules against accumulated context paths, sending the full active instruction set each time.

### Installation

Add to your Claude Code project `.claude/settings.json` or install via marketplace.
