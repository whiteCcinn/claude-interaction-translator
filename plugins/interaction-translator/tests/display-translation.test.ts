import { expect, mock, test } from "claude-code/testing"
import type { TurnStepChunk } from "claude-code"

const step = { turnId: "display-only", index: 0, model: "claude-test", messageCount: 1 }
const stop: TurnStepChunk = { kind: "stop", stopReason: "end_turn", usage: null }

test("display-only leaves headless response chunks and result in the original language", { options: { backend: "codex-cli", output_mode: "display-only" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => {
    calls += 1
    return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Hello." }
    yield stop
    return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const stream = $.turn.step(step)
  const chunks: TurnStepChunk[] = []
  let answer = ""
  while (true) {
    const item = await stream.next()
    if (item.done) { answer = item.value.answer; break }
    chunks.push(item.value)
  }
  expect(chunks).toEqual([{ kind: "text", index: 0, text: "Hello." }, stop])
  expect(answer).toBe("Hello.")
  expect(calls).toBe(0)
})

test("display-only translates an existing visible assistant row without rewriting its source", { options: { backend: "codex-cli", output_mode: "display-only" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  let calls = 0
  on("process.run", (_, e) => {
    calls += 1
    expect(e.init?.stdin).toBe("Hello.")
    return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  await $.session.start({ cwd: "/tmp/display-translation", surface: "terminal", isInteractive: true })
  const props = { text: "Hello.", isFirstOfReply: true }
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props })
  await clock.advance(500)
  expect((await ui.find({ type: "Markdown", text: "你好。" }))?.text).toBe("你好。")
  expect(props.text).toBe("Hello.")
  expect(calls).toBe(1)
  await ui.unmount()
})

test("repaints and resize do not repeat a completed visible translation", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const props = { text: "Hello.", isFirstOfReply: true }
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props })
  await clock.advance(500)
  await ui.redraw(props)
  await clock.advance(1000)
  expect((await ui.find({ type: "Markdown", text: "你好。" }))?.text).toBe("你好。")
  expect(calls).toBe(1)
  await ui.unmount()
})

test("source updates discard stale translation completions", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  const seen: string[] = []
  on("process.run", async (_, e) => {
    const text = e.init?.stdin ?? ""
    seen.push(text)
    if (text === "Old.") await clock.sleep(1000)
    return { value: { exitCode: 0, stdout: text === "Old." ? "旧译文。" : "新译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Old.", isFirstOfReply: true } })
  await clock.advance(200)
  await ui.redraw({ text: "New.", isFirstOfReply: true })
  await clock.advance(1500)
  expect((await ui.find({ type: "Markdown", text: "新译文。" }))?.text).toBe("新译文。")
  expect(await ui.find({ text: "旧译文。" })).toBe(undefined)
  expect(seen).toEqual(["Old.", "New."])
  await ui.unmount()
})

test("summary translation uses only the exact visible summary and keeps readonly metadata", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    expect(e.init?.stdin).toBe("Visible summary.")
    expect(e.init?.stdin?.includes("hidden")).toBe(false)
    return { value: { exitCode: 0, stdout: "可见摘要。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => {
    expect(e.props.isSummary).toBe(true)
    expect(e.props.isFirstOfReply).toBe(false)
    return $.ui.resolve(e).Markdown({ text: e.props.text })
  })
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Visible summary.", isFirstOfReply: false, isSummary: true } })
  await clock.advance(500)
  expect((await ui.find({ type: "Markdown", text: "可见摘要。" }))?.text).toBe("可见摘要。")
  await ui.unmount()
})

