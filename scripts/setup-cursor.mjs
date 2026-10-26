#!/usr/bin/env node
/**
 * Register the DevSpec MCP server in ~/.cursor/mcp.json.
 *
 * This is the CLI replacement for the old "DevSpec: Set MCP token" and
 * "DevSpec: Register MCP server in Cursor config" command-palette commands.
 * Cursor discovers MCP servers ONLY from ~/.cursor/mcp.json and a workspace
 * .cursor/mcp.json — never from a plugin's own mcp.json — so installing the
 * plugin cannot register the server for you, and something a person runs has
 * to (item 19956e89).
 *
 * The shape written here is the shape hooks/scripts/resolve-mcp-auth.mjs
 * reads: mcpServers.devspec = { url, headers.Authorization = "Bearer …" }.
 *
 * It also writes `x-devspec-plugin: cursor/<version>` into that entry's headers,
 * so Cursor's own MCP client says which plugin it is on every request, as the
 * plugin's scripts do (item f6566758). The version is the running plugin's
 * manifest; --refresh after an update rewrites it with the URL, and never
 * touches the credentials.
 *
 *   DEVSPEC_MCP_TOKEN=dvs_… node scripts/setup-cursor.mjs
 *   printf '%s' "$DEVSPEC_MCP_TOKEN" | node scripts/setup-cursor.mjs
 *   node scripts/setup-cursor.mjs --api-url https://api.devspecstaging.com   # reads ~/.devspec/auth.json or env
 *
 * Never pass a token on the command line (--token is rejected so tokens never
 * land in process listings or shell history). Other servers in the file are
 * preserved. The token is never printed back.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentsPageUrl } from '../hooks/scripts/app-pages.mjs'
import { PLUGIN_HEADER, pluginHeaders } from '../hooks/scripts/connection-version.mjs'

const DEFAULT_API_URL = 'https://api.devspec.ai'
const SERVER_KEY = 'devspec'

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const [flag, inline] = eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)]
    if (flag === '--token') {
      out.rejectedTokenFlag = true
      if (inline === null && argv[i + 1] && !argv[i + 1].startsWith('--')) i++
    } else if (flag === '--token-stdin') out.tokenStdin = true
    else if (flag === '--api-url') out.apiUrl = inline ?? argv[++i]
    else if (flag === '--home') out.home = inline ?? argv[++i]
    else if (flag === '--refresh') out.refresh = true
  }
  return out
}

export async function readPinnedAuth(home) {
  if (!home) return null
  try {
    const raw = await fs.readFile(path.join(home, '.devspec', 'auth.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
    let apiUrl = typeof parsed.api_url === 'string' ? parsed.api_url.trim() : ''
    if (!apiUrl && typeof parsed.mcp_url === 'string' && parsed.mcp_url.trim()) {
      try {
        apiUrl = new URL(parsed.mcp_url.trim()).origin
      } catch {
        apiUrl = ''
      }
    }
    return token ? { token, apiUrl: apiUrl || null } : null
  } catch {
    return null
  }
}

export async function readStdinToken(stream = process.stdin, { timeoutMs = 50 } = {}) {
  if (!stream || stream.isTTY) return ''
  return new Promise((resolve) => {
    const chunks = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onEnd)
      if (typeof stream.pause === 'function') stream.pause()
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve('')
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text)
          return resolve(typeof parsed?.token === 'string' ? parsed.token.trim() : '')
        } catch {
          return resolve('')
        }
      }
      resolve(text)
    }
    const onData = (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const onEnd = () => finish()
    const timer = setTimeout(finish, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onEnd)
    if (typeof stream.resume === 'function') stream.resume()
  })
}

/** A token is identified by shape, never echoed: first four and last four. */
export function fingerprint(token) {
  if (typeof token !== 'string' || token.length < 12) return '(too short to fingerprint)'
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`
}

/**
 * Merge our server into a parsed config without disturbing anything else.
 * Returns { config, changed } so a re-run can say "already correct" rather
 * than rewriting a file and claiming it did something.
 */
export function mergeMcpConfig(existing, { url, token, identification = pluginHeaders() }) {
  const config =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? structuredClone(existing)
      : {}
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {}
  const before = JSON.stringify(servers[SERVER_KEY] ?? null)
  const entry = structuredClone(servers[SERVER_KEY] ?? {})
  entry.url = url
  entry.headers = { ...(entry.headers ?? {}), Authorization: `Bearer ${token}`, ...identification }
  servers[SERVER_KEY] = entry
  config.mcpServers = servers
  return { config, changed: before !== JSON.stringify(entry) }
}

/**
 * --refresh after a plugin update: the current address and this plugin's
 * identification header, with every other header (the credentials included) kept
 * exactly as it was. Exported for tests.
 */
export function refreshMcpEntry(existing, { url, identification = pluginHeaders() }) {
  const entry = structuredClone(existing)
  const before = JSON.stringify(entry)
  entry.url = url
  if (Object.keys(identification).length) entry.headers = { ...(entry.headers ?? {}), ...identification }
  return { entry, changed: before !== JSON.stringify(entry) }
}

/**
 * The plugin's fixed tool view: `devspec__` names, and the two connection-plumbing tools
 * the model calls itself (offline heartbeat and detach, in devspec.remote-stop). DevSpec
 * lists only model tools plus the plumbing a host declares here.
 */
export const MCP_ENDPOINT_QUERY = '?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection'

export function resolveInputs({ args = {}, env = {}, stdinToken = '', pinnedAuth = null }) {
  if (args.rejectedTokenFlag) {
    throw new Error(
      'Do not pass --token on the command line (command-line arguments are visible to other local processes and shell history). ' +
        'Set DEVSPEC_MCP_TOKEN, pipe the token on stdin, or store it in ~/.devspec/auth.json.',
    )
  }
  const token = (stdinToken || env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN || pinnedAuth?.token || '').trim()
  const base = (args.apiUrl ?? env.DEVSPEC_API_URL ?? pinnedAuth?.apiUrl ?? DEFAULT_API_URL).trim().replace(/\/+$/, '')
  if (!token) {
    throw new Error(
      'No token. Set DEVSPEC_MCP_TOKEN, pipe the token on stdin, or store it in ~/.devspec/auth.json.\n' +
        `Create one on DevSpec's Agent setup page: ${agentsPageUrl(base, { env })} (Create your token, then pick Read & write).`,
    )
  }
  if (!/^https?:\/\//.test(base)) {
    throw new Error(`--api-url must be an http(s) URL, got: ${base}`)
  }
  return { token, url: `${base}/api/mcp${MCP_ENDPOINT_QUERY}` }
}

