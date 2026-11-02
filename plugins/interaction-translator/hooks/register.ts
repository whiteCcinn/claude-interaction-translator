import type { On, PluginOptions, TurnStepChunk, TurnStepResult } from "claude-code"
import { LANGUAGES, languageSettings, outputFailure, translationPrompt } from "./languages"
import { protectText, restoreText } from "./protected-text"
import { chunkBytes, failedOutputChunk, MAX_OUTPUT_BYTES, MAX_OUTPUT_CHUNKS, prepareOutput, rewriteOutput } from "./output-stream"
import { clearFeedback, startFeedback, finishFeedback } from "./translation-feedback"
import type { FeedbackState } from "./translation-feedback"
import { DEFAULT_API_MODEL } from "./configuration"
import { configurationTarget, initializeConfiguration } from "./configuration-runtime"
import type { ConfigurationState } from "./configuration-runtime"
import { requestTranslation, TRANSLATION_FAILURE as FAILURE } from "./translation-client"
import { clearDisplay, createDisplayState, displayCodeOnly, displayEntry, displayOnly, displaySourceAllowed, displayStatus, hideDisplay, incompleteCode, retryDisplay, scheduleDisplay } from "./display-translation"

export { LANGUAGES, languageCode, translationPrompt } from "./languages"
export { protectText, restoreText } from "./protected-text"

