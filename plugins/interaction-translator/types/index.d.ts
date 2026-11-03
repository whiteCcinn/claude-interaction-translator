export type PreparedInput = { id: number; source: string; translated: string; target: string; rowId?: string }
export type PreparedInputs = { serial: number; pending: PreparedInput[] }

declare module "claude-code" {
  interface PluginState {
    "interaction-translator": { preparedInputs: PreparedInputs }
  }
}
