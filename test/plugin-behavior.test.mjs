import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { CopilotInstructionsPlugin } from "../dist/src/index.js"

async function createPlugin(files) {
  const directory = await mkdtemp(join(tmpdir(), "copilot-instructions-plugin-"))

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(directory, path)
    await mkdir(join(fullPath, ".."), { recursive: true })
    await writeFile(fullPath, content)
  }

  const toasts = []
  const plugin = await CopilotInstructionsPlugin({
    directory,
    client: {
      tui: {
        showToast(toast) {
          toasts.push(toast)
        },
      },
    },
  })

  return { directory, plugin, toasts }
}

test("injects always rules and matching conditional rules", async () => {
  const { directory, plugin, toasts } = await createPlugin({
    ".github/instructions/general.md": "# General\n\nAlways follow this.",
    ".github/instructions/typescript.md": `---
applyTo: "src/**/*.ts"
---
# TypeScript

Use strict types.`,
  })

  await plugin["tool.execute.before"](
    { tool: "read", sessionID: "session-1" },
    { args: { filePath: join(directory, "src/index.ts") } }
  )

  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-1" }, output)

  assert.equal(output.system.length, 2)
  assert.match(output.system[0], /type="always"/)
  assert.match(output.system[0], /Always follow this\./)
  assert.match(output.system[1], /type="conditional"/)
  assert.match(output.system[1], /Use strict types\./)
  assert.equal(toasts.length, 1)
})

test("does not inject conditional rules before a matching path is seen", async () => {
  const { plugin } = await createPlugin({
    ".github/instructions/general.md": "# General\n\nAlways follow this.",
    ".github/instructions/ruby.md": `---
applyTo: "app/**/*.rb"
---
# Ruby

Use Ruby style.`,
  })

  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-2" }, output)

  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /type="always"/)
  assert.doesNotMatch(output.system[0], /Use Ruby style\./)
})

test("does not activate an unmatched conditional rule with duplicate content", async () => {
  const shared = "# Shared\n\nSame instructions."
  const { plugin, toasts } = await createPlugin({
    ".github/instructions/always.md": shared,
    ".github/instructions/conditional.md": `---
applyTo: "src/**/*.ts"
---
${shared}`,
  })

  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-3" }, output)

  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /type="always"/)
  assert.doesNotMatch(output.system[0], /type="conditional"/)
  assert.equal(toasts.length, 0)
})

test("normalizes paths from user messages before matching rules", async () => {
  const { plugin } = await createPlugin({
    ".github/instructions/typescript.md": `---
applyTo: "src/**/*.ts"
---
# TypeScript

Use strict types.`,
  })

  await plugin["chat.message"](
    { sessionID: "session-4" },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "Please inspect ./src/index.ts." }],
    }
  )

  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-4" }, output)

  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /Use strict types\./)
})

test("ignores paths outside the workspace", async () => {
  const outsideDirectory = await mkdtemp(join(tmpdir(), "outside-workspace-"))
  const { plugin } = await createPlugin({
    ".github/instructions/typescript.md": `---
applyTo: "src/**/*.ts"
---
# TypeScript

Use strict types.`,
  })

  await plugin["tool.execute.before"](
    { tool: "read", sessionID: "session-5" },
    { args: { filePath: join(outsideDirectory, "src/index.ts") } }
  )

  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-5" }, output)

  assert.equal(output.system.length, 0)
})

test("skips instruction files with an explicit empty applyTo", async () => {
  const { plugin } = await createPlugin({
    ".github/instructions/empty.md": `---
applyTo:
---
# Empty

Do not inject globally.`,
  })

  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-6" }, output)

  assert.equal(output.system.length, 0)
})

test("loads instruction files in filename order", async () => {
  const { plugin } = await createPlugin({
    ".github/instructions/z-last.md": "# Z\n\nLast instruction.",
    ".github/instructions/a-first.md": "# A\n\nFirst instruction.",
  })

  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-7" }, output)

  assert.equal(output.system.length, 1)
  assert.ok(output.system[0].indexOf("First instruction.") < output.system[0].indexOf("Last instruction."))
})

test("captures glob and grep result paths after tool execution", async () => {
  const { plugin } = await createPlugin({
    ".github/instructions/typescript.md": `---
applyTo: "src/**/*.ts"
---
# TypeScript

Use strict types.`,
  })

  await plugin["tool.execute.after"](
    { tool: "glob", sessionID: "session-8" },
    { output: ["src/index.ts"] }
  )

  const globOutput = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-8" }, globOutput)

  assert.equal(globOutput.system.length, 1)
  assert.match(globOutput.system[0], /Use strict types\./)

  await plugin["tool.execute.after"](
    { tool: "grep", sessionID: "session-9" },
    { output: "src/controller.ts:1:const controller = true" }
  )

  const grepOutput = { system: [] }
  await plugin["experimental.chat.system.transform"]({ sessionID: "session-9" }, grepOutput)

  assert.equal(grepOutput.system.length, 1)
  assert.match(grepOutput.system[0], /Use strict types\./)
})
