import { translationPrompt } from "./languages"
import type { Language } from "./languages"
import { protectText, restoreText } from "./protected-text"

type ChoiceOption = Record<string, unknown> & { label: string; description?: string; preview?: string }
type ChoiceQuestion = Record<string, unknown> & { question: string; header: string; options: ChoiceOption[]; multiSelect?: boolean }
type ProtectedField = { id: number; field: "question" | "header" | "label" | "description"; protectedText: ReturnType<typeof protectText> }
export type PreparedQuestionTranslation = { text: string; original: ChoiceQuestion[]; fields: ProtectedField[]; prefix: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function choiceQuestions(value: unknown): value is ChoiceQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return false
  return value.every(q => record(q) && typeof q.question === "string" && q.question.trim() && typeof q.header === "string" && q.header.trim()
    && (q.kind === undefined || q.kind === "choice") && (q.multiSelect === undefined || typeof q.multiSelect === "boolean")
    && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4
    && q.options.every(o => record(o) && typeof o.label === "string" && o.label.trim()
      && (o.description === undefined || typeof o.description === "string") && (o.preview === undefined || typeof o.preview === "string")))
}

export function questionSource(questions: readonly unknown[]): string | undefined {
  try { return choiceQuestions(questions) ? JSON.stringify(questions) : undefined }
  catch { return undefined }
}

export function parseQuestions(text: string): ChoiceQuestion[] | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return choiceQuestions(value) ? value : undefined
  } catch { return undefined }
}

export function prepareQuestionTranslation(source: string): PreparedQuestionTranslation | undefined {
  const original = parseQuestions(source)
  if (!original) return undefined
  let prefix = "__GLM_Q_KEEP_"
  while (source.includes(prefix)) prefix = "_" + prefix
  const fields: ProtectedField[] = []
  const add = (field: ProtectedField["field"], text: string) => {
    const protectedText = protectText(text)
    const fieldPrefix = `${prefix}${fields.length}_`
    fields.push({ id: fields.length, field, protectedText: {
      ...protectedText, prefix: fieldPrefix, text: protectedText.text.replaceAll(protectedText.prefix, fieldPrefix),
    } })
  }
  for (const q of original) {
    add("question", q.question)
    add("header", q.header)
    for (const option of q.options) {
      add("label", option.label)
      add("description", option.description ?? "")
    }
  }
  return { original, fields, prefix, text: JSON.stringify(fields.map(f => ({ id: f.id, field: f.field, text: f.protectedText.text }))) }
}

export function restoreQuestionTranslation(text: string, prepared: PreparedQuestionTranslation): string | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  if (!Array.isArray(value) || value.length !== prepared.fields.length) return undefined
  const texts: string[] = []
  for (const [index, expected] of prepared.fields.entries()) {
    const field: unknown = value[index]
    if (!record(field) || Object.keys(field).length !== 3 || field.id !== expected.id || field.field !== expected.field || typeof field.text !== "string") return undefined
    const restored = restoreText(field.text, expected.protectedText)
    if (restored === undefined || restored.includes(prepared.prefix) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(restored)) return undefined
    if (expected.field !== "description" && !restored.trim()) return undefined
    if (expected.field === "header" && (restored.length > 12 || /[\r\n\t]/.test(restored))) return undefined
    if (!expected.protectedText.text && restored) return undefined
    texts.push(restored)
  }
  let cursor = 0
  const questions = prepared.original.map(q => {
    const question = texts[cursor++] ?? q.question
    const header = texts[cursor++] ?? q.header
    const guide: string[] = []
    const options = q.options.map((option, index) => {
      const label = texts[cursor++] ?? option.label
      const description = texts[cursor++] ?? option.description ?? ""
      guide.push(`${index + 1}. ${label === option.label ? label : `${label}（${option.label}）`}${description ? `：${description}` : ""}`)
      return { ...option, description: [label === option.label ? "" : label, description].filter(Boolean).join(" · ") }
    })
    // Native preview layouts hide option descriptions. Put their translated
    // guide in the question; labels and preview bytes remain native identities.
    return { ...q, header, question: q.options.some(o => o.preview !== undefined) ? `${question}\n\n${guide.join("\n")}` : question, options }
  })
  const keys = new Set<string>()
  for (const [index, q] of questions.entries()) {
    if (keys.has(q.question) || prepared.original.some((original, other) => other !== index && original.question === q.question)) return undefined
    keys.add(q.question)
  }
  return JSON.stringify(questions)
}

export function questionTranslationPrompt(target: Language, source: Language): string {
  return [translationPrompt(target, source, "response"),
    "The input is a JSON array of UI fields. Translate only each text value. Return only a JSON array with exactly the same id, field, order and count; no extra keys or prose.",
    "Keep header text concise, at most 12 characters. Keep empty strings empty. Preserve every placeholder containing GLM_Q_KEEP exactly in its own field; never move text or markers between fields.",
  ].join("\n")
}
