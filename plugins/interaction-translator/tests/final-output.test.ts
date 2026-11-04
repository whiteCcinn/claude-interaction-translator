import { expect, mock, test } from "claude-code/testing"

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} final mode translates only the final reply after normal turn completion`, { options: { backend, output_trigger: "final" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "fixture-token" }))
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", (_, e) => ({ text: e.answer }))
    const sources: string[] = []
    on("process.run", async (_, e) => { sources.push(e.init?.stdin ?? ""); await clock.sleep(500); return { value: { exitCode: 0, stdout: "最终回复译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
    on("http.fetch", async (_, e) => { sources.push(JSON.parse(e.init?.body ?? "{}").messages[1].content); await clock.sleep(500); return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "最终回复译文。" } }] }) } } })
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    on("turn.step", async function* (_, e) {
      const text = e.index === 0 ? "Intermediate progress." : "Final English reply."
      yield { kind: "text", index: 0, text }
      yield { kind: "stop", stopReason: "end_turn", usage: null }
      return { ...e, answer: text, toolUses: [], stopReason: "end_turn", usage: null }
    })
    await $.session.start({ cwd: "/tmp/final-output", surface: "terminal", isInteractive: true })
    await $.turn.start({ text: "Fixture prompt.", turnId: "main-turn" })
    for await (const _ of $.turn.step({ turnId: "main-turn", index: 0, model: "fixture", messageCount: 1 })) {}
    await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "progress", message: { type: "assistant", content: [{ type: "text", text: "Intermediate progress." }] } })
    const progress = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "progress", props: { text: "Intermediate progress.", isFirstOfReply: true } })
    await clock.advance(2000)
    expect(sources).toEqual([])
    for await (const _ of $.turn.step({ turnId: "main-turn", index: 1, model: "fixture", messageCount: 2 })) {}
    await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "final", message: { type: "assistant", content: [{ type: "text", text: "Final English reply." }] } })
    const final = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "final", props: { text: "Final English reply.", isFirstOfReply: true } })
    await clock.advance(2000)
    expect(sources).toEqual([])
    const result = await $.turn.complete({ turnId: "main-turn", answer: "Final English reply.", durationMs: 100, isAborted: false, reason: "answer" })
    expect(result.text).toBe("Final English reply.")
    await clock.advance(200)
    expect(sources).toEqual(["Final English reply."])
    expect((await final.find({ type: "Markdown", text: "Final English reply." }))?.text).toBe("Final English reply.")
    await clock.advance(1000)
    expect((await final.find({ type: "Markdown", text: "最终回复译文。" }))?.text).toBe("最终回复译文。")
    expect((await progress.find({ type: "Markdown", text: "Intermediate progress." }))?.text).toBe("Intermediate progress.")
    await final.redraw({ text: "Final English reply.", isFirstOfReply: true })
    await clock.advance(1000)
    expect(sources).toEqual(["Final English reply."])
    await progress.unmount()
    await final.unmount()
  })
}

test("two queued followups suppress intermediate completion and translate only the last consumed reply", { options: { backend: "codex-cli", output_trigger: "final" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.complete", (_, e) => ({ text: e.answer }))
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  const sources: string[] = []
  on("process.run", (_, e) => { sources.push(e.init?.stdin ?? ""); return { value: { exitCode: 0, stdout: "最后一条答复译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("turn.step", async function* (_, e) {
    const text = `Reply ${e.index}.`
    yield { kind: "text", index: 0, text }
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { ...e, answer: text, toolUses: [], stopReason: "end_turn", usage: null }
  })
  await $.session.start({ cwd: "/tmp/final-followups", surface: "terminal", isInteractive: true })
  await $.turn.start({ text: "Initial question.", turnId: "initial" })
  for await (const _ of $.turn.step({ turnId: "initial", index: 0, model: "fixture", messageCount: 1 })) {}
  await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "first-row", message: { type: "assistant", content: [{ type: "text", text: "Reply 0." }] } })
  const first = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "first-row", props: { text: "Reply 0.", isFirstOfReply: true } })
  const q1 = "Please explain how this function works and describe its expected behavior in English."
  const q2 = "Please describe how these tests work and explain the expected results in English."
  expect((await $.prompt.submit({ text: q1, wait: true, origin: { kind: "composer" }, turnId: "initial" })).drop).toBe(undefined)
  expect((await $.prompt.submit({ text: q2, wait: true, origin: { kind: "composer" }, turnId: "initial" })).drop).toBe(undefined)
  await $.turn.complete({ turnId: "initial", answer: "Reply 0.", reason: "answer", isAborted: false, durationMs: 1 })
  await clock.advance(1000)
  expect(sources).toEqual([])
  const rows = [first]
  for (const [index, question] of [q1, q2].entries()) {
    await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: `followup-${index}`, message: { type: "user", content: [{ type: "text", text: question }] } })
    const turnId = `followup-turn-${index}`
    await $.turn.start({ text: question, turnId })
    for await (const _ of $.turn.step({ turnId, index: index + 1, model: "fixture", messageCount: 3 })) {}
    const text = `Reply ${index + 1}.`
    await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: `reply-${index}`, message: { type: "assistant", content: [{ type: "text", text }] } })
    rows.push(await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: `reply-${index}`, props: { text, isFirstOfReply: true } }))
    await $.turn.complete({ turnId, answer: text, reason: "answer", isAborted: false, durationMs: 1 })
    await clock.advance(1000)
    expect(sources).toEqual(index === 0 ? [] : ["Reply 2."])
  }
  expect((await first.find({ type: "Markdown", text: "Reply 0." }))?.text).toBe("Reply 0.")
  for (const row of rows) await row.unmount()
})

for (const started of [false, true]) {
  test(`a followup retires ${started ? "running" : "queued"} automatic final work without installing its late result`, { options: { backend: "codex-cli", output_trigger: "final" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", (_, e) => ({ text: e.answer }))
    on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
    let calls = 0
    on("process.run", async () => { calls += 1; await clock.sleep(1000); return { value: { exitCode: 0, stdout: "已过期的最终译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    on("turn.step", async function* (_, e) {
      yield { kind: "text", index: 0, text: "Original answer." }
      yield { kind: "stop", stopReason: "end_turn", usage: null }
      return { ...e, answer: "Original answer.", toolUses: [], stopReason: "end_turn", usage: null }
    })
    await $.session.start({ cwd: "/tmp/final-cancel", surface: "terminal", isInteractive: true })
    await $.turn.start({ text: "Question.", turnId: "turn" })
    for await (const _ of $.turn.step({ turnId: "turn", index: 0, model: "fixture", messageCount: 1 })) {}
    await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "row", message: { type: "assistant", content: [{ type: "text", text: "Original answer." }] } })
    const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "row", props: { text: "Original answer.", isFirstOfReply: true } })
    await $.turn.complete({ turnId: "turn", answer: "Original answer.", reason: "answer", isAborted: false, durationMs: 1 })
    if (started) await clock.advance(200)
    else await clock.settle()
    await $.prompt.submit({ text: "Please explain how this function works and describe its expected behavior in English.", wait: true, origin: { kind: "composer" } })
    await clock.advance(2000)
    expect(calls).toBe(started ? 1 : 0)
    expect((await row.find({ type: "Markdown", text: "Original answer." }))?.text).toBe("Original answer.")
    expect(await row.find({ text: "已过期的最终译文。" })).toBe(undefined)
    await row.unmount()
  })
}

test("final mode keeps headless output original without a translation call", { options: { backend: "codex-cli", output_trigger: "final" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.complete", (_, e) => ({ text: e.answer }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "不应调用。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Headless answer." }
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { ...e, answer: "Headless answer.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  await $.session.start({ cwd: "/tmp/final-headless", surface: "terminal", isInteractive: false })
  await $.turn.start({ text: "Question.", turnId: "turn" })
  for await (const _ of $.turn.step({ turnId: "turn", index: 0, model: "fixture", messageCount: 1 })) {}
  await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "row", message: { type: "assistant", content: [{ type: "text", text: "Headless answer." }] } })
  const response = await $.turn.complete({ turnId: "turn", answer: "Headless answer.", reason: "answer", isAborted: false, durationMs: 1 })
  await clock.advance(1000)
  expect(response.text).toBe("Headless answer.")
  expect(calls).toBe(0)
})

test("a followup that fails after the original turn completes releases its deferred final translation", { options: { backend: "codex-cli", output_trigger: "final" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.complete", (_, e) => ({ text: e.answer }))
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  let outputs = 0
  on("process.run", async (_, e) => {
    if (e.argv.join(" ").includes("assistant response")) { outputs += 1; return { value: { exitCode: 0, stdout: "原任务最终译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } }
    await clock.sleep(1000)
    return { value: { exitCode: 1, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Original answer." }
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { ...e, answer: "Original answer.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  await $.session.start({ cwd: "/tmp/final-deferred", surface: "terminal", isInteractive: true })
  await $.turn.start({ text: "Question.", turnId: "turn" })
  for await (const _ of $.turn.step({ turnId: "turn", index: 0, model: "fixture", messageCount: 1 })) {}
  await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "row", message: { type: "assistant", content: [{ type: "text", text: "Original answer." }] } })
  const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "row", props: { text: "Original answer.", isFirstOfReply: true } })
  const submitting = $.prompt.submit({ text: "请进一步解释这个测试的细节。", wait: true, turnId: "turn", origin: { kind: "composer" } })
  await clock.settle()
  await $.turn.complete({ turnId: "turn", answer: "Original answer.", reason: "answer", isAborted: false, durationMs: 1 })
  await clock.advance(200)
  expect(outputs).toBe(0)
  await clock.advance(1500)
  expect((await submitting).drop).toBeDefined()
  await clock.advance(1000)
  expect(outputs).toBe(1)
  expect((await row.find({ type: "Markdown", text: "原任务最终译文。" }))?.text).toBe("原任务最终译文。")
  await row.unmount()
})
