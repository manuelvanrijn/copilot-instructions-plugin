/**
 * @manuelvanrijn/copilot-instructions-plugin
 *
 * OpenCode / Factory Droid plugin that reads .github/instructions/*.md files
 * with `applyTo:` frontmatter and injects matching instructions into the
 * system prompt when the agent reads, edits, or writes files matching those
 * globs.
 *
 * Files without `applyTo:` frontmatter are always injected, matching GitHub
 * Copilot's behavior for always-active instructions.
 *
 * Set COPILOT_INSTRUCTIONS_DEBUG=1 to enable verbose logging.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import { InstructionEngine, createEngineState, type EngineState } from "./core/engine.js"
import { conditionalRuleCount, matchingRules, renderInjectedInstructions } from "./rules.js"

export { parseApplyTo } from "./instructions.js"

const LOG_PREFIX = "[copilot-instructions]"
const DEBUG = process.env.COPILOT_INSTRUCTIONS_DEBUG === "1"
const log = (...args: unknown[]): void => {
  if (DEBUG) console.error(LOG_PREFIX, ...args)
}

const sessions = new Map<string, EngineState>()

function getSession(id: string): EngineState {
  let state = sessions.get(id)
  if (!state) {
    state = createEngineState()
    sessions.set(id, state)
  }
  return state
}

export const CopilotInstructionsPlugin: Plugin = async ({
  directory,
  client,
}: PluginInput) => {
  const engine = await InstructionEngine.create(directory, log)

  return {
    tool: {
      list_injected_copilot_instructions: tool({
        description:
          "List which .github/instructions files have been injected into the current session's system prompt, and which are still pending (waiting for a matching file to be read/edited).",
        args: {},
        async execute(_args, ctx) {
          const state = sessions.get(ctx.sessionID)
          return engine.renderStatus(state ?? createEngineState())
        },
      }),
    },

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

        engine.addPathsFromText(state, text, "Path from user message")
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const seenSessionIDs = new Set<string>()

      for (const message of output.messages) {
        for (const part of message.parts) {
          const p = part as Record<string, unknown>
          const sessionID = p["sessionID"]
          if (typeof sessionID !== "string") continue
          seenSessionIDs.add(sessionID)
        }
      }

      for (const sessionID of seenSessionIDs) {
        const state = getSession(sessionID)
        engine.seedFromHistory(state, output.messages as Array<{ parts: Array<Record<string, unknown>> }>, sessionID)
      }
    },

    "tool.execute.before": async (input, output) => {
      const { tool: toolName, sessionID } = input
      if (!sessionID) return

      const args = (output as { args?: Record<string, unknown> }).args
      const state = getSession(sessionID)
      engine.addPathsFromToolInput(state, toolName, args ?? {})
    },

    "tool.execute.after": async (input, output) => {
      const { tool: toolName, sessionID } = input
      if (!sessionID) return

      const state = getSession(sessionID)
      engine.addPathsFromToolOutput(state, toolName, output)
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID
      if (!sessionID) return

      const state = getSession(sessionID)
      if (state.rulesInjected) return

      const matchedRules = matchingRules(engine.rules, state.contextPaths)
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

      output.context.push(engine.buildCompactionSummary(state))

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
