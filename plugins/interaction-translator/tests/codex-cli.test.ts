import { expect, mock, test } from "claude-code/testing"

const cli = { backend: "codex-cli" }

test("translates through Codex stdin without reading an API key or calling HTTP", { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    expect(e.argv[0]).toBe("codex")
    expect(e.argv[1]).toBe("exec")
    expect(e.argv).toContain("--ephemeral")
    expect(e.argv).toContain("read-only")
    expect(e.argv[e.argv.length - 1]).toBe("-")
    expect(e.argv.join(" ")).toContain("natural English")
    expect(e.init?.stdin).toBe("修改按钮。保留 __GLM_KEEP_0__。")
    expect(e.init?.timeoutMs).toBe(120000)
    return { value: { exitCode: 0, stdout: "Change the button. Keep __GLM_KEEP_0__.", stderr: "progress only", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  const result = await $.prompt.submit({ text: "修改按钮。保留 /tmp/demo.txt。", origin: { kind: "sdk" }, wait: false })
  expect(result.text).toBe("Change the button. Keep /tmp/demo.txt.")
  expect(result.context?.[0]).toContain("Reply in natural English")
  expect(result.origin?.kind).toBe("sdk")
})

test("preserves custom executable paths and keeps shell syntax exclusively in stdin", { options: { ...cli, codex_path_selection: "手动输入", codex_path: "/opt/My Tools/codex", language: "fr" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const source = "请翻译：$(touch SHOULD_NOT_RUN)\n第二行"
  on("process.run", (_, e) => {
    expect(e.argv[0]).toBe("/opt/My Tools/codex")
    expect(e.argv.join(" ")).toContain("natural French")
    expect(e.argv.join(" ").includes("SHOULD_NOT_RUN")).toBe(false)
    expect(e.init?.stdin).toBe(source)
    return { value: { exitCode: 0, stdout: "Veuillez traduire : $(touch SHOULD_NOT_RUN)\nDeuxième ligne", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }))
  const result = await $.prompt.submit({ text: source, origin: { kind: "sdk" }, wait: false })
  expect(result.text).toContain("Deuxième ligne")
  expect(result.context?.[0]).toContain("Reply in natural French")
})

test("stops on a nonzero Codex exit without using stderr or falling back to API", { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", () => ({ value: { exitCode: 1, stdout: "partial translation", stderr: "private diagnostics", isStdoutTruncated: false, isStderrTruncated: false } }))
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  expect(result.drop).toContain("Codex CLI")
  expect(result.drop?.includes("private diagnostics")).toBe(false)
  expect(result.text).toBe(undefined)
})

test("stops when Codex cannot start or times out", { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", () => { throw new Error("private process error") })
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  expect(result.drop).toContain("Codex CLI")
  expect(result.drop?.includes("private process error")).toBe(false)
})

for (const output of ["", "   "]) {
  test(`rejects empty Codex stdout ${JSON.stringify(output)}`, { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    on("process.run", () => ({ value: { exitCode: 0, stdout: output, stderr: "Hello.", isStdoutTruncated: false, isStderrTruncated: false } }))
    const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
    expect(result.drop).toContain("Codex CLI")
    expect(result.text).toBe(undefined)
  })
}

test("rejects truncated Codex stdout", { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", () => ({ value: { exitCode: 0, stdout: "partial", stderr: "", isStdoutTruncated: true, isStderrTruncated: false } }))
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  expect(result.drop).toContain("Codex CLI")
  expect(result.text).toBe(undefined)
})

for (const output of ["Keep the path.", "Keep __GLM_KEEP_0__ and __GLM_KEEP_0__."]) {
  test(`rejects invalid Codex protected markers: ${output}`, { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    on("process.run", () => ({ value: { exitCode: 0, stdout: output, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
    const result = await $.prompt.submit({ text: "保留 /tmp/demo.txt", origin: { kind: "sdk" }, wait: false })
    expect(result.drop).toContain("protected paths or code")
  })
}

test("bypasses commands and empty inputs in Codex mode", { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("ui.invalidate", () => ({ value: undefined }))
  on("prompt.submit", (_, e) => ({ text: e.text }))
  for (const text of ["/help 中文", "!echo 中文", "#记忆", "", "   "]) {
    const result = await $.prompt.submit({ text, origin: { kind: "composer" }, wait: false })
    expect(result.text).toBe(text)
  }
})

test("shows Codex CLI in interactive translation feedback", { options: cli }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on("process.run", async () => {
    await clock.sleep(500)
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  const submission = $.prompt.submit({ text: "你好", origin: { kind: "composer" }, wait: false })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
  expect((await ui.find({ type: "Text", text: /翻译中/ }))?.text).toContain("Codex CLI")
  await clock.advance(500)
  expect((await submission).text).toBe("你好")
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "codex-prompt", message: { type: "user", content: [{ type: "text", text: "你好" }] } })
  expect(row.message?.content).toEqual([{ type: "text", text: "Hello." }])
  await ui.unmount()
})
