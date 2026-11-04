import { expect, test } from "claude-code/testing"
import { createDisplayState, displayEntry, clearDisplay, incompleteCode, MAX_DISPLAY_ENTRIES, MAX_DISPLAY_BYTES, MAX_DISPLAY_SOURCE_BYTES } from "../hooks/display-translation"
import { assistantDisplayAllowed, recordFreshResponse, manualDisplay, manualDisplayTarget, requestDisplay, retryDisplay, leaveDisplayViewport, MAX_DISPLAY_PENDING, closeQuestionDisplay } from "../hooks/display-translation"
import type { EngineInterface } from "claude-code"

const manualEngine = () => {
  let scheduled = 0
  const engine = { clock: { after() { scheduled += 1; return { cancel() {} } } }, ui: { invalidate() {} } } as unknown as EngineInterface
  return { engine, scheduled: () => scheduled }
}

test("manual is the default display trigger and conversation remains automatic", () => {
  expect(manualDisplay({})).toBe(true)
  expect(manualDisplay({ output_mode: "display-only", output_trigger: "auto" })).toBe(false)
  expect(manualDisplay({ output_mode: "conversation", output_trigger: "manual" })).toBe(false)
})

test("idle history stays bounded without pinning out the latest manual control", () => {
  const state = createDisplayState()
  const first = displayEntry(state, "terminal", "oldest", "Old history.", false, "cn", "assistant", false)
  for (let i = 0; i < MAX_DISPLAY_ENTRIES + 10; i++) displayEntry(state, "terminal", String(i), `Reply ${i}.`, false, "cn", "assistant", false)
  expect(state.entries.size).toBe(MAX_DISPLAY_ENTRIES)
  expect(state.pending.size).toBe(0)
  expect(state.running.size).toBe(0)
  expect(first?.controller.signal.aborted).toBe(true)
  expect(manualDisplayTarget(state, "terminal")?.requestId).toBe(String(MAX_DISPLAY_ENTRIES + 9))
})

test("completed manual translations can make room for a new explicit control", () => {
  const state = createDisplayState()
  for (let i = 0; i < MAX_DISPLAY_ENTRIES; i++) {
    const entry = displayEntry(state, "terminal", String(i), `Reply ${i}.`, false, "cn", "assistant", false)!
    entry.phase = "ready"
    entry.translated = "译文。"
  }
  expect(displayEntry(state, "terminal", "latest", "Latest reply.", false, "cn", "assistant", false)?.phase).toBe("idle")
  expect(state.entries.size).toBe(MAX_DISPLAY_ENTRIES)
  expect(state.pending.size).toBe(0)
})

test("scrolling through idle history does not evict a completed translation before idle entries", () => {
  const state = createDisplayState()
  const translated = displayEntry(state, "terminal", "translated", "Completed answer.", false, "cn", "assistant", false)!
  translated.phase = "ready"
  translated.translated = "译文。"
  translated.visible = false
  for (let i = 0; i < MAX_DISPLAY_ENTRIES + 5; i++) displayEntry(state, "terminal", String(i), `Old history ${i}.`, false, "cn", "assistant", false)
  expect(state.entries.get(translated.key)).toBe(translated)
  expect(state.entries.size).toBe(MAX_DISPLAY_ENTRIES)
})

test("explicit requests queue once and reject stale, hidden and cleared actions", () => {
  const state = createDisplayState()
  const { engine, scheduled } = manualEngine()
  const old = displayEntry(state, "terminal", "row", "Before edit.", false, "cn", "assistant", false)!
  const current = displayEntry(state, "terminal", "row", "After edit.", false, "cn", "assistant", false)!
  requestDisplay(engine, {}, {}, state, old, "en", "cn")
  expect(state.pending.size).toBe(0)
  current.visible = false
  requestDisplay(engine, {}, {}, state, current, "en", "cn")
  expect(state.pending.size).toBe(0)
  current.visible = true
  requestDisplay(engine, {}, {}, state, current, "en", "cn")
  requestDisplay(engine, {}, {}, state, current, "en", "cn")
  expect(state.pending.size).toBe(1)
  expect(scheduled()).toBe(1)
  clearDisplay(state)
  requestDisplay(engine, {}, {}, state, current, "en", "cn")
  expect(state.pending.size).toBe(0)
})

test("an explicit retry in auto mode survives scrolling but a changed hidden source remains stale", () => {
  const state = createDisplayState()
  const { engine } = manualEngine()
  const entry = displayEntry(state, "terminal", "retry", "Original reply.", false, "cn")!
  state.pending.delete(entry.key)
  entry.phase = "error"
  expect(entry.manual).toBe(false)
  retryDisplay(engine, { output_trigger: "auto" }, {}, state, entry, "en", "cn")
  leaveDisplayViewport(state, "terminal", "retry", "Original reply.", false, "cn")
  expect(state.pending.get(entry.key)).toBe(entry)
  expect(entry.controller.signal.aborted).toBe(false)
  leaveDisplayViewport(state, "terminal", "retry", "Changed reply.", false, "cn")
  expect(state.entries.has(entry.key)).toBe(false)
  expect(state.pending.size).toBe(0)
  expect(entry.controller.signal.aborted).toBe(true)
})

