import type { EngineInterface, PluginOptions } from "claude-code"
import type { ConfigurationState } from "./configuration-runtime"
import type { protectText } from "./protected-text"
import { assembleProtectedBatch, parseSegmentResponse, prepareProtectedBatch, segmentRequest, unresolvedSegments } from "./protected-segments"
import type { ProtectedField } from "./protected-segments"
import { requestTranslation, translationFailure } from "./translation-client"
import type { TranslationResult } from "./translation-client"
import { diagnosticTime } from "./translation-diagnostics"
import { DEFAULT_CODEX_TIMEOUT_SECONDS } from "./configuration"

const SEGMENT_INSTRUCTIONS = [
  "Translate a JSON array of numbered prose gaps. Return only a JSON array of {id,text}, with every requested id exactly once, including empty text values.",
  "Each group is one field. Read context only to understand grammar; translate the text values and distribute prose across gaps within that group as needed. Never move content between groups.",
  "Protected code, paths, URLs and boundary nodes are retained by the program between gaps. Do NOT return placeholders, protected nodes, context, or accepted records; they are not part of any translated text value.",
  "Keep Markdown and line breaks. Do not add surrounding whitespace: the program retains the original spacing. Keep header fields concise (at most 12 characters).",
  "On a repair request, return only the requested unresolved ids and preserve the already accepted translations shown as read-only context. Never output an empty translation for an entire nonempty prose field.",
].join("\n")

export async function translateProtectedFields($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, prompt: string, fields: readonly ProtectedField[], maxTokens: number, signal: AbortSignal): Promise<{ texts: string[] } | Exclude<TranslationResult, { text: string }>> {
  if (signal.aborted) return { drop: "Translation cancelled; this text was not forwarded." }
  const plan = prepareProtectedBatch(fields)
  if (!plan) return translationFailure({ kind: "capacity" })
  const values = new Map<number, string>()
  if (!plan.segments.length) {
    const texts = assembleProtectedBatch(plan, values)
    return texts ? { texts } : translationFailure({ kind: "unknown" })
  }
  let ids = plan.segments.map(s => s.id)
  let startedAt: number | undefined
  const configuredSeconds = typeof options.codex_timeout_seconds === "number" ? options.codex_timeout_seconds : DEFAULT_CODEX_TIMEOUT_SECONDS
  let last = { expected: ids.length, observed: 0, missing: ids.length, duplicate: 0, unexpected: 0 }
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
    // Start the first request before awaiting its diagnostic clock so a
    // prioritized question cannot be overtaken by a plain assistant request.
    const pending = requestTranslation($, options, configuration, `${prompt}\n${SEGMENT_INSTRUCTIONS}`, segmentRequest(plan, ids, values), Math.min(8192, maxTokens + ids.length * 24), signal, remainingMs)
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
    for (const id of ids) values.delete(id)
  }
  return translationFailure({ kind: "segments", validation: { ...last, expected: plan.segments.length, observed: values.size, missing: ids.length } })
}

export async function translateProtectedText($: EngineInterface, options: PluginOptions, configuration: ConfigurationState, prompt: string, protectedText: ReturnType<typeof protectText>, maxTokens: number, signal: AbortSignal): Promise<TranslationResult> {
  if (!protectedText.values.length) return requestTranslation($, options, configuration, prompt, protectedText.text, maxTokens, signal)
  const result = await translateProtectedFields($, options, configuration, prompt, [{ protectedText, field: "prose" }], maxTokens, signal)
  if (!("texts" in result)) return result
  return result.texts[0] === undefined ? translationFailure({ kind: "unknown" }) : { text: result.texts[0] }
}
