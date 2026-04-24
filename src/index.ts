/**
 * @manuelvanrijn/opencode-copilot-instructions
 *
 * OpenCode plugin that reads .github/instructions/*.md files with `applyTo:`
 * frontmatter and injects matching instructions into the system prompt when
 * the agent reads, edits, or writes files matching those globs.
 *
 * Files without `applyTo:` frontmatter are always injected — matching GitHub
 * Copilot's behavior for always-active instructions.
 *
 * Set COPILOT_INSTRUCTIONS_DEBUG=1 to enable verbose logging.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readdir, readFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { minimatch } from "minimatch"

const LOG_PREFIX = "[copilot-instructions]"
const DEBUG = process.env.COPILOT_INSTRUCTIONS_DEBUG === "1"
const log = (...args: unknown[]): void => {
  if (DEBUG) console.error(LOG_PREFIX, ...args)
}
const FRONTMATTER_RE = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

// Matches file-like paths in text: optional ./ ../ or /, then word/dot/slash chars
// with at least one slash, excluding URLs.
const PATH_REGEX = /(?:^|[\s"'`(])((\.{0,2}\/)?[\w./-]+\/[\w./-]+(?:\.\w+)?)/gm

interface InstructionRule {
  /** Glob patterns from `applyTo:` frontmatter. null = always inject. */
  globs: string[] | null
  content: string
  path: string
}

interface SessionState {
  contextPaths: Set<string>
  /** Paths seen this session — accumulates forever, never cleared. */
  seededFromHistory: boolean
  /** Per-turn guard: reset on each new user message, set after injection. */
  rulesInjected: boolean
  /** Number of matching rules last time system.transform ran — used to detect new matches. */
  lastMatchCount: number
}

const sessions = new Map<string, SessionState>()

function getSession(id: string): SessionState {
  let state = sessions.get(id)
  if (!state) {
    state = { contextPaths: new Set(), seededFromHistory: false, rulesInjected: false, lastMatchCount: 0 }
    sessions.set(id, state)
  }
  return state
}

/**
 * Extract file-like paths from a text string.
 * Excludes URLs and bare words without slashes.
 */
function extractPathsFromText(text: string): string[] {
  const found: string[] = []
  let match: RegExpExecArray | null
  PATH_REGEX.lastIndex = 0
  while ((match = PATH_REGEX.exec(text)) !== null) {
    const p = match[1].replace(/[.,;:!?]$/, "") // strip trailing punctuation
    if (p.includes("://") || p.includes("@")) continue
    found.push(p)
  }
  return found
}

function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, "/")
}

function normalizeContextPath(directory: string, filePath: string): string | null {
  const normalizedPath = normalizePathSeparators(filePath.trim())
  if (!normalizedPath) return null

  const absolutePath = isAbsolute(normalizedPath) ? normalizedPath : join(directory, normalizedPath)
  const rel = normalizePathSeparators(relative(directory, absolutePath))

  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null
  return rel
}

function addContextPath(
  directory: string,
  state: SessionState,
  sessionID: string,
  filePath: string,
  source: string
): void {
  const rel = normalizeContextPath(directory, filePath)
  if (!rel || state.contextPaths.has(rel)) return

  state.contextPaths.add(rel)
  log(`${source}: ${rel} (session ${sessionID.slice(0, 8)})`)
}

function collectText(value: unknown, texts: string[]): void {
  if (typeof value === "string") {
    texts.push(value)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, texts)
    return
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectText(item, texts)
  }
}

function extractToolOutputText(output: unknown): string {
  const texts: string[] = []
  collectText(output, texts)
  return texts.join("\n")
}

/**
 * Parse `applyTo:` from YAML frontmatter.
 * Supports comma-separated glob lists.
 */
