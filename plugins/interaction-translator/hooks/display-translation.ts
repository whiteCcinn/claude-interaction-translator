import type { EngineInterface, PluginOptions, RenderSurface, Timer } from "claude-code"
import type { Language } from "./languages"
import { translationPrompt } from "./languages"
import { protectText, restoreText } from "./protected-text"
import { requestTranslation } from "./translation-client"
import type { ConfigurationState } from "./configuration-runtime"
import { finishFeedback, startFeedback } from "./translation-feedback"
import type { Feedback, FeedbackState } from "./translation-feedback"
import { prepareQuestionTranslation, questionTranslationPrompt, restoreQuestionTranslation } from "./question-translation"

export const MAX_DISPLAY_ENTRIES = 128
export const MAX_DISPLAY_BYTES = 4 * 1024 * 1024
export const MAX_DISPLAY_SOURCE_BYTES = 262144
export const MAX_DISPLAY_PENDING = 16
export const MAX_DISPLAY_RUNNING = 2
export const DISPLAY_DELAY_MS = 150
const encoder = new TextEncoder()

export type DisplayEntry = {
  key: string
  surface: RenderSurface
  manual: boolean
  kind: "assistant" | "question"
  requestId: string
  source: string
  bytes: number
  phase: "idle" | "pending" | "loading" | "ready" | "error"
  failure?: "queue"
  automaticFinal?: boolean
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
  epoch: number
  freshResponses: Set<string>
  closedQuestions: Set<string>
  manualAssistants: Map<RenderSurface, DisplayEntry>
  scheduled?: Scheduled
  feedback?: FeedbackState
}

export function createDisplayState(feedback?: FeedbackState): DisplayState {
  return { entries: new Map(), pending: new Map(), running: new Set(), bytes: 0, activeSteps: 0, epoch: 0, freshResponses: new Set(), closedQuestions: new Set(), manualAssistants: new Map(), feedback }
}

export function recordFreshResponse(state: DisplayState, requestId: string, blockCount = 1) {
  const ids = [requestId]
  // Native 2.1.316/317 also render per-content-block UUIDs. The index is the
  // original content position, including thinking/tool blocks, even for a
  // single text block following earlier multi-block messages in the thread.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    const count = Number.isInteger(blockCount) ? Math.min(Math.max(0, blockCount), MAX_DISPLAY_ENTRIES - 1) : 0
    for (let index = 0; index < count; index++) ids.push(requestId.slice(0, 24) + index.toString(16).padStart(12, "0"))
  }
  for (const id of ids) {
    state.freshResponses.add(id)
    if (state.freshResponses.size > MAX_DISPLAY_ENTRIES) {
      const oldest = state.freshResponses.values().next().value
      if (oldest !== undefined) state.freshResponses.delete(oldest)
    }
  }
}

export function assistantDisplayAllowed(state: DisplayState, surface: RenderSurface, requestId: string, summary: boolean, target: Language): boolean {
  // An owned cache entry remains eligible even after its recent ID is evicted.
  return state.freshResponses.has(requestId) || state.entries.has(JSON.stringify([surface, requestId, summary, target, "assistant"]))
}

export function displayOnly(options: PluginOptions): boolean { return options.output_mode !== "conversation" }
export function manualDisplay(options: PluginOptions): boolean { return displayOnly(options) && options.output_trigger !== "auto" }
export function finalDisplay(options: PluginOptions): boolean { return displayOnly(options) && options.output_trigger === "final" }
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
  if (state.manualAssistants.get(entry.surface) === entry) state.manualAssistants.delete(entry.surface)
  state.bytes -= entry.bytes
}

