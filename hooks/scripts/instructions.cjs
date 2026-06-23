#!/usr/bin/env node

/**
 * Claude Code plugin: copilot-instructions
 *
 * Core engine that loads .github/instructions/*.md files and lazily injects
 * matching instructions via Claude hook additionalContext output.
 *
 * Mirrors the OpenCode plugin logic in src/index.ts.
 */

const fs = require("fs")
const path = require("path")

const FRONTMATTER_RE = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const PATH_REGEX =
  /(?:^|[\s"'`(])((\.{0,2}\/)?[\w./-]+\/[\w./-]+(?:\.\w+)?)/gm

const TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"]

function globToRegex(glob) {
  let pattern = ""
  let i = 0
  while (i < glob.length) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        pattern += "(.*/)?"
        i += 3
      } else {
        pattern += ".*"
        i += 2
      }
    } else if (glob[i] === "*") {
      pattern += "[^/]*"
      i++
    } else if (glob[i] === "?") {
      pattern += "[^/]"
      i++
    } else {
      pattern += /[\\^$.|?*+()[{]/.test(glob[i]) ? "\\" + glob[i] : glob[i]
      i++
    }
  }
  return new RegExp("^" + pattern + "$")
}

const globCache = new Map()

function matchesGlob(filePath, glob) {
  let re = globCache.get(glob)
  if (!re) {
    re = globToRegex(glob)
    globCache.set(glob, re)
  }
  return (
    re.test(filePath) ||
    (!filePath.endsWith("/") && re.test(filePath + "/"))
  )
}

function parseApplyTo(raw) {
  const fm = raw.match(FRONTMATTER_RE)?.[1]
  if (!fm) return []

  const match = fm.match(/^\s*applyTo\s*:\s*(.+)\s*$/m)
  if (!match) return []

  const value = match[1].trim().replace(/^["']|["']$/g, "")
  return value
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

function extractPathsFromText(text) {
  if (typeof text !== "string") return []
  const found = []
  let match
  PATH_REGEX.lastIndex = 0
  while ((match = PATH_REGEX.exec(text)) !== null) {
    const p = match[1].replace(/[.,;:!?]$/, "")
    if (p.includes("://") || p.includes("@")) continue
    found.push(p)
  }
  return found
}

function loadRules(projectDir) {
  const rules = []

  const copilotPath = path.join(projectDir, ".github", "copilot-instructions.md")
  try {
    const raw = fs.readFileSync(copilotPath, "utf8")
    const content = raw.replace(FRONTMATTER_RE, "").trim()
    if (content) rules.push({ globs: null, content, path: "copilot-instructions.md", fullPath: copilotPath })
  } catch {
    // file doesn't exist, skip
  }

  const instructionsDir = path.join(projectDir, ".github", "instructions")
  let files
  try {
    files = fs.readdirSync(instructionsDir).sort()
  } catch {
    return rules
  }

  for (const file of files) {
    if (!file.endsWith(".md") || file.startsWith(".")) continue

    const filePath = path.join(instructionsDir, file)
    const raw = fs.readFileSync(filePath, "utf8")
    const globs = parseApplyTo(raw)
    const content = raw.replace(FRONTMATTER_RE, "").trim()

    rules.push({ globs: globs.length === 0 ? null : globs, content, path: file, fullPath: filePath })
  }
  return rules
}

function getStatePath(stateDir, sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")
  return path.join(stateDir, `${safe}.json`)
}

function readState(stateDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(stateDir, sessionId), "utf8"))
  } catch {
    return null
  }
}

function writeState(stateDir, sessionId, state, inputFile) {
  const dir = stateDir
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  state.lastUpdatedAt = new Date().toISOString()
  if (inputFile && !state.stateDir) state.stateDir = stateDir
  fs.writeFileSync(
    getStatePath(stateDir, sessionId),
    JSON.stringify(state, null, 2),
    "utf8"
  )
}

function initState(sessionId, projectDir) {
  return {
    sessionId,
    projectDir,
    hostProcessId: null,
    contextPaths: [],
    activeRulePaths: [],
    injectedRulePaths: [],
    rulesChecksum: "",
  }
}

function currentHostProcessId() {
  return process.env.COPILOT_INSTRUCTIONS_HOST_PROCESS_ID || String(process.ppid)
}

function resetInjectionAfterHostRestart(state) {
  const hostProcessId = currentHostProcessId()
  if (state.hostProcessId && state.hostProcessId !== hostProcessId) {
    state.injectedRulePaths = []
  }
  state.hostProcessId = hostProcessId
}

function addPath(state, p, projectDir) {
  if (!p || typeof p !== "string") return

  const normalized = path.isAbsolute(p)
    ? (() => {
        const rel = path.relative(projectDir, p)
        return rel.startsWith("..") || rel === "" ? null : rel
      })()
    : p

  if (normalized && !state.contextPaths.includes(normalized)) {
    state.contextPaths.push(normalized)
  }

  if (normalized && p !== normalized && !state.contextPaths.includes(p)) {
    state.contextPaths.push(p)
  }
}

function getActiveRules(rules, contextPaths) {
  const always = []
  const conditional = []

  for (const rule of rules) {
    if (rule.globs === null) {
      always.push(rule)
    } else if (
      contextPaths.length > 0 &&
      contextPaths.some((p) => rule.globs.some((g) => matchesGlob(p, g)))
    ) {
      conditional.push(rule)
    }
  }

  return { always, conditional }
}

function wrap(contents, label) {
  return `<project_instructions type="${label}">\nTrusted project instructions loaded from this repository. Apply them when working in their matching files.\n\n${contents.join("\n\n---\n\n")}\n</project_instructions>`
}

// Injects content of rules not yet seen this session into Claude context, and updates state.
function injectNewRules(rules, state) {
  const active = getActiveRules(rules, state.contextPaths)
  const allActive = [...active.always, ...active.conditional]
  const injected = new Set(state.injectedRulePaths || [])

  const newAlways = active.always.filter((r) => !injected.has(r.path))
  const newConditional = active.conditional.filter((r) => !injected.has(r.path))
  const newRules = [...newAlways, ...newConditional]

  state.activeRulePaths = allActive.map((r) => r.path)
  if (newRules.length > 0) {
    state.injectedRulePaths = [...injected, ...newRules.map((r) => r.path)]
  }

  if (newRules.length === 0) return null

  const parts = []
  if (newAlways.length > 0) parts.push(wrap(newAlways.map((r) => r.content), "always"))
  if (newConditional.length > 0) parts.push(wrap(newConditional.map((r) => r.content), "conditional"))
  return parts.join("\n\n")
}

function ok(hookEventName, additionalContext) {
  const out = { continue: true }
  if (additionalContext) {
    out.hookSpecificOutput = { hookEventName, additionalContext }
  }
  process.stdout.write(JSON.stringify(out))
}

function readInput(inputFile) {
  return JSON.parse(fs.readFileSync(inputFile, "utf8"))
}

function cmdSessionStart(opts) {
  const { projectDir, stateDir, inputFile, resume } = opts
  const input = readInput(inputFile)
  const sessionId = input.session_id || "default"
  const rules = loadRules(projectDir)

  // On resume/compact: restore accumulated paths + injected set. On startup/clear: fresh state.
  const state = resume
    ? (readState(stateDir, sessionId) || initState(sessionId, projectDir))
    : initState(sessionId, projectDir)
  resetInjectionAfterHostRestart(state)

  const additionalContext = injectNewRules(rules, state)
  state.rulesChecksum = String(rules.length)
  writeState(stateDir, sessionId, state, inputFile)

  ok("SessionStart", additionalContext)
}

function cmdUserPrompt(opts) {
  const { projectDir, stateDir, inputFile } = opts
  const input = readInput(inputFile)
  const sessionId = input.session_id || "default"
  const promptText = input.prompt || input.user_prompt || ""
  const rules = loadRules(projectDir)

  let state = readState(stateDir, sessionId)
  if (!state) state = initState(sessionId, projectDir)

  for (const fp of extractPathsFromText(promptText)) {
    addPath(state, fp, projectDir)
  }

  const additionalContext = injectNewRules(rules, state)
  writeState(stateDir, sessionId, state, inputFile)

  ok("UserPromptSubmit", additionalContext)
}

function cmdPreTool(opts) {
  const { projectDir, stateDir, inputFile } = opts
  const input = readInput(inputFile)
  const sessionId = input.session_id || "default"
  const toolName = input.tool_name || ""
  const rules = loadRules(projectDir)

  if (!TOOLS.includes(toolName)) {
    ok("PreToolUse", null)
    return
  }

  let state = readState(stateDir, sessionId)
  if (!state) state = initState(sessionId, projectDir)

  const toolInput = input.tool_input || {}
  const fp = toolInput.file_path || toolInput.filePath || toolInput.path
  if (fp && typeof fp === "string") {
    addPath(state, fp, projectDir)
  }

  const additionalContext = injectNewRules(rules, state)
  writeState(stateDir, sessionId, state, inputFile)

  ok("PreToolUse", additionalContext)
}

function cmdPreCompact(opts) {
  const { projectDir, stateDir, inputFile } = opts
  const input = readInput(inputFile)
  const sessionId = input.session_id || "default"

  const state = readState(stateDir, sessionId)
  if (!state || state.contextPaths.length === 0) {
    ok("PreCompact", null)
    return
  }

  // Reset injected set so all active rules are re-injected after compaction.
  state.injectedRulePaths = []
  writeState(stateDir, sessionId, state, inputFile)

  ok("PreCompact", null)
}

function cmdStatus(opts) {
  const { projectDir, stateDir } = opts
  const rules = loadRules(projectDir)

  const always = rules.filter((r) => r.globs === null)
  const conditional = rules.filter((r) => r.globs !== null)

  const lines = [
    "## Copilot Instructions Status",
    "",
    `### Always-active (no applyTo) — ${always.length} files`,
    ...always.map((r) => `- ✓ ${r.path}`),
    "",
    `### Conditional (applyTo) — ${conditional.length} files`,
    ...conditional.map((r) => `- ${r.path} [${r.globs.join(", ")}]`),
  ]

  let sessionFiles = []
  try {
    sessionFiles = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"))
  } catch {}

  if (sessionFiles.length > 0) {
    const sessions = []

    for (const f of sessionFiles) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8"))
        const sessionId = f.replace(".json", "")
        sessions.push({ sessionId, state: s })
      } catch {}
    }

    const currentSessionId = sessions
      .filter((s) => s.state.lastUpdatedAt)
      .sort((a, b) => String(b.state.lastUpdatedAt).localeCompare(String(a.state.lastUpdatedAt)))[0]
      ?.sessionId

    const current = sessions
      .filter((s) => s.state.lastUpdatedAt)
      .sort((a, b) => String(b.state.lastUpdatedAt).localeCompare(String(a.state.lastUpdatedAt)))[0]

    if (current) {
      const s = current.state
      const active = getActiveRules(rules, s.contextPaths)
      const allActive = [...active.always, ...active.conditional]
      const activePaths = allActive.map((r) => r.path)
      const pending = conditional.filter((r) => !allActive.some((a) => a.path === r.path))

      lines.push("", `### Current session`, "", `#### ${current.sessionId} (current)`)

      if (s.contextPaths.length > 0) {
        lines.push("", "Context paths:", ...s.contextPaths.map((p) => `  - ${p}`))
      }

      if (activePaths.length > 0) {
        lines.push(
          "",
          `Active rules (${activePaths.length}):`,
          ...activePaths.map((p) => `  - ✓ ${p}`)
        )
      }

      if (pending.length > 0) {
        lines.push(
          "",
          `Pending rules (${pending.length}):`,
          ...pending.map((r) => `  - ○ ${r.path}`)
        )
      }
    }
  } else {
    lines.push("", "_No active session_")
  }

  process.stdout.write(lines.join("\n"))
}

if (require.main === module) {
  const cmd = process.argv[2]
  const opts = (() => {
    const BOOLEAN_FLAGS = new Set(["resume", "fresh"])
    const o = {}
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i].startsWith("--")) {
        const k = process.argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        if (BOOLEAN_FLAGS.has(k)) {
          o[k] = true
        } else {
          o[k] = process.argv[i + 1] || ""
          i++
        }
      }
    }
    return o
  })()

  try {
    switch (cmd) {
      case "session-start":
        cmdSessionStart(opts)
        break
      case "user-prompt":
        cmdUserPrompt(opts)
        break
      case "pre-tool":
        cmdPreTool(opts)
        break
      case "pre-compact":
        cmdPreCompact(opts)
        break
      case "status":
        cmdStatus(opts)
        break
      default:
        ok("Unknown", null)
    }
  } catch (err) {
    ok("Error", null)
  }
}

module.exports = {
  parseApplyTo,
  extractPathsFromText,
  matchesGlob,
  loadRules,
  globToRegex,
  FRONTMATTER_RE,
  PATH_REGEX,
}
