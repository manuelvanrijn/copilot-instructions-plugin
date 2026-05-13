/**
 * @manuelvanrijn/copilot-instructions-plugin
 *
 * OpenCode plugin that reads .github/instructions/*.md files with `applyTo:`
 * frontmatter and injects matching instructions into the system prompt when
 * the agent reads, edits, or writes files matching those globs.
 *
 * Files without `applyTo:` frontmatter are always injected, matching GitHub
 * Copilot's behavior for always-active instructions.
 *
 * Set COPILOT_INSTRUCTIONS_DEBUG=1 to enable verbose logging.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { join } from "node:path"

import { loadRules } from "./instructions.js"
import { extractPathsFromText, extractToolOutputText, normalizeContextPath } from "./paths.js"
import {
  conditionalRuleCount,
  matchingRules,
  renderInjectedInstructions,
  renderInstructionStatus,
} from "./rules.js"

export { parseApplyTo } from "./instructions.js"

const LOG_PREFIX = "[copilot-instructions]"
const DEBUG = process.env.COPILOT_INSTRUCTIONS_DEBUG === "1"
const INPUT_PATH_TOOLS = new Set(["read", "edit", "write", "glob", "grep", "bash"])
const OUTPUT_PATH_TOOLS = new Set(["bash", "glob", "grep"])
const log = (...args: unknown[]): void => {
  if (DEBUG) console.error(LOG_PREFIX, ...args)
}

interface SessionState {
  contextPaths: Set<string>
  /** Paths seen this session accumulate so matched instructions remain active. */
  seededFromHistory: boolean
  /** Per-turn guard: reset on each new user message, set after injection. */
  rulesInjected: boolean
  /** Number of matching conditional rules last time system.transform ran. */
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

function addContextPathsFromText(
  directory: string,
  state: SessionState,
  sessionID: string,
  text: string,
  source: string
): void {
  for (const found of extractPathsFromText(text)) {
    addContextPath(directory, state, sessionID, found, source)
  }
}

export const CopilotInstructionsPlugin: Plugin = async ({
  directory,
  client,
}: PluginInput) => {
  const rules = await loadRules(directory, log)

  return {
    tool: {
      list_injected_copilot_instructions: tool({
        description:
          "List which .github/instructions files have been injected into the current session's system prompt, and which are still pending (waiting for a matching file to be read/edited).",
        args: {},
        async execute(_args, ctx) {
          const state = sessions.get(ctx.sessionID)
          const contextPaths = state ? Array.from(state.contextPaths) : []

          return renderInstructionStatus(rules, contextPaths)
        },
      }),
    },

    // Fires on each new user message: captures prompt text paths and resets
    // the per-turn injection guard so system.transform re-evaluates rules.
    "chat.message": async (input, output) => {
      const { sessionID } = input
      if (!sessionID) return
      if (output.message.role !== "user") return

      const state = getSession(sessionID)
      state.rulesInjected = false

      for (const part of output.parts) {
        const p = part as Record<string, unknown>
        if (p["type"] !== "text") continue

        const text = p["text"]
        if (typeof text !== "string") continue

        addContextPathsFromText(directory, state, sessionID, text, "Path from user message")
      }
    },

    // Seeds contextPaths from full message history on session start.
    "experimental.chat.messages.transform": async (_input, output) => {
      const seenSessionIDs = new Set<string>()

      for (const message of output.messages) {
        for (const part of message.parts) {
          const p = part as Record<string, unknown>
          const sessionID = p["sessionID"]
          if (typeof sessionID !== "string") continue
          seenSessionIDs.add(sessionID)

          const state = getSession(sessionID)
          if (state.seededFromHistory) continue

          if (p["type"] === "tool") {
            const toolState = p["state"] as Record<string, unknown> | undefined
            const toolInput = toolState?.["input"] as Record<string, unknown> | undefined
            const filePath = toolInput?.["filePath"] ?? toolInput?.["path"]

            if (typeof filePath === "string" && filePath) {
              addContextPath(directory, state, sessionID, filePath, "Seeded from history (tool)")
            }
          } else if (p["type"] === "text") {
            const text = p["text"]
            if (typeof text !== "string") continue

            addContextPathsFromText(directory, state, sessionID, text, "Seeded from history (text)")
          }
        }
      }

      for (const sessionID of seenSessionIDs) {
        getSession(sessionID).seededFromHistory = true
      }
    },

    "tool.execute.before": async (input, output) => {
      const { tool: toolName, sessionID } = input
      if (!sessionID) return
      if (!INPUT_PATH_TOOLS.has(toolName)) return

      const args = (output as { args?: Record<string, unknown> }).args
      const state = getSession(sessionID)
      const addPath = (path: string) => addContextPath(directory, state, sessionID, path, "New context path")

      if (toolName === "bash") {
        const workdir = args?.workdir
        if (typeof workdir === "string" && workdir) addPath(workdir)

        const command = args?.command
        if (typeof command === "string") {
          const cdTarget = command.match(/(?:^|&&|\s)cd\s+([^\s&|;]+)/)?.[1] ?? null
          const effectiveWorkdir = typeof workdir === "string" && workdir ? workdir : cdTarget

          for (const found of extractPathsFromText(command)) {
            addPath(found)
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
      if (!OUTPUT_PATH_TOOLS.has(toolName)) return

      const text = extractToolOutputText(output)
      if (!text) return

      const state = getSession(sessionID)
      addContextPathsFromText(directory, state, sessionID, text, `New context path from ${toolName} output`)
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID
      if (!sessionID) return

      const state = getSession(sessionID)
      if (state.rulesInjected) return

      const matchedRules = matchingRules(rules, state.contextPaths)
      if (matchedRules.length === 0) return

      for (const rule of matchedRules) {
        log(`Injected: ${rule.path} into session ${sessionID.slice(0, 8)}`)
      }

      output.system.push(...renderInjectedInstructions(matchedRules))
      state.rulesInjected = true

      const currentMatchCount = conditionalRuleCount(matchedRules)
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
          // tui is not available in non-interactive mode.
        }
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const { sessionID } = input
      if (!sessionID) return

      const state = sessions.get(sessionID)
      if (!state || state.contextPaths.size === 0) return

      const sanitize = (path: string) => path.replace(/[\r\n\t]/g, " ").slice(0, 300)
      const paths = Array.from(state.contextPaths).sort().slice(0, 20)
      const extra = state.contextPaths.size - paths.length

      output.context.push(
        [
          "Copilot Instructions context paths:",
          ...paths.map((path) => `  - ${sanitize(path)}`),
          ...(extra > 0 ? [`  ... and ${extra} more paths`] : []),
        ].join("\n")
      )

      state.rulesInjected = false
      state.seededFromHistory = false
      state.lastMatchCount = 0
      log(`Compaction: reset session state for ${sessionID.slice(0, 8)}`)
    },
  }
}

const id = "copilot-instructions-plugin" as const
const server = CopilotInstructionsPlugin satisfies Plugin
export default { id, server }
