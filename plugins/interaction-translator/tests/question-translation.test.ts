import { expect, test } from "claude-code/testing"
import type { EngineInterface } from "claude-code"
import { clearDisplay, closeQuestionDisplay, createDisplayState, displayEntry, MAX_DISPLAY_ENTRIES, MAX_DISPLAY_PENDING, scheduleDisplay } from "../hooks/display-translation"
import { parseQuestions, prepareQuestionTranslation, questionSource, questionTranslationPrompt, restoreQuestionTranslation } from "../hooks/question-translation"

const question = () => ({ question: "Where should jobs run?", header: "Runtime", multiSelect: false, options: [
  { label: "Admin binary", description: "Keep existing imports.", extra: "unchanged" },
  { label: "Sidecar", description: "Move the business code." },
] })
const translations: Record<string, string> = {
  "Where should jobs run?": "任务应该在哪里运行？", Runtime: "运行方式", "Admin binary": "Admin 可执行程序",
  "Keep existing imports.": "保留现有导入。", Sidecar: "边车服务", "Move the business code.": "迁移业务代码。",
  "Which features?": "启用哪些功能？", Features: "功能",
}
type Field = { id: number; field: string; text: string }
function translated(input: string): Field[] {
  return (JSON.parse(input) as Field[]).map(row => ({ ...row, text: translations[row.text] ?? row.text }))
}

// The native test kit has no core AskUserQuestion engine drawing. Exercise
// shaping/scheduling directly here; real dialog rendering is checked offline.
function schedulerHarness() {
  const timers: (() => void)[] = []
  const order: string[] = []
  const response = (input: string) => {
    order.push(input.startsWith("[") ? "question" : "assistant")
    return input.startsWith("[") ? JSON.stringify(translated(input)) : "正文译文。"
  }
  const engine = {
    plugin: { name: "interaction-translator", root: "/tmp/question-fixture" },
    clock: { after(_ms: number, callback: () => void) { timers.push(callback); return { cancel() {} } } },
    config: { list: async () => [] },
    env: { get: async () => "example-token" },
    process: { run: async (_argv: string[], init: { stdin: string }) => ({ exitCode: 0, stdout: response(init.stdin), stderr: "", isStdoutTruncated: false, isStderrTruncated: false }) },
    http: { fetch: async (_url: string, init: { body: string }) => ({ ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: response(JSON.parse(init.body).messages[1].content) } }] }) }) },
    ui: { invalidate() {} },
  } as unknown as EngineInterface
  return { engine, timers, order }
}

test("dialog bundle translates wording while preserving original choice semantics and opaque fields", () => {
  const questions = [question()]
  const source = questionSource(questions)
  expect(source).toBeDefined()
  const prepared = prepareQuestionTranslation(source ?? "")
  expect(prepared).toBeDefined()
  if (!prepared) return
  const result = restoreQuestionTranslation(JSON.stringify(translated(prepared.text)), prepared)
  expect(result).toBeDefined()
  expect(parseQuestions(result ?? "")).toEqual([{ ...questions[0], question: "任务应该在哪里运行？", header: "运行方式", options: [
    { ...questions[0]?.options[0], description: "Admin 可执行程序 · 保留现有导入。" },
    { ...questions[0]?.options[1], description: "边车服务 · 迁移业务代码。" },
  ] }])
  expect(questions[0]?.header).toBe("Runtime")
  expect(questionTranslationPrompt("jp", "fr")).toContain("Japanese")
})

