import type { protectText } from "./protected-text"
import type { TranslationDirection } from "./languages"

type ProtectedText = ReturnType<typeof protectText>
export type ProtectedField = { protectedText: ProtectedText; field: string }
type Piece = string | { id: number; leading: string; trailing: string }
type Segment = { id: number; field: string; text: string }
export type ProtectedBatch = { fields: { pieces: Piece[] }[]; segments: Segment[]; prefixes: string[] }
export const SEGMENT_REJECTION_REASONS = ["responseShape", "unknownId", "textType", "empty", "short", "structure", "control", "placeholder"] as const
export type SegmentRejection = typeof SEGMENT_REJECTION_REASONS[number]
type TextRejection = Exclude<SegmentRejection, "responseShape" | "unknownId">
export type SegmentValidation = {
  expected: number
  observed: number
  missing: number
  duplicate: number
  unexpected: number
  rejected?: Partial<Record<SegmentRejection, number>>
}
export const MAX_TEXT_SEGMENTS = 512
const meaningful = /[\p{L}\p{N}]/u
const inlineCode = /^`[^`\r\n]+`$/
const strandedArticle = /^([ \t]*[.!?][ \t]+)the[ \t]+$/i
// A prefix can contain consecutive markers, such as a quote followed by a
// list marker or a heading followed by a section number.
const spanPrefix = /^[ \t]*(?:(?:#{1,6}|[-+*]|\d+[.)])[ \t]+|>[ \t]*)+/

// Match only local syntax, never protected values. In particular, line endings
// and table pipes must not depend on a model preserving an otherwise empty gap.
// Escaped delimiters stay together so a literal pipe cannot become a table cell.
function structurePattern(): RegExp {
  return /\r\n|[\r\n\t\u2028\u2029]|\\[\\|*_~]|[|*]|__|~~/g
}

export function hasTranslationStructure(text: string): boolean { return structurePattern().test(text) || spanPrefix.test(text) }

function proseSize(text: string): number { return text.replace(/[^\p{L}\p{N}]/gu, "").length }

function segmentTextIssue(segment: Segment, value: string): TextRejection | undefined {
  if (!value) return "empty"
  if (hasTranslationStructure(value)) return "structure"
  // English/French -> CJK may contract heavily. This deliberately generous
  // floor catches near-empty summaries, not arbitrary semantic omissions.
  if (proseSize(value) < Math.ceil(proseSize(segment.text) / 8)) return "short"
}

export function prepareProtectedBatch(fields: readonly ProtectedField[], direction?: TranslationDirection): ProtectedBatch | undefined {
  const plan: ProtectedBatch = { fields: [], segments: [], prefixes: [] }
  const omitStrandedArticle = direction?.source === "en" && (direction.target === "cn" || direction.target === "jp")
  for (const source of fields) {
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
    for (const [gap, raw] of gaps.entries()) {
      const kept = keeps[gap]
      // In "name. The [inline code] ...", the article only introduces the
      // following name. Chinese and Japanese do not need a word before it.
      const sentenceBoundary = omitStrandedArticle && kept !== undefined && inlineCode.test(kept)
        ? strandedArticle.exec(raw)?.[1] : undefined
      if (sentenceBoundary !== undefined) pieces.push(sentenceBoundary)
      else if (!translate) pieces.push(raw)
      else {
        let offset = 0
        const addText = (span: string): boolean => {
          // A numbered heading can begin inside emphasis, e.g. **1. Title**.
          // Identify prefixes after every local delimiter, not just raw lines.
          const prefix = spanPrefix.exec(span)?.[0]
          if (prefix) { pieces.push(prefix); span = span.slice(prefix.length) }
          const leading = /^\s*/u.exec(span)?.[0] ?? ""
          const rest = span.slice(leading.length)
          const trailing = /\s*$/u.exec(rest)?.[0] ?? ""
          const text = rest.slice(0, rest.length - trailing.length)
          // Punctuation, symbols and table-rule cells have no prose. They
          // cannot disappear just because the model skipped a punctuation ID.
          if (!meaningful.test(text)) { pieces.push(span); return true }
          if (plan.segments.length >= MAX_TEXT_SEGMENTS) return false
          const id = plan.segments.length
          plan.segments.push({ id, field: source.field, text })
          pieces.push({ id, leading, trailing })
          return true
        }
        for (const token of raw.matchAll(structurePattern())) {
          if (!addText(raw.slice(offset, token.index))) return undefined
          pieces.push(token[0])
          offset = token.index + token[0].length
        }
        if (!addText(raw.slice(offset))) return undefined
      }
      if (kept !== undefined) pieces.push(kept)
    }
    plan.fields.push({ pieces })
  }
  return plan
}

export function segmentRequest(plan: ProtectedBatch, ids = plan.segments.map(s => s.id)): string {
  const rows = ids.flatMap(id => {
    const segment = plan.segments[id]
    if (!segment) return []
    return [{ id, field: segment.field, text: segment.text }]
  })
  // Present large batches independently so the model cannot treat adjacent
  // records as a sentence and move a phrase across locally retained code.
  // Stable integer mixing makes requests reproducible; IDs alone own assembly.
  if (rows.length >= 8) rows.sort((a, b) => (Math.imul(a.id + 1, 0x9e3779b1) >>> 0) - (Math.imul(b.id + 1, 0x9e3779b1) >>> 0))
  return JSON.stringify(rows)
}

export function parseSegmentResponse(text: string, plan: ProtectedBatch, ids = plan.segments.map(s => s.id)) {
  const expected = new Set(ids)
  const values = new Map<number, string>()
  const conflicts = new Set<number>()
  const seen = new Set<number>()
  const issues = new Map<number, TextRejection>()
  const validation: SegmentValidation = { expected: expected.size, observed: 0, missing: expected.size, duplicate: 0, unexpected: 0 }
  const reject = (issue: SegmentRejection) => {
    validation.unexpected++
    const counts = validation.rejected ??= {}
    counts[issue] = (counts[issue] ?? 0) + 1
  }
  let rows: unknown
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i.exec(text.trim())
  try { rows = JSON.parse(fenced?.[1] ?? text) } catch { /* Classified below. */ }
  if (!Array.isArray(rows)) { reject("responseShape"); return { values, validation, issues } }
  validation.observed = rows.length
  for (const row of rows as unknown[]) {
    if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || !expected.has(row.id)) {
      reject("unknownId")
      continue
    }
    const id = row.id
    if (seen.has(id)) validation.duplicate++
    seen.add(id)
    const rawText = "text" in row && typeof row.text === "string" ? row.text : undefined
    const segment = plan.segments[id]
    if (!segment) { reject("unknownId"); continue }
    const value = rawText?.trim() ?? ""
    let issue: TextRejection | undefined
    if (rawText === undefined) issue = "textType"
    else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(rawText)) issue = "control"
    else if (plan.prefixes.some(prefix => rawText.includes(prefix))) issue = "placeholder"
    else issue = segmentTextIssue(segment, value)
    if (issue) {
      reject(issue)
      issues.set(id, issue)
      conflicts.add(id)
      values.delete(id)
      continue
    }
    if (conflicts.has(id)) continue
    if (values.has(id) && values.get(id) !== value) { conflicts.add(id); values.delete(id) }
    else values.set(id, value)
  }
  validation.missing = ids.filter(id => !values.has(id)).length
  return { values, validation, issues }
}

export function unresolvedSegments(plan: ProtectedBatch, values: ReadonlyMap<number, string>): number[] {
  return plan.segments.filter(segment => segmentTextIssue(segment, values.get(segment.id)?.trim() ?? "")).map(segment => segment.id)
}

export function assembleProtectedBatch(plan: ProtectedBatch, values: ReadonlyMap<number, string>): string[] | undefined {
  if (unresolvedSegments(plan, values).length) return undefined
  return plan.fields.map(field => field.pieces.map(piece => {
    if (typeof piece === "string") return piece
    const text = values.get(piece.id) ?? ""
    return piece.leading + text + piece.trailing
  }).join(""))
}
