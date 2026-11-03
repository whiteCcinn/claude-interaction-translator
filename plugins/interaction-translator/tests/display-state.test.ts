import { expect, test } from "claude-code/testing"
import { createDisplayState, displayEntry, clearDisplay, incompleteCode, MAX_DISPLAY_ENTRIES, MAX_DISPLAY_BYTES, MAX_DISPLAY_SOURCE_BYTES } from "../hooks/display-translation"
import { assistantDisplayAllowed, recordFreshResponse } from "../hooks/display-translation"

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
