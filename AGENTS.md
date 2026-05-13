# AGENTS.md

## What this repo is

An OpenCode plugin (`@manuelvanrijn/copilot-instructions-plugin`) that loads `.github/instructions/*.md` files into the agent system prompt. Files with `applyTo:` frontmatter are injected on-demand when a matching file enters context; files without are always injected.

Plugin entry point: `src/index.ts`, which exports `{ id, server }` and wires OpenCode hooks.

Pure logic lives in small modules so it can be tested directly:

- `src/instructions.ts` — instruction parsing and loading
- `src/paths.ts` — path extraction and normalization
- `src/rules.ts` — glob matching, status rendering, prompt wrapping

## Commands

```bash
npm run build       # tsc → dist/
npm run dev         # tsc --watch
npm test            # build + node --test test/**/*.test.mjs
```

Tests run against compiled output in `dist/` — always build before testing. No separate lint or typecheck step; `tsc` is the type check.

## Commit conventions

Use Conventional Commits:

- `feat:` — new behaviour visible to users
- `fix:` — bug fix
- `chore:` — maintenance (deps, config, scripts, release commits)
- `docs:` — README / CHANGELOG only
- `refactor:` — internal change, no behaviour change
- `test:` — test-only change

Keep messages short and imperative. No ticket numbers needed.

**Do not push to remote directly.** The only exception is running `./scripts/release.sh` — that script pushes as part of the release flow and that is allowed.

## Releasing

**Do not run the release script.** Releasing is the user's responsibility.

For reference, the flow is:

```bash
./scripts/release.sh patch   # or: minor | major
```

This bumps `package.json`, updates `CHANGELOG.md` (renames `## Unreleased` → `## vX.Y.Z — DATE`, adds fresh `## Unreleased`), commits `chore: release vX.Y.Z`, tags, and pushes. GitHub Actions then publishes to npm.

## CHANGELOG

Always add entries under `## Unreleased` when making user-visible changes. Format:

```markdown
## Unreleased

### Changed
- Short description of what changed and why it matters.
```

Use `### Added`, `### Changed`, `### Fixed`, or `### Removed`.

## Key implementation details

- `parseApplyTo(raw)` — exported from `src/index.ts`, implemented in `src/instructions.ts`, and tested directly against compiled output
- `experimental.chat.system.transform` — fires before every LLM call; `state.rulesInjected` prevents duplicate injection within a turn, and conditional rules inject when a matching path appears in `state.contextPaths`
- `tool.execute.before` — populates `contextPaths` when agent reads/edits/writes/searches files
- `experimental.session.compacting` — resets `rulesInjected` so rules re-evaluate after compaction
- Injected content is wrapped in `<project_instructions type="always|conditional">` with an enforcement directive; always-rules use `push` after base system prompt, conditional rules `push` after that

## Debug

```bash
COPILOT_INSTRUCTIONS_DEBUG=1 opencode
```
