import { expect, mock, test } from "claude-code/testing"
import { protectText } from "../hooks/protected-text"
import { assembleProtectedBatch, parseSegmentResponse, prepareProtectedBatch, segmentRequest } from "../hooks/protected-segments"
import { mountFreshDisplay } from "./display-fixtures"

// A public, synthetic outline with the same failure shape as the reported
// long reply. Never commit the user's transcript or provider response.
const outline = [
  "Reviewed the services. Most work belongs in `admin`.",
  "",
  "## Current services",
  "",
  "| Service | Role | Single account? |",
  "|---|---|---|",
  "| **collector** | Sends records to `scan_queue`. | No. |",
  "| **admin** | Submits `projects` and processes callbacks. | Yes. |",
  "",
  "## Proposed approach",
  "1. **Configure accounts.** Read `AccountId` from configuration.",
  "2. **Separate quotas.** Keep one `daily_count` per account.",
  "",
  "## Questions",
  "- Confirm the quota before enabling `account_2`.",
].join("\n")

function planFor(source: string) {
  const plan = prepareProtectedBatch([{ protectedText: protectText(source), field: "response" }])
  if (!plan) throw new Error("Missing translation plan")
  return plan
}

test("one surviving sentence cannot validate the loss of the rest of an outline", () => {
  const plan = planFor(outline)
  const rows = plan.segments.map((segment, index) => ({ id: segment.id, text: index === 0 ? "工作主要集中在管理服务。" : "" }))
  const parsed = parseSegmentResponse(JSON.stringify(rows), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toBe(undefined)
  expect(parsed.validation.missing > 0).toBe(true)
})

test("large requests present independent fragments without full-answer context or source adjacency", () => {
  const plan = planFor(outline)
  const request = segmentRequest(plan)
  const rows = JSON.parse(request) as { id: number; field: string; text: string }[]
  expect(request).toBe(segmentRequest(plan))
  expect(rows.map(row => row.id)).not.toEqual(plan.segments.map(segment => segment.id))
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(["field", "id", "text"])
    expect(row.text).toBe(plan.segments[row.id]?.text)
  }
  const parsed = parseSegmentResponse(JSON.stringify(rows.map(row => ({ id: row.id, text: row.text }))), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual([outline])
})

test("line breaks, table cells, emphasis and list boundaries stay in the local scaffold", () => {
  const source = "## Overview\r\n\r\n| Service | Role |\r\n|---|---|\r\n| **worker** | Reads `queue`. |\r\n\r\n1. **Next step:** Add accounts.\r\n- Keep quotas."
  const plan = planFor(source)
  const translations: Record<string, string> = {
    Overview: "概述", Service: "服务", Role: "职责", worker: "任务进程",
    Reads: "读取", "Next step:": "下一步：", "Add accounts.": "增加账号。", "Keep quotas.": "保留配额。",
  }
  const rows = plan.segments.map(segment => {
    expect(/[\r\n|*]/.test(segment.text)).toBe(false)
    expect(translations[segment.text]).toBeDefined()
    return { id: segment.id, text: translations[segment.text] }
  }).reverse()
  const parsed = parseSegmentResponse(JSON.stringify(rows), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["## 概述\r\n\r\n| 服务 | 职责 |\r\n|---|---|\r\n| **任务进程** | 读取 `queue`. |\r\n\r\n1. **下一步：** 增加账号。\r\n- 保留配额。"])
})

for (const corrupt of ["", "。", "第一段\n第二段", "单元格 | 其他单元格", "**新增标题**"]) {
  test(`rejects dropped prose or injected structure: ${JSON.stringify(corrupt)}`, () => {
    const plan = planFor("Read `queue` and keep every record.")
    const parsed = parseSegmentResponse(JSON.stringify(plan.segments.map(segment => ({ id: segment.id, text: segment.id === 0 ? "读取" : corrupt }))), plan)
    expect(assembleProtectedBatch(plan, parsed.values)).toBe(undefined)
  })
}

test("empty source gaps stay local instead of allowing prose to migrate around anchors", () => {
  const plan = planFor("`first` and `second`")
  const rows = JSON.parse(segmentRequest(plan)) as { id: number; text: string }[]
  expect(rows.map(row => row.text)).toEqual(["and"])
  const parsed = parseSegmentResponse(JSON.stringify(rows.map(row => ({ id: row.id, text: row.text ? "和" : "" }))), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["`first` 和 `second`"])
})

test("one translated phrase cannot conceal a near-empty summary of a long span", () => {
  const plan = planFor("Collect every creative and preserve callbacks, counters, account ownership, history and import validation before submitting `projects`.")
  const parsed = parseSegmentResponse(JSON.stringify(plan.segments.map((segment, index) => ({ id: segment.id, text: index === 0 ? "提交" : "" }))), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toBe(undefined)
})

test("CJK translations can contract heavily while retaining a complete span", () => {
  const plan = planFor("## Internationalization\nAdministration reads `configuration`.")
  const translations: Record<string, string> = { Internationalization: "国际化", "Administration reads": "管理端读取" }
  const parsed = parseSegmentResponse(JSON.stringify(plan.segments.map(segment => ({ id: segment.id, text: translations[segment.text] ?? "" }))), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["## 国际化\n管理端读取 `configuration`."])
})

test("numbered bold headings, nested lists, escaped pipes and tabs stay local", () => {
  const source = "**1. Configure accounts.**\n    - Read `config`.\n| A \\| B | C |\n\tNext."
  const plan = planFor(source)
  const translations: Record<string, string> = { "Configure accounts.": "配置账号。", Read: "读取", A: "甲", B: "乙", C: "丙", "Next.": "下一步。" }
  const parsed = parseSegmentResponse(JSON.stringify(plan.segments.map(segment => ({ id: segment.id, text: translations[segment.text] }))), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["**1. 配置账号。**\n    - 读取 `config`.\n| 甲 \\| 乙 | 丙 |\n\t下一步。"])
})

for (const backend of ["api", "codex-cli"]) {
  test(`${backend} retains the complete original when a backend returns mostly empty gaps`, { options: { backend, output_trigger: "auto" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "test-token" }))
    let calls = 0
    const corrupt = (input: string) => {
      calls++
      const rows = JSON.parse(input) as { id: number }[]
      return JSON.stringify(rows.map(row => ({ id: row.id, text: row.id === 0 ? "工作主要集中在管理服务。" : "" })))
    }
    on("http.fetch", (_, e) => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: corrupt(JSON.parse(String(e.init?.body)).messages[1].content) } }] }) } }))
    on("process.run", (_, e) => ({ value: { exitCode: 0, stdout: corrupt(e.init?.stdin ?? ""), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }))
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    const row = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: outline, isFirstOfReply: true } })
    await clock.advance(300)
    expect(calls).toBe(2)
    expect(await row.find({ type: "Markdown", text: outline })).toBeDefined()
    expect(await row.find({ type: "Text", text: /TR_SEGMENT_INVALID/ })).toBeDefined()
    await row.redraw({ text: outline, isFirstOfReply: true })
    await clock.advance(300)
    expect(calls).toBe(2)
    await row.unmount()
  })
}
