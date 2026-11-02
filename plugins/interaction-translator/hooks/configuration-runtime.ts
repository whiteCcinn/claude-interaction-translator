import type { EngineInterface, PluginOptions } from "claude-code"
import { initialSelections, needsStoredChoices, resolveConfiguration, TEXT_FIELDS } from "./configuration"
import type { ConfigurationResult } from "./configuration"

type ConfigurationRows = { id?: string; locked: ReadonlySet<string> }
type StoredConfiguration = { options: Record<string, unknown>; initialization: Record<string, string> }
export type ConfigurationState = {
  rows?: ConfigurationRows
  rowsPending?: Promise<ConfigurationRows>
  stored?: StoredConfiguration
  pending?: Promise<StoredConfiguration>
  resolved?: PluginOptions
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

function storedOptions(configs: unknown, id: string, name: string): Record<string, unknown> {
  if (!record(configs)) return {}
  const keys = id === name || id === `${name}@inline` ? [name, `${name}@inline`] : [id]
  const entries = keys.map(key => configs[key]).filter(entry => record(entry) && record(entry.options))
  if (entries.length > 1) throw new Error("Duplicate inline translator configurations.")
  const entry = entries[0]
  return record(entry) && record(entry.options) ? { ...entry.options } : {}
}

export async function readConfigurationRows($: EngineInterface, state: ConfigurationState): Promise<ConfigurationRows> {
  if (state.rows) return state.rows
  if (!state.rowsPending) state.rowsPending = $.config.list().then(rows => {
    const own = rows.filter(row => row.key.startsWith(`${$.plugin.name}.`) && (row.provider.plugin === $.plugin.name || row.provider.plugin.startsWith(`${$.plugin.name}@`)))
    const ids = new Set(own.map(row => row.provider.plugin))
    if (ids.size > 1) throw new Error("Ambiguous translator configuration provider.")
    return { id: [...ids][0], locked: new Set(own.filter(row => row.isLocked).map(row => row.key.slice($.plugin.name.length + 1))) }
  })
  try { state.rows = await state.rowsPending; return state.rows }
  finally { state.rowsPending = undefined }
}

export async function loadStoredConfiguration($: EngineInterface, state: ConfigurationState): Promise<StoredConfiguration> {
  const { id, locked } = await readConfigurationRows($, state)
  if (!id) throw new Error("The active translator configuration provider is unavailable.")
  // Match the native option loader: project/local settings do not configure plugins.
  const layers = await Promise.all([
    $.settings.read({ source: "user" }), $.settings.read({ source: "flag" }), $.settings.read({ source: "policy" }),
  ])
  const [user = {}, flag = {}, policy = {}] = layers.map(layer => storedOptions(layer.pluginConfigs, id, $.plugin.name))
  const initialization = initialSelections(user)
  for (const { selector, field } of TEXT_FIELDS) {
    if (locked.has(field) || locked.has(selector) || [flag, policy].some(layer => Object.hasOwn(layer, selector) || Object.hasOwn(layer, field))) delete initialization[selector]
  }
  return { options: { ...user, ...flag, ...policy }, initialization }
}

export async function readStoredConfiguration($: EngineInterface, state: ConfigurationState): Promise<StoredConfiguration> {
  if (state.stored) return state.stored
  if (!state.pending) state.pending = loadStoredConfiguration($, state)
  try { state.stored = await state.pending; return state.stored }
  finally { state.pending = undefined }
}

export async function effectiveConfiguration($: EngineInterface, options: PluginOptions, state: ConfigurationState): Promise<ConfigurationResult> {
  try {
    const { locked } = await readConfigurationRows($, state)
    const stored = state.stored ?? (needsStoredChoices(options, locked) ? await readStoredConfiguration($, state) : undefined)
    const result = resolveConfiguration(options, locked, stored?.options)
    if ("value" in result) state.resolved = result.value
    return result
  } catch {
    return { drop: "无法读取当前安装来源的翻译配置。请重新加载插件并按完整插件 ID 配置后重试。", hint: "请检查当前翻译配置是否可读取。" }
  }
}

export function configurationTarget(command: string, args: string, name: string): string | undefined {
  if (command === "config") return ""
  if (command !== "plugin") return undefined
  const parts = args.trim().split(/\s+/)
  if (!parts[0]) return ""
  if (parts[0] !== "configure") return undefined
  const target = parts[1] ?? ""
  return !target || target === name || target.startsWith(`${name}@`) ? target : undefined
}

export async function initializeConfiguration($: EngineInterface, state: ConfigurationState, target: string): Promise<void> {
  const { id } = await readConfigurationRows($, state)
  if (target.includes("@") && id !== target) return
  const stored = await readStoredConfiguration($, state)
  for (const [field, value] of Object.entries(stored.initialization)) {
    const result = await $.config.set({ key: `${$.plugin.name}.${field}`, value })
    if (result.deny !== undefined || result.value !== value) throw new Error("Could not preserve the previous translator selection.")
    stored.options[field] = value
    delete stored.initialization[field]
  }
}
