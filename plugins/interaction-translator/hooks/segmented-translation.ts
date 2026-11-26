import type { EngineInterface, PluginOptions } from "claude-code"
import type { ConfigurationState } from "./configuration-runtime"
import type { TranslationDirection } from "./languages"
import type { protectText } from "./protected-text"
import { assembleProtectedBatch, hasTranslationStructure, parseSegmentResponse, prepareProtectedBatch, segmentRequest, unresolvedSegments } from "./protected-segments"
import type { ProtectedField, SegmentRejection, SegmentValidation } from "./protected-segments"
import { requestTranslation, translationFailure } from "./translation-client"
import type { TranslationResult } from "./translation-client"
import { diagnosticTime } from "./translation-diagnostics"
import { DEFAULT_CODEX_TIMEOUT_SECONDS } from "./configuration"

const SEGMENT_INSTRUCTIONS = [
  "Translate ALL content of EACH text value faithfully. Never summarize, omit, merge or move prose between ids. Every requested span must have a nonempty translation; a span containing words must retain words, not just punctuation.",
  "Translate each requested text value itself as an independent fragment. Some spans are sentence fragments: use a colon or appositional phrasing if needed to fit the SAME span. Do not reconstruct a full sentence, guess adjacent protected contents or change grammatical roles.",
  "Protected code, paths, URLs, boundary nodes, Markdown delimiters and line breaks are retained by the program between spans. Do NOT return placeholders, protected nodes, context, or accepted records; they are not part of any translated text value.",
  "Use ellipses only for ellipses already in the source fragment. When a predicate takes an adjacent restored value, phrase it so that the value can follow directly without an ellipsis or blank standing in for it.",
  "Do not return line breaks, table pipes or emphasis delimiters inside text values. Do not add surrounding whitespace: the program retains the original spacing. Keep header fields concise (at most 12 characters).",
  "On a repair request, return only the requested unresolved ids. Other translations are retained locally and must not be repeated.",
].join("\n")

const SCHEMA_REPAIR_INSTRUCTIONS = "The previous response was not a readable batch. Preserve each fragment's action and object even when it ends with a preposition before hidden code. For example, translate all of 'checks the configuration with', including 'checks the configuration', rather than just 'with'."
const CHINESE_PREDICATE_EXAMPLES = "\nFor Simplified Chinese predicates immediately before protected values, use ‘位于’ for ‘is in’ and ‘前缀为’ for ‘starts with’."

const REPAIR_GUIDANCE: Record<Exclude<SegmentRejection, "responseShape" | "unknownId">, string> = {
  textType: "return the translation as a JSON string",
  empty: "return a nonempty translation of all the source prose",
  short: "translate the complete source without abbreviating or summarizing it",
  structure: "return plain text on one line without Markdown or table delimiters",
  control: "remove control characters",
  placeholder: "translate only the source prose and omit placeholders",
  ellipsis: "remove added ellipses by rephrasing the fragment so the restored value can follow directly",
}