const BYPASS = /^\s*(?:[!/#]\S*|\/(?:translate|locale)\b)/i
const MODEL = DEFAULT_API_MODEL
export { envToken, translatedText } from "./translation-client"

export function register(on: On, options: PluginOptions) {
  const useCodex = options.backend === "codex-cli"
  const languages = languageSettings(options)
  const code = languages.prompt
  const feedback: FeedbackState = { interactive: false }
  const configuration: ConfigurationState = {}
  const display = createDisplayState(feedback)
  const interruptedDrains = new Set<string>()

  on("command.run", { command: /^(?:plugin|config)$/ }, async ($, e, next) => {
    const target = configurationTarget(e.command, e.args, $.plugin.name)
    if (target === undefined) return next(e)
    let warning: string | undefined
    try { await initializeConfiguration($, configuration, target) }
    catch { warning = "无法初始化翻译配置。请检查当前安装来源的配置后重试；旧值未被清空。" }
    const result = await next(e)
    return warning ? { ...result, text: [warning, result.text].filter(Boolean).join("\n") } : result
  })

  on("session.start", ($, e, next) => {
    feedback.interactive = e.isInteractive
    if (!e.isInteractive && feedback.current) clearFeedback($, feedback)
    return next(e)
  })

  on("session.end", ($, e, next) => {
    clearDisplay(display)
    if (feedback.current) clearFeedback($, feedback)
    return next(e)
  })

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (!displayOnly(options) || languages.reply === languages.output) return next(e)
    if (!e.props.text.trim() || e.props.onScreen === null || (displaySourceAllowed(e.props.text) && (incompleteCode(e.props.text) || displayCodeOnly(e.props.text)))) {
      hideDisplay(display, e.surface, e.requestId, Boolean(e.props.isSummary), languages.output)
      return next(e)
    }
    feedback.interactive = true
    const entry = displayEntry(display, e.surface, e.requestId, e.props.text, Boolean(e.props.isSummary), languages.output)
    if (entry?.phase === "ready" && entry.translated !== undefined) return next({ ...e, props: { ...e.props, text: entry.translated } })
    scheduleDisplay($, options, configuration, display, languages.reply, languages.output)
    const { Box, Text, Button } = $.ui.resolve(e)
    const failed = entry?.phase === "error" || !displaySourceAllowed(e.props.text) || (!entry && !display.pending.size && !display.running.size)
    const children = [Text({ color: failed ? "red" : "cyan", children: [displayStatus(languages.output, failed)] })]
    if (entry?.phase === "error") children.push(Button({
      key: "retry-output-translation", label: languages.output === "cn" ? "重试翻译" : "Retry translation",
      onPress: () => retryDisplay($, options, configuration, display, entry, languages.reply, languages.output),
    }))
    return Box({ flexDirection: "column", children })
  })

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    // A reload can happen after session.start; a shown prompt is also evidence.
    feedback.interactive = true
    const current = feedback.current
    if (!current || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const stage = current.stage === "input" ? "输入翻译" : "输出翻译"
    const target = LANGUAGES[current.target]
    const color = current.phase === "error" ? "red" : current.phase === "done" ? "green" : "cyan"
    const translatorLabel = useCodex ? "Codex CLI" : configuration.resolved?.model ?? MODEL
    const title = current.phase === "loading"
      ? `${stage}中${[".", "..", "..."][current.frame % 3]}  ${current.elapsed.toFixed(1)} 秒 · ${target.label} (${current.target}) · ${translatorLabel}`
      : current.phase === "done" ? `✓ ${stage}完成 · ${target.label} (${current.target}) · ${current.elapsed.toFixed(1)} 秒`
        : `× ${stage}失败 · ${current.stage === "input" ? "原文未发送" : "未显示原文"}`
    const content = [Text({ color, children: [title], wrap: "truncate-end" })]
    if (current.detail && e.props.maxRows >= 4) content.push(Text({ dimColor: true, children: [current.detail], wrap: "truncate-end" }))
    const compact = e.props.bodyColumns < 32 || e.props.maxRows < 3
    return Box({
      flexDirection: "column",
      children: [
        await next(e),
        Box({ flexDirection: "column", borderStyle: compact ? undefined : "round", borderColor: color, paddingX: compact ? 0 : 1, children: content }),
      ],
    })
  })

  on("prompt.submit", async ($, e, next) => {
    if (e.origin.kind === "composer") {
      feedback.interactive = true
      clearFeedback($, feedback)
    }
    if (
      (e.origin.kind !== "composer" && e.origin.kind !== "sdk") ||
      !e.text.trim() ||
      BYPASS.test(e.text)
    ) return next(e)

    let translated: string | undefined
    const leadingTag = /^[A-Z][A-Z0-9_-]{2,}:[ \t]*/.exec(e.text)?.[0] ?? ""
    const protectedText = protectText(e.text.slice(leadingTag.length))
    let errorHint = "请检查网络后重试。"
    const current = e.origin.kind === "composer"
      ? await startFeedback($, feedback, "input", languages.input, code, next.signal) : undefined
    try {
      if (next.signal.aborted) return { drop: "Translation cancelled; this prompt was not sent." }
      const result = await requestTranslation($, options, configuration, translationPrompt(code, languages.input), protectedText.text, 1024, next.signal)
      if ("drop" in result) {
        errorHint = result.hint ?? (useCodex ? "请检查 Codex CLI 路径、登录状态和配置（超时 120 秒）。" : errorHint)
        return { drop: result.drop }
      }
      translated = result.text
      if (next.signal.aborted) {
        errorHint = "翻译已取消。"
        translated = undefined
        return { drop: "Translation cancelled; this prompt was not sent." }
      }
      if (!translated) return { drop: FAILURE }
      translated = restoreText(translated, protectedText)
      if (!translated) {
        errorHint = "路径、链接或代码未完整保留，请重试。"
        return { drop: "The translation did not preserve protected paths or code. This prompt was not sent; retry." }
      }
      const introducedPrefix = /^[!/#]\S*/.exec(translated)?.[0]
      const originalAtStart = protectedText.values.some(value => translated?.startsWith(value))
      if (introducedPrefix && !e.text.includes(introducedPrefix) && !originalAtStart) {
        errorHint = "译文出现额外命令前缀，请重试。"
        translated = undefined
        return { drop: "The translation introduced a command prefix. This prompt was not sent; retry." }
      }
      translated = leadingTag + translated

      return next({
        ...e,
        text: translated,
        context: [...(e.context ?? []), `Reply in natural ${LANGUAGES[languages.reply].name}. Keep commands, paths, URLs, identifiers, and product names unchanged.`],
      })
    } catch {
      translated = undefined
      return { drop: FAILURE }
    } finally {
      await finishFeedback($, feedback, current, Boolean(translated), translated ?? errorHint)
    }
  }).catch((_, e, next) => {
    return next.called ? next(e) : { drop: FAILURE }
  })

  on("turn.step", async function* ($, e, next) {
    if (displayOnly(options)) {
      display.activeSteps += 1
      try { return yield* next(e) }
      finally {
        display.activeSteps -= 1
        if (feedback.interactive) $.ui.invalidate("ui.render")
      }
    }
    if (e.agentId || languages.reply === languages.output) return yield* next(e)
    const stream = next(e)
    const chunks: TurnStepChunk[] = []
    const error = outputFailure(languages.output)
    const failure = { shown: false }
    let bytes = 0
    let overflow = false
    let overflowErrors = 0
    let separated = false
    let result: TurnStepResult
    try {
      for await (const chunk of stream) {
        if (next.signal.aborted) continue
        if (overflow) {
          if (chunk.kind !== "text") {
            separated = true
            yield chunk
            continue
          }
          // An opaque boundary may withdraw the previous attempt. Keep an error
          // visible in a later text run too, without retaining its source text.
          if (separated) failure.shown = false
          const replacement = failedOutputChunk(chunk, error, failure)
          if (replacement.kind === "text" && replacement.text) overflowErrors += 1
          yield replacement
          separated = false
          continue
        }
        chunks.push(chunk)
        bytes += chunkBytes(chunk)
        if (bytes > MAX_OUTPUT_BYTES || chunks.length > MAX_OUTPUT_CHUNKS) {
          overflow = true
          const lastText = chunks.findLastIndex(held => held.kind === "text")
          for (const [position, held] of chunks.entries()) {
            yield held.kind === "text" && position !== lastText ? { ...held, text: "" } : failedOutputChunk(held, error, failure)
          }
          overflowErrors = failure.shown ? 1 : 0
          separated = chunks.at(-1)?.kind !== "text"
          chunks.length = 0
        }
      }
      result = await stream.result
    } catch (cause) {
      if (overflow) interruptedDrains.add(JSON.stringify([e.agentId, e.turnId, e.index]))
      throw cause
    }
    if (next.signal.aborted) return { ...result, answer: "" }
    if (overflow) return { ...result, answer: error.repeat(overflowErrors) }
    const plan = prepareOutput(chunks, result.answer)
    if (plan.kind === "empty") {
      for (const chunk of chunks) yield chunk
      return result
    }
    let rewritten: TurnStepChunk[] | undefined
    if (plan.kind === "text") {
      const protectedText = protectText(plan.text, plan.markers)
      if (next.signal.aborted) return { ...result, answer: "" }
      const current = await startFeedback($, feedback, "output", languages.reply, languages.output, next.signal)
      try {
        const translated = await requestTranslation($, options, configuration,
          translationPrompt(languages.output, languages.reply, "response"), protectedText.text, 8192, next.signal)
        if (next.signal.aborted) return { ...result, answer: "" }
        if ("text" in translated) {
          const restored = restoreText(translated.text, protectedText)
          if (restored !== undefined) rewritten = rewriteOutput(chunks, plan, restored)
        }
      } finally {
        await finishFeedback($, feedback, current, rewritten !== undefined, rewritten ? undefined : error)
      }
    }
    const lastText = chunks.findLastIndex(chunk => chunk.kind === "text")
    const output = rewritten ?? chunks.map((chunk, position) => chunk.kind === "text"
      ? { ...chunk, text: position === lastText ? error : "" } : chunk)
    for (const chunk of output) {
      if (next.signal.aborted) return { ...result, answer: "" }
      yield chunk
    }
    return { ...result, answer: output.filter(chunk => chunk.kind === "text").map(chunk => chunk.text).join("") }
  }).catch(async function* (_, e, next) {
    if (displayOnly(options)) throw new Error(next.error.message ?? "Claude response interrupted during display-only passthrough.")
    if (e.agentId || languages.reply === languages.output) {
      throw new Error("Claude response interrupted during output passthrough.")
    }
    if (interruptedDrains.delete(JSON.stringify([e.agentId, e.turnId, e.index]))) {
      // Protocol chunks already left during bounded draining. Preserve failure;
      // inventing a normal stop here could complete an unfinished tool call.
      throw new Error("Claude response interrupted after the output buffer limit.")
    }
    // Replaying a rejected host stream can call the model again. No partial
    // chunks left the normal buffering path, so replace it with an error only.
    const text = next.signal.aborted ? "" : outputFailure(languages.output)
    if (text) {
      yield { kind: "text", index: 0, text }
      yield { kind: "stop", stopReason: "end_turn", usage: null }
    }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: "end_turn", usage: null }
  })
}
