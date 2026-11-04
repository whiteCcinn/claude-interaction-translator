import { update } from "claude-code"
import type { EngineInterface } from "claude-code"

import type { PreparedInput } from "../types"

const INPUTS = { plugin: "interaction-translator", key: "preparedInputs" } as const
export const MAX_PREPARED_INPUTS = 32
export const MAX_PREPARED_BYTES = 2 * 1024 * 1024
const encoder = new TextEncoder()

// Include claimed rows until their successful storage releases the handoff.
// Unconsumed entries survive hot reload and conservatively cover queued input.
export async function hasPendingPreparedInputs($: EngineInterface): Promise<boolean> {
  const state = await $.state.get(INPUTS)
  return Boolean(state.value?.pending.length)
}

// Host session state survives hot reload, without writing prompt copies to disk.
// update uses versioned writes so concurrent submissions cannot lose each other.
export async function prepareInput($: EngineInterface, source: string, translated: string, target: string): Promise<PreparedInput | undefined> {
  let prepared: PreparedInput | undefined
  await update($, INPUTS, held => {
    const state = held ?? { serial: 0, pending: [] }
    prepared = undefined
    if (state.pending.length >= MAX_PREPARED_INPUTS || state.serial >= Number.MAX_SAFE_INTEGER || source.length + translated.length > MAX_PREPARED_BYTES) return state
    const existing = state.pending.find(entry => entry.source === source)
    if (existing && existing.target !== target) return state
    // No native submission ID survives into append. Reuse one wording while
    // identical originals are pending, so queue reordering is harmless.
    const entry = { id: state.serial + 1, source, translated: existing?.translated ?? translated, target }
    const next = { serial: entry.id, pending: [...state.pending, entry] }
    if (encoder.encode(JSON.stringify(next)).byteLength > MAX_PREPARED_BYTES) return state
    prepared = entry
    return next
  })
  return prepared
}

export async function takePreparedInput($: EngineInterface, sources: readonly string[], rowId: string): Promise<PreparedInput | undefined> {
  const allowed = new Set(sources)
  let prepared: PreparedInput | undefined
  await update($, INPUTS, held => {
    const state = held ?? { serial: 0, pending: [] }
    prepared = undefined
    const claimed = state.pending.find(entry => entry.rowId === rowId)
    const matches = state.pending.filter(entry => !entry.rowId && allowed.has(entry.source))
    const first = claimed ?? matches[0]
    if (!first || !allowed.has(first.source) || matches.some(entry => entry.source !== first.source)) return state
    const entry = { ...first, rowId }
    prepared = entry
    return { ...state, pending: state.pending.map(held => held.id === first.id ? entry : held) }
  })
  return prepared
}

export async function discardPreparedInput($: EngineInterface, id: number) {
  await update($, INPUTS, held => ({ serial: held?.serial ?? 0, pending: (held?.pending ?? []).filter(entry => entry.id !== id) }))
}

export async function clearPreparedInputs($: EngineInterface) {
  await update($, INPUTS, held => ({ serial: held?.serial ?? 0, pending: [] }))
}
