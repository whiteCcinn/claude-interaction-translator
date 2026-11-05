import { expect, mock, test } from "claude-code/testing"

// Exact native 2.1.316/318 delivery projection, captured from a real tool gap.
const prefix = "<system-reminder>\nThe user sent a new message while you were working:\n"
const suffix = "\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>"

for (const wait of [false, true]) {
  test(`a Chinese followup with wait=${wait} translates during an active turn and shows input feedback`, { options: { backend: "codex-cli", output_trigger: "final" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
    const sources: string[] = []
    on("process.run", async (_, e) => {
      sources.push(e.init?.stdin ?? "")
      await clock.sleep(500)
      return { value: { exitCode: 0, stdout: "Please explain the concurrency issue.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
    on("turn.step", async function* (_, e) {
      await clock.sleep(2000)
      yield { kind: "stop", stopReason: "end_turn", usage: null }
      return { ...e, answer: "", toolUses: [], stopReason: "end_turn", usage: null }
    })
    await $.session.start({ cwd: "/tmp/followup-input", surface: "terminal", isInteractive: true })
    await $.turn.start({ turnId: "running", text: "Original task." })
    const generating = (async () => { for await (const _ of $.turn.step({ turnId: "running", index: 0, model: "fixture", messageCount: 1 })) {} })()
    await clock.settle()
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    const source = "请继续说明并发问题。"
    const submitting = $.prompt.submit({ text: source, origin: { kind: "composer" }, wait, turnId: "running" })
    await clock.advance(300)
    expect(sources).toEqual([source])
    expect((await ui.find({ type: "Text", text: /输入翻译中/ }))?.text).toContain("Codex CLI")
    await clock.advance(600)
    expect((await submitting).text).toBe(source)
    const stored = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "followup", message: { type: "user", content: [{ type: "text", text: source }] } })
    expect(stored.message?.content).toEqual([{ type: "text", text: "Please explain the concurrency issue." }])
    await clock.advance(2000)
    await generating
    await ui.unmount()
  })
}

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} delivers the prepared translation through the native same-turn queued attachment`, { options: { backend, output_trigger: "final" } }, async ($, on) => {
    mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "fixture-token" }))
    let calls = 0
    on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "Please explain the concurrency issue.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
    on("http.fetch", () => { calls += 1; return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Please explain the concurrency issue." } }] }) } } })
    on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
    const source = "请继续说明并发问题。"
    expect((await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false, turnId: "running" })).text).toBe(source)
    const content = [{ type: "text", text: prefix + source + suffix }, { type: "text", text: "Other context." }]
    const stored = await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: "queued-delivery", message: { type: "attachment", name: "queued_command", role: "user", content } })
    expect(stored.message?.content).toEqual([{ ...content[0], text: prefix + "Please explain the concurrency issue." + suffix }, content[1]])
    expect(stored.message?.type).toBe("attachment")
    expect(stored.message?.name).toBe("queued_command")
    expect(stored.message?.role).toBe("user")
    expect(stored.uuid).toBe("queued-delivery")
    expect(calls).toBe(1)
  })
}

test("a refused delivery rewrite retains the handoff until a confirmed write", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "fixture-token" }))
  let calls = 0
  on("http.fetch", () => { calls += 1; return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Continue the explanation." } }] }) } } })
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
  const source = "继续解释问题。"
  let refuse = true
  on("session.append", { door: "delivery" }, (_, e, next) => next(refuse ? { ...e, message: { ...e.message, content: [{ type: "text", text: prefix + source + suffix }] } } : e))
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false, turnId: "running" })
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
  const append = () => $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: "refused-delivery", message: { type: "attachment", name: "queued_command", content: [{ type: "text", text: prefix + source + suffix }] } })
  expect((await append()).message?.content[0]?.text).toBe(prefix + source + suffix)
  const failure = (await ui.find({ type: "Text", text: /交付未确认/ }))?.text
  expect(failure).toContain("交付未确认")
  expect(failure).not.toContain("原文未发送")
  refuse = false
  expect((await append()).message?.content[0]?.text).toBe(prefix + "Continue the explanation." + suffix)
  expect(calls).toBe(1)
  await ui.unmount()
})

for (const type of ["image", "document", "audio"] as const) {
  test(`a mid-turn ${type} followup needing translation is rejected before backend work`, async ($, on) => {
    mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "fixture-token" }))
    let calls = 0
    on("http.fetch", () => { calls += 1; return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Explain this attachment." } }] }) } } })
    on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
    const result = await $.prompt.submit({ text: "解释这个附件。", origin: { kind: "composer" }, wait: true, turnId: "running", attachments: [{ type }] })
    expect(result.drop).toContain("after the current turn")
    expect(calls).toBe(0)
  })
}

test("already-English mid-turn media and idle media submissions remain supported", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "fixture-token" }))
  let calls = 0
  on("http.fetch", () => { calls += 1; return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Describe the image." } }] }) } } })
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const english = "Please explain how to run the application and configure the database."
  expect((await $.prompt.submit({ text: english, origin: { kind: "composer" }, wait: false, turnId: "running", attachments: [{ type: "image" }] })).text).toBe(english)
  expect(calls).toBe(0)
  expect((await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: "english-media", message: { type: "attachment", name: "queued_command", content: [{ type: "text", text: prefix + english + suffix }] } })).message?.content[0]?.text).toBe(prefix + english + suffix)
  expect((await $.prompt.submit({ text: "描述图片。", origin: { kind: "composer" }, wait: false, attachments: [{ type: "image" }] })).text).toBe("描述图片。")
  expect(calls).toBe(1)
})

test("a missing same-turn handoff does not leak the original body into the model", async ($, on) => {
  mock.clock(on)
  const source = "未准备的追问原文。"
  const stored = await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: "missing-delivery", message: { type: "attachment", name: "queued_command", content: [{ type: "text", text: prefix + source + suffix }] } })
  expect(stored.message?.content[0]?.text).toContain("Input translation is unavailable.")
  const text = stored.message?.content[0]?.text
  expect(typeof text === "string" && text.includes(source)).toBe(false)
})

test("literal commands inside a same-turn envelope remain bypassed", async ($, on) => {
  mock.clock(on)
  let calls = 0
  on("http.fetch", () => { calls += 1; return { value: { ok: false, status: 500, headers: {}, text: "" } } })
  for (const source of ["/skills 参数", "!echo test", "#原样内容"]) {
    const text = prefix + source + suffix
    const stored = await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: source, message: { type: "attachment", name: "queued_command", content: [{ type: "text", text }] } })
    expect(stored.message?.content[0]?.text).toBe(text)
  }
  expect(calls).toBe(0)
})

test("same-turn handling leaves other origins, subagents and metadata alone", async ($, on) => {
  mock.clock(on)
  const text = prefix + "历史或非用户追问。" + suffix
  const base = { door: "delivery" as const, origin: { kind: "composer" as const }, uuid: "unowned-row", message: { type: "attachment" as const, name: "queued_command", content: [{ type: "text", text }] } }
  for (const row of [
    { ...base, origin: { kind: "engine" as const } },
    { ...base, origin: { kind: "sdk" as const } },
    { ...base, agentId: "child" },
    { ...base, message: { ...base.message, isMeta: true as const } },
    { ...base, message: { ...base.message, name: "hook_context" } },
    { ...base, door: "compaction" as const },
  ]) expect((await $.session.append(row)).message?.content[0]?.text).toBe(text)
})

test("unknown and ambiguous delivery envelopes are guarded without guessing", async ($, on) => {
  mock.clock(on)
  for (const content of [
    [{ type: "text", text: "changed framing: 未翻译原文" }],
    [{ type: "text", text: prefix + "未翻译原文一" + suffix }, { type: "text", text: prefix + "未翻译原文二" + suffix }],
  ]) {
    const stored = await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: `unknown-${content.length}`, message: { type: "attachment", name: "queued_command", content } })
    expect(JSON.stringify(stored.message?.content)).toContain("Input translation is unavailable.")
    expect(JSON.stringify(stored.message?.content)).not.toContain("未翻译原文")
  }
})

test("successful same-turn delivery releases the queue for automatic final translation", { options: { backend: "codex-cli", output_trigger: "final" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.complete", (_, e) => ({ text: e.answer }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const sources: string[] = []
  on("process.run", (_, e) => {
    sources.push(e.init?.stdin ?? "")
    return { value: { exitCode: 0, stdout: sources.length === 1 ? "Continue the explanation." : "最终答复译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Final answer." }
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { ...e, answer: "Final answer.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  await $.session.start({ cwd: "/tmp/followup-final", surface: "terminal", isInteractive: true })
  await $.turn.start({ text: "Initial question.", turnId: "main" })
  const source = "继续解释问题。"
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: true, turnId: "main" })
  await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: "consumed-followup", message: { type: "attachment", name: "queued_command", content: [{ type: "text", text: prefix + source + suffix }] } })
  for await (const _ of $.turn.step({ turnId: "main", index: 1, model: "fixture", messageCount: 3 })) {}
  await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "final-row", message: { type: "assistant", content: [{ type: "text", text: "Final answer." }] } })
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "final-row", props: { text: "Final answer.", isFirstOfReply: true } })
  await $.turn.complete({ turnId: "main", answer: "Final answer.", durationMs: 1, reason: "answer", isAborted: false })
  await clock.advance(1000)
  expect(sources).toEqual([source, "Final answer."])
  expect((await ui.find({ type: "Markdown", text: "最终答复译文。" }))?.text).toBe("最终答复译文。")
  await ui.unmount()
})
