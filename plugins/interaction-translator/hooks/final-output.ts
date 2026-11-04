import type { PluginOptions, RenderSurface, TurnCompleteInput, TurnStepInput, TurnStepResult } from "claude-code"

const MAX_TURNS = 32
const MAX_RESPONSE_IDS = 128
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type FinalStep = {
  turnId: string
  index: number
  revision: number
  finished: boolean
  complete: boolean
  completionNormal: boolean
  normal: boolean
  responseIds: Set<string>
}
export type FinalOutputState = {
  revision: number
  acceptedRevision: number
  starts: Set<string>
  steps: Map<string, FinalStep>
  lastStep?: FinalStep
  selected?: { step: FinalStep; attempted: Set<string> }
  submissions: Set<FinalSubmission>
  overflow: boolean
}
type FinalSubmission = { revision: number }

export function createFinalOutputState(): FinalOutputState {
  return { revision: 0, acceptedRevision: 0, starts: new Set(), steps: new Map(), submissions: new Set(), overflow: false }
}

export function clearFinalOutput(state: FinalOutputState) {
  state.starts.clear()
  state.steps.clear()
  state.lastStep = undefined
  state.selected = undefined
  state.submissions.clear()
  state.overflow = false
  state.revision = 0
  state.acceptedRevision = 0
}

export function recordFinalStart(state: FinalOutputState, turnId: string) {
  state.starts.add(turnId)
  if (state.starts.size > MAX_TURNS) {
    const oldest = state.starts.values().next().value
    if (oldest !== undefined) state.starts.delete(oldest)
  }
}

export function beginFinalStep(state: FinalOutputState, input: TurnStepInput): FinalStep | undefined {
  if (input.agentId) return undefined
  const previous = state.steps.get(input.turnId)
  if (previous && previous.index > input.index) return undefined
  // Even an unobserved/late start must separate this response from the older
  // main turn. Never bind its append to the previously eligible step.
  state.lastStep = undefined
  state.selected = undefined
  if (!state.starts.has(input.turnId)) return undefined
  const step: FinalStep = { turnId: input.turnId, index: input.index, revision: state.revision, finished: false, complete: false, completionNormal: false, normal: false, responseIds: new Set() }
  state.steps.delete(input.turnId)
  state.steps.set(input.turnId, step)
  if (state.steps.size > MAX_TURNS) {
    const oldest = state.steps.keys().next().value
    if (oldest !== undefined) state.steps.delete(oldest)
  }
  state.lastStep = step
  state.selected = undefined
  return step
}

export function finishFinalStep(state: FinalOutputState, step: FinalStep | undefined, result: TurnStepResult) {
  if (!step || state.steps.get(step.turnId) !== step) return
  step.finished = true
  step.normal = result.stopReason === "end_turn" && result.toolUses.length === 0
}

export function recordFinalResponse(state: FinalOutputState, step: FinalStep | undefined, requestId: string, content: readonly Record<string, unknown>[]) {
  if (!step || state.lastStep !== step || state.steps.get(step.turnId) !== step || step.complete) return
  const ids = new Set<string>()
  // Only exact identities of visible text in the last stored assistant row.
  // Preserve original block positions; never admit a thinking summary by ID.
  for (let index = 0; index < content.length; index++) {
    const block = content[index]
    if (block?.type !== "text" || typeof block.text !== "string" || !block.text.trim()) continue
    ids.add(requestId)
    if (UUID.test(requestId) && ids.size < MAX_RESPONSE_IDS) ids.add(requestId.slice(0, 24) + index.toString(16).padStart(12, "0"))
  }
  step.responseIds = ids
}

export function completeFinalOutput(state: FinalOutputState, step: FinalStep | undefined, input: TurnCompleteInput, queuePending: boolean) {
  if (!step || state.steps.get(input.turnId) !== step || step.complete) return
  step.complete = true
  step.completionNormal = !input.agentId && !input.isAborted && input.reason === "answer" && Boolean(input.answer.trim())
  refreshFinalOutput(state, step, queuePending)
}

export function refreshFinalOutput(state: FinalOutputState, step: FinalStep, queuePending: boolean) {
  if (state.steps.get(step.turnId) !== step || !step.complete || !step.completionNormal || !step.finished || !step.normal || state.lastStep !== step || step.revision < state.acceptedRevision || queuePending || state.submissions.size || state.overflow || !step.responseIds.size) return
  if (state.selected?.step !== step) state.selected = { step, attempted: new Set() }
}

export function beginFinalSubmission(state: FinalOutputState): FinalSubmission | undefined {
  state.selected = undefined
  if (state.revision >= Number.MAX_SAFE_INTEGER || state.submissions.size >= MAX_TURNS) {
    state.overflow = true
    return undefined
  }
  state.revision += 1
  const token = { revision: state.revision }
  state.submissions.add(token)
  return token
}

export function finishFinalSubmission(state: FinalOutputState, token: FinalSubmission | undefined, accepted = false) {
  if (!token || !state.submissions.delete(token)) return false
  if (accepted) state.acceptedRevision = Math.max(state.acceptedRevision, token.revision)
  return true
}

export function takeFinalDisplay(state: FinalOutputState, options: PluginOptions, surface: RenderSurface, requestId: string, summary: boolean): boolean {
  const selected = state.selected
  if (options.output_trigger !== "final" || options.output_mode === "conversation" || summary || !selected || state.submissions.size || state.overflow || selected.step.revision < state.acceptedRevision || !selected.step.responseIds.has(requestId)) return false
  const key = JSON.stringify([surface, requestId])
  if (selected.attempted.has(key) || selected.attempted.size >= MAX_RESPONSE_IDS * 3) return false
  selected.attempted.add(key)
  return true
}
