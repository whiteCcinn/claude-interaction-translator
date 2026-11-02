export function protectText(text: string, extraMarkers: readonly string[] = []): { text: string; prefix: string; values: string[] } {
  let prefix = "__GLM_KEEP_"
  while (text.includes(prefix)) prefix = "_" + prefix
  const values: string[] = []
  const keep = (value: string) => `${prefix}${values.push(value) - 1}__`
  const pattern = /`[^`\n]+`|https?:\/\/[^\s<>"'`，。！？；（）]+|[A-Za-z]:\\[^\s`，。！？；（）]+|(?:~\/|\.{1,2}\/|\/)[A-Za-z0-9._~%:+/-]+/g
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

export function restoreText(text: string, protectedText: ReturnType<typeof protectText>): string | undefined {
  let restored = text
  for (const [index, value] of protectedText.values.entries()) {
    const marker = `${protectedText.prefix}${index}__`
    if (restored.split(marker).length !== 2) return undefined
    restored = restored.replace(marker, () => value)
  }
  return restored.includes(protectedText.prefix) ? undefined : restored
}
