import { expect, mock, test } from "claude-code/testing"
import type { EngineInterface, On, StreamHook, StreamNext, TurnStepChunk, TurnStepResult } from "claude-code"
import { register } from "../hooks/register"

const step = { turnId: "turn-1", index: 0, model: "claude-test", messageCount: 1 }
const stop: TurnStepChunk = { kind: "stop", stopReason: "end_turn", usage: null }

async function collect<R>(stream: AsyncGenerator<TurnStepChunk, R>) {
  const chunks: TurnStepChunk[] = []
  while (true) {
    const item = await stream.next()
    if (item.done) return { chunks, result: item.value, text: chunks.filter(chunk => chunk.kind === "text").map(chunk => chunk.text).join("") }
    chunks.push(item.value)
  }
}

test("default inbound route declares Chinese source and English Claude replies", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.messages[0].content).toContain("source language is Simplified Chinese")
    expect(request.messages[0].content).toContain("natural English")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Hello." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }))
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  expect(result.text).toBe("Hello.")
  expect(result.context?.[0]).toContain("Reply in natural English")
})

test("input, prompt, and Claude reply languages are independent", { options: { output_mode: "conversation", input_language: "jp", language: "en", claude_language: "fr", output_language: "cn" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.messages[0].content).toContain("source language is Japanese")
    expect(request.messages[0].content).toContain("natural English")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Hello." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }))
  const result = await $.prompt.submit({ text: "こんにちは", origin: { kind: "sdk" }, wait: false })
  expect(result.text).toBe("Hello.")
  expect(result.context?.[0]).toContain("Reply in natural French")
})

test("default output translates English replies into Chinese", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.messages[0].content).toContain("assistant response")
    expect(request.messages[0].content).toContain("natural Simplified Chinese")
    expect(request.max_tokens).toBe(8192)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "你好。" } }] }) } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Hello." }
    yield stop
    return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toBe("你好。")
  expect(result.result.answer).toBe("你好。")
})

test("Codex output translation restores code split across response chunks", { options: { output_mode: "conversation", backend: "codex-cli" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", (_, e) => {
    expect(e.argv.join(" ")).toContain("assistant response")
    expect(e.init?.stdin).toContain("__GLM_KEEP_0__")
    expect(e.init?.stdin?.includes("demo.go")).toBe(false)
    return { value: { exitCode: 0, stdout: "查看 __GLM_KEEP_0__。\n__GLM_KEEP_1__", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "See `/tmp/de" }
    yield { kind: "text", index: 0, text: "mo.go`.\n```go\nfmt.Println(\"hi\")\n```" }
    yield stop
    return { ...e, answer: 'See `/tmp/demo.go`.\n```go\nfmt.Println("hi")\n```', toolUses: [], stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toBe('查看 `/tmp/demo.go`。\n```go\nfmt.Println("hi")\n```')
  expect(result.chunks.filter(chunk => chunk.kind === "text").length).toBe(2)
})

test("output translation preserves tools, thinking, engine references and usage", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const protocol: TurnStepChunk[] = [
    { kind: "tool", index: 1, id: "tool-1", name: "Read" },
    { kind: "input", index: 1, json: '{"file_path":"/tmp/demo.go"}' },
    { kind: "thinking", index: 2, text: "unchanged thinking" },
  ]
  const tools = [{ name: "Read", input: { file_path: "/tmp/demo.go" } }]
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "第一段。__GLM_KEEP_0__第二段。" } }] }) } }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "First." }
    for (const chunk of protocol) yield chunk
    yield { kind: "text", index: 3, text: "Second." }
    yield stop
    return { ...e, answer: "First.Second.", toolUses: tools, stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toBe("第一段。第二段。")
  expect(result.chunks.filter(chunk => chunk.kind !== "text" && chunk.kind !== "stop")).toEqual(protocol)
  expect(result.result.toolUses).toEqual(tools)
  expect(result.chunks[0]).toEqual({ kind: "text", index: 0, text: "第一段。" })
})

test("response headings are translated without applying input command bypass", { options: { output_mode: "conversation", output_language: "jp" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.messages[0].content).toContain("natural Japanese")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "# 結果\n完了しました。" } }] }) } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "# Result\nDone." }
    yield stop
    return { ...e, answer: "# Result\nDone.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  expect((await collect($.turn.step(step))).text).toBe("# 結果\n完了しました。")
})

