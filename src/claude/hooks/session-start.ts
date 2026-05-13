import { getCacheDir, loadState, saveState } from "../state.js"
import { rebuildStateFromTranscript } from "../transcript.js"
import { readStdin } from "./_stdin.js"

async function main() {
  const input = JSON.parse(await readStdin())
  const sessionID = input.session_id as string
  const projectDir = (input.project_dir ?? input.cwd) as string
  const source = input.source as string | undefined
  const transcriptPath = input.transcript_path as string | undefined

  if (!projectDir) {
    console.error("ERROR: project_dir or cwd is missing from hook input")
    process.exit(1)
  }

  const cacheDir = getCacheDir(projectDir)
  let state = await loadState(cacheDir, sessionID)

  if (state.contextPaths.length === 0 && !state.compactSummary && transcriptPath && source === "compact") {
    state = await rebuildStateFromTranscript(transcriptPath)
  }

  if (state.compactSummary && source === "compact") {
    console.log(state.compactSummary)
  } else if (state.contextPaths.length > 0) {
    console.log(
      `Copilot Instructions: resumed with ${state.contextPaths.length} context paths.`
    )
  }

  await saveState(cacheDir, sessionID, state)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
