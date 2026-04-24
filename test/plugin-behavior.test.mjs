import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { CopilotInstructionsPlugin } from "../dist/src/index.js"

async function createPlugin(files) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-copilot-instructions-"))

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
