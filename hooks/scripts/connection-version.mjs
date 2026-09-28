import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/.test(value) ? value : undefined
function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../.cursor-plugin/plugin.json', import.meta.url), 'utf8'))
    return manifest.name === 'devspec-autopilot' ? label(manifest.version) : undefined
  } catch { return undefined }
}

export const LOADED_PLUGIN_VERSION = pluginVersion()
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
