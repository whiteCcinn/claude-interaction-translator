// Adapt legacy marked target examples to the new gap protocol. The expected
// complete translations in existing tests remain independent of production
// assembly; this helper only emulates the provider's structured response.
export function segmentResponse(input: string | undefined, markedTranslation: string): string {
  if (!input?.startsWith("[")) return markedTranslation
  const rows = JSON.parse(input) as { id: number }[]
  const prefixes = [...markedTranslation.matchAll(/(_+GLM_KEEP_)\d+__/g)].map(match => match[1] ?? "")
  const prefix = prefixes.sort((a, b) => b.length - a.length)[0]
  const parts = prefix ? markedTranslation.split(new RegExp(prefix + "\\d+__", "g")) : [markedTranslation]
  return JSON.stringify(rows.map(row => ({ id: row.id, text: parts[row.id]?.trim() ?? "" })))
}
