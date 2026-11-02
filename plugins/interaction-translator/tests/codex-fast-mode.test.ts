import { expect, test } from "claude-code/testing"
import type { TurnStepChunk } from "claude-code"

for (const mode of [undefined, "default", "on", "off"]) {
  test(`CLI Fast ${mode ?? "unset"} independently controls service tier and feature`, { options: {
    backend: "codex-cli", codex_model_selection: "手动输入", codex_model: "translation-model", codex_reasoning_effort: "medium",
    ...(mode === undefined ? {} : { codex_fast_mode: mode }),
  } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    on("process.run", (_, e) => {
      const overrides = e.argv.filter(arg => arg.startsWith("service_tier=") || arg.startsWith("features.fast_mode="))
      expect(overrides).toEqual(mode === "on" ? ['service_tier="fast"', "features.fast_mode=true"]
        : mode === "off" ? ['service_tier="default"', "features.fast_mode=false"] : [])
      for (const option of overrides) expect(e.argv[e.argv.indexOf(option) - 1]).toBe("-c")
      expect(e.argv[e.argv.indexOf("--model") + 1]).toBe("translation-model")
      expect(e.argv).toContain('model_reasoning_effort="medium"')
      expect(e.argv).toContain("read-only")
      expect(e.argv[e.argv.length - 1]).toBe("-")
      expect(e.init?.stdin).toBe("你好")
      expect(e.init?.timeoutMs).toBe(120000)
      return { value: { exitCode: 0, stdout: "Hello.", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("prompt.submit", (_, e) => ({ text: e.text }))
    expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
  })
}

for (const mode of ["on", "off"]) {
  test(`CLI Fast ${mode} also applies to output without changing the Claude model`, { options: { output_mode: "conversation", backend: "codex-cli", codex_fast_mode: mode } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
    on("process.run", (_, e) => {
      expect(e.argv).toContain(mode === "on" ? 'service_tier="fast"' : 'service_tier="default"')
      expect(e.argv).toContain(`features.fast_mode=${mode === "on"}`)
      expect(e.argv.includes("--model")).toBe(false)
      expect(e.argv.some(arg => arg.startsWith("model_reasoning_effort="))).toBe(false)
      expect(e.init?.stdin).toBe("Hello.")
      return { value: { exitCode: 0, stdout: "你好。", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on("turn.step", async function* (_, e) {
      expect(e.model).toBe("claude-test")
      expect(e.effort).toBe("high")
      yield { kind: "text", index: 0, text: "Hello." }
      yield { kind: "stop", stopReason: "end_turn", usage: null }
      return { ...e, answer: "Hello.", toolUses: [], stopReason: "end_turn", usage: null }
    })
    const chunks: TurnStepChunk[] = []
    for await (const chunk of $.turn.step({ turnId: "fast-output", index: 0, model: "claude-test", effort: "high", messageCount: 1 })) chunks.push(chunk)
    expect(chunks.filter(chunk => chunk.kind === "text").map(chunk => chunk.text).join("")).toBe("你好。")
  })
}

test("API translation ignores the CLI Fast preference", { options: { codex_fast_mode: "on" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const body = JSON.parse(e.init?.body ?? "{}")
    expect(body.model).toBe("glm-5.3-flash")
    expect(body.reasoning_effort).toBe("low")
    expect(body.service_tier).toBe(undefined)
    expect(body.features).toBe(undefined)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: "Hello." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })).text).toBe("Hello.")
})

test("a failed Fast invocation does not retry through API or expose process diagnostics", { options: { backend: "codex-cli", codex_fast_mode: "on" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  let calls = 0
  on("process.run", (_, e) => {
    calls += 1
    expect(e.argv).toContain('service_tier="fast"')
    return { value: { exitCode: 1, stdout: "partial output", stderr: "private Fast diagnostics", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  expect(result.drop).toContain("Codex CLI exited with code 1")
  expect(result.drop?.includes("private Fast diagnostics")).toBe(false)
  expect(result.text).toBe(undefined)
  expect(calls).toBe(1)
})
