import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  getCacheDir,
  getStatePath,
  loadState,
  saveState,
  deleteState,
  createEmptyState,
} from "../dist/src/droid/state.js"

test("getCacheDir returns a stable path under home cache", () => {
  const dir1 = getCacheDir("/project/a")
  const dir2 = getCacheDir("/project/a")
  const dir3 = getCacheDir("/project/b")

  assert.equal(dir1, dir2)
  assert.notEqual(dir1, dir3)
  assert.ok(dir1.includes("copilot-instructions-plugin"))
})

test("getStatePath sanitizes session IDs", () => {
  const path = getStatePath("/cache", "sess:123/abc")
  assert.ok(path.endsWith("sess_123_abc.json"))
})

test("createEmptyState returns a valid empty state", () => {
  const state = createEmptyState()
  assert.deepEqual(state.contextPaths, [])
  assert.equal(state.seededFromHistory, false)
  assert.equal(state.rulesInjected, false)
  assert.equal(state.lastMatchCount, 0)
  assert.deepEqual(state.lastMatchedConditionalPaths, [])
  assert.equal(state.version, 1)
})

test("saveState and loadState round-trip", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "droid-state-"))
  const state = {
    contextPaths: ["src/index.ts"],
    seededFromHistory: true,
    rulesInjected: true,
    lastMatchCount: 2,
    lastMatchedConditionalPaths: ["typescript.md"],
    version: 1,
  }

  await saveState(cacheDir, "session-1", state)
  const loaded = await loadState(cacheDir, "session-1")

  assert.deepEqual(loaded, state)

  await deleteState(cacheDir, "session-1")
  const afterDelete = await loadState(cacheDir, "session-1")
  assert.deepEqual(afterDelete, createEmptyState())

  await rm(cacheDir, { recursive: true })
})

test("loadState returns empty state when file is missing", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "droid-state-"))
  const loaded = await loadState(cacheDir, "nonexistent")
  assert.deepEqual(loaded, createEmptyState())
  await rm(cacheDir, { recursive: true })
})

test("loadState returns empty state when version mismatches", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "droid-state-"))
  const badState = { version: 99, contextPaths: ["a.ts"] }
  await saveState(cacheDir, "session-2", badState)
  const loaded = await loadState(cacheDir, "session-2")
  assert.deepEqual(loaded, createEmptyState())
  await rm(cacheDir, { recursive: true })
})
