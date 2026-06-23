import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const ENGINE = resolve("hooks/scripts/instructions.cjs")

function run(cmd, projectDir, stateDir, input, env = {}) {
  const inputFile = join(stateDir, "input.json")
  writeFileSync(inputFile, JSON.stringify(input))
  const result = execSync(
    `node "${ENGINE}" ${cmd} --project-dir "${projectDir}" --state-dir "${stateDir}" --input-file "${inputFile}"`,
    { encoding: "utf8", timeout: 5000, env: { ...process.env, ...env } }
  )
  return JSON.parse(result.trim())
}

function runSessionStart(projectDir, stateDir, input, flags = "", env = {}) {
  const inputFile = join(stateDir, "input.json")
  writeFileSync(inputFile, JSON.stringify(input))
  const result = execSync(
    `node "${ENGINE}" session-start --project-dir "${projectDir}" --state-dir "${stateDir}" --input-file "${inputFile}" ${flags}`,
    { encoding: "utf8", timeout: 5000, env: { ...process.env, ...env } }
  )
  return JSON.parse(result.trim())
}

function context(out) {
  return out.hookSpecificOutput?.additionalContext || ""
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "ci-cli-"))
  const stateDir = join(dir, "state")
  mkdirSync(stateDir, { recursive: true })
  const instrDir = join(dir, ".github", "instructions")
  mkdirSync(instrDir, { recursive: true })
  return { dir, stateDir, instrDir }
}

