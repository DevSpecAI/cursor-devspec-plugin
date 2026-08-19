export interface HookCommand {
  command?: string
  type?: string
  timeout?: number
  [key: string]: unknown
}

export interface HookGroup {
  hooks?: HookCommand[]
  matcher?: string
  command?: string
  [key: string]: unknown
}

export interface CursorHookConfig {
  version?: number
  hooks?: Record<string, HookGroup[] | HookCommand[]>
  [key: string]: unknown
}

export function mergeCursorHookConfig(
  input: CursorHookConfig,
  stableLauncher: string,
): CursorHookConfig

export const PROVENANCE_EVENTS: readonly string[]
export const MARKER: string
export const TRAIL_EVENTS: readonly string[]
