import type { EngineInterface, PluginOptions, RenderSurface, Timer } from "claude-code"
import type { Language } from "./languages"
import { outputFailure, translationPrompt } from "./languages"
import { protectText, restoreText } from "./protected-text"
import { requestTranslation } from "./translation-client"
import type { ConfigurationState } from "./configuration-runtime"
import { finishFeedback, startFeedback } from "./translation-feedback"
import type { Feedback, FeedbackState } from "./translation-feedback"

export const MAX_DISPLAY_ENTRIES = 128
export const MAX_DISPLAY_BYTES = 4 * 1024 * 1024
export const MAX_DISPLAY_SOURCE_BYTES = 262144
export const MAX_DISPLAY_PENDING = 16
export const MAX_DISPLAY_RUNNING = 2
export const DISPLAY_DELAY_MS = 150
const encoder = new TextEncoder()

export type DisplayEntry = {
  key: string
  source: string
  bytes: number
  phase: "pending" | "loading" | "ready" | "error"
  visible: boolean
  translated?: string
  controller: AbortController
}
type Scheduled = { timer?: Timer }
export type DisplayState = {
  entries: Map<string, DisplayEntry>
  pending: Map<string, DisplayEntry>
  running: Set<DisplayEntry>
  bytes: number
  activeSteps: number
  scheduled?: Scheduled
  feedback?: FeedbackState
}

export function createDisplayState(feedback?: FeedbackState): DisplayState {
  return { entries: new Map(), pending: new Map(), running: new Set(), bytes: 0, activeSteps: 0, feedback }
}

export function displayOnly(options: PluginOptions): boolean { return options.output_mode !== "conversation" }
export function displaySourceAllowed(text: string): boolean { return encoder.encode(text).byteLength <= MAX_DISPLAY_SOURCE_BYTES }

export function displayCodeOnly(text: string): boolean {
  const protectedText = protectText(text)
  return !protectedText.text.replace(new RegExp(protectedText.prefix + "\\d+__", "g"), "").trim()
}

// A UI block may start or end inside code from another block. Preserve the
// entire uncertain block instead of translating a possible code fragment.
export function incompleteCode(text: string): boolean {
  let fence: { char: string; length: number } | undefined
  const prose: string[] = []
  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      const run = marker[1] ?? ""
      if (!fence) fence = { char: run[0] ?? "", length: run.length }
      else if (run[0] === fence.char && run.length >= fence.length && !marker[2]?.trim()) fence = undefined
    } else if (!fence) prose.push(line)
  }
  if (fence) return true
  // Balanced inline code is removed by the existing protector.
  return protectText(prose.join("\n")).text.includes("`")
}

function removeEntry(state: DisplayState, entry: DisplayEntry) {
  entry.controller.abort()
  state.pending.delete(entry.key)
  if (state.entries.get(entry.key) !== entry) return
  state.entries.delete(entry.key)
  state.bytes -= entry.bytes
}

function makeRoom(state: DisplayState, additional: number, count: number, keep?: DisplayEntry): boolean {
  for (const entry of state.entries.values()) {
    if (state.bytes + additional <= MAX_DISPLAY_BYTES && state.entries.size + count <= MAX_DISPLAY_ENTRIES) break
    if (entry !== keep && !entry.visible && !state.running.has(entry) && entry.phase !== "pending") removeEntry(state, entry)
  }
  return state.bytes + additional <= MAX_DISPLAY_BYTES && state.entries.size + count <= MAX_DISPLAY_ENTRIES
}

export function displayEntry(state: DisplayState, surface: RenderSurface, requestId: string, source: string, summary: boolean, target: Language): DisplayEntry | undefined {
  const key = JSON.stringify([surface, requestId, summary, target])
  const previous = state.entries.get(key)
  if (previous?.source === source) {
    previous.visible = true
    // Touch an exact match without looking up a whole-response substring.
    state.entries.delete(key)
    state.entries.set(key, previous)
    return previous
  }
  if (previous) removeEntry(state, previous)
  const bytes = encoder.encode(source).byteLength
  if (bytes > MAX_DISPLAY_SOURCE_BYTES) return undefined
  if (state.pending.size >= MAX_DISPLAY_PENDING || !makeRoom(state, bytes, 1)) return undefined
  const entry: DisplayEntry = { key, source, bytes, phase: "pending", visible: true, controller: new AbortController() }
  state.entries.set(key, entry)
  state.pending.set(key, entry)
  state.bytes += bytes
  return entry
}