test("mixed preview layouts add a readable choice guide without changing previews or option values", () => {
  const q = question()
  const preview = "cmd/cronjob/ -> engine\nA technical diagram"
  const questions = [{ ...q, multiSelect: true, options: [{ ...q.options[0], preview }, q.options[1]] }]
  const prepared = prepareQuestionTranslation(questionSource(questions) ?? "")
  expect(prepared).toBeDefined()
  if (!prepared) return
  expect(prepared.text.includes("technical diagram")).toBe(false)
  const result = parseQuestions(restoreQuestionTranslation(JSON.stringify(translated(prepared.text)), prepared) ?? "")
  expect(result?.[0]?.question).toContain("1. Admin 可执行程序（Admin binary）")
  expect(result?.[0]?.question).toContain("2. 边车服务（Sidecar）")
  expect(result?.[0]?.question).toContain("保留现有导入。")
  expect(result?.[0]?.multiSelect).toBe(true)
  expect(result?.[0]?.options.map(o => o.label)).toEqual(["Admin binary", "Sidecar"])
  expect(result?.[0]?.options[0]?.preview).toBe(preview)
})

for (const corruption of ["invalid-json", "missing", "reordered", "duplicate-id", "wrong-kind", "long-header", "empty-question", "control", "missing-marker", "cross-field-marker", "duplicate-marker", "question-collision", "original-question-collision"]) {
  test(`rejects the entire dialog bundle for ${corruption}`, () => {
    const first = question()
    first.options[0]!.description = "Use `first.go`."
    first.options[1]!.description = "Use `second.go`."
    const prepared = prepareQuestionTranslation(questionSource([first, { ...question(), question: "Which features?", header: "Features" }]) ?? "")
    expect(prepared).toBeDefined()
    if (!prepared) return
    const rows = translated(prepared.text)
    if (corruption === "missing") rows.pop()
    if (corruption === "reordered") rows.reverse()
    if (corruption === "duplicate-id" && rows[1] && rows[0]) rows[1].id = rows[0].id
    if (corruption === "wrong-kind" && rows[0]) rows[0].field = "label"
    if (corruption === "long-header" && rows[1]) rows[1].text = "this header is too long"
    if (corruption === "empty-question" && rows[0]) rows[0].text = "  "
    if (corruption === "control" && rows[0]) rows[0].text += "\u001b[2J"
    if (corruption === "missing-marker" && rows[3]) rows[3].text = "The code is gone."
    if (corruption === "cross-field-marker" && rows[3] && rows[5]) [rows[3].text, rows[5].text] = [rows[5].text, rows[3].text]
    if (corruption === "duplicate-marker" && rows[3]) rows[3].text += rows[3].text
    if (corruption === "question-collision") for (const row of rows) if (row.field === "question") row.text = "请选择？"
    if (corruption === "original-question-collision" && rows[0]) rows[0].text = "Which features?"
    expect(restoreQuestionTranslation(corruption === "invalid-json" ? "not json" : JSON.stringify(rows), prepared)).toBe(undefined)
  })
}

test("dialog fields protect multiline code, paths and marker-looking source without cross-field substitution", () => {
  const q = question()
  q.options[0]!.description = 'Keep:\n```go\nfmt.Println("hello")\n```\nSee /tmp/a.go and __GLM_Q_KEEP_0_0__.'
  q.options[1]!.description = "Keep `second.go` and https://example.com/file."
  const prepared = prepareQuestionTranslation(questionSource([q]) ?? "")
  expect(prepared).toBeDefined()
  if (!prepared) return
  const result = parseQuestions(restoreQuestionTranslation(JSON.stringify(translated(prepared.text)), prepared) ?? "")
  expect(result?.[0]?.options[0]?.description).toContain(q.options[0]!.description)
  expect(result?.[0]?.options[1]?.description).toContain(q.options[1]!.description)
  expect(result?.[0]?.header).toBe("运行方式")
})

test("unsupported, malformed and unserializable question inputs pass through safely", () => {
  for (const questions of [[], [null], [{}], [{ ...question(), kind: "number" }], [{ ...question(), options: [] }], [{ ...question(), options: [null, null] }], [{ ...question(), multiSelect: "yes" }]]) expect(questionSource(questions)).toBe(undefined)
  const cyclic = { ...question(), cycle: {} }
  cyclic.cycle = cyclic
  expect(questionSource([cyclic])).toBe(undefined)
  expect(parseQuestions("not json")).toBe(undefined)
})

