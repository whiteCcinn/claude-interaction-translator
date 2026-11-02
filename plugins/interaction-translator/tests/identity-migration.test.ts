import { expect, test } from "claude-code/testing"
import type { ConfigRow } from "claude-code"
import { FOLLOW_LOCAL, MANUAL_INPUT } from "../hooks/configuration"

const NAME = "interaction-translator"

function row(plugin: string, field: string, isLocked = false): ConfigRow {
  return { key: `${plugin}.${field}`, label: field, kind: "text", value: "not-consumed", provider: { plugin: `${plugin}@inline`, tier: "user" }, isLocked }
}

test("renamed plugin ignores options and locks belonging to the previous identity", { options: { backend: "codex-cli", codex_model: "retained-model", codex_path: "/retained/codex" } }, async ($, on) => {
  on("config.list", () => ({ value: [row(NAME, "backend"), row("prompt-translator", "codex_model", true)] }))
  on("settings.read", (_, e) => ({ value: e.source === "user" ? { pluginConfigs: {
    [`${NAME}@inline`]: { options: { codex_model_selection: FOLLOW_LOCAL, codex_path_selection: FOLLOW_LOCAL } },
    "prompt-translator@inline": { options: { codex_model_selection: MANUAL_INPUT, codex_model: "old-private-model", codex_path_selection: MANUAL_INPUT, codex_path: "/old/codex" } },
  } } : {} }))
  on("process.run", (_, e) => {
    expect(e.argv[0]).toBe("codex")
    expect(e.argv.includes("--model")).toBe(false)
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("old configuration commands do not initialize the renamed plugin", async ($, on) => {
  let reads = 0
  on("config.list", () => { reads += 1; return { value: [row(NAME, "backend")] } })
  on("command.run", { command: "plugin" }, () => ({ text: "old configuration" }))
  const result = await $.command.run({ command: "plugin", args: "configure prompt-translator@inline", origin: { kind: "sdk" }, presentation: { isFullscreen: false, columns: 80 } })
  expect(result.text).toBe("old configuration")
  expect(reads).toBe(0)
})
