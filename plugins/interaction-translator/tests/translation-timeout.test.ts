import { expect, mock, test } from "claude-code/testing"
import type { EngineInterface } from "claude-code"
import { resolveConfiguration } from "../hooks/configuration"
import { mountFreshDisplay } from "./display-fixtures"
import { createDisplayState, displayEntry, translateDisplay } from "../hooks/display-translation"
import { requestTranslation } from "../hooks/translation-client"
import { translationFailureHint } from "../hooks/translation-errors"

// Like the dialog tests, direct shaping/lifecycle tests use a minimal host.
function translationEngine(run: EngineInterface["process"]["run"]): EngineInterface {
  return {
    plugin: { name: "interaction-translator", root: "/tmp/translation-timeout-fixture" },
    config: { list: async () => [] }, clock: { now: async () => 0 }, process: { run }, ui: { invalidate() {} },
  } as unknown as EngineInterface
}

test("CLI timeout defaults to 120 seconds and accepts the host boundaries", () => {
  for (const seconds of [undefined, 1, 300, 600]) {
    const result = resolveConfiguration({ backend: "codex-cli", ...(seconds === undefined ? {} : { codex_timeout_seconds: seconds }) })
    expect("value" in result && result.value.codex_timeout_seconds).toBe(seconds ?? 120)
  }
})

for (const seconds of [0, -1, 1.5, 601, NaN, Infinity, "300", "", true]) {
  test(`rejects invalid CLI timeout ${String(seconds)} before translation`, () => {
    const result = resolveConfiguration({ backend: "codex-cli", codex_timeout_seconds: seconds })
    expect("drop" in result && result.drop).toContain("1–600")
    expect("value" in resolveConfiguration({ backend: "api", codex_timeout_seconds: seconds })).toBe(true)
  })
}

