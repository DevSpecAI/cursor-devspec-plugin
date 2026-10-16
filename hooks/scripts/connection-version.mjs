import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLUGIN_ID } from './agent-identity.mjs'

const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/.test(value) ? value : undefined
function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../.cursor-plugin/plugin.json', import.meta.url), 'utf8'))
    return manifest.name === 'devspec-autopilot' ? label(manifest.version) : undefined
  } catch { return undefined }
}

export const LOADED_PLUGIN_VERSION = pluginVersion()

/**
 * DevSpec tells plugins apart by `x-devspec-plugin: <id>/<version>` on every MCP
 * request (ADR "Protecting intent" §14; contract on DevSpec item 2295e089). It
 * identifies the plugin and unlocks nothing. The version is this artifact's own
 * manifest, read once at load like plugin_version above, so the header can never
 * name a release other than the one running (item f6566758). An unreadable
 * manifest sends no header rather than a malformed one.
 */
export const PLUGIN_HEADER = 'x-devspec-plugin'
export function pluginHeaderValue(version = LOADED_PLUGIN_VERSION) {
  const checked = label(version)
  return checked && !checked.includes('/') ? `${PLUGIN_ID}/${checked}` : undefined
}
export function pluginHeaders(version = LOADED_PLUGIN_VERSION) {
  const value = pluginHeaderValue(version)
  return value ? { [PLUGIN_HEADER]: value } : {}
}
// Cursor documents this own-host variable for hook processes. If a separately
// launched helper does not inherit it, host version remains unknown.
const LOADED_HOST_VERSION = label(process.env.CURSOR_VERSION)
export function connectionVersions(hostVersion = LOADED_HOST_VERSION) {
  return LOADED_PLUGIN_VERSION ? { plugin_version: LOADED_PLUGIN_VERSION, ...(label(hostVersion) ? { host_version: label(hostVersion) } : {}) } : {}
}
export function versionedConnectionArguments(name, args = {}) {
  if (!['register_connection', 'attach_connection'].includes(name)) return args
  const { plugin_version: _plugin, host_version: _host, ...rest } = args
  return { ...rest, ...connectionVersions() }
}

export function connectionVersionHook(input) {
  const name = input?.tool_name ?? input?.toolName ?? ''
  const match = /^(?:(?:mcp__(?:plugin_devspec_)?devspec__)|devspec__|devspec\.)?(register_connection|attach_connection)$/.exec(name)
  if (!match) return null
  // Cursor merges updated_input into MCP arguments. Send only observed facts;
  // do not replace identity/scope fields or make a permission decision.
  const versions = connectionVersions(label(input.cursor_version) ?? LOADED_HOST_VERSION)
  return Object.keys(versions).length ? { updated_input: versions } : null
}

let main = false
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch {}
if (main) {
  try {
    const output = connectionVersionHook(JSON.parse(readFileSync(0, 'utf8')))
    if (output) process.stdout.write(JSON.stringify(output))
  } catch { /* Optional enrichment must never block execution. */ }
}
