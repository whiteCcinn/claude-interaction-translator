import { expect, test } from "claude-code/testing"
import { bilingualInputEcho, clearInputEcho, createInputEchoState, MAX_INPUT_ECHO_BYTES, MAX_INPUT_ECHO_ROWS, recordInputEcho } from "../hooks/input-echo"

const uuid = "01234567-89ab-4cde-8f01-23456789abcd"
const alias = uuid.slice(0, 24) + "000000000002"

test("input echo accepts only the recorded row and exact body", () => {
  const state = createInputEchoState()
  recordInputEcho(state, "row", "原文", "Translation.")
  expect(bilingualInputEcho(state, "row", "原文")).toBe("原文：原文\n译文：Translation.")
  expect(bilingualInputEcho(state, "row", "Translation.")).toBe("原文：原文\n译文：Translation.")
  expect(bilingualInputEcho(state, "other", "原文")).toBe(undefined)
  expect(bilingualInputEcho(state, "row", "原文 suffix")).toBe(undefined)
})

test("native user block aliases use the exact original stored index", () => {
  const state = createInputEchoState()
  recordInputEcho(state, uuid, "原文", "Translation.", 2)
  expect(bilingualInputEcho(state, alias, "Translation.")).toBe("原文：原文\n译文：Translation.")
  expect(bilingualInputEcho(state, uuid.slice(0, 24) + "000000000001", "Translation.")).toBe(undefined)
})

test("an alias collision cannot lend another row its original", () => {
  const state = createInputEchoState()
  const samePrefix = uuid.slice(0, 24) + "fedcba987654"
  recordInputEcho(state, uuid, "第一条", "Translation.", 2)
  recordInputEcho(state, samePrefix, "第二条", "Translation.", 2)
  expect(bilingualInputEcho(state, alias, "Translation.")).toBe(undefined)
  expect(bilingualInputEcho(state, uuid, "Translation.")).toBe("原文：第一条\n译文：Translation.")
  recordInputEcho(state, samePrefix, "Same.", "Same.")
  expect(bilingualInputEcho(state, alias, "Translation.")).toBe("原文：第一条\n译文：Translation.")
})

test("replacing a row removes old aliases and old wording", () => {
  const state = createInputEchoState()
  recordInputEcho(state, uuid, "旧原文", "Old.", 2)
  recordInputEcho(state, uuid, "新原文", "New.", 0)
  expect(bilingualInputEcho(state, alias, "Old.")).toBe(undefined)
  expect(bilingualInputEcho(state, uuid, "Old.")).toBe(undefined)
  expect(bilingualInputEcho(state, uuid, "New.")).toBe("原文：新原文\n译文：New.")
})

test("echo row pressure evicts oldest presentations and keeps native fallback", () => {
  const state = createInputEchoState()
  for (let i = 0; i <= MAX_INPUT_ECHO_ROWS; i++) recordInputEcho(state, `row-${i}`, `原文${i}`, `Translated ${i}.`)
  expect(state.rows.size).toBe(MAX_INPUT_ECHO_ROWS)
  expect(bilingualInputEcho(state, "row-0", "原文0")).toBe(undefined)
  expect(bilingualInputEcho(state, `row-${MAX_INPUT_ECHO_ROWS}`, `原文${MAX_INPUT_ECHO_ROWS}`)).toBeDefined()
})

test("UTF-8 byte pressure is bounded independently of the row count", () => {
  const state = createInputEchoState()
  for (let i = 0; i < 40; i++) recordInputEcho(state, `row-${i}`, "中".repeat(40000) + i, "a".repeat(40000) + i)
  expect(state.bytes <= MAX_INPUT_ECHO_BYTES).toBe(true)
  expect(state.rows.size < MAX_INPUT_ECHO_ROWS).toBe(true)
  expect(bilingualInputEcho(state, "row-0", "中".repeat(40000) + "0")).toBe(undefined)
  expect(bilingualInputEcho(state, "row-39", "中".repeat(40000) + "39")).toBeDefined()
})

test("an echo exceeding native printable text limits falls back without evicting other rows", () => {
  const state = createInputEchoState()
  recordInputEcho(state, "kept", "原文", "Translation.")
  expect(recordInputEcho(state, "too-long", "a".repeat(60000), "b".repeat(60000))).toBe(false)
  expect(bilingualInputEcho(state, "kept", "原文")).toBeDefined()
  expect(state.rows.size).toBe(1)
})

test("unchanged wording and lifecycle clear keep no duplicate echo", () => {
  const state = createInputEchoState()
  expect(recordInputEcho(state, "same", "Same.", "Same.")).toBe(false)
  recordInputEcho(state, uuid, "原文", "Translation.", 2)
  const epoch = state.epoch
  clearInputEcho(state)
  expect(state.epoch).toBe(epoch + 1)
  expect(state.bytes).toBe(0)
  expect(state.rows.size).toBe(0)
  expect(state.identities.size).toBe(0)
  expect(bilingualInputEcho(state, alias, "Translation.")).toBe(undefined)
})
