import type { EngineInterface, PluginOptions, RenderSurface } from "claude-code"
import { DEFAULT_CODEX_TIMEOUT_SECONDS, MAX_CODEX_TIMEOUT_SECONDS } from "./configuration"
import { translationFailureCode } from "./translation-errors"
import type { TranslationFailure } from "./translation-errors"

export type TranslationDiagnostic = {
  reportVersion: 1
  plugin: "interaction-translator"
  code: string
  backend: "api" | "codex-cli"
  stage: "input" | "output" | "question"
  elapsedMs?: number
  timeoutSeconds?: number
  httpStatus?: number
  exitCode?: number
  markerExpected?: number
  markerObserved?: number
  markerMissing?: number
  markerDuplicate?: number
  markerUnexpected?: number
}

// Construct reports field-by-field; never spread options or provider errors.
export function createTranslationDiagnostic(options: PluginOptions, stage: TranslationDiagnostic["stage"], failure: TranslationFailure, elapsedMs?: number): TranslationDiagnostic {
  const backend = options.backend === "codex-cli" ? "codex-cli" : "api"
  const result: TranslationDiagnostic = { reportVersion: 1, plugin: "interaction-translator", code: translationFailureCode(failure), backend, stage }
  if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0) result.elapsedMs = Math.round(elapsedMs)
  if (backend === "codex-cli") {
    const seconds = options.codex_timeout_seconds
    if (seconds === undefined) result.timeoutSeconds = DEFAULT_CODEX_TIMEOUT_SECONDS
    else if (typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_CODEX_TIMEOUT_SECONDS) result.timeoutSeconds = seconds
  }
  if (failure.kind === "api-http" && Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599) result.httpStatus = failure.status
  if (failure.kind === "codex-exit" && Number.isSafeInteger(failure.code)) result.exitCode = failure.code
  if (failure.kind === "markers" && failure.validation) {
    const v = failure.validation
    if (Number.isSafeInteger(v.expected) && v.expected >= 0) result.markerExpected = v.expected
    if (Number.isSafeInteger(v.observed) && v.observed >= 0) result.markerObserved = v.observed
    if (Number.isSafeInteger(v.missing) && v.missing >= 0) result.markerMissing = v.missing
    if (Number.isSafeInteger(v.duplicate) && v.duplicate >= 0) result.markerDuplicate = v.duplicate
    if (Number.isSafeInteger(v.unexpected) && v.unexpected >= 0) result.markerUnexpected = v.unexpected
  }
  return result
}

export function diagnosticSummary(report: TranslationDiagnostic): string {
  return [report.code, report.backend, report.stage,
    ...(report.elapsedMs === undefined ? [] : [`${(report.elapsedMs / 1000).toFixed(1)}s`]),
    ...(report.timeoutSeconds === undefined ? [] : [`timeout=${report.timeoutSeconds}s`]),
    ...(report.httpStatus === undefined ? [] : [`HTTP ${report.httpStatus}`]),
    ...(report.exitCode === undefined ? [] : [`exit=${report.exitCode}`]),
    ...(report.markerExpected === undefined ? [] : [`markers=${report.markerObserved}/${report.markerExpected}`, `missing=${report.markerMissing}`, `duplicate=${report.markerDuplicate}`, `unexpected=${report.markerUnexpected}`]),
  ].join(" · ")
}

export async function diagnosticTime($: EngineInterface): Promise<number | undefined> {
  try {
    const now = await $.clock.now()
    return Number.isFinite(now) ? now : undefined
  } catch { return undefined }
}

export async function copyTranslationDiagnostic($: EngineInterface, surface: RenderSurface, report: TranslationDiagnostic): Promise<void> {
  let copied = false
  try { copied = (await $.ui.copy({ surface, text: JSON.stringify(report, null, 2) })).isCopied }
  catch { /* Clipboard details are neither user diagnostics nor translation errors. */ }
  try {
    $.ui.toast(copied ? "已复制翻译错误信息，可粘贴用于反馈。" : `复制失败，请手动复制界面上的诊断摘要：${diagnosticSummary(report)}`)
  } catch { /* A missing notification surface must not affect retry or the original. */ }
}
