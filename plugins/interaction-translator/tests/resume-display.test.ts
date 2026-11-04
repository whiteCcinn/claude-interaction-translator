import { expect, mock, test } from "claude-code/testing"

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} leaves restored history original while translating newly appended replies`, { options: { output_trigger: "auto", backend } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "test-token" }))
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    let calls = 0
    on("http.fetch", () => { calls += 1; return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "新的中文译文。" } }] }) } } })
    on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "新的中文译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    await $.session.start({ cwd: "/tmp/resume-display", surface: "terminal", isInteractive: true })
    const props = { text: "Same response text.", isFirstOfReply: true }
    const old = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "restored-row", props })
    await clock.advance(1000)
    expect(calls).toBe(0)
    expect((await old.find({ type: "Markdown", text: props.text }))?.text).toBe(props.text)
    await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "new-row", message: { type: "assistant", content: [{ type: "text", text: props.text }] } })
    const fresh = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "new-row", props })
    await clock.advance(1000)
    expect(calls).toBe(1)
    expect((await fresh.find({ type: "Markdown", text: "新的中文译文。" }))?.text).toBe("新的中文译文。")
    await old.redraw({ ...props, isSummary: true, onScreen: { first: 0, last: 0, of: 1 } })
    await clock.advance(5000)
    expect(calls).toBe(1)
    expect((await old.find({ type: "Markdown", text: props.text }))?.text).toBe(props.text)
    expect(await old.find({ text: /输出翻译失败/ })).toBe(undefined)
    await old.unmount()
    await fresh.unmount()
  })
}

test("history rendered after plugin reload does not translate without a fresh response append", { options: { output_trigger: "auto", backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on("config.list", () => ({ value: [] }))
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "不要翻译旧历史", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "desktop", component: "AssistantMessage", requestId: "old-child-response", props: { text: "Earlier child transcript.", isFirstOfReply: false } })
  await clock.advance(3000)
  expect(calls).toBe(0)
  expect((await row.find({ type: "Markdown", text: "Earlier child transcript." }))?.text).toBe("Earlier child transcript.")
  await row.unmount()
})

for (const boundary of ["resume", "session.start"]) {
  test(`${boundary} retires earlier response identities and cached translations`, { options: { output_trigger: "auto", backend: "codex-cli" } }, async ($, on) => {
    const clock = mock.clock(on)
    let calls = 0
    on("config.list", () => ({ value: [] }))
    on("command.run", { command: "resume" }, () => ({ text: "resumed" }))
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "先前译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    const props = { text: "Earlier reply.", isFirstOfReply: true }
    await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "earlier-row", message: { type: "assistant", content: [{ type: "text", text: props.text }] } })
    const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "earlier-row", props })
    await clock.advance(1000)
    expect(calls).toBe(1)
    expect((await row.find({ text: "先前译文。" }))?.text).toBe("先前译文。")
    await row.unmount()
    if (boundary === "resume") await $.command.run({ command: "resume", args: "fixture", origin: { kind: "sdk" }, presentation: { isFullscreen: false, columns: 80 } })
    else await $.session.start({ cwd: "/tmp/new-start", surface: "terminal", isInteractive: true })
    const restored = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "earlier-row", props })
    await clock.advance(1000)
    expect(calls).toBe(1)
    expect((await restored.find({ text: props.text }))?.text).toBe(props.text)
    await restored.unmount()
  })
}

test("a reply drawn before append becomes eligible after it is stored", { options: { output_trigger: "auto", backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on("config.list", () => ({ value: [] }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "新译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  await $.session.start({ cwd: "/tmp/early-render", surface: "terminal", isInteractive: true })
  const props = { text: "Fresh reply.", isFirstOfReply: true }
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "early-row", props })
  await clock.advance(300)
  expect(calls).toBe(0)
  await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "early-row", message: { type: "assistant", content: [{ type: "text", text: props.text }] } })
  await clock.advance(1000)
  expect(calls).toBe(1)
  expect((await row.find({ text: "新译文。" }))?.text).toBe("新译文。")
  await row.unmount()
})

test("a response append completing after session clear cannot revive old display work", { options: { output_trigger: "auto", backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  let calls = 0
  on("config.list", () => ({ value: [] }))
  on("session.append", { door: "response" }, async (_, e, next) => { await clock.sleep(500); return next(e) })
  on("session.end", (_, e) => ({ sessionId: e.sessionId }))
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "过期译文", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const appending = $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "late-row", message: { type: "assistant", content: [{ type: "text", text: "Late original." }] } })
  await clock.settle()
  await $.session.end({ reason: "clear", sessionId: "old-session", resume: { id: "old-session" } })
  await clock.advance(500)
  await appending
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "late-row", props: { text: "Late original.", isFirstOfReply: true } })
  await clock.advance(1000)
  expect(calls).toBe(0)
  expect((await row.find({ text: "Late original." }))?.text).toBe("Late original.")
  await row.unmount()
})

test("a fresh thinking summary translates only its visible summary text", { options: { output_trigger: "auto", backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  const sources: string[] = []
  on("process.run", (_, e) => { sources.push(e.init?.stdin ?? ""); return { value: { exitCode: 0, stdout: "可见摘要译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "thinking-row", message: { type: "assistant", content: [{ type: "thinking", thinking: "Hidden reasoning must not be sent.", signature: "fixture", summary: [{ type: "summary_text", text: "Visible summary." }] }] } })
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "thinking-row", props: { text: "Visible summary.", isFirstOfReply: true, isSummary: true } })
  await clock.advance(1000)
  expect(sources).toEqual(["Visible summary."])
  expect((await row.find({ text: "可见摘要译文。" }))?.text).toBe("可见摘要译文。")
  await row.unmount()
})
