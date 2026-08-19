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
 * server rejects with "connection belongs to a different token" (dispatch delivery
 * then spams). So Cursor's mcp.json is the source of truth and wins over a generic
 * project `.mcp.json`. (The Claude Code plugin's resolver reads
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
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

function gitTopLevel(startDir) {
  try {
    return path.resolve(execFileSync('git', ['-C', startDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000,
    }).trim())
  } catch {
    return null
  }
}

function walkForConfig(startDir, relativeNames, home) {
  if (!startDir) return null
  let dir = path.resolve(startDir)
  const homePath = home ? path.resolve(home) : null
  const projectBoundary = homePath ? null : (gitTopLevel(dir) || dir)
  let urlOnly = null
  for (let i = 0; i < 24; i++) {
    // Home-level Cursor config has its own explicit precedence below project
    // config. Never accidentally consume it during a project walk.
    if (homePath && dir === homePath) break
    for (const relativeName of relativeNames) {
      const file = path.join(dir, relativeName)
      const got = fromServerEntry(devspecEntry(readJson(file)))
      if (got?.token) return { ...got, source: file }
      if (got?.mcp_url && !urlOnly) urlOnly = { ...got, source: file }
    }
    if (projectBoundary && dir === projectBoundary) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return urlOnly
}

function firstConfigured(roots, relativeNames, home) {
  let urlOnly = null
  for (const root of uniqueRoots(roots)) {
    const got = walkForConfig(root, relativeNames, home)
    if (got?.token) return got
    if (got?.mcp_url && !urlOnly) urlOnly = got
  }
  return urlOnly
}

function cursorConfigAuth(cwd, { mainWorktree = null, home = null } = {}) {
  const project = firstConfigured([cwd, mainWorktree], [path.join('.cursor', 'mcp.json')], home)
  if (project?.token) return project

  const homeFile = home ? path.join(path.resolve(home), '.cursor', 'mcp.json') : null
  const fromHome = homeFile ? fromServerEntry(devspecEntry(readJson(homeFile))) : null
  if (fromHome?.token) return { ...fromHome, source: homeFile }
  if (project?.mcp_url) return project
  return fromHome?.mcp_url ? { ...fromHome, source: homeFile } : null
}

function projectMcpAuth(cwd, { mainWorktree = null, home = null } = {}) {
  return firstConfigured([cwd, mainWorktree], ['.mcp.json', 'mcp.json'], home)
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
  if (envToken) {
    return { ok: true, token: envToken, mcp_url: envUrl || DEFAULT_PROD_URL, source: 'env' }
  }

  const cursor = cursorConfigAuth(cwd, { mainWorktree, home })
  const fromProject = projectMcpAuth(cwd, { mainWorktree, home })

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
      error:
        'Found a DevSpec MCP URL but no Bearer token. Run "DevSpec: Set MCP token" in Cursor (writes ~/.cursor/mcp.json), or set DEVSPEC_MCP_TOKEN.',
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error:
      'No DevSpec MCP token found. Run "DevSpec: Set MCP token" in Cursor (writes ~/.cursor/mcp.json), or set DEVSPEC_MCP_TOKEN.',
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  // Reflect the same host-token preference the write path uses, for diagnostics.
  const result = resolveDevspecMcpAuth(process.cwd(), { env: process.env, hostToken: hostTokenFromEnv(process.env) })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
