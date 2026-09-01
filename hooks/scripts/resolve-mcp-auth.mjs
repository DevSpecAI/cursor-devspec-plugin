#!/usr/bin/env node
/**
 * Resolve DevSpec MCP URL + Bearer token for Cursor remote-control hooks/poller.
 *
 * WHY THIS IS CURSOR-SPECIFIC (this repo owns every script in it — the plugins are
 * independent implementations and nothing is synced between them). The Cursor
 * extension stores the DevSpec token in Cursor's OWN MCP config —
 * `~/.cursor/mcp.json` (written by the "DevSpec: Set MCP token" command) or a
 * project `.cursor/mcp.json` — NOT in a `CLAUDE_PLUGIN_OPTION_*` env var. The
 * detached poller and the turn-mirroring hooks run in a side channel that doesn't
 * share Cursor's config, so they must resolve THAT token — otherwise
 * register_connection ran on one token while the poller heartbeats another and the
 * server rejects with "connection belongs to a different token" (the poll loop then
 * repeats the auth failure). So Cursor's mcp.json is the source of truth and wins
 * over a generic project `.mcp.json`. (The Claude Code plugin's resolver reads
 * `CLAUDE_PLUGIN_OPTION_*` + `~/.claude.json`, which are meaningless for Cursor.)
 *
 * Lookup order:
 * 1. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN (+ DEVSPEC_MCP_URL) — explicit override.
 * 2. opts.hostToken — an explicitly supplied host bearer.
 * 3. Cursor project MCP config — target cwd chain, then repository main worktree.
 * 4. Cursor home MCP config — `~/.cursor/mcp.json`.
 * 5. Generic project `.mcp.json` — target cwd chain, then main worktree.
 *
 * Prints JSON: { ok, token?, mcp_url?, source?, error? }
 * Never prints the full token in human logs — only to stdout JSON for piping.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DEFAULT_PROD_URL = 'https://devspec.ai/api/mcp'

// Captured at load so tests that overwrite HOME/USERPROFILE cannot make a
// project walk climb into the real ~/.cursor/mcp.json.
let processHomeAtLoad = null
try {
  processHomeAtLoad = fs.realpathSync.native(os.homedir())
} catch {
  try {
    processHomeAtLoad = path.resolve(os.homedir())
  } catch {
    processHomeAtLoad = null
  }
}

/** Windows editors (and PowerShell Set-Content -Encoding utf8) prefix UTF-8 with BOM. Cursor's MCP client tolerates it; Node JSON.parse does not. */
function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function createSearchLog() {
  return { entries: [] }
}

/**
 * Read and parse an MCP JSON file. Missing vs unreadable are distinct in `log`
 * so a BOM/corrupt home file is never reported as "no DevSpec entry".
 * `noteMissing: false` skips logging ancestor misses while walking parents.
 */
function readJson(file, log, { noteMissing = true } = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    try {
      const value = JSON.parse(stripUtf8Bom(raw))
      log?.entries.push({ path: file, status: 'ok' })
      return value
    } catch {
      log?.entries.push({ path: file, status: 'unreadable' })
      return null
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (noteMissing) log?.entries.push({ path: file, status: 'missing' })
      return null
    }
    log?.entries.push({ path: file, status: 'unreadable' })
    return null
  }
}

function formatLookedIn(log) {
  if (!log?.entries?.length) return ''
  const seen = new Set()
  const parts = []
  for (const entry of log.entries) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    parts.push(`${entry.path} (${entry.status})`)
  }
  return parts.join('; ')
}

function tokenNotFoundError(log, { urlOnly = false } = {}) {
  const looked = formatLookedIn(log)
  const unreadable = [...new Set((log?.entries || []).filter((e) => e.status === 'unreadable').map((e) => e.path))]
  const hint =
    'Run "DevSpec: Set MCP token" in Cursor (writes ~/.cursor/mcp.json), or set DEVSPEC_MCP_TOKEN.'
  if (unreadable.length) {
    return `Found a DevSpec MCP config but could not parse it: ${unreadable.join(', ')}.${looked ? ` Searched: ${looked}.` : ''} ${hint}`
  }
  if (urlOnly) {
    return `Found a DevSpec MCP URL but no Bearer token.${looked ? ` Searched: ${looked}.` : ''} ${hint}`
  }
  return `No DevSpec MCP token found.${looked ? ` Searched: ${looked}.` : ''} ${hint}`
}

function extractBearer(headers) {
  if (!headers || typeof headers !== 'object') return null
  const auth = headers.Authorization || headers.authorization
  if (typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : auth.trim() || null
}

function fromServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const url = entry.url || entry.serverUrl || entry.server_url || null
  const token = extractBearer(entry.headers) || entry.token || null
  if (!url && !token) return null
  return { mcp_url: url || DEFAULT_PROD_URL, token: token || null }
}

/** Pull the `devspec` server entry out of a parsed MCP-config JSON object. */
function devspecEntry(j) {
  const servers = j?.mcpServers || j?.mcp?.servers || {}
  return servers.devspec || servers.DevSpec || servers['devspec-mcp']
}

function uniqueRoots(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))]
}

function canonicalDir(dir) {
  try {
    return fs.realpathSync.native(dir)
  } catch {
    try {
      return fs.realpathSync(dir)
    } catch {
      return path.resolve(dir)
    }
  }
}

function sameDir(a, b) {
  if (!a || !b) return false
  return canonicalDir(a).toLowerCase() === canonicalDir(b).toLowerCase()
}

