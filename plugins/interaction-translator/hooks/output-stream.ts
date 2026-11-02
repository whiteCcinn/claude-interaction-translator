import type { TurnStepChunk } from "claude-code"

export const MAX_OUTPUT_BYTES = 262144
export const MAX_OUTPUT_CHUNKS = 10000
const encoder = new TextEncoder()

type TextRun = { index: number; positions: number[]; parts: string[] }
export type OutputPlan = { kind: "text"; text: string; runs: TextRun[]; start: number; markers: string[]; prefix: string }

export function chunkBytes(chunk: TurnStepChunk): number {
  return encoder.encode(JSON.stringify(chunk)).byteLength
}

export function prepareOutput(chunks: readonly TurnStepChunk[], answer: string): OutputPlan | { kind: "empty" | "invalid" } {
  const runs: TextRun[] = []
  let current: TextRun | undefined
  for (const [position, chunk] of chunks.entries()) {
    if (chunk.kind !== "text") {
      current = undefined
      continue
    }
    if (!current || current.index !== chunk.index) {
      current = { index: chunk.index, positions: [], parts: [] }
      runs.push(current)
    }
    current.positions.push(position)
    current.parts.push(chunk.text)
  }
  const texts = runs.map(run => run.parts.join(""))
  const original = texts.join("")
  if (!original.trim()) return { kind: "empty" }

  // A retry can reuse a block index. Locate its completed answer by position,
  // never merge distinct runs merely because their indices match.
  let start = 0
  if (original.trim() !== answer.trim()) {
    if (!answer || !original.endsWith(answer)) return { kind: "invalid" }
    const offset = original.length - answer.length
    let consumed = 0
    while (start < texts.length && consumed < offset) consumed += texts[start++]?.length ?? 0
    if (consumed !== offset) return { kind: "invalid" }
  }
  let prefix = "__PT_BOUNDARY_"
  while (original.includes(prefix)) prefix = "_" + prefix
  const selected = texts.slice(start)
  const markers = selected.slice(1).map((_, index) => `${prefix}${index}__`)
  const text = selected.map((value, index) => index ? `${markers[index - 1]}${value}` : value).join("")
  return { kind: "text", text, runs, start, markers, prefix }
}

export function rewriteOutput(chunks: readonly TurnStepChunk[], plan: OutputPlan, translation: string): TurnStepChunk[] | undefined {
  const pieces: string[] = []
  let cursor = 0
  for (const marker of plan.markers) {
    const position = translation.indexOf(marker, cursor)
    if (position < 0 || translation.indexOf(marker, position + marker.length) >= 0) return undefined
    pieces.push(translation.slice(cursor, position))
    cursor = position + marker.length
  }
  pieces.push(translation.slice(cursor))
  if (pieces.some(piece => piece.includes(plan.prefix))) return undefined

  const replacements = new Map<number, string>()
  for (const [index, run] of plan.runs.entries()) {
    for (const [part, position] of run.positions.entries()) {
      replacements.set(position, index < plan.start || part > 0 ? "" : pieces[index - plan.start] ?? "")
    }
  }
  return chunks.map((chunk, position) => chunk.kind === "text"
    ? { ...chunk, text: replacements.get(position) ?? "" } : chunk)
}

export function failedOutputChunk(chunk: TurnStepChunk, error: string, state: { shown: boolean }): TurnStepChunk {
  if (chunk.kind !== "text") return chunk
  const text = state.shown ? "" : error
  state.shown = true
  return { ...chunk, text }
}
