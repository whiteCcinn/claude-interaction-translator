import type { PluginOptions } from "claude-code"

export const FOLLOW_LOCAL = "跟随本地配置"
export const MANUAL_INPUT = "手动输入"
export const DEFAULT_API_URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
export const DEFAULT_API_MODEL = "glm-5.3-flash"
// Presets from the official Codex model catalog, checked 2026-11-01.
// Keep the manual choice for private providers and future model IDs.
export const MODEL_CHOICES: readonly string[] = [FOLLOW_LOCAL, "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna", MANUAL_INPUT]
export type ConfigurationResult = { value: PluginOptions } | { drop: string; hint?: string }

const PATH_CHOICES = [FOLLOW_LOCAL, MANUAL_INPUT]
const CONTROL_VALUES = new Set([FOLLOW_LOCAL, MANUAL_INPUT, "未配置"])
export const TEXT_FIELDS = [
  { selector: "codex_model_selection", field: "codex_model", fallback: FOLLOW_LOCAL, inherited: "", choices: MODEL_CHOICES },
  { selector: "codex_path_selection", field: "codex_path", fallback: FOLLOW_LOCAL, inherited: "codex", choices: PATH_CHOICES },
  { selector: "api_url_selection", field: "api_url", fallback: DEFAULT_API_URL, inherited: DEFAULT_API_URL, choices: [DEFAULT_API_URL, MANUAL_INPUT] },
  { selector: "api_model_selection", field: "model", fallback: DEFAULT_API_MODEL, inherited: DEFAULT_API_MODEL, choices: [DEFAULT_API_MODEL, MANUAL_INPUT] },
] as const

function text(value: unknown): string { return typeof value === "string" ? value.trim() : "" }
function usable(value: string): boolean { return Boolean(value) && !CONTROL_VALUES.has(value) && !/[\u0000-\u001f\u007f]/.test(value) }

function selection(options: PluginOptions, saved: Readonly<Record<string, unknown>>, key: string, fallback: string, choices: readonly string[]) {
  const choice = text(options[key])
  if (choice !== fallback && choices.includes(choice)) return { choice, explicit: true }
  const stored = text(saved[key])
  return choices.includes(stored) ? { choice: stored, explicit: true } : { choice: fallback, explicit: false }
}

function selectedText(options: PluginOptions, saved: Readonly<Record<string, unknown>>, key: string, field: string, fallback: string, choices: readonly string[], inherited: string): string {
  const { choice, explicit } = selection(options, saved, key, fallback, choices)
  const manual = text(options[field])
  if (choice === MANUAL_INPUT || (!explicit && manual && manual !== inherited)) return manual
  return choice === FOLLOW_LOCAL ? inherited : choice
}

function missing(field: string): ConfigurationResult {
  return { drop: `请在插件配置的“${field}”单独一行填写手动值后重试。`, hint: `“${field}”已选择手动输入，请填写对应值。` }
}

export function resolveConfiguration(options: PluginOptions, locked: ReadonlySet<string> = new Set(), saved: Readonly<Record<string, unknown>> = {}): ConfigurationResult {
  for (const { selector, field, fallback, inherited } of TEXT_FIELDS) {
    if (locked.has(selector)) {
      saved = { ...saved, [selector]: text(options[selector]) || fallback }
      continue
    }
    if (!locked.has(field)) continue
    // A new picker must not bypass a legacy field locked by managed settings.
    const raw = text(options[field])
    const choice = raw && raw !== inherited ? MANUAL_INPUT : fallback
    options = { ...options, [field]: raw, [selector]: choice }
    saved = { ...saved, [selector]: choice }
  }
  if (options.backend === "codex-cli") {
    const model = selectedText(options, saved, "codex_model_selection", "codex_model", FOLLOW_LOCAL, MODEL_CHOICES, "")
    const path = selectedText(options, saved, "codex_path_selection", "codex_path", FOLLOW_LOCAL, PATH_CHOICES, "codex")
    const modelChoice = selection(options, saved, "codex_model_selection", FOLLOW_LOCAL, MODEL_CHOICES)
    if ((modelChoice.choice === MANUAL_INPUT || model) && !usable(model)) return missing("Codex model · 手动值")
    if (!usable(path)) return missing("Codex executable · 手动值")
    let effort = text(options.codex_reasoning_effort)
    if (effort === MANUAL_INPUT) {
      effort = text(options.codex_reasoning_effort_manual)
      if (!usable(effort) || !/^[a-zA-Z0-9_-]+$/.test(effort)) return missing("Codex reasoning · 手动值")
    } else if (!effort || effort === FOLLOW_LOCAL || effort === "default") effort = "default"
    else if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) return missing("Codex reasoning effort")
    const fast = text(options.codex_fast_mode)
    if (fast && ![FOLLOW_LOCAL, "default", "on", "off"].includes(fast)) return missing("Codex Fast mode")
    return { value: { ...options, codex_model: model, codex_path: path, codex_reasoning_effort: effort, codex_fast_mode: fast === "on" || fast === "off" ? fast : "default" } }
  }
  const url = selectedText(options, saved, "api_url_selection", "api_url", DEFAULT_API_URL, [DEFAULT_API_URL, MANUAL_INPUT], DEFAULT_API_URL)
  const model = selectedText(options, saved, "api_model_selection", "model", DEFAULT_API_MODEL, [DEFAULT_API_MODEL, MANUAL_INPUT], DEFAULT_API_MODEL)
  if (!usable(url)) return missing("API URL · 手动值")
  if (!usable(model)) return missing("API model · 手动值")
  try {
    const parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid URL")
  } catch {
    return { drop: "Invalid API URL. Use an HTTP or HTTPS URL without embedded credentials.", hint: "请填写完整 HTTP 或 HTTPS 地址，并把密钥放在 API Key 字段。" }
  }
  if (options.api_key_source === MANUAL_INPUT && !usable(text(options.api_key))) return missing("API Key")
  return { value: { ...options, api_url: url, model, reasoning_effort: text(options.reasoning_effort) || "low" } }
}

export function needsStoredChoices(options: PluginOptions, locked: ReadonlySet<string>): boolean {
  return TEXT_FIELDS.some(({ selector, field, fallback, inherited }) => {
    if (selector.startsWith("codex_") !== (options.backend === "codex-cli") || locked.has(field) || locked.has(selector)) return false
    const choice = text(options[selector])
    const manual = text(options[field])
    return (!choice || choice === fallback) && Boolean(manual) && manual !== inherited
  })
}

export function initialSelections(saved: Readonly<Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { selector, field, inherited } of TEXT_FIELDS) {
    const manual = text(saved[field])
    if (Object.hasOwn(saved, selector) || !usable(manual) || manual === inherited) continue
    result[selector] = selector === "codex_model_selection" && MODEL_CHOICES.includes(manual) ? manual : MANUAL_INPUT
  }
  return result
}
