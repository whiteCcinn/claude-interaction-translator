export const MAX_INPUT_ECHO_ROWS = 128
export const MAX_INPUT_ECHO_BYTES = 2 * 1024 * 1024
const MAX_PRINTABLE_CHARS = 100000
const ORIGINAL_LABEL = "原文："
const TRANSLATION_LABEL = "\n译文："

type InputEcho = { source: string; translated: string; bytes: number; ids: string[] }
export type InputEchoState = { rows: Map<string, InputEcho>; identities: Map<string, Set<string>>; bytes: number; epoch: number }
const encoder = new TextEncoder()

export function createInputEchoState(): InputEchoState {
  return { rows: new Map(), identities: new Map(), bytes: 0, epoch: 0 }
}

export function clearInputEcho(state: InputEchoState) {
  state.rows.clear()
  state.identities.clear()
  state.bytes = 0
  state.epoch += 1
}

function removeInputEcho(state: InputEchoState, rowId: string) {
  const entry = state.rows.get(rowId)
  if (!entry) return
  state.rows.delete(rowId)
  state.bytes -= entry.bytes
  for (const id of entry.ids) {
    const owners = state.identities.get(id)
    owners?.delete(rowId)
    if (!owners?.size) state.identities.delete(id)
  }
}

export function recordInputEcho(state: InputEchoState, rowId: string, source: string, translated: string, blockIndex?: number): boolean {
  removeInputEcho(state, rowId)
  if (!rowId || !source.trim() || source === translated) return false
  if (source.length + translated.length + ORIGINAL_LABEL.length + TRANSLATION_LABEL.length > MAX_PRINTABLE_CHARS) return false
  // Native 2.1.316/318 can split user rows into exact original block aliases,
  // including after an earlier multi-block row. Queued attachments stay raw.
  const ids = [rowId]
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rowId) && blockIndex !== undefined && Number.isSafeInteger(blockIndex) && blockIndex >= 0) {
    const alias = rowId.slice(0, 24) + blockIndex.toString(16).padStart(12, "0")
    if (alias !== rowId) ids.push(alias)
  }
  const bytes = encoder.encode(ids.join("\n")).byteLength + encoder.encode(source).byteLength + encoder.encode(translated).byteLength
  if (bytes > MAX_INPUT_ECHO_BYTES) return false
  while (state.rows.size >= MAX_INPUT_ECHO_ROWS || state.bytes + bytes > MAX_INPUT_ECHO_BYTES) {
    const oldest = state.rows.entries().next().value
    if (!oldest) return false
    removeInputEcho(state, oldest[0])
  }
  state.rows.set(rowId, { source, translated, bytes, ids })
  for (const id of ids) {
    const owners = state.identities.get(id) ?? new Set<string>()
    owners.add(rowId)
    state.identities.set(id, owners)
  }
  state.bytes += bytes
  return true
}

export function bilingualInputEcho(state: InputEchoState, rowId: string, text: string): string | undefined {
  const owners = state.identities.get(rowId)
  if (owners?.size !== 1) return undefined
  const owner = owners.values().next().value
  const entry = owner === undefined ? undefined : state.rows.get(owner)
  if (!entry || (text !== entry.source && text !== entry.translated)) return undefined
  return ORIGINAL_LABEL + entry.source + TRANSLATION_LABEL + entry.translated
}
