import type { EngineInterface, Timer } from "claude-code"
import { LANGUAGES } from "./languages"
import type { Language, SourceLanguage } from "./languages"

export type Feedback = {
  stage: "input" | "output"
  target: Language
  phase: "loading" | "done" | "error"
  startedAt: number
  elapsed: number
  frame: number
  detail: string
  signal: AbortSignal
  timer?: Timer
  dispose: () => void
}

export type FeedbackState = { interactive: boolean; current?: Feedback; hideTimer?: Timer }

// Host capabilities must be called through statically traceable top-level helpers.
export function clearFeedback($: EngineInterface, state: FeedbackState, handle = state.current) {
  handle?.dispose()
  if (state.current !== handle) return
  state.hideTimer?.cancel()
  state.hideTimer = undefined
  state.current = undefined
  $.ui.invalidate("ui.render")
}

export async function startFeedback($: EngineInterface, state: FeedbackState, stage: Feedback["stage"], source: SourceLanguage, target: Language, signal: AbortSignal): Promise<Feedback | undefined> {
  if (!state.interactive || signal.aborted) return undefined
  state.current?.dispose()
  state.hideTimer?.cancel()
  state.hideTimer = undefined
  const handle: Feedback = {
    stage, target, phase: "loading", startedAt: 0, elapsed: 0, frame: 0,
    detail: `${source === "auto" ? "自动识别" : LANGUAGES[source].label} → ${LANGUAGES[target].label}`,
    signal, dispose() {},
  }
  state.current = handle
  const cancel = () => clearFeedback($, state, handle)
  handle.dispose = () => {
    handle.timer?.cancel()
    signal.removeEventListener("abort", cancel)
  }
  signal.addEventListener("abort", cancel, { once: true })
  handle.startedAt = await $.clock.now()
  if (state.current !== handle || signal.aborted) return handle
  $.ui.invalidate("ui.render")
  handle.timer = $.clock.every(250, async () => {
    if (state.current !== handle || signal.aborted) return handle.dispose()
    if (handle.phase !== "loading") return
    const now = await $.clock.now()
    if (state.current !== handle || signal.aborted) return handle.dispose()
    if (handle.phase !== "loading") return
    handle.frame += 1
    handle.elapsed = (now - handle.startedAt) / 1000
    $.ui.invalidate("ui.render")
  })
  return handle
}

export async function finishFeedback($: EngineInterface, state: FeedbackState, handle: Feedback | undefined, succeeded: boolean, detail?: string) {
  if (!handle) return
  handle.timer?.cancel()
  if (state.current !== handle) return handle.dispose()
  const now = await $.clock.now()
  if (state.current !== handle) return handle.dispose()
  if (handle.signal.aborted) return clearFeedback($, state, handle)
  // Completed/error cards still belong to this operation until dismissed.
  // Keep its abort listener so cancellation also clears a pending hide timer.
  handle.timer = undefined
  handle.elapsed = (now - handle.startedAt) / 1000
  handle.phase = succeeded ? "done" : "error"
  if (detail !== undefined) handle.detail = detail.replace(/\s+/g, " ").slice(0, 180)
  $.ui.invalidate("ui.render")
  if (succeeded) state.hideTimer = $.clock.after(3000, () => clearFeedback($, state, handle))
}
