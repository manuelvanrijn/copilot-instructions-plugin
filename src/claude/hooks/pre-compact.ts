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

  if (!projectDir) {
    console.error("ERROR: project_dir or cwd is missing from hook input")
    process.exit(1)
  }

  const cacheDir = getCacheDir(projectDir)
  const persisted = await loadState(cacheDir, sessionID)

  const engine = await InstructionEngine.create(projectDir, () => {})
  const state = createEngineState()
  state.contextPaths = new Set(persisted.contextPaths)

  const summary = engine.buildCompactionSummary(state)

  const newPersisted: DroidPersistedState = {
    contextPaths: Array.from(state.contextPaths),
    seededFromHistory: false,
    rulesInjected: false,
    lastMatchCount: 0,
    lastMatchedConditionalPaths: [],
    version: 1,
    compactSummary: summary,
  }

  await saveState(cacheDir, sessionID, newPersisted)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
