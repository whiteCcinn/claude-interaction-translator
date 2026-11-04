import { expect, mock, test } from "claude-code/testing"
import { mountFreshDisplay } from "./display-fixtures"

const visible = { first: 0, last: 0, of: 1 }

for (const backend of ["api", "codex-cli"]) {
  for (const mode of ["manual", "final", "auto"]) {
    for (const running of mode === "auto" ? [true] : [false, true]) {
      test(`${backend} ${mode} retains ${running ? "running" : "requested queued"} translation across scroll away and back`, { options: { backend, output_trigger: mode } }, async ($, on) => {
        const clock = mock.clock(on)
        on("config.list", () => ({ value: [] }))
        on("env.get", () => ({ value: "fixture-token" }))
        on("session.start", (_, e) => ({ cwd: e.cwd }))
        on("turn.start", (_, e) => ({ turnId: e.turnId }))
        on("turn.complete", (_, e) => ({ text: e.answer }))
        let calls = 0
        on("process.run", async () => { calls += 1; await clock.sleep(800); return { value: { exitCode: 0, stdout: "滚回后保留的译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
        on("http.fetch", async () => { calls += 1; await clock.sleep(800); return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "滚回后保留的译文。" } }] }) } } })
        on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
        on("turn.step", async function* (_, e) {
          yield { kind: "text", index: 0, text: "Original visible answer." }
          yield { kind: "stop", stopReason: "end_turn", usage: null }
          return { ...e, answer: "Original visible answer.", toolUses: [], stopReason: "end_turn", usage: null }
        })
        await $.session.start({ cwd: "/tmp/scroll-display", surface: "terminal", isInteractive: true })
        await $.turn.start({ text: "Question.", turnId: "scroll-turn" })
        for await (const _ of $.turn.step({ turnId: "scroll-turn", index: 0, model: "fixture", messageCount: 1 })) {}
        await $.session.append({ door: "response", origin: { kind: "model", model: "fixture" }, uuid: "scroll-row", message: { type: "assistant", content: [{ type: "text", text: "Original visible answer." }] } })
        const props = { text: "Original visible answer.", isFirstOfReply: true, onScreen: visible }
        const row = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", requestId: "scroll-row", props })
        if (mode === "manual") await row.press({ key: "translate-output" })
        if (mode === "final") await $.turn.complete({ turnId: "scroll-turn", answer: props.text, reason: "answer", isAborted: false, durationMs: 1 })
        if (running) await clock.advance(200)
        else await clock.settle()
        await row.redraw({ ...props, onScreen: null })
        await clock.advance(1500)
        await row.redraw(props)
        await clock.advance(1500)
        expect((await row.find({ type: "Markdown", text: "滚回后保留的译文。" }))?.text).toBe("滚回后保留的译文。")
        expect(calls).toBe(1)
        expect(props.text).toBe("Original visible answer.")
        await row.unmount()
      })
    }
  }
}

test("requested offscreen work resumes after generation without waiting for another visible render", { options: { backend: "codex-cli" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", () => { calls += 1; return { value: { exitCode: 0, stdout: "后台完成译文。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  on("turn.step", async function* (_, e) {
    await clock.sleep(1000)
    yield { kind: "stop", stopReason: "end_turn", usage: null }
    return { ...e, answer: "", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const props = { text: "Previously requested answer.", isFirstOfReply: true, onScreen: visible }
  const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props })
  await row.press({ key: "translate-output" })
  const generating = (async () => { for await (const _ of $.turn.step({ turnId: "new-generation", index: 0, model: "fixture", messageCount: 1 })) {} })()
  await clock.settle()
  await row.redraw({ ...props, onScreen: null })
  await clock.advance(1500)
  await generating
  expect(calls).toBe(1)
  await row.redraw(props)
  expect((await row.find({ type: "Markdown", text: "后台完成译文。" }))?.text).toBe("后台完成译文。")
  await row.unmount()
})
