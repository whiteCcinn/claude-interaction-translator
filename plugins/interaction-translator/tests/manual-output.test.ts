import { expect, mock, test } from "claude-code/testing"
import { mountFreshDisplay } from "./display-fixtures"

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} leaves output original until its translate button is pressed`, { options: { backend } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "test-token" }))
    let calls = 0
    on("http.fetch", async () => { calls += 1; await clock.sleep(500); return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "手动点击后的译文。" } }] }) } } })
    on("process.run", async () => { calls += 1; await clock.sleep(500); return { value: { exitCode: 0, stdout: "手动点击后的译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    const props = { text: "Original English response.", isFirstOfReply: true }
    const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props })
    await clock.advance(2000)
    expect(calls).toBe(0)
    expect((await row.find({ type: "Markdown", text: props.text }))?.text).toBe(props.text)
    await row.press({ key: "translate-output" })
    await clock.advance(200)
    expect(calls).toBe(1)
    expect((await row.find({ type: "Markdown", text: props.text }))?.text).toBe(props.text)
    await clock.advance(600)
    expect((await row.find({ type: "Markdown", text: "手动点击后的译文。" }))?.text).toBe("手动点击后的译文。")
    await row.redraw(props)
    await clock.advance(2000)
    expect(calls).toBe(1)
    expect(props.text).toBe("Original English response.")
    await row.unmount()
  })
}

test("restored output can be explicitly translated without automatic resume work", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "历史译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "restored", props: { text: "Historical English response.", isFirstOfReply: true } })
  await clock.advance(1000)
  expect(calls).toBe(0)
  await row.press({ key: "translate-output" })
  await clock.advance(1000)
  expect(calls).toBe(1)
  expect((await row.find({ text: "历史译文。" }))?.text).toBe("历史译文。")
  await row.unmount()
})

test("the prompt band offers a keyboard accessible manual translation action", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "入口译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Text({ children: ["Composer"] }))
  const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Original reply for the prompt control.", isFirstOfReply: true } })
  const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, scroll: { offset: 0, bodyRows: 6 }, view: {}, bodyColumns: 100, maxRows: 6 } })
  await clock.advance(1000)
  expect(calls).toBe(0)
  await band.press({ key: "translate-output" })
  await clock.advance(1000)
  expect(calls).toBe(1)
  expect((await row.find({ text: "入口译文。" }))?.text).toBe("入口译文。")
  await row.unmount()
  await band.unmount()
})

test("manual failure keeps the original and only retries after an explicit press", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => {
    calls += 1
    return { value: { exitCode: calls === 1 ? 1 : 0, stdout: calls === 1 ? "" : "重试译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const props = { text: "Original remains readable after failure.", isFirstOfReply: true }
  const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props })
  await row.press({ key: "translate-output" })
  await clock.advance(2000)
  expect(calls).toBe(1)
  expect((await row.find({ type: "Markdown", text: props.text }))?.text).toBe(props.text)
  await row.redraw(props)
  await clock.advance(2000)
  expect(calls).toBe(1)
  await row.press({ key: "retry-output-translation" })
  await clock.advance(1000)
  expect(calls).toBe(2)
  expect((await row.find({ text: "重试译文。" }))?.text).toBe("重试译文。")
  await row.unmount()
})

test("a stale manual translation cannot replace a redrawn source or translate it automatically", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", async () => { calls += 1; await clock.sleep(1000); return { value: { exitCode: 0, stdout: "过期译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Old source.", isFirstOfReply: true } })
  await row.press({ key: "translate-output" })
  await clock.advance(200)
  await row.redraw({ text: "Updated source.", isFirstOfReply: true })
  await clock.advance(2000)
  expect(calls).toBe(1)
  expect((await row.find({ type: "Markdown", text: "Updated source." }))?.text).toBe("Updated source.")
  expect(await row.find({ text: "过期译文。" })).toBe(undefined)
  await row.unmount()
})

test("the prompt controls translate only the selected reply", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  const sources: string[] = []
  on("process.run", (_, e) => { sources.push(e.init?.stdin ?? ""); return { value: { exitCode: 0, stdout: "选中译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Text({ children: ["Composer"] }))
  const first = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "First original.", isFirstOfReply: true } })
  const second = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Second original.", isFirstOfReply: true } })
  const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, scroll: { offset: 0, bodyRows: 6 }, view: {}, bodyColumns: 100, maxRows: 6 } })
  await band.press({ key: "previous-output" })
  await band.press({ key: "translate-output" })
  await clock.advance(1000)
  expect(sources).toEqual(["First original."])
  expect((await second.find({ type: "Markdown", text: "Second original." }))?.text).toBe("Second original.")
  await first.unmount()
  await second.unmount()
  await band.unmount()
})

test("the terminal action targets its own surface when desktop is attached", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("process.run", () => ({ value: { exitCode: 0, stdout: "终端译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Text({ children: ["Composer"] }))
  const props = { text: "Shared original.", isFirstOfReply: true }
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "shared", props })
  const desktop = await $.ui.mount({ plugin: "interaction-translator", surface: "desktop", component: "AssistantMessage", requestId: "shared", props })
  const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, scroll: { offset: 0, bodyRows: 6 }, view: {}, bodyColumns: 100, maxRows: 6 } })
  await band.press({ key: "translate-output" })
  await clock.advance(1000)
  expect((await row.find({ type: "Markdown", text: "终端译文。" }))?.text).toBe("终端译文。")
  expect((await desktop.find({ type: "Markdown", text: props.text }))?.text).toBe(props.text)
  await row.unmount()
  await desktop.unmount()
  await band.unmount()
})

test("session start redraws history controls that were mounted before the lifecycle hook", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "恢复后主动翻译。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("ui.render", { component: "AbovePrompt" }, ($, e) => $.ui.resolve(e).Text({ children: ["Composer"] }))
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "restored-before-start", props: { text: "Restored before session start.", isFirstOfReply: true } })
  const band = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, scroll: { offset: 0, bodyRows: 6 }, view: {}, bodyColumns: 100, maxRows: 6 } })
  await $.session.start({ cwd: "/tmp/manual-session-start", surface: "terminal", isInteractive: true })
  await clock.advance(500)
  expect(calls).toBe(0)
  await band.press({ key: "translate-output" })
  await clock.advance(1000)
  expect(calls).toBe(1)
  expect((await row.find({ type: "Markdown", text: "恢复后主动翻译。" }))?.text).toBe("恢复后主动翻译。")
  await row.unmount()
  await band.unmount()
})