function makeRoom(state: DisplayState, additional: number, count: number, keep?: DisplayEntry): boolean {
  for (const entry of state.entries.values()) {
    if (state.bytes + additional <= MAX_DISPLAY_BYTES && state.entries.size + count <= MAX_DISPLAY_ENTRIES) break
    // Manual entries can be recreated without a backend call. Pinning every
    // restored or completed row would hide controls for newer replies forever.
    if (entry !== keep && (entry.manual || !entry.visible) && !state.running.has(entry) && entry.phase !== "pending" && entry.phase !== "loading") removeEntry(state, entry)
  }
  return state.bytes + additional <= MAX_DISPLAY_BYTES && state.entries.size + count <= MAX_DISPLAY_ENTRIES
}

export function displayEntry(state: DisplayState, surface: RenderSurface, requestId: string, source: string, summary: boolean, target: Language, kind: DisplayEntry["kind"] = "assistant", autoStart = true): DisplayEntry | undefined {
  if (kind === "question" && state.closedQuestions.has(requestId)) return undefined
  const key = JSON.stringify([surface, requestId, summary, target, kind])
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
  if (autoStart && state.pending.size >= MAX_DISPLAY_PENDING && kind === "question") {
    const queued = Array.from(state.pending.values()).findLast(entry => entry.kind === "assistant")
    if (queued) removeEntry(state, queued)
  }
  if ((autoStart && state.pending.size >= MAX_DISPLAY_PENDING) || !makeRoom(state, bytes, 1)) return undefined
  const entry: DisplayEntry = { key, surface, manual: !autoStart, kind, requestId, source, bytes, phase: autoStart ? "pending" : "idle", visible: true, controller: new AbortController() }
  state.entries.set(key, entry)
  if (autoStart) state.pending.set(key, entry)
  else if (kind === "assistant") state.manualAssistants.set(surface, entry)
  state.bytes += bytes
  return entry
}

export function hideDisplay(state: DisplayState, surface: RenderSurface, requestId: string, summary: boolean, target: Language) {
  const entry = state.entries.get(JSON.stringify([surface, requestId, summary, target, "assistant"]))
  if (!entry) return
  entry.visible = false
  if (entry.phase === "pending" || entry.phase === "loading") removeEntry(state, entry)
}

export function clearDisplay(state: DisplayState) {
  state.epoch += 1
  state.freshResponses.clear()
  state.closedQuestions.clear()
  state.scheduled?.timer?.cancel()
  state.scheduled = undefined
  for (const entry of state.entries.values()) entry.controller.abort()
  for (const entry of state.running) entry.controller.abort()
  state.entries.clear()
  state.manualAssistants.clear()
  state.pending.clear()
  state.bytes = 0
}

export function closeQuestionDisplay(state: DisplayState, requestId: string, epoch = state.epoch) {
  if (epoch !== state.epoch) return
  state.closedQuestions.add(requestId)
  if (state.closedQuestions.size > MAX_DISPLAY_ENTRIES) {
    const oldest = state.closedQuestions.values().next().value
    if (oldest !== undefined) state.closedQuestions.delete(oldest)
  }
  for (const entry of state.entries.values()) if (entry.kind === "question" && entry.requestId === requestId) removeEntry(state, entry)
}

