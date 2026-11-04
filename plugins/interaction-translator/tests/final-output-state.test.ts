import { expect, test } from "claude-code/testing"
import { beginFinalStep, beginFinalSubmission, clearFinalOutput, completeFinalOutput, createFinalOutputState, finishFinalStep, finishFinalSubmission, recordFinalResponse, recordFinalStart, takeFinalDisplay } from "../hooks/final-output"
import type { TurnCompleteInput, TurnStepInput, TurnStepResult } from "claude-code"

const input: TurnStepInput = { turnId: "turn", index: 0, model: "fixture", messageCount: 1 }
const result: TurnStepResult = { turnId: "turn", index: 0, answer: "Answer.", toolUses: [], stopReason: "end_turn", usage: null }
const complete: TurnCompleteInput = { turnId: "turn", answer: "Answer.", durationMs: 1, isAborted: false, reason: "answer" }
const options = { output_trigger: "final" }

function fixture() {
  const state = createFinalOutputState()
  recordFinalStart(state, input.turnId)
  const step = beginFinalStep(state, input)
  recordFinalResponse(state, step, "row", [{ type: "text", text: "Answer." }])
  finishFinalStep(state, step, result)
  return { state, step }
}

test("final admission selects the last stored row with exact original text block positions", () => {
  const { state, step } = fixture()
  const uuid = "5cf9480d-015d-468f-8880-5c8151621aab"
  recordFinalResponse(state, step, uuid, [{ type: "thinking", thinking: "Hidden content." }, { type: "text", text: "Final block." }])
  completeFinalOutput(state, step, complete, false)
  expect(takeFinalDisplay(state, options, "terminal", "row", false)).toBe(false)
  expect(takeFinalDisplay(state, options, "terminal", uuid.slice(0, 24) + "000000000000", false)).toBe(false)
  expect(takeFinalDisplay(state, options, "terminal", uuid.slice(0, 24) + "000000000001", true)).toBe(false)
  expect(takeFinalDisplay(state, options, "terminal", uuid.slice(0, 24) + "000000000001", false)).toBe(true)
  expect(takeFinalDisplay(state, options, "terminal", uuid.slice(0, 24) + "000000000001", false)).toBe(false)
  expect(takeFinalDisplay(state, options, "desktop", uuid.slice(0, 24) + "000000000001", false)).toBe(true)
})

for (const reason of ["aborted", "error", "refusal"] as const) {
  test(`a ${reason} completion retains manual translation only`, () => {
    const { state, step } = fixture()
    const event: TurnCompleteInput = reason === "refusal" ? { ...complete, reason, refusal: { category: null, explanation: null } } : { ...complete, reason, isAborted: reason === "aborted" }
    completeFinalOutput(state, step, event, false)
    expect(takeFinalDisplay(state, options, "terminal", "row", false)).toBe(false)
  })
}

test("partial steps, tools, empty final text and unseen starts cannot authorize automatic work", () => {
  for (const stopReason of ["max_tokens", "tool_use", "pause_turn", null] as const) {
    const { state, step } = fixture()
    finishFinalStep(state, step, { ...result, stopReason })
    completeFinalOutput(state, step, complete, false)
    expect(takeFinalDisplay(state, options, "terminal", "row", false)).toBe(false)
  }
  const { state, step } = fixture()
  completeFinalOutput(state, step, { ...complete, answer: "" }, false)
  expect(takeFinalDisplay(state, options, "terminal", "row", false)).toBe(false)
  expect(beginFinalStep(createFinalOutputState(), input)).toBe(undefined)
})

test("followups, persisted handoffs and delayed completions cannot authorize an intermediate reply", () => {
  const { state, step } = fixture()
  const submission = beginFinalSubmission(state)
  finishFinalSubmission(state, submission, true)
  completeFinalOutput(state, step, complete, false)
  expect(takeFinalDisplay(state, options, "terminal", "row", false)).toBe(false)
  const second = beginFinalStep(state, { ...input, index: 1 })
  recordFinalResponse(state, second, "second", [{ type: "text", text: "Second." }])
  finishFinalStep(state, second, { ...result, index: 1 })
  completeFinalOutput(state, second, complete, true)
  expect(takeFinalDisplay(state, options, "terminal", "second", false)).toBe(false)
  const last = beginFinalStep(state, { ...input, index: 2 })
  recordFinalResponse(state, last, "last", [{ type: "text", text: "Last." }])
  finishFinalStep(state, last, { ...result, index: 2 })
  completeFinalOutput(state, last, complete, false)
  expect(takeFinalDisplay(state, options, "terminal", "last", false)).toBe(true)
})

test("a rejected followup does not supersede a running task's final reply", () => {
  const { state, step } = fixture()
  const failed = beginFinalSubmission(state)
  finishFinalSubmission(state, failed, false)
  completeFinalOutput(state, step, complete, false)
  expect(takeFinalDisplay(state, options, "terminal", "row", false)).toBe(true)
})

test("an older turn start or completion does not replace the newest step or its final selection", () => {
  const { state, step } = fixture()
  recordFinalStart(state, "new")
  const newest = beginFinalStep(state, { ...input, turnId: "new" })
  recordFinalResponse(state, newest, "new-row", [{ type: "text", text: "New." }])
  finishFinalStep(state, newest, { ...result, turnId: "new" })
  recordFinalStart(state, "turn")
  completeFinalOutput(state, step, complete, false)
  expect(takeFinalDisplay(state, options, "terminal", "row", false)).toBe(false)
  completeFinalOutput(state, newest, { ...complete, turnId: "new" }, false)
  expect(takeFinalDisplay(state, options, "terminal", "new-row", false)).toBe(true)
})

test("a main step with an unseen start cannot attach its response to an older turn", () => {
  const { state, step } = fixture()
  beginFinalStep(state, { ...input, turnId: "unseen-new-turn" })
  recordFinalResponse(state, state.lastStep, "new-unfinished-row", [{ type: "text", text: "New unfinished response." }])
  completeFinalOutput(state, step, complete, false)
  expect(takeFinalDisplay(state, options, "terminal", "new-unfinished-row", false)).toBe(false)
})

test("a session clear invalidates pending callbacks and admission without reviving retired work", () => {
  const { state, step } = fixture()
  const old = beginFinalSubmission(state)
  clearFinalOutput(state)
  const current = beginFinalSubmission(state)
  finishFinalSubmission(state, old)
  expect(current !== undefined && state.submissions.has(current)).toBe(true)
  recordFinalResponse(state, step, "late-row", [{ type: "text", text: "Late." }])
  completeFinalOutput(state, step, complete, false)
  expect(takeFinalDisplay(state, options, "terminal", "late-row", false)).toBe(false)
})

test("final lifecycle bounds overflow conservatively and isolate subagent work", () => {
  const state = createFinalOutputState()
  for (let i = 0; i < 100; i++) {
    recordFinalStart(state, String(i))
    beginFinalStep(state, { ...input, turnId: String(i) })
  }
  expect(state.starts.size).toBe(32)
  expect(state.steps.size).toBe(32)
  const last = state.lastStep
  expect(beginFinalStep(state, { ...input, agentId: "child", turnId: "99" })).toBe(undefined)
  expect(state.lastStep).toBe(last)
  for (let i = 0; i < 33; i++) beginFinalSubmission(state)
  expect(state.submissions.size).toBe(32)
  expect(state.overflow).toBe(true)
})
