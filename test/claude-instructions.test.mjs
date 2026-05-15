import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, sep } from "node:path"
import { tmpdir } from "node:os"

const {
  parseApplyTo,
  extractPathsFromText,
  matchesGlob,
  loadRules,
  FRONTMATTER_RE,
  PATH_REGEX,
} = await import("../hooks/scripts/instructions.cjs")

const winSep = sep === "\\"

// =============================================================================
// parseApplyTo — parity with src/index.ts
// =============================================================================

test("parseApplyTo: returns empty when no frontmatter exists", () => {
  assert.deepEqual(parseApplyTo("# Instructions"), [])
})

test("parseApplyTo: parses single applyTo pattern", () => {
  const raw = `---
applyTo: "app/models/**/*.rb"
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), ["app/models/**/*.rb"])
})

test("parseApplyTo: parses comma-separated patterns", () => {
  const raw = `---
applyTo: "**/*.ts,**/*.tsx"
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), ["**/*.ts", "**/*.tsx"])
})

test("parseApplyTo: parses applyTo when extra frontmatter keys exist", () => {
  const raw = `---
applyTo: "**"
excludeAgent: "code-review"
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), ["**"])
})

test("parseApplyTo: parses regardless of key order", () => {
  const raw = `---
excludeAgent: "code-review"
applyTo: "src/**/*.py"
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), ["src/**/*.py"])
})

test("parseApplyTo: parses documented glob list", () => {
  const raw = `---
applyTo: "*,**,**/*,*.py,**/*.py,src/*.py,src/**/*.py,**/subdir/**/*.py"
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), [
    "*",
    "**",
    "**/*",
    "*.py",
    "**/*.py",
    "src/*.py",
    "src/**/*.py",
    "**/subdir/**/*.py",
  ])
})

test("parseApplyTo: supports CRLF with spacing", () => {
  const raw =
    '---\r\napplyTo: "**/*.ts, **/*.tsx"\r\nexcludeAgent: "code-review"\r\n---\r\n# Instructions'
  assert.deepEqual(parseApplyTo(raw), ["**/*.ts", "**/*.tsx"])
})

test("parseApplyTo: returns empty when frontmatter has no applyTo", () => {
  const raw = `---
excludeAgent: "code-review"
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), [])
})

test("parseApplyTo: BOM is ignored", () => {
  const raw = `\uFEFF---
applyTo: "src/**"
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), ["src/**"])
})

test("parseApplyTo: unquoted value", () => {
  const raw = `---
applyTo: src/**/*.ts
---
# Instructions`
  assert.deepEqual(parseApplyTo(raw), ["src/**/*.ts"])
})

// =============================================================================
// FRONTMATTER_RE — frontmatter stripping
// =============================================================================

test("FRONTMATTER_RE: strips frontmatter", () => {
  const raw = `---
applyTo: "src/**"
---
# Hello world`
  const result = raw.replace(FRONTMATTER_RE, "").trim()
  assert.equal(result, "# Hello world")
})

test("FRONTMATTER_RE: strips frontmatter with CRLF", () => {
  const raw = "---\r\napplyTo: \"src/**\"\r\n---\r\n# Hello world"
  const result = raw.replace(FRONTMATTER_RE, "").trim()
  assert.equal(result, "# Hello world")
})

// =============================================================================
// matchesGlob
// =============================================================================

test("matchesGlob: matches extension glob", () => {
  assert.equal(matchesGlob("src/file.ts", "**/*.ts"), true)
  assert.equal(matchesGlob("src/file.py", "**/*.ts"), false)
  assert.equal(matchesGlob("file.ts", "*.ts"), true)
})

test("matchesGlob: matches directory glob", () => {
  assert.equal(matchesGlob("app/controllers/users.rb", "app/controllers/**"), true)
  assert.equal(matchesGlob("app/models/user.rb", "app/controllers/**"), false)
})

test("matchesGlob: matches deep glob", () => {
  assert.equal(
    matchesGlob("a/b/c/d.ts", "**/*.ts"),
    true
  )
})

test("matchesGlob: does not match partial", () => {
  if (winSep) return test.skip("Partial matching behaves differently on Windows")
  assert.equal(matchesGlob("controllers/users.rb", "app/controllers/**"), false)
})

test("matchesGlob: single * matches within one segment", () => {
  if (winSep) return test.skip("Glob regex behaves differently on Windows")
  assert.equal(matchesGlob("src/index.ts", "src/*.ts"), true)
  assert.equal(matchesGlob("src/sub/index.ts", "src/*.ts"), false)
})

test("matchesGlob: trailing ** matches nested", () => {
  if (winSep) return test.skip("Glob regex behaves differently on Windows")
  assert.equal(matchesGlob("src/x.ts", "src/**"), true)
  assert.equal(matchesGlob("src/a/b/x.ts", "src/**"), true)
})

