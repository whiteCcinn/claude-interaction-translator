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

for (const corrupt of ["", "。", "第一段\n第二段", "单元格 | 其他单元格", "**新增标题**", "1. 新增编号"]) {
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

test("English articles separated from inline names cannot fail an otherwise complete CJK translation", () => {
  const source = "Read `entry`. The `records` table stores IDs."
  const fields = [{ protectedText: protectText(source), field: "prose" }]
  for (const target of ["cn", "jp"] as const) {
    const plan = prepareProtectedBatch(fields, { source: "en", target })
    if (!plan) throw new Error("Missing translation plan")
    const rows = JSON.parse(segmentRequest(plan)) as { id: number; text: string }[]
    expect(rows.map(row => row.text)).toEqual(["Read", "table stores IDs."])
    const translations = target === "cn" ? ["读取", "表存储 ID。"] : ["読み取る", "テーブルには ID が格納されます。"]
    const parsed = parseSegmentResponse(JSON.stringify(rows.map(row => ({ id: row.id, text: translations[row.id] }))), plan)
    expect(assembleProtectedBatch(plan, parsed.values)).toEqual([`${translations[0]} \`entry\`. \`records\` ${translations[1]}`])
  }
  const french = prepareProtectedBatch(fields, { source: "en", target: "fr" })
  expect(french?.segments.map(row => row.text)).toContain(". The")
  const unknownSource = prepareProtectedBatch(fields, { source: "auto", target: "cn" })
  expect(unknownSource?.segments.map(row => row.text)).toContain(". The")
})

test("the length guard still rejects loss of the subject before a protected name", () => {
  const plan = planFor("Here are all the records in the `archive`.")
  const parsed = parseSegmentResponse('[{"id":0,"text":"以下是"}]', plan)
  expect(parsed.validation.rejected).toEqual({ short: 1 })
  expect(assembleProtectedBatch(plan, parsed.values)).toBe(undefined)
})

test("prose validation rejects invented ellipses and allows a source ellipsis in another style", () => {
  const plan = planFor("Reason . . . then check `name`.")
  const parse = (text: string) => parseSegmentResponse(JSON.stringify([{ id: 0, text }]), plan)
  expect(assembleProtectedBatch(plan, parse("原因……然后检查").values)).toEqual(["原因……然后检查 `name`."])
  for (const second of ["...", "⋯", "．．．", "。。。", ". . ."]) {
    const result = parse(`原因……然后检查${second}`)
    expect(result.validation.rejected).toEqual({ ellipsis: 1 })
    expect(assembleProtectedBatch(plan, result.values)).toBe(undefined)
  }
})

test("Codex output repairs only invented ellipses beside protected identifiers", { options: { backend: "codex-cli", output_trigger: "auto", output_language: "cn", claude_language: "en" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const source = "- `sample_id` is in `archive` → keep it.\n- `record_id` starts with `test_`."
  let calls = 0
  on("process.run", (_, e) => {
    calls++
    const rows = JSON.parse(e.init?.stdin ?? "") as { id: number; text: string }[]
    const instructions = e.argv.find(argument => argument.startsWith("developer_instructions="))
    if (calls === 1) {
      expect(rows.map(row => row.text)).toEqual(["is in", "→ keep it.", "starts with"])
    } else {
      expect(rows.map(row => row.text)).toEqual(["is in", "starts with"])
      expect(instructions).toContain("remove added ellipses")
    }
    const texts = calls === 1 ? ["位于……中", "→ 保留。", "以...开头"] : ["位于", "", "前缀为"]
    return { value: { exitCode: 0, stdout: JSON.stringify(rows.map(({ id }) => ({ id, text: texts[id] }))), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: source, isFirstOfReply: true } })
  await clock.advance(300)
  expect(calls).toBe(2)
  expect(await ui.find({ type: "Markdown", text: "- `sample_id` 位于 `archive` → 保留。\n- `record_id` 前缀为 `test_`." })).toBeDefined()
  await ui.unmount()
})

test("Codex recovers two repeated edge ellipses in a 50-span output", { options: { backend: "codex-cli", output_trigger: "auto", output_language: "cn", claude_language: "en" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const leadingLines = Array.from({ length: 48 }, (_, index) => `- Check \`item_${index}\`.`)
  const source = [...leadingLines, "- `sample_record` record to `ready`.", "- `sample_result` comes from a local check."].join("\n")
  let calls = 0
  on("process.run", (_, e) => {
    calls++
    const input = e.init?.stdin ?? ""
    const rows = JSON.parse(input) as { id: number; text: string }[]
    expect(rows).toHaveLength(calls === 1 ? 50 : 2)
    if (calls === 2) {
      expect(rows.map(row => row.id)).toEqual([48, 49])
      const instructions = e.argv.find(argument => argument.startsWith("developer_instructions=")) ?? ""
      expect(instructions).toContain("Inline code will be restored immediately before these IDs: 48, 49.")
      expect(instructions).toContain("Inline code will be restored immediately after these IDs: 48.")
      expect(input + instructions).not.toContain("sample_record")
      expect(input + instructions).not.toContain("sample_result")
    }
    const translations = new Map([["record to", "记录设为……"], ["comes from a local check.", ". . . 来自本地检查。"]])
    const result = rows.map(row => ({ id: row.id, text: translations.get(row.text) ?? "检查" }))
    return { value: { exitCode: 0, stdout: JSON.stringify(result), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: source, isFirstOfReply: true } })
  await clock.advance(300)
  expect(calls).toBe(2)
  const translated = [...leadingLines.map(line => line.replace("Check", "检查")), "- `sample_record` 记录设为 `ready`.", "- `sample_result` 来自本地检查。"].join("\n")
  expect(await ui.find({ type: "Markdown", text: translated })).toBeDefined()
  await ui.unmount()
})

test("edge ellipsis recovery still requires a matching inline boundary and valid prose", () => {
  const cases = [
    ["Check all accounts in `archive`.", "检查……中所有账号", "ellipsis"],
    ["Check every archived record in `archive`.", "看……", "ellipsis"],
    ["Check `archive`.", "……", "ellipsis"],
    ["Check `archive`.", "……检查", "ellipsis"],
    ["Check. `archive`", "检查……", "ellipsis"],
    ["Check\n`archive`.", "检查……", "ellipsis"],
    ["Check | `archive`", "检查……", "ellipsis"],
    ["Check **`archive`**.", "检查……", "ellipsis"],
    ["Check ... then read `archive`.", "查看……然后读取……", "ellipsis"],
    ["Check `archive`.", "检查\u0000……", "control"],
    ["Check `archive`.", "**检查**……", "structure"],
    ["`archive` is available.", "……1. 可用", "ellipsis"],
  ] as const
  for (const [source, text, reason] of cases) {
    const plan = planFor(source)
    const parsed = parseSegmentResponse(JSON.stringify([{ id: 0, text }]), plan, [0], new Set([0]))
    expect(parsed.validation.rejected).toEqual({ [reason]: 1 })
    expect(assembleProtectedBatch(plan, parsed.values)).toBe(undefined)
  }
})

test("Codex display translation keeps a stranded article out of the requested prose", { options: { backend: "codex-cli", output_trigger: "auto", output_language: "cn", claude_language: "en" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const source = "Read `entry`. The `records` table stores IDs."
  let calls = 0
  on("process.run", (_, e) => {
    calls++
    const rows = JSON.parse(e.init?.stdin ?? "") as { id: number; text: string }[]
    expect(rows.map(row => row.text)).toEqual(["Read", "table stores IDs."])
    return { value: { exitCode: 0, stdout: '[{"id":0,"text":"读取"},{"id":1,"text":"表存储 ID。"}]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: source, isFirstOfReply: true } })
  await clock.advance(300)
  expect(calls).toBe(1)
  expect(await ui.find({ type: "Markdown", text: "读取 `entry`. `records` 表存储 ID。" })).toBeDefined()
  await ui.unmount()
})

test("numbered bold headings, nested lists, escaped pipes and tabs stay local", () => {
  const source = "**1. Configure accounts.**\n    - Read `config`.\n| A \\| B | C |\n\tNext."
  const plan = planFor(source)
  const translations: Record<string, string> = { "Configure accounts.": "配置账号。", Read: "读取", A: "甲", B: "乙", C: "丙", "Next.": "下一步。" }
  const parsed = parseSegmentResponse(JSON.stringify(plan.segments.map(segment => ({ id: segment.id, text: translations[segment.text] }))), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["**1. 配置账号。**\n    - 读取 `config`.\n| 甲 \\| 乙 | 丙 |\n\t下一步。"])
})

test("numbered Markdown headings and quoted lists keep all consecutive prefixes local", () => {
  const source = "## 1. Setup\n## 2. Request\n## 3. Validation\n## 4. Rotation\n## 5. Limits\n> > ### 12) Notes\n> - Use version 1.2."
  const plan = planFor(source)
  const rows = JSON.parse(segmentRequest(plan)) as { id: number; text: string }[]
  expect(rows.map(row => row.text)).toEqual(["Setup", "Request", "Validation", "Rotation", "Limits", "Notes", "Use version 1.2."])
  const translations = ["设置", "请求", "校验", "轮换", "限制", "说明", "使用 1.2 版。"]
  const parsed = parseSegmentResponse(JSON.stringify(rows.map(({ id }) => ({ id, text: translations[id] }))), plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["## 1. 设置\n## 2. 请求\n## 3. 校验\n## 4. 轮换\n## 5. 限制\n> > ### 12) 说明\n> - 使用 1.2 版。"])
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
