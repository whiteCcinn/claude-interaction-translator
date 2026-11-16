import { expect, mock, test } from "claude-code/testing"
import type { EngineInterface, PluginOptions } from "claude-code"
import { mountFreshDisplay } from "./display-fixtures"
import { createTranslationDiagnostic, diagnosticSummary } from "../hooks/translation-diagnostics"
import { createDisplayState, displayEntry, requestDisplay, translateDisplay } from "../hooks/display-translation"

const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

test("shareable reports contain only allowlisted fields and bounded numeric metadata", () => {
  const options: PluginOptions = { backend: "codex-cli", codex_timeout_seconds: 300, api_key: "private-key", api_url: "https://private.example", codex_path: "/private/codex", codex_model: "private-model" }
  const diagnostic = createTranslationDiagnostic(options, "output", { kind: "codex-exit", code: 9 }, 1234.6)
  expect(diagnostic).toEqual({ reportVersion: 1, plugin: "interaction-translator", code: "TR_CLI_EXIT", backend: "codex-cli", stage: "output", elapsedMs: 1235, timeoutSeconds: 300, exitCode: 9 })
  expect(JSON.stringify(diagnostic).includes("private")).toBe(false)
  expect(diagnosticSummary(diagnostic)).toContain("TR_CLI_EXIT")
  expect(diagnosticSummary(diagnostic)).toContain("1.2s")
  expect(createTranslationDiagnostic({}, "input", { kind: "api-http", status: 429 }, NaN)).toEqual({ reportVersion: 1, plugin: "interaction-translator", code: "TR_API_HTTP", backend: "api", stage: "input", httpStatus: 429 })
  expect(createTranslationDiagnostic({ backend: "codex-cli", codex_timeout_seconds: 601 }, "input", { kind: "configuration" }).timeoutSeconds).toBe(undefined)
})

test("a retry while the old diagnostic clock is pending cannot revive its report", async () => {
  let reads = 0
  let resume: ((now: number) => void) | undefined
  let paused: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { paused = resolve })
  const engine = {
    plugin: { name: "interaction-translator", root: "/tmp/diagnostic-race-fixture" },
    config: { list: async () => [] },
    clock: {
      now: async () => ++reads === 3 ? new Promise<number>(resolve => { resume = resolve; paused?.() }) : 0,
      after: () => ({ cancel() {} }),
    },
    process: { run: async () => ({ exitCode: 7, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }) },
    ui: { invalidate() {} },
  } as unknown as EngineInterface
  const state = createDisplayState()
  const entry = displayEntry(state, "terminal", "race", "Hello.", false, "cn", "assistant", false)
  if (!entry) throw new Error("Fixture entry missing")
  entry.phase = "loading"
  state.running.add(entry)
  const options = { backend: "codex-cli" }
  const old = translateDisplay(engine, options, {}, state, entry, "en", "cn")
  await waiting
  expect(entry.phase).toBe("error")
  requestDisplay(engine, options, {}, state, entry, "en", "cn")
  if (!resume) throw new Error("Diagnostic clock did not pause")
  resume(1000)
  await old
  expect(entry.phase).toBe("pending")
  expect(entry.diagnostic).toBe(undefined)
  expect(entry.translationFailure).toBe(undefined)
})

for (const status of [401, 429, 503]) {
  test(`API HTTP ${status} displays its cause and copies a safe report`, { options: { backend: "api", output_trigger: "auto" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "private-key" }))
    on("http.fetch", () => ({ value: { ok: false, status, headers: {}, text: "private response body" } }))
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    let report = ""
    on("ui.copy", (_, e) => { report = e.text; expect(e.surface).toBe("terminal"); return { value: { isCopied: true } } })
    let notice = ""
    on("ui.toast", (_, e) => { notice = e.text; return { value: undefined } })
    const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Private original response.", isFirstOfReply: true } })
    await clock.advance(300)
    const error = (await row.find({ type: "Text", text: /输出翻译失败/ }))?.text
    expect(error).toContain(`HTTP ${status}`)
    expect(error).toContain("TR_API_HTTP")
    expect(await row.find({ type: "Markdown", text: "Private original response." })).toBeDefined()
    await row.press({ key: "copy-output-error" })
    const parsed = JSON.parse(report)
    expect(parsed.code).toBe("TR_API_HTTP")
    expect(parsed.httpStatus).toBe(status)
    expect(parsed.backend).toBe("api")
    expect(parsed.stage).toBe("output")
    expect(report.includes("private")).toBe(false)
    expect(report.includes("Private")).toBe(false)
    expect(notice).toContain("已复制")
    await row.unmount()
  })
}

