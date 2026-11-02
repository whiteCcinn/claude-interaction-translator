import { expect, test } from "claude-code/testing"
import { createDisplayState, displayEntry, clearDisplay, incompleteCode, MAX_DISPLAY_ENTRIES, MAX_DISPLAY_BYTES, MAX_DISPLAY_SOURCE_BYTES } from "../hooks/display-translation"

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