test("failed output translation shows one error without leaking original text", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "missing path marker" } }] }) } }))
  let calls = 0
  on("turn.step", async function* (_, e) {
    calls += 1
    yield { kind: "text", index: 0, text: "Secret source /tmp/demo.go" }
    yield stop
    return { ...e, answer: "Secret source /tmp/demo.go", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toContain("输出翻译失败")
  expect(result.text.includes("Secret source")).toBe(false)
  expect(calls).toBe(1)
})

test("same-language output and subagents pass without calling a translator", { options: { output_mode: "conversation", claude_language: "fr", output_language: "fr" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Bonjour." }
    yield stop
    return { ...e, answer: "Bonjour.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  expect((await collect($.turn.step(step))).text).toBe("Bonjour.")
  expect((await collect($.turn.step({ ...step, agentId: "agent-1" }))).text).toBe("Bonjour.")
})

test("tool-only responses do not invoke output translation", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const tool: TurnStepChunk = { kind: "tool", index: 0, id: "call-1", name: "Read" }
  on("turn.step", async function* (_, e) {
    yield tool
    yield { kind: "stop", stopReason: "tool_use", usage: null }
    return { ...e, answer: "", toolUses: [{ name: "Read", input: {} }], stopReason: "tool_use", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toBe("")
  expect(result.chunks[0]).toEqual(tool)
})

test("retry response indices do not merge failed and successful attempts", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.messages[1].content).toBe("Complete response.")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "完整回复。" } }] }) } }
  })
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Failed prefix" }
    yield { kind: "thinking", index: 1, text: "retry boundary" }
    yield { kind: "text", index: 0, text: "Complete response." }
    yield stop
    return { ...e, answer: "Complete response.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toBe("完整回复。")
  expect(result.chunks[1]).toEqual({ kind: "thinking", index: 1, text: "retry boundary" })
})

test("oversized response buffering fails explicitly while preserving protocol chunks", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const tool: TurnStepChunk = { kind: "tool", index: 1, id: "call-1", name: "Read" }
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "x".repeat(262145) }
    yield tool
    yield stop
    return { ...e, answer: "oversized", toolUses: [{ name: "Read", input: {} }], stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text.length < 300).toBe(true)
  expect(result.text).toContain("输出翻译失败")
  expect(result.chunks[1]).toEqual(tool)
})

test("subagent responses bypass translation even when output differs", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Agent report." }
    yield stop
    return { ...e, answer: "Agent report.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  expect((await collect($.turn.step({ ...step, agentId: "agent-1" }))).text).toBe("Agent report.")
})

test("same-as-claude output inherits a legacy prompt language without translation", { options: { output_mode: "conversation", language: "jp", output_language: "same-as-claude" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "こんにちは。" }
    yield stop
    return { ...e, answer: "こんにちは。", toolUses: [], stopReason: "end_turn", usage: null }
  })
  expect((await collect($.turn.step(step))).text).toBe("こんにちは。")
})

test("output token truncation shows an error instead of partial translation", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "不完整译文" } }] }) } }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Original response." }
    yield stop
    return { ...e, answer: "Original response.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toContain("输出翻译失败")
  expect(result.text.includes("不完整译文")).toBe(false)
})

test("parallel responses keep their source text and translations separate", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", async (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    const first = request.messages[1].content === "First response."
    await clock.sleep(first ? 100 : 50)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: first ? "第一条回复。" : "第二条回复。" } }] }) } }
  })
  on("turn.step", async function* (_, e) {
    const text = e.turnId === "first" ? "First response." : "Second response."
    yield { kind: "text", index: 0, text }
    yield stop
    return { ...e, answer: text, toolUses: [], stopReason: "end_turn", usage: null }
  })
  const first = collect($.turn.step({ ...step, turnId: "first" }))
  const second = collect($.turn.step({ ...step, turnId: "second" }))
  await clock.settle()
  await clock.advance(100)
  expect((await first).text).toBe("第一条回复。")
  expect((await second).text).toBe("第二条回复。")
})