export async function translateProtectedFields($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, prompt: string, fields: readonly ProtectedField[], maxTokens: number, signal: AbortSignal, direction?: TranslationDirection): Promise<{ texts: string[] } | Exclude<TranslationResult, { text: string }>> {
  if (signal.aborted) return { drop: "Translation cancelled; this text was not forwarded." }
  const plan = prepareProtectedBatch(fields, direction)
  if (!plan) return translationFailure({ kind: "capacity" })
  const values = new Map<number, string>()
  if (!plan.segments.length) {
    const texts = assembleProtectedBatch(plan, values)
    return texts ? { texts } : translationFailure({ kind: "unknown" })
  }
  let ids = plan.segments.map(s => s.id)
  let startedAt: number | undefined
  const configuredSeconds = typeof options.codex_timeout_seconds === "number" ? options.codex_timeout_seconds : DEFAULT_CODEX_TIMEOUT_SECONDS
  let last: SegmentValidation = { expected: ids.length, observed: 0, missing: ids.length, duplicate: 0, unexpected: 0 }
  let repairGuidance = ""
  let repairWithSchema = false
  const predicateExamples = direction?.target === "cn" ? CHINESE_PREDICATE_EXAMPLES : ""
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return { drop: "Translation cancelled; this text was not forwarded." }
    let remainingMs: number | undefined
    if (attempt > 0 && options.backend === "codex-cli" && startedAt !== undefined) {
      const now = await diagnosticTime($)
      if (now !== undefined) {
        remainingMs = Math.floor(configuredSeconds * 1000 - (now - startedAt))
        if (remainingMs <= 0) return translationFailure({ kind: "timeout", seconds: configuredSeconds })
      }
    }
    const started = attempt === 0 ? diagnosticTime($) : undefined
    const responseFormat = repairWithSchema
      ? 'Return only a JSON object with a single "segments" array of {id,text}, with every requested id exactly once.'
      : "Return only a JSON array of {id,text}, with every requested id exactly once."
    const instructions = `${prompt}\nTranslate a JSON array of numbered nonempty prose spans. ${responseFormat}\n${SEGMENT_INSTRUCTIONS}${predicateExamples}${repairGuidance}`
    // Start the first request before awaiting its diagnostic clock so a
    // prioritized question cannot be overtaken by a plain assistant request.
    const pending = requestTranslation($, options, configuration, instructions, segmentRequest(plan, ids), Math.min(8192, maxTokens + ids.length * 24), signal, { remainingMs, segmentSchema: repairWithSchema })
    if (started) startedAt = await started
    const result = await pending
    if ("drop" in result) return result
    if (signal.aborted) return { drop: "Translation cancelled; this text was not forwarded." }
    const parsed = parseSegmentResponse(result.text, plan, ids)
    last = parsed.validation
    for (const [id, text] of parsed.values) values.set(id, text)
    ids = unresolvedSegments(plan, values)
    const texts = assembleProtectedBatch(plan, values)
    if (texts) return { texts }
    if (attempt === 0 && options.backend === "codex-cli" && last.rejected?.responseShape === 1) {
      repairWithSchema = true
      repairGuidance = "\n" + SCHEMA_REPAIR_INSTRUCTIONS
    } else if (attempt === 0 && parsed.issues.size) {
      const byReason = new Map<keyof typeof REPAIR_GUIDANCE, number[]>()
      for (const [id, issue] of parsed.issues) {
        const group = byReason.get(issue)
        if (group) group.push(id)
        else byReason.set(issue, [id])
      }
      const corrections = [...byReason].map(([issue, group]) =>
        `${group.length === 1 ? "ID" : "IDs"} ${group.join(", ")}: ${REPAIR_GUIDANCE[issue]}.`)
      repairGuidance = "\nCorrect these validation errors in this request:\n" + corrections.join("\n")
    }
    for (const id of ids) values.delete(id)
  }
  return translationFailure({ kind: "segments", validation: { ...last, expected: plan.segments.length, observed: values.size, missing: ids.length } })
}

export function protectedTextFormat(protectedText: ReturnType<typeof protectText>): "text" | "segments" {
  return protectedText.values.length || hasTranslationStructure(protectedText.text) ? "segments" : "text"
}

export async function translateProtectedText($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, prompt: string, protectedText: ReturnType<typeof protectText>, maxTokens: number, signal: AbortSignal, direction?: TranslationDirection): Promise<TranslationResult> {
  if (protectedTextFormat(protectedText) === "text") return requestTranslation($, options, configuration, prompt, protectedText.text, maxTokens, signal)
  const result = await translateProtectedFields($, options, configuration, prompt, [{ protectedText, field: "prose" }], maxTokens, signal, direction)
  if (!("texts" in result)) return result
  return result.texts[0] === undefined ? translationFailure({ kind: "unknown" }) : { text: result.texts[0] }
}