for (const seconds of [1, 300, 600]) {
  test(`CLI input passes ${seconds} seconds to the native process runner`, { options: { backend: "codex-cli", codex_timeout_seconds: seconds } }, async ($, on) => {
    on("config.list", () => ({ value: [] }))
    on("process.run", (_, e) => {
      expect(e.init?.timeoutMs).toBe(seconds * 1000)
      return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("prompt.submit", (_, e) => ({ text: e.text }))
    expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
  })
}

test("an early process startup failure does not claim a timeout or expose its exception", { options: { backend: "codex-cli", codex_timeout_seconds: 300 } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("process.run", () => { throw new Error("private startup diagnostics") })
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  expect(result.drop).toContain("could not start or finish")
  expect(result.drop?.includes("seconds")).toBe(false)
  expect(result.drop?.includes("private")).toBe(false)
})

test("a CLI deadline reports its configured seconds on input", { options: { backend: "codex-cli", codex_timeout_seconds: 300 } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("process.run", async () => {
    await clock.sleep(300000)
    throw new Error("private timeout diagnostics")
  })
  const pending = $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  await clock.settle()
  await clock.advance(300000)
  const result = await pending
  expect(result.drop).toContain("300 seconds")
  expect(result.drop?.includes("private")).toBe(false)
  expect(result.text).toBe(undefined)
})

test("an extended CLI deadline accepts a translation taking longer than the old 120-second limit", { options: { backend: "codex-cli", codex_timeout_seconds: 300 } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  on("process.run", async (_, e) => {
    expect(e.init?.timeoutMs).toBe(300000)
    await clock.sleep(150000)
    return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  const pending = $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  await clock.settle()
  await clock.advance(150000)
  expect((await pending).text).toBe("Hello.")
})

test("a question dialog uses the configured CLI timeout", async () => {
  const engine = translationEngine(async (_, init) => {
    expect(init?.timeoutMs).toBe(450000)
    return { exitCode: 0, stdout: init?.stdin ?? "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
  })
  const state = createDisplayState()
  const source = JSON.stringify([{ question: "Where should jobs run?", header: "Runtime", multiSelect: false, options: [{ label: "Host", description: "Run on the host." }, { label: "Container", description: "Run in a container." }] }])
  const entry = displayEntry(state, "terminal", "timeout-question", source, false, "cn", "question", false)
  expect(entry).toBeDefined()
  if (!entry) return
  entry.phase = "loading"
  state.running.add(entry)
  await translateDisplay(engine, { backend: "codex-cli", codex_timeout_seconds: 450 }, {}, state, entry, "en", "cn")
  expect(entry.phase).toBe("ready")
})

for (const rejects of [false, true]) {
  test(`cancellation during a CLI ${rejects ? "failure" : "success"} suppresses the result and timeout hint`, async () => {
    const controller = new AbortController()
    const engine = translationEngine(async () => {
      controller.abort()
      if (rejects) throw new Error("private cancellation details")
      return { exitCode: 0, stdout: "late translation", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
    })
    const result = await requestTranslation(engine, { backend: "codex-cli", codex_timeout_seconds: 600 }, {}, "Translate", "Hello.", 8192, controller.signal)
    expect("drop" in result && result.drop).toContain("cancelled")
    expect("failure" in result).toBe(false)
    expect("text" in result).toBe(false)
  })
}

test("the host maximum never suggests increasing the timeout beyond 600 seconds", () => {
  expect(translationFailureHint({ kind: "timeout", seconds: 600 }, "cn")).toContain("已达到 600 秒上限")
  expect(translationFailureHint({ kind: "timeout", seconds: 600 }, "en").includes("Increase")).toBe(false)
  for (const language of ["cn", "en", "jp", "fr"] as const) {
    expect(translationFailureHint({ kind: "timeout", seconds: 300 }, language)).toContain("300")
  }
})

test("output timeout shows its cause and retry clears it while retaining the original", { options: { backend: "codex-cli", codex_timeout_seconds: 1, output_trigger: "auto" } }, async ($, on) => {
  const clock = mock.clock(on)
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", async (_, e) => {
    expect(e.init?.timeoutMs).toBe(1000)
    calls += 1
    if (calls === 1) {
      await clock.sleep(1000)
      throw new Error("private timeout diagnostics")
    }
    await clock.sleep(500)
    return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
  const ui = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Hello.", isFirstOfReply: true } })
  await clock.advance(300)
  await clock.advance(1000)
  expect((await ui.find({ type: "Text", text: /输出翻译失败/ }))?.text).toContain("1 秒")
  expect((await ui.find({ type: "Text", text: /输出翻译失败/ }))?.text).toContain("codex_timeout_seconds")
  expect((await ui.find({ type: "Markdown", text: "Hello." }))?.text).toBe("Hello.")
  expect(await ui.find({ text: /private timeout/ })).toBe(undefined)
  await ui.press({ key: "retry-output-translation" })
  expect(await ui.find({ type: "Text", text: /1 秒/ })).toBe(undefined)
  await clock.advance(300)
  await clock.advance(500)
  expect((await ui.find({ type: "Markdown", text: "你好。" }))?.text).toBe("你好。")
  expect(calls).toBe(2)
  await ui.unmount()
})

for (const failure of ["exit", "empty", "truncated", "markers"] as const) {
  test(`output identifies ${failure} without claiming a timeout`, { options: { backend: "codex-cli", output_trigger: "auto" } }, async ($, on) => {
    const clock = mock.clock(on)
    on("config.list", () => ({ value: [] }))
    on("process.run", () => ({ value: {
      exitCode: failure === "exit" ? 9 : 0, stdout: failure === "empty" ? "" : "partial", stderr: "private diagnostics",
      isStdoutTruncated: failure === "truncated", isStderrTruncated: false,
    } }))
    on("ui.render", { component: "AssistantMessage" }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
    const ui = await mountFreshDisplay($, { plugin: "interaction-translator", surface: "terminal", component: "AssistantMessage", props: { text: "Read `/tmp/demo.txt`.", isFirstOfReply: true } })
    await clock.advance(300)
    const error = (await ui.find({ type: "Text", text: /输出翻译失败/ }))?.text
    expect(error).toContain({ exit: "退出码 9", empty: "空译文", truncated: "截断", markers: "TR_SEGMENT_INVALID" }[failure])
    expect(error?.includes("超时")).toBe(false)
    expect(await ui.find({ text: /private diagnostics/ })).toBe(undefined)
    await ui.unmount()
  })
}
