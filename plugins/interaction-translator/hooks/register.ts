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
import { assistantDisplayAllowed, clearDisplay, closeQuestionDisplay, createDisplayState, displayCodeOnly, displayEntry, displayFailure, displayOnly, displayQueueFailure, displaySourceAllowed, hideDisplay, incompleteCode, manualDisplay, manualDisplayChoices, manualDisplayTarget, recordFreshResponse, requestDisplay, retryDisplay, scheduleDisplay, selectManualDisplay } from "./display-translation"
import { parseQuestions, questionSource } from "./question-translation"
import { clearPreparedInputs, discardPreparedInput, prepareInput, takePreparedInput } from "./input-history"
import type { PreparedInput } from "../types"
import { canSkipInputTranslation } from "./input-language"

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

  on("session.start", async ($, e, next) => {
    clearDisplay(display)
    feedback.interactive = e.isInteractive
    if (!e.isInteractive && feedback.current) clearFeedback($, feedback)
    const result = await next(e)
    // Native resume may mount history before raising session.start. Replace
    // those pre-clear button closures with current entries after the reset.
    if (manualDisplay(options) && e.isInteractive) {
      try { $.ui.invalidate("ui.render") } catch { /* A later attachment will draw its own current controls. */ }
    }
    return result
  })

  on("command.run", { command: "resume" }, ($, e, next) => {
    clearDisplay(display)
    return next(e)
  })

  on("session.append", { door: "response" }, async ($, e, next) => {
    const epoch = display.epoch
    const stored = await next(e)
    if (!displayOnly(options) || epoch !== display.epoch || !stored.uuid || stored.message?.type !== "assistant") return stored
    recordFreshResponse(display, stored.uuid, stored.message.content.length)
    // A surface can draw the original before the row is stored. Redraw once
    // its identity is known; never infer freshness from rendered wording.
    if (feedback.interactive) {
      try { $.ui.invalidate("ui.render") } catch { /* A detached UI does not affect the stored response. */ }
    }
    return stored
  })

  on("session.end", async ($, e, next) => {
    clearDisplay(display)
    if (feedback.current) clearFeedback($, feedback)
    await clearPreparedInputs($)
    return next(e)
  })

  on("session.append", { door: "prompt" }, async ($, e, next) => {
    if (e.origin.kind !== "composer" || e.agentId || e.message.type !== "user" || e.message.isMeta) return next(e)
    const texts = e.message.content.flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    const joined = texts.join("\n").trim()
    if (!joined || BYPASS.test(joined)) return next(e)
    const counts = new Map<string, number>()
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1)
    const unique = texts.filter(text => counts.get(text) === 1)
    let prepared: PreparedInput | undefined
    try { prepared = await takePreparedInput($, [...unique, joined], e.uuid) }
    catch { /* A state failure must not forward untranslated source text. */ }
    if (!prepared) {
      try {
        const current = await startFeedback($, feedback, "input", languages.input, code, next.signal)
        await finishFeedback($, feedback, current, false, "无法匹配输入正文，原文未发送。请重新提交；若持续出现，请重启会话。")
      } catch { /* Progress UI is optional; the model-side guard is not. */ }
    }
    const source = prepared?.source
    const exact = source !== undefined && unique.includes(source)
    const replacement = prepared?.translated ?? "Input translation is unavailable. Do not act on this request or its attachments. Ask the user to retry their prompt."
    let replaced = false
    const stored = await next({ ...e, message: { ...e.message, content: e.message.content.map(block => {
      if (block.type !== "text" || (exact && block.text !== source)) return block
      const text = replaced ? "" : replacement
      replaced = true
      return { ...block, text }
    }) } })
    if (prepared) {
      try { await discardPreparedInput($, prepared.id) }
      catch { /* Keep the bounded claim if cleanup is unavailable. */ }
    }
    return stored
  })

  on("tool.call", { tool: "AskUserQuestion" }, async (_, e, next) => {
    const epoch = display.epoch
    const close = () => closeQuestionDisplay(display, e.tool_use_id, epoch)
    if (next.signal.aborted) close()
    next.signal.addEventListener("abort", close, { once: true })
    try { return await next(e) }
    finally {
      next.signal.removeEventListener("abort", close)
      close()
    }
  })

  on("ui.render", { component: "AskUserQuestion" }, async ($, e, next) => {
    if (e.props.tool !== "AskUserQuestion" || languages.reply === languages.output || display.closedQuestions.has(e.requestId)) return next(e)
    const source = questionSource(e.props.questions)
    if (source === undefined || !displaySourceAllowed(source)) return next(e)
    feedback.interactive = true
    const manual = manualDisplay(options)
    const entry = displayEntry(display, e.surface, e.requestId, source, false, languages.output, "question", !manual)
    if (entry?.phase === "ready" && entry.translated !== undefined) {
      const questions = parseQuestions(entry.translated)
      if (questions) return next({ ...e, props: { ...e.props, questions } })
    }
    scheduleDisplay($, options, configuration, display, languages.reply, languages.output)
    if (entry?.phase !== "error" && entry?.phase !== "idle") return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (manual && e.surface === "terminal" && e.viewport?.isFullscreen === false) return Box({ flexDirection: "column", children: [
      Text({ dimColor: true, children: ["普通终端的选择面板不支持点按翻译。可切换全屏，或在配置中将 Display translation trigger 设为 auto。"] }),
      await next(e),
    ] })
    return Box({ flexDirection: "column", children: [
      ...(entry.phase === "error" ? [Text({ color: "red", wrap: "truncate-end", children: [entry.failure === "queue" ? displayQueueFailure(languages.output) : displayFailure(languages.output)] })] : []),
      Button({ key: entry.phase === "error" ? "retry-question-translation" : "translate-question", label: entry.phase === "error" ? "重试翻译 / Retry" : "翻译问题 / Translate",
        onPress: () => requestDisplay($, options, configuration, display, entry, languages.reply, languages.output) }),
      await next(e),
    ] })
  })

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (!displayOnly(options) || languages.reply === languages.output) return next(e)
    const manual = manualDisplay(options)
    if (!manual && !assistantDisplayAllowed(display, e.surface, e.requestId, Boolean(e.props.isSummary), languages.output)) return next(e)
    if (!e.props.text.trim() || e.props.onScreen === null || (displaySourceAllowed(e.props.text) && (incompleteCode(e.props.text) || displayCodeOnly(e.props.text)))) {
      hideDisplay(display, e.surface, e.requestId, Boolean(e.props.isSummary), languages.output)
      return next(e)
    }
    feedback.interactive = true
    const entry = displayEntry(display, e.surface, e.requestId, e.props.text, Boolean(e.props.isSummary), languages.output, "assistant", !manual)
    if (entry?.phase === "ready" && entry.translated !== undefined) return next({ ...e, props: { ...e.props, text: entry.translated } })
    scheduleDisplay($, options, configuration, display, languages.reply, languages.output)
    if (entry?.phase === "idle") {
      if (display.activeSteps || (e.surface === "terminal" && e.viewport?.isFullscreen === false)) return next(e)
      const { Box, Button } = $.ui.resolve(e)
      return Box({ flexDirection: "column", children: [await next(e), Button({ key: "translate-output", label: "翻译 / Translate",
        onPress: () => requestDisplay($, options, configuration, display, entry, languages.reply, languages.output) })] })
    }
    if (manual && !entry) return next(e)
    const failed = entry?.phase === "error" || !displaySourceAllowed(e.props.text) || (!entry && !display.pending.size && !display.running.size)
    // Keep the native source drawing until a complete current translation exists.
    if (!failed) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const children = [await next(e), Text({ color: "red", children: [entry?.failure === "queue" ? displayQueueFailure(languages.output) : displayFailure(languages.output)] })]
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
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const entry = manualDisplay(options) ? manualDisplayTarget(display, e.surface) : undefined
    const controls = entry ? Box({ flexDirection: "column", children: [
      ...(e.props.maxRows >= 3 ? [Text({ dimColor: true, wrap: "truncate-end", children: [(entry.kind === "question" ? parseQuestions(entry.source)?.[0]?.question ?? entry.source : entry.source).replace(/\s+/g, " ").slice(0, 100)] })] : []),
      Box({ children: [
        ...(entry.kind === "assistant" && manualDisplayChoices(display, e.surface).filter(candidate => candidate.kind === "assistant").length > 1 ? [
          Button({ key: "previous-output", label: "上一条", hotkey: "p", onPress: () => selectManualDisplay($, display, e.surface, -1) }),
          Button({ key: "next-output", label: "下一条", hotkey: "n", onPress: () => selectManualDisplay($, display, e.surface, 1) }),
        ] : []),
        Button({ key: "translate-output", label: entry.phase === "error" ? "重试翻译 / Retry" : entry.kind === "question" ? "翻译问题 / Translate" : "翻译回复 / Translate", hotkey: "t",
          onPress: () => requestDisplay($, options, configuration, display, entry, languages.reply, languages.output) }),
      ] }),
    ] }) : undefined
    if (!current) return controls ? Box({ flexDirection: "column", children: [await next(e), controls] }) : next(e)
    const feedbackRows = e.props.maxRows - (controls ? e.props.maxRows >= 3 ? 2 : 1 : 0)
    if (feedbackRows < 1 && controls) return Box({ flexDirection: "column", children: [await next(e), controls] })
    const stage = current.stage === "input" ? "输入翻译" : "输出翻译"
    const target = LANGUAGES[current.target]
    const color = current.phase === "error" ? "red" : current.phase === "done" ? "green" : "cyan"
    const translatorLabel = useCodex ? "Codex CLI" : configuration.resolved?.model ?? MODEL
    const failureDetail = current.stage === "input" ? "原文未发送" : displayOnly(options) ? "已保留原文" : "未显示原文"
    const title = current.phase === "loading"
      ? `${stage}中${[".", "..", "..."][current.frame % 3]}  ${current.elapsed.toFixed(1)} 秒 · ${target.label} (${current.target}) · ${translatorLabel}`
      : current.phase === "done" ? `✓ ${stage}完成 · ${target.label} (${current.target}) · ${current.elapsed.toFixed(1)} 秒`
        : `× ${stage}失败 · ${failureDetail}`
    const content = [Text({ color, children: [title], wrap: "truncate-end" })]
    if (current.detail && feedbackRows >= 4) content.push(Text({ dimColor: true, children: [current.detail], wrap: "truncate-end" }))
    const compact = e.props.bodyColumns < 32 || feedbackRows < 3
    return Box({
      flexDirection: "column",
      children: [
        await next(e),
        Box({ flexDirection: "column", borderStyle: compact ? undefined : "round", borderColor: color, paddingX: compact ? 0 : 1, children: content }),
        ...(controls ? [controls] : []),
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
      (e.origin.kind === "composer" && (e.isMeta || e.command)) ||
      !e.text.trim() ||
      BYPASS.test(e.text)
    ) return next(e)

    let translated: string | undefined
    let preparedId: number | undefined
    const leadingTag = /^[A-Z][A-Z0-9_-]{2,}:[ \t]*/.exec(e.text)?.[0] ?? ""
    const protectedText = protectText(e.text.slice(leadingTag.length))
    const skipTranslation = canSkipInputTranslation(e.text.slice(leadingTag.length), code)
    let errorHint = "请检查网络后重试。"
    const current = !skipTranslation && e.origin.kind === "composer"
      ? await startFeedback($, feedback, "input", languages.input, code, next.signal) : undefined
    try {
      if (next.signal.aborted) return { drop: "Translation cancelled; this prompt was not sent." }
      const result = skipTranslation ? { text: protectedText.text }
        : await requestTranslation($, options, configuration, translationPrompt(code, languages.input), protectedText.text, 1024, next.signal)
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

      if (e.origin.kind === "composer") {
        const prepared = await prepareInput($, e.text, translated, code)
        if (!prepared || next.signal.aborted) {
          if (prepared) await discardPreparedInput($, prepared.id)
          translated = undefined
          errorHint = "输入等待队列已满、目标语言冲突或翻译已取消，请稍后重试。"
          return { drop: "Translation handoff unavailable; this prompt was not sent. Retry after pending prompts are processed." }
        }
        preparedId = prepared.id
        translated = prepared.translated
      }

      const accepted = await next({
        ...e,
        text: e.origin.kind === "composer" ? e.text : translated,
        context: [...(e.context ?? []), `Reply in natural ${LANGUAGES[languages.reply].name}. Keep commands, paths, URLs, identifiers, and product names unchanged.`],
      })
      if (accepted.drop && preparedId !== undefined) await discardPreparedInput($, preparedId)
      return accepted
    } catch {
      if (preparedId !== undefined) {
        try { await discardPreparedInput($, preparedId) } catch { /* The session owns the bounded pending state. */ }
      }
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