test("an interrupted model stream is not requested again by the catch handler", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("turn.step", async function* () {
    calls += 1
    yield { kind: "text", index: 0, text: "Partial original response." }
    throw new Error("Model stream interrupted")
  })
  const result = await collect($.turn.step(step))
  expect(result.text).toContain("输出翻译失败")
  expect(result.text.includes("Partial original response.")).toBe(false)
  expect(calls).toBe(1)
})

test("translation failure is placed in the completed retry attempt", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", () => ({ value: { ok: false, status: 500, headers: {}, text: "" } }))
  on("turn.step", async function* (_, e) {
    yield { kind: "text", index: 0, text: "Partial" }
    yield { kind: "thinking", index: 1, text: "retry boundary" }
    yield { kind: "text", index: 0, text: "Completed response." }
    yield stop
    return { ...e, answer: "Completed response.", toolUses: [], stopReason: "end_turn", usage: null }
  })
  const result = await collect($.turn.step(step))
  expect(result.chunks[0]).toEqual({ kind: "text", index: 0, text: "" })
  const final = result.chunks[2]
  expect(final?.kind === "text" && final.text.includes("输出翻译失败")).toBe(true)
})

test("cancellation while reading credentials prevents the outgoing HTTP request", { options: { output_mode: "conversation" } }, async () => {
  let handler: StreamHook<"turn.step"> | undefined
  const on = ((name: string, ...args: unknown[]) => {
    if (name === "turn.step") handler = args.at(-1) as StreamHook<"turn.step">
    return { catch() {} }
  }) as unknown as On
  register(on, { output_mode: "conversation" })
  const cancellation = new AbortController()
  let httpCalls = 0
  const engine = {
    plugin: { name: "interaction-translator", root: "/tmp/translator" },
    config: { list: async () => [] },
    env: { get: async () => { cancellation.abort(); return "example-token" } },
    http: { fetch: async () => {
      httpCalls += 1
      return { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "你好。" } }] }) }
    } },
  } as unknown as EngineInterface
  const response: TurnStepResult = { turnId: step.turnId, index: step.index, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
  const next = Object.assign(() => {
    const stream = (async function* () {
      yield { kind: "text", index: 0, text: "Hello." } as TurnStepChunk
      yield stop
      return response
    })()
    return Object.assign(stream, { result: Promise.resolve(response) })
  }, { signal: cancellation.signal }) as unknown as StreamNext<"turn.step">
  if (!handler) throw new Error("Missing output handler")
  const result = await collect(handler(engine, step, next))
  expect(httpCalls).toBe(0)
  expect(result.text).toBe("")
})

test("an oversized interrupted stream is not promoted into a completed tool response", { options: { output_mode: "conversation" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("turn.step", async function* () {
    calls += 1
    yield { kind: "text", index: 0, text: "x".repeat(262145) }
    yield { kind: "tool", index: 1, id: "call-1", name: "Bash" }
    yield { kind: "input", index: 1, json: '{"command":"echo must-not-run"}' }
    throw new Error("Model stream interrupted")
  })
  const chunks: TurnStepChunk[] = []
  let failed = false
  try { for await (const chunk of $.turn.step(step)) chunks.push(chunk) } catch { failed = true }
  expect(failed).toBe(true)
  expect(chunks.some(chunk => chunk.kind === "stop" && chunk.stopReason === "end_turn")).toBe(false)
  expect(calls).toBe(1)
})

for (const subagent of [true, false]) {
  test(`interrupted passthrough streams keep failure status (subagent=${subagent})`, { options: subagent ? {} : { output_language: "same-as-claude" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    let calls = 0
    on("turn.step", async function* () {
      calls += 1
      yield { kind: "tool", index: 0, id: "partial-call", name: "Read" }
      throw new Error("Interrupted passthrough stream")
    })
    const chunks: TurnStepChunk[] = []
    let failed = false
    try {
      for await (const chunk of $.turn.step({ ...step, ...(subagent ? { agentId: "agent-1" } : {}) })) chunks.push(chunk)
    } catch { failed = true }
    expect(failed).toBe(true)
    expect(chunks.some(chunk => chunk.kind === "stop")).toBe(false)
    expect(calls).toBe(1)
  })
}
