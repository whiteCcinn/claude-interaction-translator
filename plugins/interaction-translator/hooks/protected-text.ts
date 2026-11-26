const pastedContentTag = /<(\/?)pasted_content id="([0-9a-f]{4})">/

export function withoutPasteDelimiters(text: string): string {
  if (!text.includes("<pasted_content ")) return text
  const delimiterLine = new RegExp(String.raw`^${pastedContentTag.source}\r?$`)
  const lines = text.split("\n")
  const openings = new Map<string, number>()
  const hidden = new Set<number>()
  lines.forEach((line, index) => {
    const match = delimiterLine.exec(line)
    if (!match) return
    const [, closing, id] = match
    if (!closing) {
      openings.set(id!, index)
      return
    }
    const opening = openings.get(id!)
    if (opening === undefined) return
    hidden.add(opening)
    hidden.add(index)
    openings.delete(id!)
  })
  // A paste-only submission starts with two line breaks before its opener.
  // Keep one after the label and drop the transport newline after the closer.
  if (hidden.has(2) && lines[0] === "" && lines[1] === "") hidden.add(0)
  const last = lines.length - 1
  if (hidden.has(last - 1) && lines[last] === "") hidden.add(last)
  return lines.filter((_, index) => !hidden.has(index)).join("\n")
}

export function protectText(text: string, extraMarkers: readonly string[] = []): { text: string; prefix: string; values: string[] } {
  let prefix = "__GLM_KEEP_"
  while (text.includes(prefix)) prefix = "_" + prefix
  const values: string[] = []
  const keep = (value: string) => `${prefix}${values.push(value) - 1}__`
  // Claude hides long-paste delimiters in the terminal only when their syntax
  // is intact. Match the entire tag before a closing tag's slash is read as a path.
  const lexemes = /`[^`\n]+`|https?:\/\/[^\s<>"'`，。！？；（）]+|[A-Za-z]:\\[^\s`，。！？；（）]+|(?:~\/|\.{1,2}\/|\/)[A-Za-z0-9._~%:+/-]+/
  const pattern = new RegExp(`${pastedContentTag.source}|${lexemes.source}`, "g")
  const fences = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm
  const parts: string[] = []
  let cursor = 0
  let opening: RegExpExecArray | null
  while ((opening = fences.exec(text)) !== null) {
    const fence = opening[1]
    if (!fence) break
    const character = fence.startsWith("`") ? "`" : "~"
    // A closing fence occupies its own line and can be longer than the opener.
    // Operators or quoted delimiters inside code never close a fenced block.
    const closing = new RegExp("^ {0,3}" + character + "{" + fence.length + ",}[ \\t]*(?=\\r?$)", "gm")
    closing.lastIndex = fences.lastIndex
    const match = closing.exec(text)
    const end = match ? match.index + match[0].length : text.length
    parts.push(text.slice(cursor, opening.index).replace(pattern, keep))
    parts.push(keep(text.slice(opening.index, end)))
    cursor = end
    fences.lastIndex = end
  }
  parts.push(text.slice(cursor).replace(pattern, keep))
  let masked = parts.join("")
  for (const marker of extraMarkers) {
    masked = masked.replaceAll(marker, keep)
  }
  return { text: masked, prefix, values }
}

export type MarkerValidation = { expected: number; observed: number; missing: number; duplicate: number; unexpected: number }
export type RestoredText = { text: string } | { failure: MarkerValidation }

export function protectedTranslationPrompt(prompt: string, protectedText: ReturnType<typeof protectText>): string {
  const count = protectedText.values.length
  if (!count) return prompt
  const token = (index: number) => `${protectedText.prefix}${index}__`
  // Bound instructions even for marker-heavy responses.
  const inventory = count <= 64 ? protectedText.values.map((_, index) => token(index)).join(", ")
    : `every sequential token from ${token(0)} through ${token(count - 1)}`
  return `${prompt}\nThe input contains ${count} protected tokens: ${inventory}. Copy every token exactly once, byte-for-byte, in its original location relative to the surrounding prose. Do not translate, escape, renumber, duplicate, omit, or expand tokens. Verify that all ${count} tokens remain before returning the translation. Do not append this inventory to the output.`
}

export function restoreProtectedText(text: string, protectedText: ReturnType<typeof protectText>): RestoredText {
  const { prefix, values } = protectedText
  const failure: MarkerValidation = { expected: values.length, observed: 0, missing: 0, duplicate: 0, unexpected: 0 }
  if (!prefix) return { failure: { ...failure, missing: values.length, unexpected: 1 } }
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const marker = new RegExp(escaped + "(0|[1-9]\\d*)__", "y")
  const counts = new Uint32Array(values.length)
  let cursor = 0
  let position: number
  while ((position = text.indexOf(prefix, cursor)) !== -1) {
    failure.observed++
    marker.lastIndex = position
    const match = marker.exec(text)
    const index = match ? Number(match[1]) : -1
    if (match && Number.isSafeInteger(index) && index >= 0 && index < values.length && typeof values[index] === "string") {
      counts[index] = (counts[index] ?? 0) + 1
    } else failure.unexpected++
    cursor = match ? marker.lastIndex : position + prefix.length
  }
  for (const count of counts) {
    if (!count) failure.missing++
    else failure.duplicate += count - 1
  }
  if (failure.missing || failure.duplicate || failure.unexpected) return { failure }
  // Expand only after validating all counts: malicious duplicate markers must
  // not expand a large protected code block thousands of times in memory.
  return { text: text.replace(new RegExp(escaped + "(0|[1-9]\\d*)__", "g"), (token, index: string) => values[Number(index)] ?? token) }
}

export function restoreText(text: string, protectedText: ReturnType<typeof protectText>): string | undefined {
  const restored = restoreProtectedText(text, protectedText)
  return "text" in restored ? restored.text : undefined
}
