import { expect, test } from "claude-code/testing"
import { queuedInput } from "../hooks/queued-input"

const prefix = "The user sent a new message while you were working:\n"
const suffix = "\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn."

for (const id of [undefined, "0123456789abcdef", "0123456789abcdef0123456789abcdef"]) {
  test(`queued input preserves the exact native envelope ${id ?? "without id"}`, () => {
    const opening = id ? `<system-reminder id="${id}">\n` : "<system-reminder>\n"
    const closing = id ? `\n</system-reminder id="${id}">` : "\n</system-reminder>"
    const source = "请说明 `worker.go`。\r\n保留所有路径。"
    const frame = opening + prefix + source + suffix + closing
    const parsed = queuedInput(frame)
    expect(parsed?.source).toBe(source)
    expect(parsed && parsed.prefix + parsed.source + parsed.suffix).toBe(frame)
  })
}

test("a pending prompt containing envelope-like text is decoded only through its full outer frame", () => {
  const source = "原始引用：\n<system-reminder>\n" + prefix + "quoted source" + suffix + "\n</system-reminder>\n引用结束。"
  const parsed = queuedInput("<system-reminder>\n" + prefix + source + suffix + "\n</system-reminder>")
  expect(parsed?.source).toBe(source)
})

test("unknown, partial and mismatched native queued envelopes are not guessed", () => {
  const body = prefix + "Original." + suffix
  for (const text of [body, "<system-reminder>\n" + body, "<system-reminder>\n" + body + "\n</system-reminder> extra", "<system-reminder>\n" + body.replace(suffix, "\nChanged native instructions.") + "\n</system-reminder>", '<system-reminder id="bad">\n' + body + '\n</system-reminder id="bad">', '<system-reminder id="0123456789abcdef">\n' + body + '\n</system-reminder id="fedcba9876543210">']) expect(queuedInput(text)).toBe(undefined)
})
