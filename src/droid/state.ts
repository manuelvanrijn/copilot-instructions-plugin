import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface DroidPersistedState {
  contextPaths: string[]
  seededFromHistory: boolean
  rulesInjected: boolean
  lastMatchCount: number
  lastMatchedConditionalPaths: string[]
  version: number
  compactSummary?: string | undefined
}

const STATE_VERSION = 1

export function getCacheDir(projectDir: string): string {
  const hash = createHash("sha256")
    .update(projectDir)
    .digest("hex")
    .slice(0, 16)
  return join(homedir(), ".cache", "copilot-instructions-plugin", "droid", hash)
}

export function getStatePath(cacheDir: string, sessionID: string): string {
  const safeID = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
  return join(cacheDir, `${safeID}.json`)
}

export function createEmptyState(): DroidPersistedState {
  return {
    contextPaths: [],
    seededFromHistory: false,
    rulesInjected: false,
    lastMatchCount: 0,
    lastMatchedConditionalPaths: [],
    version: STATE_VERSION,
  }
}

export async function loadState(
  cacheDir: string,
  sessionID: string
): Promise<DroidPersistedState> {
  const path = getStatePath(cacheDir, sessionID)
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as DroidPersistedState
    if (parsed.version !== STATE_VERSION) throw new Error("Version mismatch")
    return parsed
  } catch {
    return createEmptyState()
  }
}

export async function saveState(
  cacheDir: string,
  sessionID: string,
  state: DroidPersistedState
): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const path = getStatePath(cacheDir, sessionID)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(state, null, 2))
  await rename(tmpPath, path)
}

export async function deleteState(
  cacheDir: string,
  sessionID: string
): Promise<void> {
  try {
    await unlink(getStatePath(cacheDir, sessionID))
  } catch {
    // ignore
  }
}
