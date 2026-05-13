# Changelog

## Unreleased

### Changed
- Package and repository renamed from `@manuelvanrijn/opencode-copilot-instructions` to `@manuelvanrijn/copilot-instructions-plugin`. The old npm package is deprecated; migrate to the new name.

### Added
- `.github/copilot-instructions.md` is now always loaded if present — this is the repository-level instructions file used by GitHub Copilot.
- `tool.execute.after` hook that scans bash output for file paths (e.g. `find` results), enabling rules to match on paths discovered via shell commands.
- `tool.execute.after` now also scans `glob` and `grep` output for file paths, enabling rules to match on files discovered by search tools.
- Bash command path resolution: relative paths in bash commands (e.g. `rails test test/controllers`) are now resolved against the `cd` target or `workdir`, so `apps/joblab/test/controllers` is correctly derived and matched against `apps/joblab/test/**` globs.
- Directory paths without trailing slash (e.g. `apps/joblab`) now match `apps/joblab/**` globs by trying with a trailing slash appended.

### Changed
- `chat.message` hook now also extracts file paths from user message text via regex, enabling same-turn injection when a file path is mentioned without the agent calling a tool.
- `tool.execute.before` now also captures `glob`, `grep`, and `bash` tool paths in addition to `read/edit/write`.
- `experimental.chat.messages.transform` now seeds paths from both tool call args and text parts in message history.
- After compaction, `seededFromHistory` is reset so history re-seeds from the compacted summary.
- TUI toast notifications now appear only when the number of active conditional instruction files increases, avoiding repeated stale notifications.
- Context paths are now normalized through one shared path resolver, rejected when outside the workspace, and stored with POSIX separators for consistent glob matching.
- `.github/instructions/*.md` files are now loaded in sorted filename order for deterministic prompt output.
- Instruction parsing, path handling, and rule rendering are now split into focused modules with direct unit coverage.

### Fixed
- Conditional instruction files with the same content as an always-active file no longer activate unless their `applyTo` glob actually matches.
- Instruction files with an explicit empty `applyTo:` are now skipped instead of being treated as always-active.
- Path extraction no longer treats the leading path-like segment of an email address as a context path.


## v0.1.1 — 2026-04-24

### Changed

- Injected instructions are now wrapped in `<project_instructions>` XML tags with an explicit directive to follow them immediately. This gives the model a clear signal that the content is authoritative project guidance rather than passive context.
- Always-active rules (no `applyTo`) are injected as `type="always"`, conditional rules (with `applyTo`) as `type="conditional"`.
- Injection order preserved: base system prompt first, always rules second, conditional rules last — all via `push`.
