import { expect, mock, test } from "claude-code/testing"
import type { On } from "claude-code"

const source = "可以设置成卡片式的吗？填进去之后发现太长了。"
const translated = "Can we use a card layout? After filling it in, I realized it was too long."
const bilingual = `原文：${source}\n译文：${translated}`
const prefix = "<system-reminder>\nThe user sent a new message while you were working:\n"
const suffix = "\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>"

function setup(on: On, wording = translated) {
  mock.clock(on)
  const traffic = { calls: 0 }
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "fixture-token" }))
  on("http.fetch", () => { traffic.calls += 1; return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: wording } }] }) } } })
  on("process.run", () => { traffic.calls += 1; return { value: { exitCode: 0, stdout: wording, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  on("ui.render", { component: "UserMessage" }, ($, e) => $.ui.resolve(e).Text({ children: [e.props.text] }))
  return traffic
}

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} input echo is bilingual while the submitted original and model translation stay separate`, { options: { backend } }, async ($, on) => {
    const traffic = setup(on)
    const accepted = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
    expect(accepted.text).toBe(source)
    const stored = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "input-row", message: { type: "user", content: [{ type: "text", text: source }] } })
    expect(stored.message?.content).toEqual([{ type: "text", text: translated }])
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: "input-row", props: { text: translated, origin: { kind: "composer" }, isExpanded: true } })
    expect((await ui.find({ type: "Text", text: bilingual }))?.text).toBe(bilingual)
    await ui.redraw({ text: translated, origin: { kind: "composer" }, isExpanded: false, onScreen: null })
    await ui.redraw({ text: translated, origin: { kind: "composer" }, isExpanded: false })
    expect((await ui.find({ type: "Text", text: bilingual }))?.text).toBe(bilingual)
    expect(traffic.calls).toBe(1)
    await ui.redraw({ text: translated, origin: { kind: "composer" }, isExpanded: false })
    expect((await ui.find({ type: "Text", text: bilingual }))?.text).toBe(bilingual)
    await ui.unmount()
  })
}

test("a confirmed same-turn followup shows the original and sent translation", async ($, on) => {
  setup(on)
  const accepted = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: true, turnId: "running" })
  expect(accepted.text).toBe(source)
  const stored = await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: "followup-row", message: { type: "attachment", name: "queued_command", content: [{ type: "text", text: prefix + source + suffix }] } })
  expect(stored.message?.content).toEqual([{ type: "text", text: prefix + translated + suffix }])
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: "followup-row", props: { text: source, origin: { kind: "composer" }, isExpanded: false } })
  expect((await ui.find({ type: "Text", text: bilingual }))?.text).toBe(bilingual)
  await ui.unmount()
})

test("a multi-block prompt owns only its original translated block alias", async ($, on) => {
  setup(on)
  const rowId = "01234567-89ab-4cde-8f01-23456789abcd"
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
  const stored = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: rowId, message: { type: "user", content: [{ type: "text", text: "Other context." }, { type: "text", text: source }] } })
  expect(stored.message?.content).toEqual([{ type: "text", text: "Other context." }, { type: "text", text: translated }])
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: rowId.slice(0, 24) + "000000000001", props: { text: translated, origin: { kind: "composer" }, isExpanded: true } })
  expect((await ui.find({ type: "Text", text: bilingual }))?.text).toBe(bilingual)
  const other = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: rowId.slice(0, 24) + "000000000000", props: { text: "Other context.", origin: { kind: "composer" }, isExpanded: true } })
  expect((await other.find({ type: "Text", text: "Other context." }))?.text).toBe("Other context.")
  await ui.unmount()
  await other.unmount()
})

for (const lifecycle of ["start", "end", "resume"]) {
  test(`${lifecycle} clears bilingual ownership without translating historical rows`, async ($, on) => {
    const traffic = setup(on)
    on("session.start", (_, e) => ({ cwd: e.cwd }))
    on("session.end", () => ({ sessionId: "echo-session" }))
    on("command.run", { command: "resume" }, () => ({ text: "Resumed." }))
    await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
    await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "cleared-input", message: { type: "user", content: [{ type: "text", text: source }] } })
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: "cleared-input", props: { text: translated, origin: { kind: "composer" }, isExpanded: true } })
    expect((await ui.find({ type: "Text", text: bilingual }))?.text).toBe(bilingual)
    if (lifecycle === "start") await $.session.start({ cwd: "/tmp/input-echo", surface: "terminal", isInteractive: true })
    else if (lifecycle === "end") await $.session.end({ reason: "prompt_input_exit", sessionId: "echo-session", resume: { id: "echo-session" } })
    else await $.command.run({ command: "resume", args: "fixture", origin: { kind: "sdk" }, presentation: { isFullscreen: false, columns: 80 } })
    await ui.redraw({ text: translated, origin: { kind: "composer" }, isExpanded: true })
    expect((await ui.find({ type: "Text", text: translated }))?.text).toBe(translated)
    expect(traffic.calls).toBe(1)
    await ui.unmount()
  })
}

test("an append finishing after a session reset cannot repopulate input echoes", async ($, on) => {
  setup(on)
  on("command.run", { command: "resume" }, () => ({ text: "Resumed." }))
  let entered: () => void = () => {}
  let release: () => void = () => {}
  const arriving = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  on("session.append", { door: "prompt" }, async (_, e, next) => {
    entered()
    await gate
    return next(e)
  })
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
  const appending = $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "late-input", message: { type: "user", content: [{ type: "text", text: source }] } })
  await arriving
  await $.command.run({ command: "resume", args: "fixture", origin: { kind: "sdk" }, presentation: { isFullscreen: false, columns: 80 } })
  release()
  await appending
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: "late-input", props: { text: translated, origin: { kind: "composer" }, isExpanded: true } })
  expect((await ui.find({ type: "Text", text: translated }))?.text).toBe(translated)
  await ui.unmount()
})

test("a queued rewrite refused by the host cannot claim bilingual delivery", async ($, on) => {
  setup(on)
  on("session.append", { door: "delivery" }, (_, e, next) => next({ ...e, message: { ...e.message, content: [{ type: "text", text: prefix + source + suffix }] } }))
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: true, turnId: "running" })
  await $.session.append({ door: "delivery", origin: { kind: "composer" }, uuid: "refused-input", message: { type: "attachment", name: "queued_command", content: [{ type: "text", text: prefix + source + suffix }] } })
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: "refused-input", props: { text: source, origin: { kind: "composer" }, isExpanded: true } })
  expect((await ui.find({ type: "Text", text: source }))?.text).toBe(source)
  await ui.unmount()
})

test("an unrelated existing translation cannot confirm a refused ordinary prompt rewrite", async ($, on) => {
  setup(on)
  const rowId = "01234567-89ab-4cde-8f01-23456789abcd"
  const originalContent = [{ type: "text", text: translated }, { type: "text", text: source }]
  on("session.append", { door: "prompt" }, (_, e, next) => next({ ...e, message: { ...e.message, content: originalContent } }))
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
  const stored = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: rowId, message: { type: "user", content: originalContent } })
  expect(stored.message?.content).toEqual(originalContent)
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: rowId.slice(0, 24) + "000000000000", props: { text: translated, origin: { kind: "composer" }, isExpanded: true } })
  expect((await ui.find({ type: "Text", text: translated }))?.text).toBe(translated)
  await ui.unmount()
})

test("distinct originals with one translation keep their own echo identity", async ($, on) => {
  setup(on, "Change the button.")
  const originals = ["修改按钮。", "请改一下按钮。"]
  for (const [index, original] of originals.entries()) {
    await $.prompt.submit({ text: original, origin: { kind: "composer" }, wait: true })
    await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: `repeated-${index}`, message: { type: "user", content: [{ type: "text", text: original }] } })
  }
  for (const [index, original] of originals.entries()) {
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: `repeated-${index}`, props: { text: "Change the button.", origin: { kind: "composer" }, isExpanded: true } })
    expect((await ui.find({ type: "Text", text: `原文：${original}\n译文：Change the button.` }))?.text).toBeDefined()
    await ui.unmount()
  }
})

test("a bilingual echo cannot be attached to unrelated text or another row or origin", async ($, on) => {
  setup(on)
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
  await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "owned-row", message: { type: "user", content: [{ type: "text", text: source }] } })
  for (const target of [
    { requestId: "other-row", text: translated, origin: { kind: "composer" as const } },
    { requestId: "owned-row", text: "Different body.", origin: { kind: "composer" as const } },
    { requestId: "owned-row", text: translated, origin: { kind: "task-notification" as const } },
    { requestId: "owned-row", text: translated, origin: { kind: "sdk" as const } },
  ]) {
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: target.requestId, props: { text: target.text, origin: target.origin, isExpanded: true } })
    expect((await ui.find({ type: "Text", text: target.text }))?.text).toBe(target.text)
    await ui.unmount()
  }
})

test("same-language and command input keep a single native echo", async ($, on) => {
  setup(on)
  for (const [index, text] of ["Please explain how this function works and describe its expected behavior in English.", "/skills", "!echo test", "#原样内容"].entries()) {
    await $.prompt.submit({ text, origin: { kind: "composer" }, wait: false })
    await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: `bypass-${index}`, message: { type: "user", content: [{ type: "text", text }] } })
    const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "UserMessage", requestId: `bypass-${index}`, props: { text, origin: { kind: "composer" }, isExpanded: true } })
    expect((await ui.find({ type: "Text", text }))?.text).toBe(text)
    await ui.unmount()
  }
})