test("failure stays in the UI and retries only after the retry button is pressed", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => {
    calls += 1
    return { value: { exitCode: calls === 1 ? 1 : 0, stdout: calls === 1 ? "partial" : "你好。", stderr: "private diagnostics", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Hello.", isFirstOfReply: true } })
  await clock.advance(500)
  expect((await ui.find({ type: "Text", text: /输出翻译失败/ }))?.text).toContain("输出翻译失败")
  expect(await ui.find({ text: /private diagnostics|partial/ })).toBe(undefined)
  await ui.redraw()
  await clock.advance(1000)
  expect(calls).toBe(1)
  await ui.press({ key: "retry-output-translation" })
  await clock.advance(500)
  expect((await ui.find({ type: "Markdown", text: "你好。" }))?.text).toBe("你好。")
  expect(calls).toBe(2)
  await ui.unmount()
})

test("offscreen rows and incomplete code units never start background translation", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on("config.list", () => ({ value: [] }))
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "should not run", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  for (const props of [
    { text: "Offscreen.", isFirstOfReply: true, onScreen: null },
    { text: "See `/tmp/", isFirstOfReply: true },
    { text: "file.go` now", isFirstOfReply: false },
    { text: "fmt.Println(1)\n```", isFirstOfReply: false },
  ]) {
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props })
    await clock.advance(500)
    expect((await ui.find({ type: "Markdown", text: props.text }))?.text).toBe(props.text)
    await ui.unmount()
  }
  expect(calls).toBe(0)
})

test("code-only visible blocks are preserved without a translation request", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "__GLM_KEEP_0__", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const text = '```go\nfmt.Println("hello")\n```'
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text, isFirstOfReply: true } })
  await clock.advance(500)
  expect((await ui.find({ type: "Markdown", text }))?.text).toBe(text)
  expect(calls).toBe(0)
  await ui.unmount()
})

test("visible display translation keeps the output progress card", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  on("process.run", async () => {
    await clock.sleep(1000)
    return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", ($, e) => {
    const ui = $.ui.resolve(e)
    return e.component === "AssistantMessage" ? ui.Markdown({ text: e.props.text }) : ui.Box({ children: [] })
  })
  await $.session.start({ cwd: "/tmp/display-progress", surface: "terminal", isInteractive: true })
  const progress = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
  const message = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Hello.", isFirstOfReply: true } })
  await clock.advance(300)
  expect((await progress.find({ type: "Text", text: /输出翻译中/ }))?.text).toContain("Codex CLI")
  await clock.advance(1000)
  expect((await progress.find({ type: "Text", text: /输出翻译完成/ }))?.text).toContain("1.0 秒")
  await message.unmount()
  await progress.unmount()
})

test("all active steps must settle before visible text translation starts", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "完成。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("turn.step", async function* (_, e) {
    await clock.sleep(e.agentId ? 1000 : 300)
    yield { kind: "text", index: 0, text: "Complete." }
    yield stop
    return { ...e, answer: "Complete.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const main = (async () => { for await (const _ of $.turn.step(step)) {} })()
  const child = (async () => { for await (const _ of $.turn.step({ ...step, turnId: "child", agentId: "child-agent" })) {} })()
  await clock.settle()
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Complete.", isFirstOfReply: true } })
  await clock.advance(500)
  await main
  expect(calls).toBe(0)
  await clock.advance(1000)
  await child
  expect(calls).toBe(1)
  expect((await ui.find({ type: "Markdown", text: "完成。" }))?.text).toBe("完成。")
  await ui.unmount()
})

test("source stream failures are not converted into translated answers or synthetic stops", async ($, on) => {
  let calls = 0
  on("turn.step", async function* () {
    calls += 1
    yield { kind: "text", index: 0, text: "Partial original." }
    throw new Error("original stream failure")
  })
  const chunks: TurnStepChunk[] = []
  let failed = false
  try { for await (const chunk of $.turn.step(step)) chunks.push(chunk) }
  catch { failed = true }
  expect(failed).toBe(true)
  expect(calls).toBe(1)
  expect(chunks).toEqual([{ kind: "text", index: 0, text: "Partial original." }])
})

test("display-only does not replace oversized source streams", async ($, on) => {
  const text = "Original. ".repeat(40000)
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text }
    yield stop
    return { ...e, answer: text, toolUses: [], stopReason: "end_turn", usage: null }
  })
  const chunks: TurnStepChunk[] = []
  for await (const chunk of $.turn.step(step)) chunks.push(chunk)
  expect(chunks).toEqual([{ kind: "text", index: 0, text }, stop])
})

test("leaving the viewport before scheduling cancels queued display work", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Hello.", isFirstOfReply: true } })
  await ui.redraw({ text: "Hello.", isFirstOfReply: true, onScreen: null })
  await clock.advance(1000)
  expect((await ui.find({ type: "Markdown", text: "Hello." }))?.text).toBe("Hello.")
  await ui.unmount()
})

