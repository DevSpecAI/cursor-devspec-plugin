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
 *   node scripts/setup-cursor.mjs --token dvs_…
 *   node scripts/setup-cursor.mjs --token dvs_… --api-url https://api.devspecstaging.com
 *   DEVSPEC_MCP_TOKEN=dvs_… node scripts/setup-cursor.mjs
 *
 * Other servers in the file are preserved. The token is never printed back.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_API_URL = 'https://api.devspec.ai'
const SERVER_KEY = 'devspec'

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const [flag, inline] = eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)]
    if (flag === '--token') out.token = inline ?? argv[++i]
    else if (flag === '--api-url') out.apiUrl = inline ?? argv[++i]
    else if (flag === '--home') out.home = inline ?? argv[++i]
  }
  return out
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
export function mergeMcpConfig(existing, { url, token }) {
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
  entry.headers = { ...(entry.headers ?? {}), Authorization: `Bearer ${token}` }
  servers[SERVER_KEY] = entry
  config.mcpServers = servers
  return { config, changed: before !== JSON.stringify(entry) }
}

export function resolveInputs({ args, env }) {
  const token = (args.token ?? env.DEVSPEC_MCP_TOKEN ?? env.DEVSPEC_TOKEN ?? '').trim()
  const base = (args.apiUrl ?? env.DEVSPEC_API_URL ?? DEFAULT_API_URL).trim().replace(/\/+$/, '')
  if (!token) {
    throw new Error(
      'No token. Pass --token dvs_… or set DEVSPEC_MCP_TOKEN.\n' +
        'Create one in DevSpec under You → Connections → Connect a tool (Read & write).',
    )
  }
  if (!/^https?:\/\//.test(base)) {
    throw new Error(`--api-url must be an http(s) URL, got: ${base}`)
  }
  return { token, url: `${base}/api/mcp` }
}

async function main(argv, env, homedir) {
  const args = parseArgs(argv)
  const { token, url } = resolveInputs({ args, env })
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

  const { config, changed } = mergeMcpConfig(existing, { url, token })
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const others = Object.keys(config.mcpServers).filter((k) => k !== SERVER_KEY)
  console.log(`${changed ? 'Registered' : 'Already registered'} DevSpec MCP in ${file}`)
  console.log(`  url:   ${url}`)
  console.log(`  token: ${fingerprint(token)}`)
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