export function scheduleDisplay($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, state: DisplayState, source: Language, target: Language) {
  if (state.scheduled || !state.pending.size || state.running.size >= MAX_DISPLAY_RUNNING) return
  if (state.activeSteps && !Array.from(state.pending.values()).some(entry => entry.kind === "question")) return
  const scheduled: Scheduled = {}
  state.scheduled = scheduled
  scheduled.timer = $.clock.after(DISPLAY_DELAY_MS, async () => {
    if (state.scheduled !== scheduled) return
    state.scheduled = undefined
    const work: Promise<void>[] = []
    const pending = Array.from(state.pending.values()).sort((left, right) => Number(right.kind === "question") - Number(left.kind === "question"))
    for (const entry of pending) {
      if (state.running.size >= MAX_DISPLAY_RUNNING) break
      if (state.activeSteps && entry.kind !== "question") continue
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
    const question = entry.kind === "question" ? prepareQuestionTranslation(entry.source) : undefined
    if (entry.kind === "question" && !question) { entry.phase = "error"; return }
    const protectedText = question ? undefined : protectText(entry.source)
    const text = question?.text ?? protectedText?.text
    if (text === undefined) { entry.phase = "error"; return }
    const prompt = question ? questionTranslationPrompt(target, source) : translationPrompt(target, source, "response")
    const result = await requestTranslation($, options, configuration, prompt, text, 8192, entry.controller.signal)
    if (state.entries.get(entry.key) !== entry || entry.controller.signal.aborted) return
    const translated = "text" in result ? question ? restoreQuestionTranslation(result.text, question)
      : protectedText ? restoreText(result.text, protectedText) : undefined : undefined
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
      if (state.feedback) await finishFeedback($, state.feedback, feedback, entry.phase === "ready", entry.phase === "error" ? displayFailure(target) : undefined)
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
  if (entry.phase !== "error") return
  requestDisplay($, options, configuration, state, entry, source, target)
}

export function requestDisplay($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, state: DisplayState, entry: DisplayEntry, source: Language, target: Language, automaticFinal = false) {
  if (state.entries.get(entry.key) !== entry || !entry.visible || (entry.phase !== "idle" && entry.phase !== "error") || (entry.kind === "assistant" && state.activeSteps)) return
  if (state.pending.size >= MAX_DISPLAY_PENDING) {
    entry.phase = "error"
    entry.failure = "queue"
    $.ui.invalidate("ui.render")
    return
  }
  entry.controller = new AbortController()
  entry.automaticFinal = automaticFinal
  entry.failure = undefined
  entry.phase = "pending"
  state.pending.set(entry.key, entry)
  scheduleDisplay($, options, configuration, state, source, target)
  $.ui.invalidate("ui.render")
}

export function cancelFinalDisplay(state: DisplayState) {
  for (const entry of state.entries.values()) {
    if (entry.automaticFinal && (entry.phase === "pending" || entry.phase === "loading")) removeEntry(state, entry)
  }
}

export function manualDisplayTarget(state: DisplayState, surface: RenderSurface): DisplayEntry | undefined {
  const choices = manualDisplayChoices(state, surface)
  return choices.find(entry => entry.kind === "question") ?? choices.find(entry => entry === state.manualAssistants.get(surface)) ?? choices.at(-1)
}

export function manualDisplayChoices(state: DisplayState, surface: RenderSurface): DisplayEntry[] {
  return Array.from(state.entries.values()).filter(entry => entry.surface === surface && entry.visible && (entry.phase === "idle" || entry.phase === "error") && (!state.activeSteps || entry.kind === "question"))
}

export function selectManualDisplay($: EngineInterface, state: DisplayState, surface: RenderSurface, direction: number) {
  const choices = manualDisplayChoices(state, surface).filter(entry => entry.kind === "assistant")
  if (!choices.length) return
  const current = manualDisplayTarget(state, surface)
  const index = Math.max(0, choices.findIndex(entry => entry === current))
  const selected = choices[(index + direction + choices.length) % choices.length]
  if (selected) state.manualAssistants.set(surface, selected)
  $.ui.invalidate("ui.render")
}

export function displayQueueFailure(target: Language): string {
  return {
    cn: "翻译等待队列已满，已保留原文。请稍后重试。",
    en: "Translation queue is full. The original remains displayed; retry shortly.",
    jp: "翻訳の待機キューが満杯です。原文を表示しています。後で再試行してください。",
    fr: "La file de traduction est pleine. Le texte original reste affiché ; réessayez plus tard.",
  }[target]
}

export function displayFailure(target: Language): string {
  return {
    cn: "输出翻译失败，已保留原文。请检查翻译配置或缩短回复后重试。",
    en: "Output translation failed; the original response is still displayed. Check the translator settings or retry with a shorter response.",
    jp: "出力の翻訳に失敗しました。原文を表示しています。翻訳設定を確認するか、短い応答で再試行してください。",
    fr: "Échec de la traduction de sortie ; la réponse originale reste affichée. Vérifiez les paramètres ou réessayez avec une réponse plus courte.",
  }[target]
}
