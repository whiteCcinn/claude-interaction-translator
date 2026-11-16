import type { protectText } from "./protected-text"

type ProtectedText = ReturnType<typeof protectText>
export type ProtectedField = { protectedText: ProtectedText; field: string }
type Piece = string | { id: number; leading: string; trailing: string; hadText: boolean }
type Segment = { id: number; group: number; gap: number; field: string; text: string }
export type ProtectedBatch = { fields: { protectedText: ProtectedText; pieces: Piece[]; ids: number[] }[]; segments: Segment[]; prefixes: string[] }
export type SegmentValidation = { expected: number; observed: number; missing: number; duplicate: number; unexpected: number }
export const MAX_TEXT_SEGMENTS = 512
const meaningful = /[\p{L}\p{N}]/u

export function prepareProtectedBatch(fields: readonly ProtectedField[]): ProtectedBatch | undefined {
  const plan: ProtectedBatch = { fields: [], segments: [], prefixes: [] }
  for (const [group, source] of fields.entries()) {
    const p = source.protectedText
    if (!p.prefix) return undefined
    plan.prefixes.push(p.prefix)
    const escaped = p.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const regex = new RegExp(escaped + "(0|[1-9]\\d*)__", "g")
    const gaps: string[] = []
    const keeps: string[] = []
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(p.text)) !== null) {
      const value = p.values[Number(match[1])]
      if (value === undefined) return undefined
      gaps.push(p.text.slice(cursor, match.index))
      keeps.push(value)
      cursor = regex.lastIndex
    }
    gaps.push(p.text.slice(cursor))
    if (keeps.length !== p.values.length) return undefined
    const translate = gaps.some(gap => meaningful.test(gap))
    const pieces: Piece[] = []
    const ids: number[] = []
    for (const [gap, raw] of gaps.entries()) {
      if (!translate) pieces.push(raw)
      else {
        if (plan.segments.length >= MAX_TEXT_SEGMENTS) return undefined
        const leading = /^\s*/u.exec(raw)?.[0] ?? ""
        const rest = raw.slice(leading.length)
        const trailing = /\s*$/u.exec(rest)?.[0] ?? ""
        const text = rest.slice(0, rest.length - trailing.length)
        const id = plan.segments.length
        plan.segments.push({ id, group, gap, field: source.field, text })
        pieces.push({ id, leading, trailing, hadText: Boolean(text) })
        ids.push(id)
      }
      const kept = keeps[gap]
      if (kept !== undefined) pieces.push(kept)
    }
    plan.fields.push({ protectedText: p, pieces, ids })
  }
  return plan
}

export function segmentRequest(plan: ProtectedBatch, ids = plan.segments.map(s => s.id), accepted: ReadonlyMap<number, string> = new Map()): string {
  const seen = new Set<number>()
  return JSON.stringify(ids.flatMap(id => {
    const segment = plan.segments[id]
    if (!segment) return []
    const first = !seen.has(segment.group)
    seen.add(segment.group)
    return [{ ...segment, ...(first ? {
      context: plan.fields[segment.group]?.protectedText.text,
      ...(accepted.size ? { accepted: plan.segments.filter(s => s.group === segment.group && accepted.has(s.id)).map(s => ({ id: s.id, text: accepted.get(s.id) })) } : {}),
    } : {}) }]
  }))
}

export function parseSegmentResponse(text: string, plan: ProtectedBatch, ids = plan.segments.map(s => s.id)) {
  const expected = new Set(ids)
  const values = new Map<number, string>()
  const conflicts = new Set<number>()
  const seen = new Set<number>()
  const validation: SegmentValidation = { expected: expected.size, observed: 0, missing: expected.size, duplicate: 0, unexpected: 0 }
  let rows: unknown
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i.exec(text.trim())
  try { rows = JSON.parse(fenced?.[1] ?? text) } catch { validation.unexpected = 1; return { values, validation } }
  if (!Array.isArray(rows)) { validation.unexpected = 1; return { values, validation } }
  validation.observed = rows.length
  for (const row of rows as unknown[]) {
    if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || !expected.has(row.id)) {
      validation.unexpected++
      continue
    }
    const id = row.id
    if (seen.has(id)) validation.duplicate++
    seen.add(id)
    const rawText = "text" in row && typeof row.text === "string" ? row.text : undefined
    if (rawText === undefined || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rawText) || plan.prefixes.some(prefix => rawText.includes(prefix))) {
      validation.unexpected++
      conflicts.add(id)
      values.delete(id)
      continue
    }
    const value = rawText.trim()
    if (conflicts.has(id)) continue
    if (values.has(id) && values.get(id) !== value) { conflicts.add(id); values.delete(id) }
    else values.set(id, value)
  }
  validation.missing = ids.filter(id => !values.has(id)).length
  return { values, validation }
}

export function unresolvedSegments(plan: ProtectedBatch, values: ReadonlyMap<number, string>): number[] {
  const missing = new Set(plan.segments.filter(s => !values.has(s.id)).map(s => s.id))
  for (const field of plan.fields) {
    if (field.ids.length && field.ids.every(id => values.has(id)) && !meaningful.test(field.ids.map(id => values.get(id) ?? "").join(""))) {
      for (const id of field.ids) missing.add(id)
    }
  }
  return [...missing].sort((a, b) => a - b)
}

export function assembleProtectedBatch(plan: ProtectedBatch, values: ReadonlyMap<number, string>): string[] | undefined {
  if (unresolvedSegments(plan, values).length) return undefined
  return plan.fields.map(field => field.pieces.map(piece => {
    if (typeof piece === "string") return piece
    const text = values.get(piece.id) ?? ""
    if (!text && piece.hadText) return (piece.leading + piece.trailing).replace(/[^\r\n]/g, "")
    return piece.leading + text + piece.trailing
  }).join(""))
}
