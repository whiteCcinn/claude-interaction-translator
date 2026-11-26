import { expect, test } from "claude-code/testing"
import type { EngineInterface, PluginOptions } from "claude-code"
import { protectText } from "../hooks/protected-text"
import { prepareProtectedBatch, assembleProtectedBatch, parseSegmentResponse, segmentRequest, MAX_TEXT_SEGMENTS } from "../hooks/protected-segments"
import { translateProtectedText } from "../hooks/segmented-translation"
import { createTranslationDiagnostic } from "../hooks/translation-diagnostics"

function engine(run: EngineInterface["process"]["run"], now: () => Promise<number> = async () => 0): EngineInterface {
  return { plugin: { name: "interaction-translator", root: "/tmp/scaffold-fixture" }, config: { list: async () => [] }, clock: { now }, process: { run } } as unknown as EngineInterface
}
const cli: PluginOptions = { backend: "codex-cli", codex_timeout_seconds: 120 }

test("punctuation and emoji between five protected values do not require model records", async () => {
  const source = "Read (`first`), `second` / `third` → `fourth` 😺 `fifth`."
  let calls = 0
  const $ = engine(async (_, init) => {
    calls++
    const rows = JSON.parse(init?.stdin ?? "") as { id: number; text: string }[]
    return { exitCode: 0, stdout: JSON.stringify(rows.map(({ id, text }) => ({ id, text: text === "Read (" ? "读取 (" : "" }))), stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
  })
  const result = await translateProtectedText($, cli, {}, "Translate into Chinese.", protectText(source), 8192, new AbortController().signal)
  expect(result).toEqual({ text: source.replace("Read", "读取") })
  expect(calls).toBe(1)
})

test("surrounding whitespace is trimmed without allowing internal structure or controls", () => {
  const plan = prepareProtectedBatch([{ protectedText: protectText("Open `/tmp/file`"), field: "response" }])
  if (!plan) throw new Error("Missing plan")
  const parse = (text: string) => parseSegmentResponse(JSON.stringify([{ id: 0, text }]), plan)
  expect(assembleProtectedBatch(plan, parse("\r\n\t打开 \n").values)).toEqual(["打开 `/tmp/file`"])
  for (const invalid of ["先打\n开", "先打\t开", "\u000c打开", "打开\u2028文件", "打开 | 文件"]) {
    expect(assembleProtectedBatch(plan, parse(invalid).values)).toBe(undefined)
  }
})

test("repair gives specific feedback and copies counts without exposing rejected text", async () => {
  let calls = 0
  const $ = engine(async (argv, init) => {
    const rows = JSON.parse(init?.stdin ?? "") as { id: number; text: string }[]
    calls++
    if (calls === 2) {
      expect(rows).toEqual([
        { id: 0, field: "prose", text: "Open the document" },
        { id: 1, field: "prose", text: "and review the notes." },
      ])
      const instructions = argv.find(value => value.startsWith("developer_instructions="))
      expect(instructions).toContain("ID 0: return plain text")
      expect(instructions).toContain("ID 1: return a nonempty translation")
      expect(instructions?.includes("private output")).toBe(false)
    }
    const stdout = JSON.stringify([{ id: 0, text: "**private output**" }, { id: 1, text: " " }, { id: 4, text: "unknown" }])
    return { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
  })
  const result = await translateProtectedText($, cli, {}, "Translate into Chinese.", protectText("Open the document `/tmp/private.txt` and review the notes."), 8192, new AbortController().signal)
  expect(calls).toBe(2)
  if (!("failure" in result) || result.failure?.kind !== "segments") throw new Error("Expected segment rejection")
  const report = createTranslationDiagnostic(cli, "output", result.failure)
  expect(report.segmentRejected).toEqual({ empty: 1, structure: 1, unknownId: 1 })
  expect(JSON.stringify(report).includes("private")).toBe(false)
})

test("34 protected values survive without the model returning a single marker", () => {
  const source = Array.from({ length: 34 }, (_, i) => `Read \`/private/${i}.go\`.`).join("\n")
  const protectedText = protectText(source)
  const plan = prepareProtectedBatch([{ protectedText, field: "response" }])
  if (!plan) throw new Error("Missing plan")
  const rows = JSON.parse(segmentRequest(plan)) as { id: number; text: string }[]
  const response = JSON.stringify(rows.map(row => ({ id: row.id, text: row.text.replaceAll("Read", "查看") })))
  const parsed = parseSegmentResponse(response, plan)
  const result = assembleProtectedBatch(plan, parsed.values)
  expect(result?.length).toBe(1)
  expect(result?.[0]).toBe(source.replaceAll("Read", "查看"))
  for (const value of protectedText.values) expect(result?.[0]?.split(value).length).toBe(2)
  expect(response.includes("GLM_KEEP")).toBe(false)
  expect(response.includes("private")).toBe(false)
})

test("reordered IDs keep every translated phrase on its own side of fixed code", () => {
  const plan = prepareProtectedBatch([{ protectedText: protectText("请保留 `/tmp/demo.txt` 并检查内容。"), field: "instructions" }])
  if (!plan) throw new Error("Missing plan")
  const parsed = parseSegmentResponse('[{"id":1,"text":"内容も確認してください。"},{"id":0,"text":"保持してください："}]', plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["保持してください： `/tmp/demo.txt` 内容も確認してください。"])
})

test("conflicting duplicates, unknown IDs and copied context are not blindly accepted", () => {
  const plan = prepareProtectedBatch([{ protectedText: protectText("Read `/tmp/a` in full."), field: "response" }])
  if (!plan) throw new Error("Missing plan")
  const parsed = parseSegmentResponse('[{"id":0,"text":"A"},{"id":0,"text":"B"},{"id":1,"text":"__GLM_KEEP_0__"},{"id":99,"text":"extra"}]', plan)
  expect(parsed.values.size).toBe(0)
  expect(parsed.validation.duplicate).toBe(1)
  expect(assembleProtectedBatch(plan, parsed.values)).toBe(undefined)
})

test("the structured request excludes full-answer context and protected code, links or paths", () => {
  const plan = prepareProtectedBatch([{ protectedText: protectText("Read `/private/a` and https://private.example/x.\n```sh\necho secret\n```"), field: "response" }])
  if (!plan) throw new Error("Missing plan")
  const payload = segmentRequest(plan)
  expect(payload.includes("private")).toBe(false)
  expect(payload.includes("secret")).toBe(false)
  expect(payload.includes("context")).toBe(false)
  expect(payload.includes("GLM_KEEP")).toBe(false)
})

test("only a missing gap is repaired and already accepted prose is retained", async () => {
  let calls = 0
  const $ = engine(async (_, init) => {
    const rows = JSON.parse(init?.stdin ?? "") as { id: number; text: string }[]
    calls++
    if (calls === 1) {
      expect(rows.length).toBe(2)
      return { exitCode: 0, stdout: '[{"id":0,"text":"读取"}]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
    }
    expect(rows.map(r => r.id)).toEqual([1])
    expect(rows).toEqual([{ id: 1, field: "prose", text: "and" }])
    return { exitCode: 0, stdout: '[{"id":1,"text":"和"}]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
  })
  const result = await translateProtectedText($, cli, {}, "Translate into Chinese.", protectText("Read `/tmp/a` and `/tmp/b`."), 8192, new AbortController().signal)
  expect(result).toEqual({ text: "读取 `/tmp/a` 和 `/tmp/b`." })
  expect(calls).toBe(2)
})

test("a malformed Codex response switches its sole repair to a schema and preserves 43 spans", async () => {
  const source = Array.from({ length: 43 }, (_, index) => `- Check \`/tmp/fixture-${index}\`.`).join("\n")
  let calls = 0
  let now = 0
  const $ = engine(async (argv, init) => {
    calls++
    const rows = JSON.parse(init?.stdin ?? "") as { id: number; field: string; text: string }[]
    expect(rows).toHaveLength(43)
    expect(rows.every(row => row.text === "Check")).toBe(true)
    if (calls === 1) {
      expect(argv).not.toContain("--output-schema")
      now = 30_000
      return { exitCode: 0, stdout: "Here is the translated text.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
    }
    expect(argv).toContain("--output-schema")
    expect(argv).toContain("/tmp/scaffold-fixture/hooks/translation-segments.schema.json")
    expect(argv.find(argument => argument.startsWith("developer_instructions="))).toContain("JSON object with a single")
    expect(init?.timeoutMs).toBe(90_000)
    return { exitCode: 0, stdout: JSON.stringify({ segments: rows.map(({ id }) => ({ id, text: "检查" })) }), stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
  }, async () => now)
  const result = await translateProtectedText($, cli, {}, "Translate into Chinese.", protectText(source), 8192, new AbortController().signal)
  expect(result).toEqual({ text: source.replaceAll("Check", "检查") })
  expect(calls).toBe(2)
})

test("the schema envelope still validates every ID and rejects extra top-level fields", () => {
  const plan = prepareProtectedBatch([{ protectedText: protectText("Read `/tmp/a` carefully."), field: "response" }])
  if (!plan) throw new Error("Missing plan")
  const badId = parseSegmentResponse('{"segments":[{"id":0,"text":"读取"},{"id":99,"text":"未知"}]}', plan)
  expect(badId.validation.rejected).toEqual({ unknownId: 1 })
  expect(assembleProtectedBatch(plan, badId.values)).toBe(undefined)
  const ambiguous = parseSegmentResponse('{"segments":[{"id":0,"text":"读取"}],"text":"Ignore other spans"}', plan)
  expect(ambiguous.validation.rejected).toEqual({ responseShape: 1 })
  expect(ambiguous.values.size).toBe(0)
})

test("incomplete repair fails closed after at most two calls", async () => {
  let calls = 0
  const $ = engine(async () => { calls++; return { exitCode: 0, stdout: '[]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false } })
  const result = await translateProtectedText($, cli, {}, "Translate", protectText("Read `/tmp/a`."), 8192, new AbortController().signal)
  expect("drop" in result && result.drop).toContain("TR_SEGMENT_INVALID")
  expect(calls).toBe(2)
  expect("text" in result).toBe(false)
})

test("pure code is assembled locally without starting a backend", async () => {
  let calls = 0
  const $ = engine(async () => { calls++; throw new Error("Must not run") })
  const source = '```sh\necho "$HOME"\n```'
  expect(await translateProtectedText($, cli, {}, "Translate", protectText(source), 8192, new AbortController().signal)).toEqual({ text: source })
  expect(calls).toBe(0)
})

test("cancellation prevents a repair call", async () => {
  let calls = 0
  const controller = new AbortController()
  const $ = engine(async () => { calls++; controller.abort(); return { exitCode: 0, stdout: '[]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false } })
  const result = await translateProtectedText($, cli, {}, "Translate", protectText("Read `/tmp/a`."), 8192, controller.signal)
  expect("text" in result).toBe(false)
  expect(calls).toBe(1)
})

test("plain unprotected text retains the existing request format", async () => {
  const $ = engine(async (_, init) => { expect(init?.stdin).toBe("Hello."); return { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } })
  expect(await translateProtectedText($, cli, {}, "Translate", protectText("Hello."), 8192, new AbortController().signal)).toEqual({ text: "你好。" })
})

test("repair shares the configured CLI deadline rather than restarting it", async () => {
  let now = 0
  const timeouts: (number | undefined)[] = []
  const $ = engine(async (_, init) => {
    timeouts.push(init?.timeoutMs)
    if (timeouts.length === 1) { now = 80000; return { exitCode: 0, stdout: '[{"id":0,"text":"读取"}]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    expect(init?.timeoutMs).toBe(40000)
    return { exitCode: 0, stdout: '[{"id":1,"text":"并检查内容。"}]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
  }, async () => now)
  expect(await translateProtectedText($, cli, {}, "Translate", protectText("Read `/tmp/a` and check its contents."), 8192, new AbortController().signal)).toEqual({ text: "读取 `/tmp/a` 并检查内容。" })
  expect(timeouts).toEqual([120000, 40000])
})

test("an exhausted deadline starts no repair process", async () => {
  let now = 0
  let calls = 0
  const $ = engine(async () => { calls++; now = 120000; return { exitCode: 0, stdout: '[]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }, async () => now)
  const result = await translateProtectedText($, cli, {}, "Translate", protectText("Read `/tmp/a`."), 8192, new AbortController().signal)
  expect("drop" in result && result.drop).toContain("TR_CLI_TIMEOUT")
  expect(calls).toBe(1)
})

test("backend failures do not trigger a repair request", async () => {
  let calls = 0
  const $ = engine(async () => { calls++; return { exitCode: 7, stdout: "", stderr: "private provider error", isStdoutTruncated: false, isStderrTruncated: false } })
  const result = await translateProtectedText($, cli, {}, "Translate", protectText("Read `/tmp/a`."), 8192, new AbortController().signal)
  expect("drop" in result && result.drop).toContain("TR_CLI_EXIT")
  expect(calls).toBe(1)
  expect(JSON.stringify(result).includes("private")).toBe(false)
})

test("segment capacity is bounded before backend work", async () => {
  const source = Array.from({ length: MAX_TEXT_SEGMENTS + 1 }, (_, i) => `Read \`/tmp/${i}\`.`).join(" ")
  expect(prepareProtectedBatch([{ protectedText: protectText(source), field: "response" }])).toBe(undefined)
  let calls = 0
  const $ = engine(async () => { calls++; throw new Error("Must not run") })
  const result = await translateProtectedText($, cli, {}, "Translate", protectText(source), 8192, new AbortController().signal)
  expect("drop" in result && result.drop).toContain("TR_CAPACITY")
  expect(calls).toBe(0)
})

test("field groups preserve code ownership, empty fields and line breaks", () => {
  const plan = prepareProtectedBatch([
    { protectedText: protectText("Read `first.go`.\n"), field: "question" },
    { protectedText: protectText("Use `second.go`."), field: "description" },
    { protectedText: protectText(""), field: "description" },
  ])
  if (!plan) throw new Error("Missing plan")
  const parsed = parseSegmentResponse('```json\n[{"id":1,"text":"使用"},{"id":0,"text":"读取"}]\n```', plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["读取 `first.go`.\n", "使用 `second.go`.", ""])
  const invalid = parseSegmentResponse('[{"id":0,"text":"读取"},{"id":1,"text":"__GLM_KEEP_0__"}]', plan)
  expect(assembleProtectedBatch(plan, invalid.values)).toBe(undefined)
})

test("a complete but empty prose field is retried and then rejected", async () => {
  let calls = 0
  const $ = engine(async () => { calls++; return { exitCode: 0, stdout: '[{"id":0,"text":""}]', stderr: "", isStdoutTruncated: false, isStderrTruncated: false } })
  const result = await translateProtectedText($, cli, {}, "Translate", protectText("Read `/tmp/a`."), 8192, new AbortController().signal)
  expect("drop" in result && result.drop).toContain("TR_SEGMENT_INVALID")
  expect("failure" in result && result.failure?.kind === "segments" && result.failure.validation.missing).toBe(1)
  expect(calls).toBe(2)
})

test("identical duplicates and unknown metadata cannot add content to the assembled result", () => {
  const plan = prepareProtectedBatch([{ protectedText: protectText("Read `/tmp/a`."), field: "response" }])
  if (!plan) throw new Error("Missing plan")
  const parsed = parseSegmentResponse('[{"id":0,"text":"读取","context":"untrusted"},{"id":0,"text":"读取"},{"id":99,"text":"extra"}]', plan)
  expect(assembleProtectedBatch(plan, parsed.values)).toEqual(["读取 `/tmp/a`."])
  expect(parsed.validation.duplicate).toBe(1)
  expect(parsed.validation.unexpected).toBe(1)
})