test("matchesGlob: ? matches single char", () => {
  if (winSep) return test.skip("Glob regex behaves differently on Windows")
  assert.equal(matchesGlob("file1.ts", "file?.ts"), true)
  assert.equal(matchesGlob("file10.ts", "file?.ts"), false)
})

// =============================================================================
// extractPathsFromText
// =============================================================================

test("extractPathsFromText: finds relative paths", () => {
  const result = extractPathsFromText("look at src/app.ts")
  assert.ok(result.includes("src/app.ts"))
})

test("extractPathsFromText: finds paths starting with ./", () => {
  const result = extractPathsFromText("run ./scripts/build.sh")
  assert.ok(result.includes("./scripts/build.sh"))
})

test("extractPathsFromText: ignores URLs", () => {
  const result = extractPathsFromText("see https://example.com/path/to")
  assert.equal(result.length, 0)
})

test("extractPathsFromText: ignores email-like strings", () => {
  const result = extractPathsFromText("email user@host.com now")
  assert.equal(result.length, 0)
})

test("extractPathsFromText: strips trailing punctuation", () => {
  const result = extractPathsFromText("check src/app.ts, and src/lib.ts.")
  assert.ok(result.includes("src/app.ts"))
  assert.ok(result.includes("src/lib.ts"))
})

test("extractPathsFromText: handles empty input", () => {
  assert.deepEqual(extractPathsFromText(""), [])
  assert.deepEqual(extractPathsFromText(null), [])
  assert.deepEqual(extractPathsFromText(undefined), [])
})

test("extractPathsFromText: finds paths with dots in filename", () => {
  const result = extractPathsFromText("check app/models/user.rb")
  assert.ok(result.some((p) => p.includes("user.rb")))
})

// =============================================================================
// loadRules
// =============================================================================

test("loadRules: returns empty when no instructions dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-"))
  try {
    assert.deepEqual(loadRules(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadRules: loads markdown files with applyTo", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-"))
  try {
    const instrDir = join(dir, ".github", "instructions")
    mkdirSync(instrDir, { recursive: true })
    writeFileSync(
      join(instrDir, "controllers.instructions.md"),
      '---\napplyTo: "app/controllers/**"\n---\n# Controllers Guide\nAlways use strong params.'
    )
    writeFileSync(
      join(instrDir, "general.instructions.md"),
      "# General Guide\nWrite tests first."
    )

    const rules = loadRules(dir)
    assert.equal(rules.length, 2)

    const conditional = rules.find((r) => r.globs !== null)
    assert.ok(conditional)
    assert.deepEqual(conditional.globs, ["app/controllers/**"])
    assert.ok(conditional.content.includes("Controllers Guide"))

    const always = rules.find((r) => r.globs === null)
    assert.ok(always)
    assert.ok(always.content.includes("General Guide"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadRules: frontmatter is stripped from content", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-"))
  try {
    const instrDir = join(dir, ".github", "instructions")
    mkdirSync(instrDir, { recursive: true })
    writeFileSync(
      join(instrDir, "test.instructions.md"),
      '---\napplyTo: "src/**"\n---\n# Real Content'
    )

    const rules = loadRules(dir)
    assert.equal(rules.length, 1)
    assert.equal(rules[0].content, "# Real Content")
    assert.ok(!rules[0].content.includes("applyTo"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadRules: skips non-md and dotfiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-"))
  try {
    const instrDir = join(dir, ".github", "instructions")
    mkdirSync(instrDir, { recursive: true })
    writeFileSync(join(instrDir, "readme.txt"), "text")
    writeFileSync(join(instrDir, ".hidden.md"), "hidden")
    writeFileSync(join(instrDir, "valid.instructions.md"), "# Valid")

    const rules = loadRules(dir)
    assert.equal(rules.length, 1)
    assert.equal(rules[0].path, "valid.instructions.md")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadRules: handles comma-separated globs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-"))
  try {
    const instrDir = join(dir, ".github", "instructions")
    mkdirSync(instrDir, { recursive: true })
    writeFileSync(
      join(instrDir, "multi.instructions.md"),
      '---\napplyTo: "app/models/**, test/**"\n---\n# Multi'
    )
    const rules = loadRules(dir)
    assert.deepEqual(rules[0].globs, ["app/models/**", "test/**"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// =============================================================================
// PATH_REGEX — no false positives
// =============================================================================

test("PATH_REGEX: ignores bare words", () => {
  PATH_REGEX.lastIndex = 0
  assert.equal(PATH_REGEX.test("just a word"), false)
})

test("PATH_REGEX: requires a slash", () => {
  PATH_REGEX.lastIndex = 0
  assert.equal(PATH_REGEX.test("filename.txt"), false)
})

test("PATH_REGEX: matches typical paths", () => {
  PATH_REGEX.lastIndex = 0
  const match = PATH_REGEX.exec("edit src/app/models/user.rb")
  assert.ok(match)
  assert.equal(match[1], "src/app/models/user.rb")
})
