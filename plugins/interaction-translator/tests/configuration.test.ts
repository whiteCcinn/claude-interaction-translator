import { expect, test } from "claude-code/testing"
import type { PluginOptions } from "claude-code"
import { FOLLOW_LOCAL, MANUAL_INPUT, DEFAULT_API_URL, DEFAULT_API_MODEL, MODEL_CHOICES, resolveConfiguration, initialSelections } from "../hooks/configuration"

function resolved(options: PluginOptions, locked: readonly string[] = [], saved: Record<string, unknown> = {}) {
  const result = resolveConfiguration(options, new Set(locked), saved)
  if ("drop" in result) throw new Error(result.drop)
  return result.value
}

test("model choices begin with inheritance, include current presets and end with manual input", () => {
  expect(MODEL_CHOICES).toEqual([FOLLOW_LOCAL, "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna", MANUAL_INPUT])
})

test("explicit CLI inheritance ignores retained manual values", () => {
  const value = resolved({ backend: "codex-cli", codex_model: "company-model", codex_path: "/opt/company/codex" }, [], { codex_model_selection: FOLLOW_LOCAL, codex_path_selection: FOLLOW_LOCAL })
  expect(value.codex_model).toBe("")
  expect(value.codex_path).toBe("codex")
  expect(value.codex_reasoning_effort).toBe("default")
  expect(value.codex_fast_mode).toBe("default")
})

test("model preset ignores a retained manual model", () => {
  expect(resolved({ backend: "codex-cli", codex_model_selection: "gpt-6.1-terra", codex_model: "company-model" }).codex_model).toBe("gpt-6.1-terra")
})

test("manual selection reuses old text values including executable paths with spaces", () => {
  const value = resolved({ backend: "codex-cli", codex_model_selection: MANUAL_INPUT, codex_model: " company-model ", codex_path_selection: MANUAL_INPUT, codex_path: " /opt/My Tools/codex " })
  expect(value.codex_model).toBe("company-model")
  expect(value.codex_path).toBe("/opt/My Tools/codex")
})

for (const field of ["codex_model", "codex_path"]) {
  for (const text of ["", "   ", MANUAL_INPUT, FOLLOW_LOCAL, "未配置", "bad\u0000value"]) {
    test(`manual ${field} rejects missing/control value ${JSON.stringify(text)}`, () => {
      expect("drop" in resolveConfiguration({ backend: "codex-cli", [`${field}_selection`]: MANUAL_INPUT, [field]: text })).toBe(true)
    })
  }
}

test("reasoning and Fast labels normalize without becoming CLI values", () => {
  const value = resolved({ backend: "codex-cli", codex_reasoning_effort: FOLLOW_LOCAL, codex_fast_mode: FOLLOW_LOCAL })
  expect(value.codex_reasoning_effort).toBe("default")
  expect(value.codex_fast_mode).toBe("default")
  expect(resolved({ backend: "codex-cli", codex_reasoning_effort: "default", codex_fast_mode: "default" }).codex_fast_mode).toBe("default")
})

test("manual reasoning reads its separate value and requires a valid identifier", () => {
  expect(resolved({ backend: "codex-cli", codex_reasoning_effort: MANUAL_INPUT, codex_reasoning_effort_manual: "ultra" }).codex_reasoning_effort).toBe("ultra")
  for (const value of ["", FOLLOW_LOCAL, "low\nmax"]) {
    expect("drop" in resolveConfiguration({ backend: "codex-cli", codex_reasoning_effort: MANUAL_INPUT, codex_reasoning_effort_manual: value })).toBe(true)
  }
})

test("unused manual API fields do not block CLI translation", () => {
  expect("value" in resolveConfiguration({ backend: "codex-cli", api_url_selection: MANUAL_INPUT, api_model_selection: MANUAL_INPUT, api_key_source: MANUAL_INPUT })).toBe(true)
})

test("API presets ignore retained manual values and keep the low reasoning default", () => {
  const value = resolved({ api_url: "https://old.example/v1/chat/completions", model: "old-model" }, [], { api_url_selection: DEFAULT_API_URL, api_model_selection: DEFAULT_API_MODEL })
  expect(value.api_url).toBe(DEFAULT_API_URL)
  expect(value.model).toBe(DEFAULT_API_MODEL)
  expect(value.reasoning_effort).toBe("low")
})

test("manual API settings and credential source require their separate values", () => {
  for (const field of ["api_url_selection", "api_model_selection", "api_key_source"]) expect("drop" in resolveConfiguration({ [field]: MANUAL_INPUT })).toBe(true)
  const value = resolved({ api_url_selection: MANUAL_INPUT, api_url: "https://gateway.example/v1/chat/completions", api_model_selection: MANUAL_INPUT, model: "company-api-model", api_key_source: MANUAL_INPUT, api_key: "example-token" })
  expect(value.api_url).toBe("https://gateway.example/v1/chat/completions")
  expect(value.model).toBe("company-api-model")
})

test("manual API URL rejects unsupported schemes and embedded credentials", () => {
  for (const url of ["invalid", "file:///tmp/api", "https://user:password@example.com/v1/chat/completions"]) expect("drop" in resolveConfiguration({ api_url_selection: MANUAL_INPUT, api_url: url })).toBe(true)
})

test("managed raw fields stay authoritative until policy manages the new picker", () => {
  const options = { backend: "codex-cli", codex_model_selection: "gpt-6-luna", codex_model: "managed-model" }
  expect(resolved(options, ["codex_model"]).codex_model).toBe("managed-model")
  expect(resolved(options, ["codex_model", "codex_model_selection"]).codex_model).toBe("gpt-6-luna")
  expect(resolved({ ...options, codex_model: "" }, ["codex_model"]).codex_model).toBe("")
})

test("locked default selectors override locked retained manual values", () => {
  expect(resolved({ backend: "codex-cli", codex_model_selection: FOLLOW_LOCAL, codex_model: "managed-old" }, ["codex_model", "codex_model_selection"]).codex_model).toBe("")
  expect(resolved({ api_url_selection: DEFAULT_API_URL, api_url: "https://old.example/v1/chat/completions" }, ["api_url", "api_url_selection"]).api_url).toBe(DEFAULT_API_URL)
})

test("legacy custom model, path and API endpoint stay active until selectors are saved", () => {
  const cli = resolved({ backend: "codex-cli", codex_model: "company-model", codex_path: "/old/codex" })
  expect(cli.codex_model).toBe("company-model")
  expect(cli.codex_path).toBe("/old/codex")
  const api = resolved({ api_url: "https://old.example/v1/chat/completions", model: "old-model" })
  expect(api.api_url).toBe("https://old.example/v1/chat/completions")
  expect(api.model).toBe("old-model")
})

test("initialization only fills missing selectors and never changes a secret", () => {
  const saved = { codex_model: "gpt-6-luna", codex_path: "/old/codex", api_url: "https://old.example/v1/chat/completions", model: "old-model", api_key: "never-change" }
  expect(initialSelections(saved)).toEqual({ codex_model_selection: "gpt-6-luna", codex_path_selection: MANUAL_INPUT, api_url_selection: MANUAL_INPUT, api_model_selection: MANUAL_INPUT })
  expect(initialSelections({ ...saved, codex_model_selection: FOLLOW_LOCAL }).codex_model_selection).toBe(undefined)
  expect(saved.api_key).toBe("never-change")
})