async function main(argv, env, homedir) {
  const args = parseArgs(argv)
  const home = args.home ?? homedir
  const file = path.join(home, '.cursor', 'mcp.json')

  let existing = null
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    // A missing file is the normal first run. A malformed one is not ours to
    // silently overwrite — someone else's servers may be in there.
    if (err.code !== 'ENOENT') {
      throw new Error(`${file} exists but could not be parsed — fix or move it first: ${err.message}`)
    }
  }

  let token, url, config, changed
  if (args.refresh) {
    const entry = existing?.mcpServers?.[SERVER_KEY]
    if (!entry || typeof entry.url !== 'string') throw new Error('No existing DevSpec HTTP server to refresh. Run normal setup first.')
    // The same address normal setup writes, on the server this entry already uses.
    const current = new URL(entry.url)
    url = `${current.origin}${current.pathname}${MCP_ENDPOINT_QUERY}`
    config = structuredClone(existing)
    const refreshed = refreshMcpEntry(config.mcpServers[SERVER_KEY], { url })
    changed = refreshed.changed
    config.mcpServers[SERVER_KEY] = refreshed.entry
  } else {
    const pinnedAuth = await readPinnedAuth(home)
    const hasEnvOrPinned = Boolean((env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN || pinnedAuth?.token || '').trim())
    const stdinToken = args.tokenStdin || !hasEnvOrPinned ? await readStdinToken(process.stdin) : ''
    ;({ token, url } = resolveInputs({ args, env, stdinToken, pinnedAuth }))
    ;({ config, changed } = mergeMcpConfig(existing, { url, token }))
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

  const others = Object.keys(config.mcpServers).filter((k) => k !== SERVER_KEY)
  console.log(`${changed ? 'Registered' : 'Already registered'} DevSpec MCP in ${file}`)
  console.log(`  url:   ${url}`)
  const identification = config.mcpServers[SERVER_KEY].headers?.[PLUGIN_HEADER]
  if (identification) console.log(`  plugin: ${identification}`)
  console.log(args.refresh ? '  credentials: preserved unchanged' : `  token: ${fingerprint(token)}`)
  if (others.length) console.log(`  left alone: ${others.join(', ')}`)
  console.log('\nRestart cursor-agent so it picks up the server.')
}

// fileURLToPath, not string-concatenation: a path with a space in it arrives as
// %20 in import.meta.url and raw in argv[1], so the naive compare is false and
// the script silently does nothing and exits 0. This repo lives under a
// directory with a space in it, which is why the test for this exists.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (invokedDirectly) {
  main(process.argv.slice(2), process.env, os.homedir()).catch((err) => {
    console.error(`setup-cursor: ${err.message}`)
    process.exit(1)
  })
}
