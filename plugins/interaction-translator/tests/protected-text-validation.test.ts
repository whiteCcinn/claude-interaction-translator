import { expect, mock, test } from "claude-code/testing"
import { protectText, protectedTranslationPrompt, restoreProtectedText, restoreText } from "../hooks/protected-text"
import { createTranslationDiagnostic } from "../hooks/translation-diagnostics"
import { mountFreshDisplay } from "./display-fixtures"

const source = "Read `/private/a.txt` and `/private/b.txt`."

test("restoration reports count-only details for missing, duplicate and unexpected markers", () => {
  const masked = protectText(source)
  const result = restoreProtectedText("__GLM_KEEP_0__ __GLM_KEEP_0__ __GLM_KEEP_99__", masked)
  expect(result).toEqual({ failure: { expected: 2, observed: 3, missing: 1, duplicate: 1, unexpected: 1 } })
  expect(restoreText("__GLM_KEEP_0__ __GLM_KEEP_0__ __GLM_KEEP_99__", masked)).toBe(undefined)
  if (!("failure" in result)) throw new Error("Expected validation failure")
  const diagnostic = createTranslationDiagnostic({ backend: "codex-cli" }, "output", { kind: "markers", validation: result.failure })
  expect(diagnostic.markerExpected).toBe(2)
  expect(diagnostic.markerObserved).toBe(3)
  expect(diagnostic.markerMissing).toBe(1)
  expect(diagnostic.markerDuplicate).toBe(1)
  expect(diagnostic.markerUnexpected).toBe(1)
  expect(JSON.stringify(diagnostic).includes("private")).toBe(false)
})

for (const token of ["__GLM_KEEP_00__", "__GLM_KEEP_-1__", "__GLM_KEEP_1", "__GLM_KEEP_", "__GLM_KEEP_9007199254740993__"]) {
  test(`malformed or unknown marker ${token} remains invalid`, () => {
    const masked = protectText(source)
    const result = restoreProtectedText(`__GLM_KEEP_0__ __GLM_KEEP_1__ ${token}`, masked)
    expect("failure" in result && result.failure.unexpected).toBe(1)
  })
}

test("empty and colliding literal prefixes round-trip without interpreting restored values as markers", () => {
  for (const text of ["", "Literal __GLM_KEEP_0__ and `__GLM_KEEP_1__` plus `/tmp/a`.", "No protected content."]) {
    const masked = protectText(text)
    expect(restoreProtectedText(masked.text, masked)).toEqual({ text })
  }
  const masked = protectText("Literal `__GLM_KEEP_0__`.")
  expect(restoreText(masked.text + masked.prefix + "99__", masked)).toBe(undefined)
})

test("large marker sets restore exactly once while allowing natural-language reordering", () => {
  const source = Array.from({ length: 1000 }, (_, i) => `Read \`/tmp/${i}.txt\`.`).join("\n")
  const masked = protectText(source)
  expect(restoreProtectedText(masked.text, masked)).toEqual({ text: source })
  const pair = protectText("`/tmp/a` then `/tmp/b`")
  expect(restoreText("__GLM_KEEP_1__ 后是 __GLM_KEEP_0__", pair)).toBe("`/tmp/b` 后是 `/tmp/a`")
})

test("the prompt inventories only opaque markers with exact-once requirements", () => {
  const masked = protectText(source)
  const prompt = protectedTranslationPrompt("Translate faithfully.", masked)
  expect(prompt).toContain("2")
  expect(prompt).toContain("__GLM_KEEP_0__")
  expect(prompt).toContain("__GLM_KEEP_1__")
  expect(prompt).toContain("exactly once")
  expect(prompt.includes("private")).toBe(false)
  expect(protectedTranslationPrompt("Translate.", protectText("Hello."))).toBe("Translate.")
  const large = protectText(Array.from({ length: 1000 }, (_, i) => `\`/tmp/${i}\``).join(" "))
  expect(protectedTranslationPrompt("Translate.", large).length < 1000).toBe(true)
})

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} input reports incomplete prose segments without submitting the original`, { options: { backend } }, async ($, on) => {
    mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "example-token" }))
    on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Keep __GLM_KEEP_0__." } }] }) } }))
    on("process.run", () => ({ value: { exitCode: 0, stdout: "Keep __GLM_KEEP_0__.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
    on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
    let report = ""
    on("ui.copy", (_, e) => { report = e.text; return { value: { isCopied: true } } })
    on("ui.toast", () => ({ value: undefined }))
    const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    const result = await $.prompt.submit({ text: "保留 `/private/a.txt` 和 `/private/b.txt`。", origin: { kind: "composer" }, wait: false })
    expect(result.drop).toContain("TR_SEGMENT_INVALID")
    expect(result.text).toBe(undefined)
    expect(await band.find({ type: "Text", text: /仍缺 3/ })).toBeDefined()
    await band.press({ key: "copy-translation-error" })
    expect(JSON.parse(report).stage).toBe("input")
    expect(JSON.parse(report).segmentMissing).toBe(3)
    expect(report.includes("private")).toBe(false)
    await band.unmount()
  })

  test(`${backend} output keeps the original and copies precise segment failure counts`, { options: { backend, output_trigger: "auto" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "example-token" }))
    const bad = "只保留 __GLM_KEEP_0__。"
    let calls = 0
    on("http.fetch", (_, e) => {
      calls++
      const body = JSON.parse(typeof e.init?.body === "string" ? e.init.body : "")
      expect(JSON.parse(body.messages[1].content).map((row: { text: string }) => row.text)).toEqual(["Read", "and", "."])
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: bad } }] }) } }
    })
    on("process.run", (_, e) => {
      calls++
      expect(JSON.parse(e.init?.stdin ?? "").map((row: { text: string }) => row.text)).toEqual(["Read", "and", "."])
      return { value: { exitCode: 0, stdout: bad, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    let report = ""
    on("ui.copy", (_, e) => { report = e.text; return { value: { isCopied: true } } })
    on("ui.toast", () => ({ value: undefined }))
    const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: source, isFirstOfReply: true } })
    await clock.advance(300)
    expect((await row.find({ type: "Text", text: /TR_SEGMENT_INVALID/ }))?.text).toContain("仍缺 3")
    expect(await row.find({ type: "Markdown", text: source })).toBeDefined()
    await row.press({ key: "copy-output-error" })
    expect(JSON.parse(report).segmentMissing).toBe(3)
    expect(JSON.parse(report).segmentExpected).toBe(3)
    expect(JSON.parse(report).segmentObserved).toBe(0)
    expect(report.includes("private")).toBe(false)
    expect(calls).toBe(2)
    await row.unmount()
  })
}