export function hideDisplay(state: DisplayState, surface: RenderSurface, requestId: string, summary: boolean, target: Language) {
  const entry = state.entries.get(JSON.stringify([surface, requestId, summary, target]))
  if (!entry) return
  entry.visible = false
  if (entry.phase === "pending" || entry.phase === "loading") removeEntry(state, entry)
}

export function clearDisplay(state: DisplayState) {
  state.scheduled?.timer?.cancel()
  state.scheduled = undefined
  for (const entry of state.entries.values()) entry.controller.abort()
  for (const entry of state.running) entry.controller.abort()
  state.entries.clear()
  state.pending.clear()
  state.bytes = 0
}

export function scheduleDisplay($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, state: DisplayState, source: Language, target: Language) {
  if (state.scheduled || state.activeSteps || !state.pending.size || state.running.size >= MAX_DISPLAY_RUNNING) return
  const scheduled: Scheduled = {}
  state.scheduled = scheduled
  scheduled.timer = $.clock.after(DISPLAY_DELAY_MS, async () => {
    if (state.scheduled !== scheduled) return
    state.scheduled = undefined
    if (state.activeSteps) return
    const work: Promise<void>[] = []
    for (const entry of state.pending.values()) {
      if (state.running.size >= MAX_DISPLAY_RUNNING) break
      state.pending.delete(entry.key)
      if (state.entries.get(entry.key) !== entry || entry.controller.signal.aborted) continue
      state.running.add(entry)
      entry.phase = "loading"
      // The timer dispatch, rather than ui.render, owns the asynchronous work.
      work.push(translateDisplay($, options, configuration, state, entry, source, target))
    }
    await Promise.all(work)
  })
}

export async function translateDisplay($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, state: DisplayState, entry: DisplayEntry, source: Language, target: Language): Promise<void> {
  let feedback: Feedback | undefined
  try {
    if (state.feedback?.interactive && !(state.feedback.current?.stage === "input" && state.feedback.current.phase === "loading")) {
      feedback = await startFeedback($, state.feedback, "output", source, target, entry.controller.signal)
    }
    const protectedText = protectText(entry.source)
    const result = await requestTranslation($, options, configuration, translationPrompt(target, source, "response"), protectedText.text, 8192, entry.controller.signal)
    if (state.entries.get(entry.key) !== entry || entry.controller.signal.aborted) return
    const translated = "text" in result ? restoreText(result.text, protectedText) : undefined
    if (translated === undefined) { entry.phase = "error"; return }
    const extra = encoder.encode(translated).byteLength
    if (extra > MAX_DISPLAY_SOURCE_BYTES || !makeRoom(state, extra, 0, entry)) { entry.phase = "error"; return }
    entry.translated = translated
    entry.bytes += extra
    state.bytes += extra
    entry.phase = "ready"
  } catch {
    if (state.entries.get(entry.key) === entry && !entry.controller.signal.aborted) entry.phase = "error"
  } finally {
    state.running.delete(entry)
    try {
      if (state.feedback) await finishFeedback($, state.feedback, feedback, entry.phase === "ready", entry.phase === "error" ? outputFailure(target) : undefined)
    } catch {
      // A progress-card failure must not change a completed UI translation.
    }
    try {
      if (state.entries.get(entry.key) === entry && !entry.controller.signal.aborted) $.ui.invalidate("ui.render")
      scheduleDisplay($, options, configuration, state, source, target)
    } catch {
      // Rendering may have detached while this independent task completed.
    }
  }
}

export function retryDisplay($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, state: DisplayState, entry: DisplayEntry, source: Language, target: Language) {
  if (state.entries.get(entry.key) !== entry || entry.phase !== "error" || state.pending.size >= MAX_DISPLAY_PENDING) return
  entry.controller = new AbortController()
  entry.phase = "pending"
  state.pending.set(entry.key, entry)
  scheduleDisplay($, options, configuration, state, source, target)
  $.ui.invalidate("ui.render")
}

export function displayStatus(target: Language, failed: boolean): string {
  if (failed) return outputFailure(target)
  return { cn: "输出翻译中…", en: "Translating response…", jp: "応答を翻訳中…", fr: "Traduction de la réponse…" }[target]
}
