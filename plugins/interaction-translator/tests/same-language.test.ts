import { expect, mock, test } from "claude-code/testing"
import type { Language } from "../hooks/languages"

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} skips translation calls and progress for English input targeting English`, { options: { backend, claude_language: "fr" } }, async ($, on) => {
    const clock = mock.clock(on)
    let calls = 0
    on("config.list", () => ({ value: [] }))
    on("http.fetch", () => { calls += 1; return { value: { ok: false, status: 500, headers: {}, text: "" } } })
    on("process.run", () => { calls += 1; return { value: { exitCode: 1, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
    on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
    on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
    const source = "Please review this code and fix the bug."
    const accepted = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false, context: ["Existing context."] })
    expect(accepted.text).toBe(source)
    expect(accepted.context?.[0]).toBe("Existing context.")
    expect(accepted.context?.[1]).toContain("Reply in natural French")
    const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "same-language", message: { type: "user", content: [{ type: "text", text: source }] } })
    expect(row.message?.content).toEqual([{ type: "text", text: source }])
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    await clock.advance(1000)
    expect(calls).toBe(0)
    expect(await ui.find({ text: /输入翻译/ })).toBe(undefined)
    await ui.unmount()
  })
}

test("same-language SDK input needs no translator credentials and keeps literal code and paths", async ($, on) => {
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  const source = "TASK_001: Please check `/tmp/中文.txt` and https://example.com/中文.\n```js\nconst message = '你好';\n```"
  const accepted = await $.prompt.submit({ text: source, origin: { kind: "sdk" }, wait: false })
  expect(accepted.text).toBe(source)
  expect(accepted.context?.[0]).toContain("Reply in natural English")
})

test("mixed English and Chinese instructions still invoke translation", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "test-token" }))
  let calls = 0
  on("http.fetch", () => { calls += 1; return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Please fix the button." } }] }) } } })
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  expect((await $.prompt.submit({ text: "Please 修复按钮", origin: { kind: "sdk" }, wait: false })).text).toBe("Please fix the button.")
  expect(calls).toBe(1)
})

const localInputs: Array<[Language, string]> = [
  ["fr", "Veuillez vérifier le code et corriger cette erreur."],
  ["cn", "请修改这个按钮。"],
  ["jp", "このコードを確認してバグを修正してください。"],
]
for (const [language, source] of localInputs) {
  test(`${language} same-language input bypasses the backend with auto source detection`, { options: { language, input_language: "auto" } }, async ($, on) => {
    on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
    expect((await $.prompt.submit({ text: source, origin: { kind: "sdk" }, wait: false })).text).toBe(source)
  })
}

test("queued same-language composer prompts keep their exact handoff when consumed out of order", async ($, on) => {
  mock.clock(on)
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const sources = ["Please check this code.", "Please fix the bug."]
  for (const source of sources) expect((await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: true, turnId: "running" })).text).toBe(source)
  for (const [index, source] of [...sources].reverse().entries()) {
    const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: `local-queued-${index}`, message: { type: "user", content: [{ type: "text", text: source }] } })
    expect(row.message?.content).toEqual([{ type: "text", text: source }])
  }
})