for (const failure of ["network", "json", "content", "length", "credentials"]) {
  test(`API ${failure} exposes a distinct error code`, { options: { backend: "api", output_trigger: "auto" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: failure === "credentials" ? undefined : "private-key" }))
    on("fs.read", () => { throw new Error("private filesystem failure") })
    on("http.fetch", () => {
      if (failure === "network") throw new Error("private network details")
      return { value: { ok: true, status: 200, headers: {}, text: failure === "json" ? "private malformed response" : JSON.stringify({ choices: [{ finish_reason: failure === "length" ? "length" : "stop", message: { content: "" } }] }) } }
    })
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Hello.", isFirstOfReply: true } })
    await clock.advance(300)
    expect((await row.find({ type: "Text", text: /输出翻译失败/ }))?.text).toContain({ network: "TR_API_REQUEST", json: "TR_API_RESPONSE", content: "TR_API_RESPONSE", length: "TR_API_LENGTH", credentials: "TR_API_KEY" }[failure] ?? "")
    expect(await row.find({ text: /private/ })).toBe(undefined)
    await row.unmount()
  })
}

test("compact input failures retain a reason and copy action", { options: { backend: "codex-cli", codex_timeout_seconds: 300 } }, async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("process.run", () => ({ value: { exitCode: 7, stdout: "partial private text", stderr: "private diagnostics", isStdoutTruncated: false, isStderrTruncated: false } }))
  on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  let report = ""
  on("ui.copy", (_, e) => { report = e.text; return { value: { isCopied: true } } })
  on("ui.toast", () => ({ value: undefined }))
  const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
  const result = await $.prompt.submit({ text: "保留私有正文", origin: { kind: "composer" }, wait: false })
  expect(result.drop).toContain("Codex CLI")
  expect((await band.find({ type: "Text", text: /输入翻译失败/ }))?.text).toContain("TR_CLI_EXIT")
  expect((await band.find({ type: "Text", text: /退出码 7/ }))?.text).toContain("退出码 7")
  await band.press({ key: "copy-translation-error" })
  expect(JSON.parse(report).stage).toBe("input")
  expect(JSON.parse(report).timeoutSeconds).toBe(300)
  expect(JSON.parse(report).exitCode).toBe(7)
  expect(report.includes("private")).toBe(false)
  expect(report.includes("私有")).toBe(false)
  await band.unmount()
})

test("retry immediately removes its old report from both row and prompt band", { options: { backend: "codex-cli", output_trigger: "auto" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => ({ value: { exitCode: ++calls === 1 ? 1 : 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Hello.", isFirstOfReply: true } })
  const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
  await clock.advance(300)
  expect(await band.find({ type: "Button", key: "copy-translation-error" })).toBeDefined()
  await row.press({ key: "retry-output-translation" })
  expect(await row.find({ type: "Button", key: "copy-output-error" })).toBe(undefined)
  expect(await band.find({ type: "Button", key: "copy-translation-error" })).toBe(undefined)
  await clock.advance(300)
  expect(await row.find({ type: "Markdown", text: "你好。" })).toBeDefined()
  expect(await band.find({ text: /TR_CLI_EXIT/ })).toBe(undefined)
  await row.unmount()
  await band.unmount()
})

test("classic prompt controls copy the selected failed row without a duplicate hotkey", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => ({ value: { exitCode: e.init?.stdin === "First reply." ? 7 : 8, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  let report = ""
  on("ui.copy", (_, e) => { report = e.text; return { value: { isCopied: true } } })
  on("ui.toast", () => ({ value: undefined }))
  const first = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "First reply.", isFirstOfReply: true } })
  const second = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Second reply.", isFirstOfReply: true } })
  await first.press({ key: "translate-output" })
  await second.press({ key: "translate-output" })
  await clock.advance(300)
  const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { ...props, maxRows: 6 } })
  expect(await band.find({ type: "Button", key: "copy-translation-error" })).toBe(undefined)
  await band.press({ key: "previous-output" })
  await band.press({ key: "copy-selected-error" })
  expect(JSON.parse(report).exitCode).toBe(7)
  await band.press({ key: "next-output" })
  await band.press({ key: "copy-selected-error" })
  expect(JSON.parse(report).exitCode).toBe(8)
  await first.unmount()
  await second.unmount()
  await band.unmount()
})

for (const throws of [false, true]) {
  test(`clipboard ${throws ? "exception" : "refusal"} is reported without losing retry`, { options: { backend: "codex-cli", output_trigger: "auto" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("process.run", () => ({ value: { exitCode: 1, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    on("ui.copy", () => { if (throws) throw new Error("private copy error"); return { value: { isCopied: false, reason: "no-clipboard" } } })
    let notice = ""
    on("ui.toast", (_, e) => { notice = e.text; return { value: undefined } })
    const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Hello.", isFirstOfReply: true } })
    await clock.advance(300)
    await row.press({ key: "copy-output-error" })
    expect(notice).toContain("复制失败")
    expect(notice.includes("private")).toBe(false)
    expect(await row.find({ type: "Button", key: "retry-output-translation" })).toBeDefined()
    await row.unmount()
  })
}
