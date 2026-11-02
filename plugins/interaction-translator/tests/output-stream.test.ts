import { expect, test } from "claude-code/testing"
import type { TurnStepChunk } from "claude-code"
import { prepareOutput, rewriteOutput } from "../hooks/output-stream"
import { protectText, restoreText } from "../hooks/protected-text"

test("positional text replacement preserves opaque engine refs and split inline code", () => {
  const chunks: TurnStepChunk[] = [
    { kind: "text", index: 0, text: "Use `co", ref: 1 },
    { kind: "engine", ref: 2 },
    { kind: "text", index: 0, text: "de`.", ref: 3 },
  ]
  const plan = prepareOutput(chunks, "Use `code`.")
  expect(plan.kind).toBe("text")
  if (plan.kind !== "text") throw new Error("Expected a text plan")
  const masked = protectText(plan.text, plan.markers)
  const restored = restoreText("使用 __GLM_KEEP_0__。", masked)
  expect(restored).toBeDefined()
  const rewritten = rewriteOutput(chunks, plan, restored ?? "")
  expect(rewritten).toEqual([
    { kind: "text", index: 0, text: "使用 `co", ref: 1 },
    { kind: "engine", ref: 2 },
    { kind: "text", index: 0, text: "de`。", ref: 3 },
  ])
})

test("reordered response boundaries are rejected", () => {
  const chunks: TurnStepChunk[] = [
    { kind: "text", index: 0, text: "One." }, { kind: "engine", ref: 1 },
    { kind: "text", index: 1, text: "Two." }, { kind: "engine", ref: 2 },
    { kind: "text", index: 2, text: "Three." },
  ]
  const plan = prepareOutput(chunks, "One.Two.Three.")
  if (plan.kind !== "text") throw new Error("Expected a text plan")
  expect(rewriteOutput(chunks, plan, `三${plan.markers[1]}二${plan.markers[0]}一`)).toBe(undefined)
})

test("opaque retry boundaries with reused indices retain only the completed answer", () => {
  const chunks: TurnStepChunk[] = [
    { kind: "text", index: 0, text: "Partial", ref: 1 },
    { kind: "engine", ref: 7 },
    { kind: "text", index: 0, text: "Answer", ref: 8 },
  ]
  const plan = prepareOutput(chunks, "Answer")
  if (plan.kind !== "text") throw new Error("Expected a text plan")
  expect(plan.text).toBe("Answer")
  expect(rewriteOutput(chunks, plan, "回答")).toEqual([
    { kind: "text", index: 0, text: "", ref: 1 },
    { kind: "engine", ref: 7 },
    { kind: "text", index: 0, text: "回答", ref: 8 },
  ])
})

test("ambiguous retry boundaries fail without guessing character offsets in translated words", () => {
  const plan = prepareOutput([{ kind: "text", index: 0, text: "PrefixAnswer" }], "Answer")
  expect(plan.kind).toBe("invalid")
})

test("code protection includes tilde fences, longer fences, and unfinished code blocks", () => {
  for (const code of [
    '~~~go\nfmt.Println("hello")\n~~~',
    '````markdown\n```go\nfmt.Println("hello")\n```\n````',
    '```go\nfmt.Println("hello")',
  ]) {
    const protectedText = protectText(code)
    expect(protectedText.values).toEqual([code])
    expect(restoreText(protectedText.text, protectedText)).toBe(code)
  }
})

test("fence characters inside code do not end protection and longer closing fences are accepted", () => {
  for (const code of [
    '~~~js\nconst mask = ~~~value;\nconsole.log("hello");\n~~~',
    '```js\nconst marker = "```";\nconsole.log("hello");\n```',
    '```js\nconsole.log("hello");\n````',
    '```js\n\t```\nconsole.log("hello");\n```',
  ]) {
    const protectedText = protectText(code)
    expect(protectedText.values).toEqual([code])
    expect(protectedText.text.includes("hello")).toBe(false)
    expect(restoreText(protectedText.text, protectedText)).toBe(code)
  }
})
