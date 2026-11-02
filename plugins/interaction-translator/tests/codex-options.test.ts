import { expect, test } from "claude-code/testing"
import type { TurnStepChunk } from "claude-code"

test("CLI model and reasoning overrides are separate from API settings", { options: {
  backend: "codex-cli", codex_model_selection: "手动输入", codex_model: "translation-model", codex_reasoning_effort: "low", model: "api-model", reasoning_effort: "high",
} }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    const position = e.argv.indexOf("--model")
    expect(position >= 0).toBe(true)
    expect(e.argv[position + 1]).toBe("translation-model")
    expect(e.argv).toContain('model_reasoning_effort="low"')
    expect(e.argv.includes("api-model")).toBe(false)
    expect(e.argv[e.argv.length - 1]).toBe("-")
    expect(e.init?.stdin).toBe("你好")
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

for (const effort of ["default", "low", "medium", "high", "xhigh", "max"]) {
  test(`CLI reasoning ${effort} preserves local model selection`, { options: { backend: "codex-cli", codex_reasoning_effort: effort } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    on("process.run", (_, e) => {
      expect(e.argv.includes("--model")).toBe(false)
      const override = e.argv.filter(arg => arg.startsWith("model_reasoning_effort="))
      expect(override).toEqual(effort === "default" ? [] : [`model_reasoning_effort=${JSON.stringify(effort)}`])
      return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("prompt.submit", (_, e) => ({ text: e.text }))
    expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
  })
}

test("CLI model overrides are trimmed but remain a single argv value", { options: { backend: "codex-cli", codex_model_selection: "手动输入", codex_model: "  translation model;$(touch MUST_NOT_RUN)  " } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    const position = e.argv.indexOf("--model")
    expect(position >= 0).toBe(true)
    expect(e.argv[position + 1]).toBe("translation model;$(touch MUST_NOT_RUN)")
    expect(e.argv.filter(arg => arg.startsWith("model_reasoning_effort="))).toEqual([])
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("blank CLI model does not override local configuration", { options: { backend: "codex-cli", codex_model: "   " } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    expect(e.argv.includes("--model")).toBe(false)
    expect(e.argv.some(arg => arg.startsWith("model_reasoning_effort="))).toBe(false)
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("CLI overrides also apply to output translation", { options: { output_mode: "conversation", backend: "codex-cli", codex_model_selection: "手动输入", codex_model: "translation-model", codex_reasoning_effort: "medium" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    const position = e.argv.indexOf("--model")
    expect(position >= 0).toBe(true)
    expect(e.argv[position + 1]).toBe("translation-model")
    expect(e.argv).toContain('model_reasoning_effort="medium"')
    expect(e.init?.stdin).toBe("Hello.")
    return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Hello." }
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const chunks: TurnStepChunk[] = []
  for await (const chunk of $.turn.step({ turnId: "options-output", index: 0, model: "claude-test", messageCount: 1 })) chunks.push(chunk)
  expect(chunks.filter(chunk => chunk.kind === "text").map(chunk => chunk.text).join("")).toBe("你好。")
})

test("API translation ignores CLI overrides and retains the low default", { options: { codex_model: "cli-only", codex_reasoning_effort: "high" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.model).toBe("glm-5.3-flash")
    expect(request.reasoning_effort).toBe("low")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Hello." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})