test("manual question discovery does not evict queued work and queue pressure is retryable", () => {
  const state = createDisplayState()
  const { engine } = manualEngine()
  for (let i = 0; i < MAX_DISPLAY_PENDING; i++) displayEntry(state, "terminal", String(i), `Reply ${i}.`, false, "cn")
  const question = displayEntry(state, "terminal", "dialog", "[]", false, "cn", "question", false)!
  expect(question.phase).toBe("idle")
  expect(state.pending.size).toBe(MAX_DISPLAY_PENDING)
  requestDisplay(engine, {}, {}, state, question, "en", "cn")
  expect(question.phase).toBe("error")
  expect(question.failure).toBe("queue")
  state.pending.clear()
  requestDisplay(engine, {}, {}, state, question, "en", "cn")
  expect(question.phase).toBe("pending")
  expect(question.failure).toBe(undefined)
  expect(state.pending.size).toBe(1)
  closeQuestionDisplay(state, "dialog")
  requestDisplay(engine, {}, {}, state, question, "en", "cn")
  expect(state.pending.size).toBe(0)
})

test("native assistant block zero uses the recorded response UUID with its block suffix", () => {
  const state = createDisplayState()
  recordFreshResponse(state, "5cf9480d-015d-468f-8880-5c8151621aab", 3)
  expect(assistantDisplayAllowed(state, "terminal", "5cf9480d-015d-468f-8880-000000000000", false, "cn")).toBe(true)
  expect(assistantDisplayAllowed(state, "desktop", "5cf9480d-015d-468f-8880-000000000002", true, "cn")).toBe(true)
  expect(assistantDisplayAllowed(state, "terminal", "5cf9480d-015d-468f-8880-000000000003", false, "cn")).toBe(false)
  expect(assistantDisplayAllowed(state, "terminal", "5cf9480d-015d-468f-8880-5c8151621aab", false, "cn")).toBe(true)
  expect(assistantDisplayAllowed(state, "terminal", "5cf9480d-015d-468f-8881-000000000000", false, "cn")).toBe(false)
})

test("fresh response identities stay bounded while existing cache entries remain usable", () => {
  const state = createDisplayState()
  expect(assistantDisplayAllowed(state, "terminal", "old", false, "cn")).toBe(false)
  recordFreshResponse(state, "current")
  expect(assistantDisplayAllowed(state, "terminal", "current", true, "cn")).toBe(true)
  const cached = displayEntry(state, "terminal", "current", "Reply.", false, "cn")
  expect(cached).toBeDefined()
  for (let i = 0; i < MAX_DISPLAY_ENTRIES; i++) recordFreshResponse(state, `next-${i}`)
  expect(state.freshResponses.size).toBe(MAX_DISPLAY_ENTRIES)
  expect(state.freshResponses.has("current")).toBe(false)
  expect(assistantDisplayAllowed(state, "terminal", "current", false, "cn")).toBe(true)
  expect(assistantDisplayAllowed(state, "desktop", "current", false, "cn")).toBe(false)
  clearDisplay(state)
  expect(state.freshResponses.size).toBe(0)
  expect(assistantDisplayAllowed(state, "terminal", "current", false, "cn")).toBe(false)
})

test("visible cache entries are pinned rather than evicted into an automatic translation loop", () => {
  const state = createDisplayState()
  for (let index = 0; index < MAX_DISPLAY_ENTRIES; index += 1) {
    const entry = displayEntry(state, "terminal", String(index), `Reply ${index}`, false, "cn")
    if (!entry) throw new Error("Fixture exceeds the cache")
    entry.phase = "ready"
    state.pending.delete(entry.key)
  }
  expect(displayEntry(state, "terminal", "new", "New reply", false, "cn")).toBe(undefined)
  expect(state.entries.size).toBe(MAX_DISPLAY_ENTRIES)
})

test("cache bounds include source text and reject oversized visible blocks", () => {
  const state = createDisplayState()
  expect(displayEntry(state, "terminal", "huge", "x".repeat(MAX_DISPLAY_SOURCE_BYTES + 1), false, "cn")).toBe(undefined)
  for (let index = 0; index < 40; index += 1) displayEntry(state, "terminal", String(index), "x".repeat(200000), false, "cn")
  expect(state.bytes <= MAX_DISPLAY_BYTES).toBe(true)
  expect(state.entries.size <= MAX_DISPLAY_ENTRIES).toBe(true)
})

test("exact source and summary status are independent cache identities", () => {
  const state = createDisplayState()
  const first = displayEntry(state, "terminal", "message", "Visible.", false, "cn")
  expect(displayEntry(state, "terminal", "message", "Visible.", false, "cn")).toBe(first)
  expect(displayEntry(state, "terminal", "message", "Visible.", true, "cn") === first).toBe(false)
  const updated = displayEntry(state, "terminal", "message", "Visible update.", false, "cn")
  expect(updated === first).toBe(false)
  expect(first?.controller.signal.aborted).toBe(true)
})

test("clearing a display session aborts entries and retains no text", () => {
  const state = createDisplayState()
  const entry = displayEntry(state, "terminal", "message", "Private reply.", false, "cn")
  clearDisplay(state)
  expect(entry?.controller.signal.aborted).toBe(true)
  expect(state.entries.size).toBe(0)
  expect(state.pending.size).toBe(0)
  expect(state.bytes).toBe(0)
})

test("split code boundaries are conservatively detected", () => {
  for (const text of ["See `/tmp/", "file.go` now", "```go\nfmt.Println(1)", "fmt.Println(1)\n```", "~~~\ncode"]) expect(incompleteCode(text)).toBe(true)
  for (const text of ["See `file.go` now", "```go\nfmt.Println(1)\n```", "~~~\ncode\n~~~", "Ordinary prose."]) expect(incompleteCode(text)).toBe(false)
})
