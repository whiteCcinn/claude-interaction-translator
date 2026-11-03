import { expect, mock, test } from "claude-code/testing"
import { prepareInput, takePreparedInput, discardPreparedInput, MAX_PREPARED_INPUTS, MAX_PREPARED_BYTES } from "../hooks/input-history"
import type { EngineInterface } from "claude-code"

function stateEngine() {
  let value: unknown
  let version = 0
  return { state: {
    get: async () => ({ value, version }),
    set: async (_: unknown, next: unknown, options?: { ifVersion?: number }) => {
      if (options?.ifVersion !== undefined && options.ifVersion !== version) return { isSet: false, version }
      value = JSON.parse(JSON.stringify(next))
      return { isSet: true, version: ++version }
    },
  } } as unknown as EngineInterface
}

test("composer history keeps the exact original while the model row receives the translation", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "test-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Change the button." } }] }) } }))
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  const source = "修改按钮。"
  const accepted = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
  expect(accepted.text).toBe(source)
  expect(accepted.context?.[0]).toContain("Reply in natural English")
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "user-1", message: { type: "user", role: "user", content: [{ type: "text", text: source }] } })
  expect(row.message?.content).toEqual([{ type: "text", text: "Change the button." }])
})

test("composer metadata and rendered commands bypass history preparation", async ($, on) => {
  mock.clock(on)
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const source = "rendered command or metadata"
  for (const extra of [{ isMeta: true as const }, { command: { name: "example", args: "" } }]) {
    const accepted = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false, ...extra })
    expect(accepted.text).toBe(source)
  }
})

test("repeated pending source uses one translation even when generation differs", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "test-token" }))
  let calls = 0
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: ++calls === 1 ? "First wording." : "Second wording." } }] }) } }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  for (let i = 0; i < 2; i++) await $.prompt.submit({ text: "同一原文", origin: { kind: "composer" }, wait: true })
  for (let i = 0; i < 2; i++) {
    const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: `repeat-${i}`, message: { type: "user", content: [{ type: "text", text: "同一原文" }] } })
    expect(row.message?.content).toEqual([{ type: "text", text: "First wording." }])
  }
})

test("expanded text blocks are matched as a complete prompt without merging unrelated context", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "test-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Two paragraphs." } }] }) } }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  await $.prompt.submit({ text: "第一段\n第二段", origin: { kind: "composer" }, wait: false })
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "expanded-row", message: { type: "user", content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] } })
  // The native append validator removes empty text blocks.
  expect(row.message?.content).toEqual([{ type: "text", text: "Two paragraphs." }])
})

test("an unmatched accepted prompt fails visibly without forwarding source text", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "test-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Translated prompt." } }] }) } }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  await $.prompt.submit({ text: "原始正文", origin: { kind: "composer" }, wait: false })
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "mismatched-row", message: { type: "user", content: [{ type: "text", text: "宿主改变后的原始正文" }] } })
  expect(JSON.stringify(row.message?.content).includes("原始正文")).toBe(false)
  expect(JSON.stringify(row.message?.content)).toContain("translation")
})

test("bounded pending state survives a new consumer and refuses target conflicts", async () => {
  const engine = stateEngine()
  const first = await prepareInput(engine, "原文", "First.", "en")
  expect(first?.translated).toBe("First.")
  expect(await prepareInput(engine, "原文", "日本語", "jp")).toBe(undefined)
  const claimed = await takePreparedInput(engine, ["原文"], "row-1")
  expect(claimed?.translated).toBe("First.")
  expect((await takePreparedInput(engine, ["原文"], "row-1"))?.id).toBe(claimed?.id)
  expect(await takePreparedInput(engine, ["另一段正文"], "row-1")).toBe(undefined)
  expect(await takePreparedInput(engine, ["原文"], "row-2")).toBe(undefined)
  if (first) await discardPreparedInput(engine, first.id)
  for (let i = 0; i < MAX_PREPARED_INPUTS; i++) expect((await prepareInput(engine, `原文${i}`, `English ${i}.`, "en"))?.id).toBeDefined()
  expect(await prepareInput(engine, "overflow", "English.", "en")).toBe(undefined)
})

test("pending state refuses oversized data before it can be accepted", async () => {
  expect(await prepareInput(stateEngine(), "x".repeat(MAX_PREPARED_BYTES), "English.", "en")).toBe(undefined)
})

for (const failure of ["read", "feedback", "cleanup"]) {
  test(`append ${failure} failure cannot undo translation or forward source`, async ($, on) => {
    mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("env.get", () => ({ value: "test-token" }))
    on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Translated prompt." } }] }) } }))
    on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
    let fail = false
    on("state.get", { plugin: "interaction-translator" }, (_, e, next) => fail && failure === "read" ? { deny: "state read unavailable" } : next(e))
    on("state.set", { plugin: "interaction-translator" }, (_, e, next) => fail && failure === "cleanup" && e.value.pending.length === 0 ? { deny: "state cleanup unavailable" } : next(e))
    on("clock.now", {}, (_, e, next) => fail && failure === "feedback" ? { deny: "clock unavailable" } : next(e))
    const source = "原始正文"
    await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
    fail = true
    const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: `failed-${failure}`, message: { type: "user", content: [{ type: "text", text: failure === "feedback" ? "结构改变后的原始正文" : source }] } })
    expect(JSON.stringify(row.message?.content).includes(source)).toBe(false)
    expect(JSON.stringify(row.message?.content)).toContain(failure === "cleanup" ? "Translated prompt." : "translation")
  })
}

test("queued originals with identical translations retain separate native history text", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "test-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Change the button." } }] }) } }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const sources = ["修改按钮。", "请改一下按钮。"]
  for (const source of sources) {
    const accepted = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: true, turnId: "running-turn" })
    expect(accepted.text).toBe(source)
  }
  for (const [i, source] of sources.entries()) {
    const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: `queued-${i}`, message: { type: "user", content: [{ type: "text", text: source }] } })
    expect(row.message?.content).toEqual([{ type: "text", text: "Change the button." }])
  }
})

test("append replacement preserves other text, media, provenance and subagents", async ($, on) => {
  mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "test-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Describe the image." } }] }) } }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const source = "描述图片。"
  await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
  const content = [{ type: "text" as const, text: source }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "fixture" } }, { type: "text" as const, text: "Other context." }]
  const child = await $.session.append({ door: "prompt", origin: { kind: "composer" }, agentId: "child", uuid: "child-row", message: { type: "user", content } })
  expect(child.message?.content).toEqual(content)
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "image-row", message: { type: "user", role: "user", content } })
  expect(row.uuid).toBe("image-row")
  expect(row.message?.role).toBe("user")
  expect(row.message?.content).toEqual([{ type: "text", text: "Describe the image." }, ...content.slice(1)])
})
