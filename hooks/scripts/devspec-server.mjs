/**
 * Which DevSpec server this plugin talks to, read exactly the way Cursor reads it.
 *
 * Cursor connects the agent's DevSpec tools from this plugin's own mcp.json. It fills
 * each `${NAME}` / `${NAME:-default}` / `${env:NAME}` from the environment
 * cursor-agent was started in first, then from the plugin's settings (Configure
 * variables), and a `${NAME:-default}` nobody set takes its default.
 *
 * The background features (remote control, commit tracking) run as hook and helper
 * processes. They inherit cursor-agent's environment but never see the plugin's
 * settings, so they read the SAME mcp.json entry and fill it the same way from the
 * environment. That keeps one source of truth: with nothing set, Cursor's own
 * connection and the background features both use production; started with
 * DEVSPEC_API_URL (and DEVSPEC_CURSOR_CLIENT_ID for that server's sign-in app), both
 * use that server, with no settings file edited by hand (item 95a67ee4).
 *
 * DEVSPEC_MCP_URL stays the full-address override for runs with no browser, beside
 * DEVSPEC_MCP_TOKEN.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin's server in mcp.json; Cursor shows it as plugin-devspec-devspec-cursor. */
export const PLUGIN_SERVER_NAME = 'devspec-cursor'

export const PRODUCTION_ORIGIN = 'https://api.devspec.ai'
export const STAGING_ORIGIN = 'https://api.devspecstaging.com'

/** This plugin's root: hooks/scripts/ is two levels down. */
export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The command a person (or the agent) runs to sign the background features in. */
export const LOGIN_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'devspec-login.mjs')

/**
 * Cursor's substitution grammar (cursor-agent 2026.11.05, plugin mcp.json loader):
 * `${env:NAME}`, `${NAME}` and `${NAME:-default}`. An unset name with no default is
 * left as written, which is how Cursor itself behaves.
 */
const GRAMMAR = /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|([^:}]+)(?::-([^}]*))?)\}/g

export function interpolateCursorValue(value, lookup) {
  if (typeof value === 'string') {
    return value.replace(GRAMMAR, (whole, envName, name, fallback) => {
      if (envName !== undefined) return lookup(envName) ?? whole
      const found = lookup(name)
      if (found !== undefined) return found
      return fallback !== undefined ? fallback : whole
    })
  }
  if (Array.isArray(value)) return value.map((item) => interpolateCursorValue(item, lookup))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateCursorValue(item, lookup)]))
  }
  return value
}

/** The plugin's own server entry from its mcp.json, before any substitution. */
export function bundledServerEntry(root = PLUGIN_ROOT) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'), 'utf8'))
  const entry = config?.mcpServers?.[PLUGIN_SERVER_NAME]
  if (!entry || typeof entry.url !== 'string') throw new Error(`mcp.json has no ${PLUGIN_SERVER_NAME} server`)
  return entry
}

/**
 * The plugin's server as Cursor fills it from `env` alone: the address its DevSpec
 * tools use and the sign-in app Cursor asks for there.
 */
export function bundledConnection(env = process.env, { root = PLUGIN_ROOT } = {}) {
  const entry = interpolateCursorValue(bundledServerEntry(root), (name) => {
    const value = env?.[name]
    return typeof value === 'string' ? value : undefined
  })
  if (entry.url.includes('${')) throw new Error(`DevSpec's server address in mcp.json is incomplete: ${entry.url}`)
  return {
    url: entry.url,
    clientId: typeof entry.auth?.CLIENT_ID === 'string' && !entry.auth.CLIENT_ID.includes('${') ? entry.auth.CLIENT_ID : null,
    scopes: Array.isArray(entry.auth?.scopes) ? entry.auth.scopes : [],
  }
}

/**
 * The DevSpec MCP address the background features use: DEVSPEC_MCP_URL when set,
 * otherwise the same address Cursor's own connection uses.
 */
export function configuredMcpUrl(env = process.env, opts = {}) {
  const override = typeof env?.DEVSPEC_MCP_URL === 'string' ? env.DEVSPEC_MCP_URL.trim() : ''
  return override || bundledConnection(env, opts).url
}

/**
 * The MCP address for a server a person names: an origin such as
 * https://api.devspecstaging.com means "the plugin's address on that server", exactly
 * as DEVSPEC_API_URL would; a full address is used as given.
 */
export function mcpUrlForServer(server, env = process.env, opts = {}) {
  const parsed = new URL(String(server).trim())
  if (parsed.pathname === '/' && !parsed.search) {
    return bundledConnection({ ...env, DEVSPEC_API_URL: parsed.origin }, opts).url
  }
  return parsed.toString()
}

/** The production address with nothing set: the default every install starts with. */
export const DEFAULT_MCP_URL = bundledConnection({}).url

/** Origin + path with no trailing slash, query or fragment: one login per DevSpec server. */
export function normalizeResource(url) {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/** "production", "staging", or the server's own address for any other DevSpec. */
export function serverLabel(mcpUrl) {
  let origin
  try {
    origin = new URL(mcpUrl).origin
  } catch {
    return String(mcpUrl)
  }
  if (origin === PRODUCTION_ORIGIN) return 'production'
  if (origin === STAGING_ORIGIN) return 'staging'
  return origin
}

/**
 * DevSpec's "copy this code" page for a sign-in on a machine the browser cannot
 * reach (an SSH session, a remote box). It lives on the app host of the server; a
 * DevSpec run locally serves the app and the API from one origin.
 */
export function codePageUrl(mcpUrl) {
  const origin = new URL(mcpUrl).origin
  if (origin === PRODUCTION_ORIGIN) return 'https://app.devspec.ai/oauth-code'
  if (origin === STAGING_ORIGIN) return 'https://app.devspecstaging.com/oauth-code'
  return `${origin}/oauth-code`
}

/** `node "<plugin>/scripts/devspec-login.mjs" <args>`, quoted for a shell. */
export function loginCommand(args = '') {
  return `node "${LOGIN_SCRIPT}"${args ? ` ${args}` : ''}`
}