test("clearing a visible row before scheduling cancels its obsolete translation", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "旧译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Old.", isFirstOfReply: true } })
  await ui.redraw({ text: "  ", isFirstOfReply: true })
  await clock.advance(1000)
  expect(calls).toBe(0)
  expect(await ui.find({ text: "旧译文。" })).toBe(undefined)
  await ui.unmount()
})

test("an offscreen attached surface cannot cancel the terminal's visible translation", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  const sources: string[] = []
  on("process.run", (_, e) => {
    sources.push(e.init?.stdin ?? "")
    return { value: { exitCode: 0, stdout: "终端译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const props = { text: "Terminal text.", isFirstOfReply: true }
  const terminal = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "shared-row", props })
  const desktop = await $.ui.mount({ plugin: "interaction-translator", surface: "desktop", component: "AssistantMessage", requestId: "shared-row", props: { ...props, onScreen: null } })
  await clock.advance(1000)
  expect(sources).toEqual(["Terminal text."])
  expect((await terminal.find({ type: "Markdown", text: "终端译文。" }))?.text).toBe("终端译文。")
  expect((await desktop.find({ type: "Markdown", text: "Terminal text." }))?.text).toBe("Terminal text.")
  await desktop.unmount()
  await terminal.unmount()
})

test("attached surfaces keep their exact visible text and translations independent", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  const sources: string[] = []
  on("process.run", (_, e) => {
    const source = e.init?.stdin ?? ""
    sources.push(source)
    return { value: { exitCode: 0, stdout: source === "Terminal text." ? "终端译文。" : "桌面译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const terminal = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "shared-row", props: { text: "Terminal text.", isFirstOfReply: true } })
  const desktop = await $.ui.mount({ plugin: "interaction-translator", surface: "desktop", component: "AssistantMessage", requestId: "shared-row", props: { text: "Desktop text.", isFirstOfReply: true } })
  await clock.advance(1000)
  expect(sources).toEqual(["Terminal text.", "Desktop text."])
  expect((await terminal.find({ type: "Markdown", text: "终端译文。" }))?.text).toBe("终端译文。")
  expect((await desktop.find({ type: "Markdown", text: "桌面译文。" }))?.text).toBe("桌面译文。")
  await desktop.unmount()
  await terminal.unmount()
})

test("display translation runs at most two backend calls concurrently", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let active = 0
  let maximum = 0
  let calls = 0
  on("process.run", async (_, e) => {
    calls += 1
    active += 1
    maximum = Math.max(maximum, active)
    await clock.sleep(1000)
    active -= 1
    return { value: { exitCode: 0, stdout: `译文 ${e.init?.stdin}`, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const rows = []
  for (let index = 0; index < 5; index += 1) rows.push(await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: `Reply ${index}.`, isFirstOfReply: true } }))
  await clock.advance(300)
  expect(calls).toBe(2)
  expect(active).toBe(2)
  await clock.advance(4000)
  expect(calls).toBe(5)
  expect(maximum).toBe(2)
  for (const [index, row] of rows.entries()) {
    expect((await row.find({ type: "Markdown", text: `译文 Reply ${index}.` }))?.text).toBe(`译文 Reply ${index}.`)
    await row.unmount()
  }
})

test("session clear drops queued work and ignores late results from the previous session", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("session.end", (_, e) => ({ sessionId: e.sessionId }))
  const sources: string[] = []
  on("process.run", async (_, e) => {
    const text = e.init?.stdin ?? ""
    sources.push(text)
    if (text === "Old.") await clock.sleep(1000)
    return { value: { exitCode: 0, stdout: text === "Old." ? "旧会话译文。" : "新会话译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const old = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "row", props: { text: "Old.", isFirstOfReply: true } })
  await clock.advance(200)
  const queued = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Queued.", isFirstOfReply: true } })
  await old.unmount()
  await queued.unmount()
  await $.session.end({ reason: "clear", sessionId: "old-session", resume: { id: "old-session" } })
  const current = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "row", props: { text: "New.", isFirstOfReply: true } })
  await clock.advance(2000)
  expect(sources).toEqual(["Old.", "New."])
  expect((await current.find({ type: "Markdown", text: "新会话译文。" }))?.text).toBe("新会话译文。")
  expect(await current.find({ text: "旧会话译文。" })).toBe(undefined)
  await current.unmount()
})
