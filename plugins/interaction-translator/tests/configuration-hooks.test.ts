import { expect, test } from "claude-code/testing"
import type { ConfigRow, TurnStepChunk } from "claude-code"
import { FOLLOW_LOCAL, MANUAL_INPUT, DEFAULT_API_MODEL, DEFAULT_API_URL } from "../hooks/configuration"

function lockedRow(field: string, plugin = "interaction-translator"): ConfigRow {
  return { key: `${plugin}.${field}`, label: field, kind: "text", value: "not-consumed", provider: { plugin: `${plugin}@inline`, tier: "user" }, isLocked: true }
}

const commandContext = { origin: { kind: "sdk" as const }, presentation: { isFullscreen: false, columns: 80 } }

test("a Codex preset reaches argv without requiring a manual text value", { options: { backend: "codex-cli", codex_model_selection: "gpt-6.1-terra" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    expect(e.argv[e.argv.indexOf("--model") + 1]).toBe("gpt-6.1-terra")
    expect(e.argv.includes(FOLLOW_LOCAL)).toBe(false)
    expect(e.argv.includes(MANUAL_INPUT)).toBe(false)
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("configuration locks are read once per activation and manual mode reuses old values", { options: { backend: "codex-cli", codex_model_selection: MANUAL_INPUT, codex_model: "company-model" } }, async ($, on) => {
  let reads = 0
  on("config.list", () => { reads += 1; return { value: [] } })
  on("process.run", (_, e) => {
    expect(e.argv[e.argv.indexOf("--model") + 1]).toBe("company-model")
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  for (let index = 0; index < 2; index += 1) expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
  expect(reads).toBe(1)
})

test("follow-local ignores retained manual values", { options: { backend: "codex-cli", codex_model: "company-model", codex_path: "/old/codex" } }, async ($, on) => {
  on("config.list", () => ({ value: [{ ...lockedRow("backend"), isLocked: false }] }))
  on("settings.read", (_, e) => ({ value: e.source === "user" ? { pluginConfigs: { "interaction-translator@inline": { options: { codex_model_selection: FOLLOW_LOCAL, codex_path_selection: FOLLOW_LOCAL } } } } : {} }))
  on("process.run", (_, e) => {
    expect(e.argv[0]).toBe("codex")
    expect(e.argv.includes("--model")).toBe(false)
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("missing manual model stops before starting Codex or reading credentials", { options: { backend: "codex-cli", codex_model_selection: MANUAL_INPUT } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).drop).toContain("手动")
})

test("manual API key mode does not fall back to environment credentials", { options: { api_key_source: MANUAL_INPUT } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).drop).toContain("API Key")
})

test("API preset ignores retained manual endpoint/model values", { options: { api_url: "https://old.example/v1/chat/completions", model: "old-model" } }, async ($, on) => {
  on("config.list", () => ({ value: [{ ...lockedRow("backend"), isLocked: false }] }))
  on("settings.read", (_, e) => ({ value: e.source === "user" ? { pluginConfigs: { "interaction-translator@inline": { options: { api_url_selection: DEFAULT_API_URL, api_model_selection: DEFAULT_API_MODEL } } } } : {} }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    expect(e.url).toBe(DEFAULT_API_URL)
    expect(JSON.parse(e.init?.body ?? "{}").model).toBe(DEFAULT_API_MODEL)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Hello." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("output uses the preset without changing Claude's model", { options: { output_mode: "conversation", backend: "codex-cli", codex_model_selection: "gpt-6-luna" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    expect(e.argv[e.argv.indexOf("--model") + 1]).toBe("gpt-6-luna")
    return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("turn.step", async function* (_, e) {
    expect(e.model).toBe("claude-test")
    yield { kind: "text", index: 0, text: "Hello." }
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const chunks: TurnStepChunk[] = []
  for await (const chunk of $.turn.step({ turnId: "preset-output", index: 0, model: "claude-test", messageCount: 1 })) chunks.push(chunk)
  expect(chunks.filter(chunk => chunk.kind === "text").map(chunk => chunk.text).join("")).toBe("你好。")
})

for (const model of ["managed-model", ""]) {
  test(`picker cannot override the managed legacy model ${JSON.stringify(model)}`, { options: { backend: "codex-cli", codex_model_selection: "gpt-6-luna", codex_model: model } }, async ($, on) => {
    on("config.list", () => ({ value: [lockedRow("codex_model")] }))
    on("process.run", (_, e) => {
      expect(e.argv.includes("--model")).toBe(Boolean(model))
      if (model) expect(e.argv[e.argv.indexOf("--model") + 1]).toBe(model)
      return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("prompt.submit", (_, e) => ({ text: e.text }))
    expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
  })
}

test("API picker cannot redirect a locked legacy URL", { options: { api_url: "https://managed.example/v1/chat/completions" } }, async ($, on) => {
  on("config.list", () => ({ value: [lockedRow("api_url")] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    expect(e.url).toBe("https://managed.example/v1/chat/completions")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Hello." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("another plugin's locked row does not constrain this translator", { options: { backend: "codex-cli", codex_model_selection: "gpt-6-luna", codex_model: "retained-model" } }, async ($, on) => {
  on("config.list", () => ({ value: [lockedRow("codex_model", "another-plugin")] }))
  on("process.run", (_, e) => {
    expect(e.argv[e.argv.indexOf("--model") + 1]).toBe("gpt-6-luna")
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("legacy settings use the exact native provider and trusted layers once per activation", { options: { backend: "codex-cli", codex_model: "company-model" } }, async ($, on) => {
  let reads = 0
  on("config.list", () => ({ value: [{ ...lockedRow("backend"), isLocked: false }] }))
  on("settings.read", (_, e) => {
    reads += 1
    return { value: { pluginConfigs: {
      "interaction-translator@foreign": { options: { codex_model_selection: FOLLOW_LOCAL } },
      "interaction-translator@inline": { options: e.source === "user" ? { codex_model: "company-model" } : e.source === "flag" || e.source === "policy" ? {} : { codex_model_selection: FOLLOW_LOCAL } },
    } } }
  })
  on("process.run", (_, e) => {
    expect(e.argv[e.argv.indexOf("--model") + 1]).toBe("company-model")
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  for (let index = 0; index < 2; index += 1) expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
  expect(reads).toBe(3)
})

test("opening configuration preserves two legacy fields and initialization is idempotent", async ($, on) => {
  on("config.list", () => ({ value: [{ ...lockedRow("backend"), isLocked: false }] }))
  on("settings.read", (_, e) => ({ value: e.source === "user" ? { pluginConfigs: { "interaction-translator@inline": { options: { codex_model: "company-model", codex_path: "/old/codex" } } } } : {} }))
  const writes: Array<{ key: string; value: unknown }> = []
  on("config.set", (_, e) => { writes.push({ key: e.key, value: e.value }); return { value: e.value } })
  on("command.run", { command: "plugin" }, () => ({ text: "configured" }))
  for (let index = 0; index < 2; index += 1) expect((await $.command.run({ command: "plugin", args: "configure interaction-translator@inline", ...commandContext })).text).toBe("configured")
  expect(writes).toEqual([{ key: "interaction-translator.codex_model_selection", value: MANUAL_INPUT }, { key: "interaction-translator.codex_path_selection", value: MANUAL_INPUT }])
})

test("failed initialization still opens native configuration", async ($, on) => {
  on("config.list", () => ({ value: [{ ...lockedRow("backend"), isLocked: false }] }))
  on("settings.read", (_, e) => ({ value: e.source === "user" ? { pluginConfigs: { "interaction-translator@inline": { options: { codex_model: "company-model" } } } } : {} }))
  on("config.set", () => ({ deny: "read-only settings" }))
  on("command.run", { command: "plugin" }, () => ({ text: "configured" }))
  const result = await $.command.run({ command: "plugin", args: "configure interaction-translator@inline", ...commandContext })
  expect(result.text).toContain("configured")
  expect(result.text).toContain("无法初始化")
})

test("configuration for another installation does not initialize active settings", async ($, on) => {
  on("config.list", () => ({ value: [{ ...lockedRow("backend"), isLocked: false }] }))
  on("command.run", { command: "plugin" }, () => ({ text: "other source" }))
  expect((await $.command.run({ command: "plugin", args: "configure interaction-translator@foreign", ...commandContext })).text).toBe("other source")
})

test("flag overrides never initialize user selectors", async ($, on) => {
  on("config.list", () => ({ value: [{ ...lockedRow("backend"), isLocked: false }] }))
  on("settings.read", (_, e) => ({ value: { pluginConfigs: { "interaction-translator@inline": { options: e.source === "user" ? { codex_model: "user-model" } : e.source === "flag" ? { codex_model: "temporary-model" } : {} } } } }))
  on("command.run", { command: "plugin" }, () => ({ text: "configured" }))
  expect((await $.command.run({ command: "plugin", args: "configure interaction-translator@inline", ...commandContext })).text).toBe("configured")
})

test("ambiguous native providers stop before transport", { options: { backend: "codex-cli", codex_model: "company-model" } }, async ($, on) => {
  on("config.list", () => ({ value: [
    { ...lockedRow("backend"), isLocked: false },
    { ...lockedRow("backend"), provider: { plugin: "interaction-translator@foreign", tier: "user" }, isLocked: false },
  ] }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).drop).toContain("无法读取")
})