test("session-start: injects always rules only", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways rule content.")
    writeFileSync(
      join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond rule content.'
    )

    const out = run("session-start", dir, stateDir, { session_id: "ss1" })
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart")
    assert.ok(context(out).includes("Always rule content"))
    assert.ok(context(out).includes('type="always"'))
    assert.ok(!context(out).includes("Cond rule content"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("user-prompt: extracts paths and matches conditional rules", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways.")
    writeFileSync(
      join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond.'
    )

    const out = run("user-prompt", dir, stateDir, {
      session_id: "up1",
      user_prompt: "edit src/index.ts",
    })

    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit")
    assert.ok(context(out).includes("Always."))
    assert.ok(context(out).includes("Cond."))
    assert.ok(context(out).includes('type="always"'))
    assert.ok(context(out).includes('type="conditional"'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("user-prompt: reads Claude Code prompt field", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(
      join(instrDir, "cond.md"),
      '---\napplyTo: "apps/backend/**"\n---\n# Backend\nBackend rule.'
    )

    const out = run("user-prompt", dir, stateDir, {
      session_id: "up-prompt",
      prompt: "read apps/backend/app/controllers/v1/users_controller.rb",
    })

    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit")
    assert.ok(context(out).includes("Backend rule."))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("user-prompt: non-matching path activates only always rules", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways.")
    writeFileSync(
      join(instrDir, "cond.md"),
      '---\napplyTo: "app/controllers/**"\n---\n# Cond\nCond.'
    )

    const out = run("user-prompt", dir, stateDir, {
      session_id: "up2",
      user_prompt: "edit app/models/user.rb",
    })

    assert.ok(context(out).includes("Always."))
    assert.ok(!context(out).includes("Cond."))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pre-tool: tracks Read paths and injects matching rules", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways.")
    writeFileSync(
      join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond.'
    )

    const out = run("pre-tool", dir, stateDir, {
      session_id: "pt1",
      tool_name: "Read",
      tool_input: { file_path: "src/index.ts" },
    })

    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse")
    assert.ok(context(out).includes("Always."))
    assert.ok(context(out).includes("Cond."))
  } finally {
    rmSync(dir, { recursive: true, force: true }
    )
  }
})

test("pre-tool: ignores non-tracked tools", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways.")

    const out = run("pre-tool", dir, stateDir, {
      session_id: "pt2",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    })

    assert.ok(!out.hookSpecificOutput)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pre-tool: directory path activates directory-scoped rule", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "cond.md"),
      '---\napplyTo: "app/models/**"\n---\n# Models\nModel instructions.'
    )

    const out = run("pre-tool", dir, stateDir, {
      session_id: "pt3",
      tool_name: "Grep",
      tool_input: { path: "app/models" },
    })

    assert.ok(context(out).includes("Model instructions"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pre-compact: preserves context paths", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond.'
    )

    run("user-prompt", dir, stateDir, {
      session_id: "pc1",
      user_prompt: "edit src/index.ts",
    })

    const out = run("pre-compact", dir, stateDir, {
      session_id: "pc1",
    })

    assert.ok(!out.hookSpecificOutput)

    const stateFile = join(stateDir, "pc1.json")
    const state = JSON.parse(readFileSync(stateFile, "utf8"))
    assert.ok(state.contextPaths.includes("src/index.ts"))
    assert.deepEqual(state.injectedRulePaths, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("session-start resume re-injects active rules after compaction", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond.'
    )

    run("user-prompt", dir, stateDir, {
      session_id: "pc2",
      prompt: "edit src/index.ts",
    })

    run("pre-compact", dir, stateDir, {
      session_id: "pc2",
    })

    const parsed = runSessionStart(dir, stateDir, { session_id: "pc2" }, "--resume")
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart")
    assert.ok(context(parsed).includes("Cond."))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("session-start resume re-injects active rules after Claude host restarts", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "cond.md"),
      '---\napplyTo: "apps/backend/app/controllers/**"\n---\n# Controllers\nPrefix rule.'
    )

    runSessionStart(
      dir,
      stateDir,
      { session_id: "resume1" },
      "",
      { COPILOT_INSTRUCTIONS_HOST_PROCESS_ID: "old-host" }
    )

    run("user-prompt", dir, stateDir, {
      session_id: "resume1",
      prompt: "read apps/backend/app/controllers/v1/users_controller.rb",
    }, { COPILOT_INSTRUCTIONS_HOST_PROCESS_ID: "old-host" })

    const sameHost = runSessionStart(
      dir,
      stateDir,
      { session_id: "resume1" },
      "--resume",
      { COPILOT_INSTRUCTIONS_HOST_PROCESS_ID: "old-host" }
    )
    assert.ok(!sameHost.hookSpecificOutput)

    const newHost = runSessionStart(
      dir,
      stateDir,
      { session_id: "resume1" },
      "--resume",
      { COPILOT_INSTRUCTIONS_HOST_PROCESS_ID: "new-host" }
    )
    assert.equal(newHost.hookSpecificOutput.hookEventName, "SessionStart")
    assert.ok(context(newHost).includes("Prefix rule."))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("state persists across hook invocations", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond.'
    )

    // Step 1: SessionStart — no conditional
    const sOut = run("session-start", dir, stateDir, { session_id: "persist1" })
    assert.ok(!sOut.hookSpecificOutput)

    // Step 2: UserPrompt with path — conditionals activate
    const upOut = run("user-prompt", dir, stateDir, {
      session_id: "persist1",
      user_prompt: "edit src/index.ts",
    })
    assert.ok(context(upOut).includes("Cond."))

    // Step 3: State file exists with accumulated paths
    const stateFile = join(stateDir, "persist1.json")
    const state = JSON.parse(readFileSync(stateFile, "utf8"))
    assert.ok(state.contextPaths.includes("src/index.ts"))
    assert.ok(state.activeRulePaths.includes("cond.md"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("outside-project paths are NOT persisted", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond.'
    )

    run("pre-tool", dir, stateDir, {
      session_id: "outside1",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/secret.txt" },
    })

    const stateFile = join(stateDir, "outside1.json")
    const state = JSON.parse(readFileSync(stateFile, "utf8"))
    assert.equal(state.contextPaths.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true }
    )
  }
})

test("no instructions dir produces valid empty response", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-cli-"))
  const stateDir = join(dir, "state")
  mkdirSync(stateDir, { recursive: true })
  try {
    const out = run("session-start", dir, stateDir, { session_id: "empty1" })
    assert.equal(out.continue, true)
    assert.ok(!out.hookSpecificOutput)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status: lists always and conditional rules when no sessions", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways.")
    writeFileSync(
      join(instrDir, "cond.md"),
      '---\napplyTo: "src/**"\n---\n# Cond\nCond.'
    )

    const out = execSync(
      `node "${ENGINE}" status --project-dir "${dir}" --state-dir "${stateDir}"`,
      { encoding: "utf8", timeout: 5000 }
    )

    assert.ok(out.includes("Always-active"))
    assert.ok(out.includes("always.md"))
    assert.ok(out.includes("Conditional"))
    assert.ok(out.includes("cond.md"))
    assert.ok(out.includes("src/**"))
    assert.ok(!out.includes("Session details"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status: shows per-session active/pending rules and context paths", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways.")
    writeFileSync(
      join(instrDir, "frontend.md"),
      '---\napplyTo: "src/frontend/**"\n---\n# Frontend\nFrontend guide.'
    )
    writeFileSync(
      join(instrDir, "backend.md"),
      '---\napplyTo: "src/backend/**"\n---\n# Backend\nBackend guide.'
    )

    run("user-prompt", dir, stateDir, {
      session_id: "st1",
      user_prompt: "edit src/frontend/App.tsx",
    })

    const out = execSync(
      `node "${ENGINE}" status --project-dir "${dir}" --state-dir "${stateDir}"`,
      { encoding: "utf8", timeout: 5000 }
    )

    assert.ok(out.includes("Current session"))
    assert.ok(out.includes("st1 (current)"))
    assert.ok(out.includes("src/frontend/App.tsx"))
    assert.ok(out.includes("Active rules"))
    assert.ok(out.includes("frontend.md"))
    assert.ok(out.includes("Pending rules"))
    assert.ok(out.includes("backend.md"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status: marks newest updated session as current", () => {
  const { dir, stateDir, instrDir } = fixtureDir()
  try {
    writeFileSync(join(instrDir, "always.md"), "# Always\nAlways.")
    writeFileSync(
      join(instrDir, "frontend.md"),
      '---\napplyTo: "src/frontend/**"\n---\n# Frontend\nFrontend guide.'
    )
    writeFileSync(
      join(instrDir, "backend.md"),
      '---\napplyTo: "src/backend/**"\n---\n# Backend\nBackend guide.'
    )

    run("user-prompt", dir, stateDir, {
      session_id: "old-session",
      user_prompt: "edit src/frontend/App.tsx",
    })
    run("user-prompt", dir, stateDir, {
      session_id: "new-session",
      user_prompt: "edit src/backend/User.rb",
    })

    const out = execSync(
      `node "${ENGINE}" status --project-dir "${dir}" --state-dir "${stateDir}"`,
      { encoding: "utf8", timeout: 5000 }
    )

    assert.ok(!out.includes("old-session"))
    assert.ok(out.includes("new-session (current)"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
