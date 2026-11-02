import { expect, mock, test } from "claude-code/testing"
import type { Engine } from "claude-code/testing"
import type { On, TurnStepChunk } from "claude-code"

const step = { turnId: "feedback-turn", index: 0, model: "claude-test", messageCount: 1 }
const stop: TurnStepChunk = { kind: "stop", stopReason: "end_turn", usage: null }
const props = { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} }

async function collect<R>(stream: AsyncGenerator<TurnStepChunk, R>) {
  const chunks: TurnStepChunk[] = []
  while (true) {
    const item = await stream.next()
    if (item.done) return { result: item.value, text: chunks.filter(chunk => chunk.kind === "text").map(chunk => chunk.text).join("") }
    chunks.push(item.value)
  }
}

function session(on: On) {
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
}

async function start($: Engine, interactive = true) {
  await $.session.start({ cwd: "/tmp/translator-feedback-test", surface: interactive ? "terminal" : null, isInteractive: interactive })
}

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} output progress shows its own direction and completes with translation-only timing`, { options: { output_mode: "conversation", backend, output_language: "jp" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    const clock = mock.clock(on)
    session(on)
    on("env.get", () => ({ value: "example-token" }))
    on("http.fetch", async () => {
      await clock.sleep(1200)
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "こんにちは。" } }] }) } }
    })
    on("process.run", async () => {
      await clock.sleep(1200)
      return { value: { exitCode: 0, stdout: "こんにちは。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("turn.step", async function* (_, e) {
      await clock.sleep(1000)
      yield { kind: "text", index: 0, text: "Hello." }
      yield stop
      return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
    })
    await start($)
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
    const response = collect($.turn.step(step))
    await clock.settle()
    expect(await ui.find({ type: "Text", text: /输出翻译中/ })).toBe(undefined)
    await clock.advance(1000)
    expect((await ui.find({ type: "Text", text: /输出翻译中/ }))?.text).toContain(backend === "api" ? "glm-5.3-flash" : "Codex CLI")
    expect((await ui.find({ type: "Text", text: /输出翻译中/ }))?.text).toContain("日文 (jp)")
    expect((await ui.find({ type: "Text", text: "英文 → 日文" }))?.text).toBe("英文 → 日文")
    await clock.advance(500)
    expect((await ui.find({ type: "Text", text: /输出翻译中/ }))?.text).toContain("0.5 秒")
    await clock.advance(700)
    expect((await response).text).toBe("こんにちは。")
    expect((await ui.find({ type: "Text", text: /输出翻译完成/ }))?.text).toContain("1.2 秒")
    await clock.advance(3000)
    expect(await ui.find({ type: "Text", text: /输出翻译/ })).toBe(undefined)
    await ui.unmount()
  })
}

test("output failure remains visible without input failure wording or private source text", { options: { output_mode: "conversation", backend: "codex-cli" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  session(on)
  on("process.run", async () => {
    await clock.sleep(500)
    return { value: { exitCode: 1, stdout: "partial reply", stderr: "private diagnostics", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Private original reply." }
    yield stop
    return { ...e, answer: "Private original reply.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  await start($)
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
  const response = collect($.turn.step(step))
  await clock.settle()
  await clock.advance(500)
  expect((await response).text).toContain("输出翻译失败")
  const title = (await ui.find({ type: "Text", text: /输出翻译失败/ }))?.text
  expect(title).toBeDefined()
  expect(title?.includes("原文未发送")).toBe(false)
  expect(await ui.find({ type: "Text", text: /private diagnostics|Private original|partial reply/ })).toBe(undefined)
  await clock.advance(6000)
  expect(await ui.find({ type: "Text", text: /输出翻译失败/ })).toBeDefined()
  await $.prompt.submit({ text: "/help", origin: { kind: "composer" }, wait: false })
  expect(await ui.find({ type: "Text", text: /输出翻译失败/ })).toBe(undefined)
  await ui.unmount()
})

test("an old input dismissal cannot hide a newer output translation", { options: { output_mode: "conversation", backend: "codex-cli" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  session(on)
  on("process.run", async (_, e) => {
    const response = e.argv.join(" ").includes("assistant response")
    if (response) await clock.sleep(4000)
    return { value: { exitCode: 0, stdout: response ? "你好。" : "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Hello." }
    yield stop
    return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  await start($)
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
  await $.prompt.submit({ text: "你好", origin: { kind: "composer" }, wait: false })
  const response = collect($.turn.step(step))
  await clock.settle()
  await clock.advance(3000)
  expect((await ui.find({ type: "Text", text: /输出翻译中/ }))?.text).toContain("3.0 秒")
  await clock.advance(1000)
  expect((await response).text).toBe("你好。")
  await ui.unmount()
})

test("an older output completion cannot replace the newest translation card", { options: { output_mode: "conversation", backend: "codex-cli" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  session(on)
  on("process.run", async (_, e) => {
    const first = e.init?.stdin === "First response."
    await clock.sleep(first ? 500 : 4000)
    return { value: { exitCode: 0, stdout: first ? "第一条。" : "第二条。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("turn.step", async function* (_, e) {
    const answer = e.turnId === "first" ? "First response." : "Second response."
    yield { kind: "text", index: 0, text: answer }
    yield stop
    return { ...e, answer, toolUses: [], stopReason: "end_turn", usage: null }
  })
  await start($)
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
  const first = collect($.turn.step({ ...step, turnId: "first" }))
  await clock.settle()
  const second = collect($.turn.step({ ...step, turnId: "second" }))
  await clock.settle()
  await clock.advance(500)
  expect((await first).text).toBe("第一条。")
  expect(await ui.find({ type: "Text", text: /输出翻译完成/ })).toBe(undefined)
  await clock.advance(3000)
  expect((await ui.find({ type: "Text", text: /输出翻译中/ }))?.text).toContain("3.5 秒")
  await clock.advance(500)
  expect((await second).text).toBe("第二条。")
  await ui.unmount()
})

test("headless output translation creates no feedback timers or redraws", { options: { output_mode: "conversation", backend: "codex-cli" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  session(on)
  on("process.run", () => ({ value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Hello." }
    yield stop
    return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  let redraws = 0
  on("ui.invalidate", () => { redraws += 1; return { value: undefined } })
  await start($, false)
  expect((await collect($.turn.step(step))).text).toBe("你好。")
  expect(redraws).toBe(0)
})

test("a mounted prompt enables output progress after a plugin reload without another session start", { options: { output_mode: "conversation", backend: "codex-cli" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on("process.run", async () => {
    await clock.sleep(500)
    return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Hello." }
    yield stop
    return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
  const response = collect($.turn.step(step))
  await clock.settle()
  expect(await ui.find({ type: "Text", text: /输出翻译中/ })).toBeDefined()
  await clock.advance(500)
  expect((await response).text).toBe("你好。")
  await ui.unmount()
})

for (const skipped of ["same-language", "subagent", "tools-only"]) {
  test(`${skipped} replies create no output translation card`, { options: { output_mode: "conversation", backend: "codex-cli", ...(skipped === "same-language" ? { output_language: "same-as-claude" } : {}) } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    session(on)
    on("turn.step", async function* (_, e) {
      const answer = skipped === "tools-only" ? "" : "Hello."
      if (answer) yield { kind: "text", index: 0, text: answer }
      else yield { kind: "tool", index: 0, id: "call-1", name: "Read" }
      yield stop
      return { ...e, answer, toolUses: [], stopReason: "end_turn", usage: null }
    })
    await start($)
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props })
    await collect($.turn.step({ ...step, ...(skipped === "subagent" ? { agentId: "agent-1" } : {}) }))
    expect(await ui.find({ type: "Text", text: /输出翻译/ })).toBe(undefined)
    await ui.unmount()
  })
}
