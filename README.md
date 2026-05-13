# @manuelvanrijn/copilot-instructions-plugin

[![npm version](https://img.shields.io/npm/v/@manuelvanrijn/copilot-instructions-plugin)](https://www.npmjs.com/package/@manuelvanrijn/copilot-instructions-plugin)

An [OpenCode](https://opencode.ai) / [Factory Droid](https://factory.ai/) plugin that loads `.github/instructions/` files into the AI agent's system prompt — following the same `applyTo:` convention as [GitHub Copilot custom instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot).

## How it works

- **`.github/copilot-instructions.md`** is always injected if it exists — this is the repository-level instructions file used by GitHub Copilot
- **Files with `applyTo:`** are injected on-demand when the agent reads, edits, or writes a file matching the glob pattern
- **Files without `applyTo:`** are always injected at the start of every session

This means you can keep your existing `.github/copilot-instructions.md` and `.github/instructions/` setup and it works in both Copilot and OpenCode / Droid without any duplication.

## Installation

### OpenCode

```bash
opencode plugin @manuelvanrijn/copilot-instructions-plugin@0.1.2 --global
```

Or add it to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@manuelvanrijn/copilot-instructions-plugin@0.1.2"]
}
```

### Claude Code

This plugin can also be used with [Claude Code](https://code.claude.com/). The repository includes a `.claude-plugin/` manifest for compatibility.

**Local development:**

```bash
claude --plugin-dir /path/to/this/repo
```

**Install from GitHub:**

```bash
claude --plugin-url https://github.com/manuelvanrijn/copilot-instructions-plugin
```

Then run `/reload-plugins` to activate.

Note: Claude Code uses a different hooks system than Factory Droid. The core instruction-loading logic is shared, but hook timing and event names may differ between platforms.

### Factory Droid

This plugin is available from the [Factory Droid marketplace](https://docs.factory.ai/cli/configuration/plugins#marketplaces) via this repository.

**From marketplace (recommended):**

```bash
droid plugin marketplace add https://github.com/manuelvanrijn/copilot-instructions-plugin
droid plugin install copilot-instructions-plugin@copilot-instructions-plugin
```

Or browse and install via the UI: `/plugins` → Browse tab.

**From local path (for development):**

```bash
droid plugin install /path/to/this/repo
```

Droid hooks will then activate automatically:
- `SessionStart` — restores continuity after compaction
- `UserPromptSubmit` — injects matching instructions into context
- `PreToolUse` / `PostToolUse` — captures paths from tool inputs/outputs
- `PreCompact` — persists state for resume

## Marketplace

This plugin is published as a Factory Droid marketplace plugin. The repository itself acts as a marketplace containing a single plugin. When you add this repo as a marketplace, Droid fetches the latest version from the `main` branch.

To add this marketplace globally (available in all projects):

```bash
droid plugin marketplace add https://github.com/manuelvanrijn/copilot-instructions-plugin
```

Then install the plugin:

```bash
droid plugin install copilot-instructions-plugin@copilot-instructions-plugin
```

To update to the latest version later:

```bash
droid plugin update copilot-instructions-plugin@copilot-instructions-plugin
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
