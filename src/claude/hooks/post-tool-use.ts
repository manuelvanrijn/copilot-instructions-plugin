import { renderInjectedInstructions } from "../../rules.js"
import { InstructionEngine, createEngineState } from "../../core/engine.js"
import {
  getCacheDir,
  loadState,
  saveState,
  type DroidPersistedState,
} from "../state.js"
import { readStdin } from "./_stdin.js"

async function main() {
  const input = JSON.parse(await readStdin())
  const sessionID = input.session_id as string
  const projectDir = (input.project_dir ?? input.cwd) as string
  const toolName = (input.tool_name ?? input.tool?.name as string)?.toLowerCase() ?? ""
  const toolOutput = input.tool_output ?? input.tool?.output

  if (!projectDir) {
    console.error("ERROR: project_dir or cwd is missing from hook input")
    process.exit(1)
  }

  const cacheDir = getCacheDir(projectDir)
  const persisted = await loadState(cacheDir, sessionID)

  const engine = await InstructionEngine.create(projectDir, () => {})
  const state = createEngineState()
  state.contextPaths = new Set(persisted.contextPaths)
  state.seededFromHistory = persisted.seededFromHistory
  state.rulesInjected = persisted.rulesInjected
  state.lastMatchCount = persisted.lastMatchCount
  state.lastMatchedConditionalPaths = persisted.lastMatchedConditionalPaths

  engine.addPathsFromToolOutput(state, toolName, toolOutput)

  const matchedConditional = engine.getMatchedConditionalRules(state)
  const currentPaths = matchedConditional.map((r) => r.path)
  const previousPaths = new Set(state.lastMatchedConditionalPaths)

  const newlyActive = matchedConditional.filter((r) => !previousPaths.has(r.path))
  const currentMatchCount = matchedConditional.length

  const newPersisted: DroidPersistedState = {
    contextPaths: Array.from(state.contextPaths),
    seededFromHistory: state.seededFromHistory,
    rulesInjected: state.rulesInjected,
    lastMatchCount: currentMatchCount,
    lastMatchedConditionalPaths: currentPaths,
    version: 1,
    compactSummary: persisted.compactSummary,
  }

  await saveState(cacheDir, sessionID, newPersisted)

  if (newlyActive.length === 0) {
    console.log(JSON.stringify({}))
    return
  }

  const instructions = renderInjectedInstructions(newlyActive)
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        additionalContext: instructions.map((text) => ({ type: "text", text })),
      },
    })
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