function resolvedHomeDir(home) {
  const dirs = []
  if (home) dirs.push(path.resolve(home))
  if (processHomeAtLoad) dirs.push(processHomeAtLoad)
  try {
    dirs.push(path.resolve(os.homedir()))
  } catch {
    // os.homedir() can throw if HOME/USERPROFILE is unset in a stripped env.
  }
  return dirs
}

function gitTopLevel(startDir) {
  try {
    return path.resolve(execFileSync('git', ['-C', startDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000,
    }).trim())
  } catch {
    return null
  }
}

function walkForConfig(startDir, relativeNames, home, log) {
  if (!startDir) return null
  let dir = path.resolve(startDir)
  const homeDirs = resolvedHomeDir(home)
  const gitBoundary = gitTopLevel(dir)
  let urlOnly = null
  for (let i = 0; i < 24; i++) {
    // Home-level Cursor config has its own explicit precedence below project
    // config. Never accidentally consume the real or test home during a walk —
    // temp directories on Windows live under the user profile, so climbing
    // would otherwise treat ~/.cursor/mcp.json as a project file.
    if (homeDirs.some((homeDir) => sameDir(dir, homeDir))) break
    for (const relativeName of relativeNames) {
      const file = path.join(dir, relativeName)
      const got = fromServerEntry(devspecEntry(readJson(file, log, { noteMissing: i === 0 })))
      if (got?.token) return { ...got, source: file }
      if (got?.mcp_url && !urlOnly) urlOnly = { ...got, source: file }
    }
    if (gitBoundary && sameDir(dir, gitBoundary)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return urlOnly
}

function firstConfigured(roots, relativeNames, home, log) {
  let urlOnly = null
  for (const root of uniqueRoots(roots)) {
    const got = walkForConfig(root, relativeNames, home, log)
    if (got?.token) return got
    if (got?.mcp_url && !urlOnly) urlOnly = got
  }
  return urlOnly
}

function cursorConfigAuth(cwd, { mainWorktree = null, home = null, log = null } = {}) {
  const project = firstConfigured([cwd, mainWorktree], [path.join('.cursor', 'mcp.json')], home, log)
  if (project?.token) return project

  const homeFile = home ? path.join(path.resolve(home), '.cursor', 'mcp.json') : null
  const fromHome = homeFile ? fromServerEntry(devspecEntry(readJson(homeFile, log))) : null
  if (fromHome?.token) return { ...fromHome, source: homeFile }
  if (project?.mcp_url) return project
  return fromHome?.mcp_url ? { ...fromHome, source: homeFile } : null
}

function projectMcpAuth(cwd, { mainWorktree = null, home = null, log = null } = {}) {
  return firstConfigured([cwd, mainWorktree], ['.mcp.json', 'mcp.json'], home, log)
}

/**
 * An actual bearer explicitly carried by the hook environment. Project/home
 * Cursor config is resolved later with the real target cwd and main worktree;
 * treating an unrelated home token as a host token would incorrectly let it
 * shadow project-specific identity in linked worktrees.
 *
 * Named `hostTokenFromEnv` because shared callers import this symbol. Cursor owns
 * only this resolver and its host-specific credential precedence.
 */
export function hostTokenFromEnv(env = process.env) {
  const envTok = env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN
  return typeof envTok === 'string' && envTok.trim() ? envTok.trim() : null
}

export function resolveDevspecMcpAuth(cwd = process.cwd(), opts = {}) {
  const hasInjectedEnv = Object.hasOwn(opts, 'env')
  const env = hasInjectedEnv ? (opts.env || {}) : process.env
  const home = opts.home || env.USERPROFILE || env.HOME || (hasInjectedEnv ? null : os.homedir())
  const mainWorktree = opts.mainWorktree || null
  const envToken = env.DEVSPEC_MCP_TOKEN || env.DEVSPEC_TOKEN || null
  const envUrl = env.DEVSPEC_MCP_URL || null
  const log = createSearchLog()
  log.entries.push({ path: 'env DEVSPEC_MCP_TOKEN', status: envToken ? 'ok' : 'missing' })
  if (envToken) {
    return { ok: true, token: envToken, mcp_url: envUrl || DEFAULT_PROD_URL, source: 'env' }
  }

  const cursor = cursorConfigAuth(cwd, { mainWorktree, home, log })
  const fromProject = projectMcpAuth(cwd, { mainWorktree, home, log })

  const hostToken =
    typeof opts.hostToken === 'string' && opts.hostToken.trim() ? opts.hostToken.trim() : null
  if (hostToken) {
    return {
      ok: true,
      token: hostToken,
      mcp_url: envUrl || cursor?.mcp_url || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: 'host',
    }
  }

  // Cursor's own config — the token register_connection ran on. Wins over .mcp.json.
  if (cursor?.token) {
    return {
      ok: true,
      token: cursor.token,
      mcp_url: envUrl || cursor.mcp_url || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: cursor.source,
    }
  }

  if (fromProject?.token) {
    return {
      ok: true,
      token: fromProject.token,
      mcp_url: envUrl || fromProject.mcp_url || cursor?.mcp_url || DEFAULT_PROD_URL,
      source: fromProject.source,
    }
  }

  const urlOnly = cursor?.mcp_url ? cursor : fromProject
  if (urlOnly?.mcp_url) {
    return {
      ok: false,
      mcp_url: envUrl || urlOnly.mcp_url,
      source: urlOnly.source,
      error: tokenNotFoundError(log, { urlOnly: true }),
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error: tokenNotFoundError(log),
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  // Reflect the same host-token preference the write path uses, for diagnostics.
  const result = resolveDevspecMcpAuth(process.cwd(), { env: process.env, hostToken: hostTokenFromEnv(process.env) })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