test("assistant rows and question dialogs with the same ID have independent cache identities", () => {
  const state = createDisplayState()
  const source = JSON.stringify([question()])
  const prose = displayEntry(state, "terminal", "same", source, false, "cn")
  const dialog = displayEntry(state, "terminal", "same", source, false, "cn", "question")
  expect(dialog === prose).toBe(false)
  expect(state.entries.size).toBe(2)
})

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} dispatches a complete dialog during active generation even when assistant pending work is full`, async () => {
    const { engine, timers, order } = schedulerHarness()
    const state = createDisplayState()
    state.activeSteps = 1
    for (let i = 0; i < MAX_DISPLAY_PENDING; i += 1) displayEntry(state, "terminal", `row-${i}`, `Original ${i}.`, false, "cn")
    const entry = displayEntry(state, "terminal", "dialog", JSON.stringify([question()]), false, "cn", "question")
    expect(entry).toBeDefined()
    scheduleDisplay(engine, { backend }, {}, state, "en", "cn")
    const dispatch = timers.shift()
    expect(dispatch).toBeDefined()
    if (dispatch) await dispatch()
    expect(order).toEqual(["question"])
    expect(entry?.phase).toBe("ready")
    expect(state.pending.size).toBe(MAX_DISPLAY_PENDING - 1)
    expect(parseQuestions(entry?.translated ?? "")?.[0]?.header).toBe("运行方式")
  })
}

test("dialogs run before queued assistant work when generation is idle", async () => {
  const { engine, timers, order } = schedulerHarness()
  const state = createDisplayState()
  for (let i = 0; i < MAX_DISPLAY_PENDING; i += 1) displayEntry(state, "terminal", `row-${i}`, `Original ${i}.`, false, "cn")
  displayEntry(state, "terminal", "dialog", JSON.stringify([question()]), false, "cn", "question")
  scheduleDisplay(engine, { backend: "codex-cli" }, {}, state, "en", "cn")
  const dispatch = timers.shift()
  expect(dispatch).toBeDefined()
  if (dispatch) await dispatch()
  expect(order[0]).toBe("question")
  clearDisplay(state)
})

test("closing a dialog cancels every surface without prematurely freeing an in-flight slot", () => {
  const state = createDisplayState()
  const source = JSON.stringify([question()])
  const first = displayEntry(state, "terminal", "dialog", source, false, "cn", "question")
  const other = displayEntry(state, "desktop", "dialog", source, false, "cn", "question")
  const prose = displayEntry(state, "terminal", "dialog", "Assistant body.", false, "cn")
  expect(first).toBeDefined()
  expect(other).toBeDefined()
  if (!first || !other) return
  state.pending.delete(first.key)
  state.running.add(first)
  first.phase = "loading"
  closeQuestionDisplay(state, "dialog")
  closeQuestionDisplay(state, "dialog")
  expect(first.controller.signal.aborted).toBe(true)
  expect(other.controller.signal.aborted).toBe(true)
  expect(state.entries.size).toBe(1)
  expect(state.bytes).toBe(prose?.bytes)
  expect(state.running.has(first)).toBe(true)
  expect(displayEntry(state, "terminal", "dialog", source, false, "cn", "question")).toBe(undefined)
})

test("a previous session's close cannot cancel a new dialog, and closed IDs stay bounded", () => {
  const state = createDisplayState()
  const epoch = state.epoch
  closeQuestionDisplay(state, "dialog")
  clearDisplay(state)
  const current = displayEntry(state, "terminal", "dialog", JSON.stringify([question()]), false, "cn", "question")
  closeQuestionDisplay(state, "dialog", epoch)
  expect(current?.controller.signal.aborted).toBe(false)
  expect(state.entries.size).toBe(1)
  for (let i = 0; i < MAX_DISPLAY_ENTRIES + 20; i += 1) closeQuestionDisplay(state, `closed-${i}`)
  expect(state.closedQuestions.size).toBe(MAX_DISPLAY_ENTRIES)
})