export function parseApplyTo(raw: string): string[] {
  const frontmatter = raw.match(FRONTMATTER_RE)?.[1]
  if (!frontmatter) return []

  const match = frontmatter.match(/^\s*applyTo\s*:\s*(.*)\s*$/m)
  if (!match) return []

  const value = match[1].trim().replace(/^["']|["']$/g, "")
  if (!value || value === "[]") return []

  return value
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

function hasApplyTo(raw: string): boolean {
  const frontmatter = raw.match(FRONTMATTER_RE)?.[1]
  return Boolean(frontmatter?.match(/^\s*applyTo\s*:/m))
}

function matchesGlob(filePath: string, glob: string): boolean {
  if (minimatch(filePath, glob, { matchBase: false, dot: true })) return true
  // Also try with trailing slash for directory paths (e.g. "apps/joblab" vs "apps/joblab/**")
  if (!filePath.endsWith("/") && minimatch(filePath + "/", glob, { matchBase: false, dot: true })) return true
  return false
}

async function loadRules(directory: string): Promise<InstructionRule[]> {
  const rules: InstructionRule[] = []

  // Load .github/copilot-instructions.md as an always-active rule if it exists
  const copilotInstructionsPath = join(directory, ".github", "copilot-instructions.md")
  try {
    const raw = await readFile(copilotInstructionsPath, "utf8")
    const content = raw.replace(FRONTMATTER_RE, "").trim()
    rules.push({ globs: null, content, path: "copilot-instructions.md" })
    log(`Loaded: copilot-instructions.md (always)`)
  } catch {
    // File doesn't exist, skip silently
  }

  // Load .github/instructions/*.md files
  const instructionsDir = join(directory, ".github", "instructions")
  let files: string[]

  try {
    files = (await readdir(instructionsDir)).sort()
  } catch {
    log("No .github/instructions/ directory found, skipping")
    return rules
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue

    const filePath = join(instructionsDir, file)
    const raw = await readFile(filePath, "utf8")
    const explicitApplyTo = hasApplyTo(raw)
    const globs = parseApplyTo(raw)
    const always = !explicitApplyTo

    if (explicitApplyTo && globs.length === 0) {
      log(`Skipped: ${file} (empty applyTo)`)
      continue
    }

    // Strip YAML frontmatter before injecting content
    const content = raw.replace(FRONTMATTER_RE, "").trim()

    rules.push({ globs: always ? null : globs, content, path: file })
    log(`Loaded: ${file} ${always ? "(always)" : `(applyTo: ${globs.join(", ")})`}`)
  }

  const alwaysCount = rules.filter((r) => r.globs === null).length
  const conditionalCount = rules.filter((r) => r.globs !== null).length
  log(`Total: ${rules.length} rules (${alwaysCount} always, ${conditionalCount} conditional)`)

  return rules
}

export const CopilotInstructionsPlugin: Plugin = async ({
  directory,
  client,
}: PluginInput) => {
  const rules = await loadRules(directory)

  return {
    tool: {
      list_injected_copilot_instructions: tool({
        description:
          "List which .github/instructions files have been injected into the current session's system prompt, and which are still pending (waiting for a matching file to be read/edited).",
        args: {},
        async execute(_args, ctx) {
          const state = sessions.get(ctx.sessionID)
          const contextPaths = state ? Array.from(state.contextPaths) : []

          const alwaysRules = rules.filter((r) => r.globs === null)
          const conditionalRules = rules.filter((r) => r.globs !== null)

          const injectedConditional = conditionalRules.filter(
            (r) => contextPaths.some((p) => r.globs!.some((g) => matchesGlob(p, g)))
          )
          const pendingConditional = conditionalRules.filter(
            (r) => !contextPaths.some((p) => r.globs!.some((g) => matchesGlob(p, g)))
          )

          const lines: string[] = [
            `## Copilot Instructions Status`,
            ``,
            `### Always-active (no applyTo) — ${alwaysRules.length} files`,
            ...alwaysRules.map((r) => `- ✓ ${r.path}`),
            ``,
            `### Conditional (applyTo) — ${conditionalRules.length} files`,
            `Active (${injectedConditional.length}):`,
            ...injectedConditional.map(
              (r) => `- ✓ ${r.path} [${r.globs!.join(", ")}]`
            ),
            `Pending — no matching files yet (${pendingConditional.length}):`,
            ...pendingConditional.map(
              (r) => `- ○ ${r.path} [${r.globs!.join(", ")}]`
            ),
            ``,
            `### Context paths seen this session (${contextPaths.length})`,
            ...contextPaths.map((p) => `- ${p}`),
          ]

          return lines.join("\n")
        },
      }),
    },

    // Fires on each new user message — captures prompt text paths and resets
    // the per-turn injection guard so system.transform re-evaluates rules.
    "chat.message": async (input, output) => {
      const { sessionID } = input
      if (!sessionID) return
      if (output.message.role !== "user") return

      const state = getSession(sessionID)

      // Reset per-turn guard so system.transform injects again this turn
      state.rulesInjected = false

      // Extract file paths mentioned in the user message text
      for (const part of output.parts) {
        const p = part as Record<string, unknown>
        if (p["type"] !== "text") continue
        const text = p["text"]
        if (typeof text !== "string") continue

        for (const found of extractPathsFromText(text)) {
          addContextPath(directory, state, sessionID, found, "Path from user message")
        }
      }
    },

    // Seeds contextPaths from full message history on session start.
    // Extracts paths from both tool call args and message text.
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const message of output.messages) {
        for (const part of message.parts) {
          const p = part as Record<string, unknown>

          // Extract sessionID from part (present on ToolPart, TextPart, etc.)
          const sessionID = p["sessionID"]
          if (typeof sessionID !== "string") continue

          const state = getSession(sessionID)
          if (state.seededFromHistory) continue

          if (p["type"] === "tool") {
            // Extract from tool call input args
            const toolState = p["state"] as Record<string, unknown> | undefined
            const toolInput = toolState?.["input"] as Record<string, unknown> | undefined
            if (!toolInput) continue

            const filePath = toolInput["filePath"] ?? toolInput["path"]
            if (typeof filePath !== "string" || !filePath) continue

            addContextPath(directory, state, sessionID, filePath, "Seeded from history (tool)")
          } else if (p["type"] === "text") {
            // Extract from text parts (user messages)
            const text = p["text"]
            if (typeof text !== "string") continue

            for (const found of extractPathsFromText(text)) {
              addContextPath(directory, state, sessionID, found, "Seeded from history (text)")
            }
          }
        }
      }

      // Mark all seen sessions as seeded
      for (const message of output.messages) {
        for (const part of message.parts) {
          const p = part as Record<string, unknown>
          const sessionID = p["sessionID"]
          if (typeof sessionID === "string") {
            getSession(sessionID).seededFromHistory = true
          }
        }
      }
    },

    "tool.execute.before": async (input, output) => {
      const { tool: toolName, sessionID } = input
      if (!sessionID) return

      if (!["read", "edit", "write", "glob", "grep", "bash"].includes(toolName)) return

      const args = (output as { args?: Record<string, unknown> }).args
      const state = getSession(sessionID)

      const addPath = (p: string) => addContextPath(directory, state, sessionID, p, "New context path")

      if (toolName === "bash") {
        // Extract workdir arg
        const workdir = args?.workdir
        if (typeof workdir === "string" && workdir) addPath(workdir)

        // Extract paths from command string (e.g. "cd apps/joblab && rails test test/controllers")
        // Also resolve relative paths against workdir or any cd target in the command
        const command = args?.command
        if (typeof command === "string") {
          // Find cd target in command (e.g. "cd apps/joblab")
          const cdMatch = command.match(/(?:^|&&|\s)cd\s+([^\s&|;]+)/)
          const cdTarget = cdMatch?.[1] ?? null
          const effectiveWorkdir = (typeof workdir === "string" && workdir) ? workdir : cdTarget

          for (const found of extractPathsFromText(command)) {
            addPath(found)
            // Also try resolving relative path against the effective workdir
            if (effectiveWorkdir && !found.startsWith("/") && !found.startsWith(".")) {
              addPath(join(effectiveWorkdir, found))
            }
          }
        }
      } else {
        const filePath = (args?.filePath ?? args?.path) as string | undefined
        if (typeof filePath === "string" && filePath) addPath(filePath)
      }
    },

    "tool.execute.after": async (input, output) => {
      const { tool: toolName, sessionID } = input
      if (!sessionID) return
      if (!["bash", "glob", "grep"].includes(toolName)) return

      // Extract paths from tool output (e.g. find/glob/grep results)
      const text = extractToolOutputText(output)
      if (!text) return

      const state = getSession(sessionID)
      const addPath = (p: string) =>
        addContextPath(directory, state, sessionID, p, `New context path from ${toolName} output`)

      for (const found of extractPathsFromText(text)) addPath(found)
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID
      if (!sessionID) return

      const state = getSession(sessionID)

      // Per-turn guard: skip if already injected this turn
      if (state.rulesInjected) return

      const matchedRules: InstructionRule[] = []

      for (const rule of rules) {
        const matches =
          rule.globs === null
            ? true
            : state.contextPaths.size > 0 &&
              Array.from(state.contextPaths).some((p) =>
                rule.globs!.some((g) => matchesGlob(p, g))
              )

        if (matches) {
          matchedRules.push(rule)
          log(`Injected: ${rule.path} into session ${sessionID.slice(0, 8)}`)
        }
      }

      if (matchedRules.length > 0) {
        const alwaysContent = matchedRules
          .filter((r) => r.globs === null)
          .map((r) => r.content)
        const conditionalContent = matchedRules
          .filter((r) => r.globs !== null)
          .map((r) => r.content)

        const wrap = (contents: string[], label: string) =>
          `<project_instructions type="${label}">\nThe following project-specific instructions MUST be followed. Apply them immediately and for all subsequent actions.\n\n${contents.join("\n\n---\n\n")}\n</project_instructions>`

        if (alwaysContent.length > 0) output.system.push(wrap(alwaysContent, "always"))
        if (conditionalContent.length > 0) output.system.push(wrap(conditionalContent, "conditional"))

        // Mark injected for this turn — reset by chat.message on next user turn
        state.rulesInjected = true

        // Toast only when conditional rules grow — always-rules don't count
        const currentMatchCount = matchedRules.filter((r) => r.globs !== null).length
        if (currentMatchCount > state.lastMatchCount) {
          const added = currentMatchCount - state.lastMatchCount
          state.lastMatchCount = currentMatchCount
          try {
            await (client as any).tui.showToast({
              body: {
                title: "📖 Copilot Instructions",
                message: `${currentMatchCount} active (+${added} new)`,
                variant: "info",
                duration: 3000,
              },
            })
          } catch {
            // tui not available in non-interactive mode
          }
        }
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const { sessionID } = input
      if (!sessionID) return

      const state = sessions.get(sessionID)
      if (!state || state.contextPaths.size === 0) return

      const sanitize = (p: string) =>
        p.replace(/[\r\n\t]/g, " ").slice(0, 300)

      const paths = Array.from(state.contextPaths).sort().slice(0, 20)
      const extra = state.contextPaths.size - paths.length

      output.context.push(
        [
          "Copilot Instructions context paths:",
          ...paths.map((p) => `  - ${sanitize(p)}`),
          ...(extra > 0 ? [`  ... and ${extra} more paths`] : []),
        ].join("\n")
      )

      // Reset per-turn guard after compaction so rules re-evaluate
      state.rulesInjected = false
      state.seededFromHistory = false
      state.lastMatchCount = 0
      log(`Compaction: reset session state for ${sessionID.slice(0, 8)}`)
    },
  }
}

const id = "opencode-copilot-instructions" as const
const server = CopilotInstructionsPlugin satisfies Plugin
export default { id, server }
