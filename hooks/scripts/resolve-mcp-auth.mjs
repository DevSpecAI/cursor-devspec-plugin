#!/usr/bin/env node
/**
 * Resolve DevSpec MCP URL + Bearer token for remote-control hooks/poller.
 *
 * Lookup order (first wins for sync resolve):
 * 1. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN (+ DEVSPEC_MCP_URL or DEVSPEC_API_URL)
 * 2. Project .mcp.json (cwd and parents)
 * 3. ~/.claude.json project entries that match cwd (mcpServers.devspec)
 * 4. ~/.claude.json top-level mcpServers.devspec
 * 5. CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN — the plugin userConfig token
 *    (keychain-stored; Claude Code exports it to hook/tool subprocesses).
 *    Lowest priority so a developer's own .mcp.json (e.g. staging) still wins.
 *
 * Validated resolve (`resolveDevspecMcpAuthValidated`) walks the same order but
 * probes each candidate: on HTTP 401/403 it tries the next source so a stale
 * shell env token cannot permanently override a good project `.mcp.json`.
 *
 * Prints JSON: { ok, token?, mcp_url?, source?, error? }
 * Never prints the full token in human logs — only to stdout JSON for piping.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

/** Map DEVSPEC_API_URL (app origin) → MCP endpoint when DEVSPEC_MCP_URL is unset. */
export function mcpUrlFromApiBase(apiBase) {
  if (!apiBase || typeof apiBase !== 'string') return null
  const trimmed = apiBase.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  if (/\/api\/mcp$/i.test(trimmed)) return trimmed
  return `${trimmed}/api/mcp`
}

function resolveEnvMcpUrl() {
  return (
    process.env.DEVSPEC_MCP_URL ||
    mcpUrlFromApiBase(process.env.DEVSPEC_API_URL) ||
    null
  )
}

function fromServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const url = entry.url || entry.serverUrl || entry.server_url || null
  const token = extractBearer(entry.headers) || entry.token || null
  if (!url && !token) return null
  return { mcp_url: url || DEFAULT_PROD_URL, token: token || null }
}

function walkMcpJson(startDir) {
  let dir = path.resolve(startDir || process.cwd())
  for (let i = 0; i < 12; i++) {
    for (const name of ['.mcp.json', 'mcp.json']) {
      const file = path.join(dir, name)
      if (!fs.existsSync(file)) continue
      const j = readJson(file)
      const servers = j?.mcpServers || j?.mcp?.servers || {}
      const entry = servers.devspec || servers.DevSpec || servers['devspec-mcp']
      const got = fromServerEntry(entry)
      if (got?.token) return { ...got, source: file }
      if (got?.mcp_url) return { ...got, source: file }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function fromClaudeJson(cwd) {
  const file = path.join(os.homedir(), '.claude.json')
  const j = readJson(file)
  if (!j) return null

  const abs = path.resolve(cwd || process.cwd())

  // Prefer project-scoped config matching cwd prefix (longest match wins)
  const projects = j.projects || {}
  const matches = Object.keys(projects)
    .filter((p) => abs === p || abs.startsWith(p + path.sep) || p.startsWith(abs + path.sep))
    .sort((a, b) => b.length - a.length)

  for (const proj of matches) {
    const servers = projects[proj]?.mcpServers || {}
    const entry = servers.devspec || servers.DevSpec
    const got = fromServerEntry(entry)
    if (got?.token) return { ...got, source: `${file}#projects[${proj}]` }
  }

  // Any project entry named for this path substring
  for (const [proj, cfg] of Object.entries(projects)) {
    if (!proj.includes('devspec') && !abs.includes(path.basename(proj))) continue
    const servers = cfg?.mcpServers || {}
    const entry = servers.devspec || servers.DevSpec
    const got = fromServerEntry(entry)
    if (got?.token) return { ...got, source: `${file}#projects[${proj}]` }
  }

  const top = fromServerEntry((j.mcpServers || {}).devspec)
  if (top?.token) return { ...top, source: `${file}#mcpServers` }

  return null
}

/** True when an MCP tools/call failed with HTTP 401 or 403 (stale/wrong token). */
export function isMcpAuthHttpError(err) {
  const msg = String(err?.message || err || '')
  return /\bMCP HTTP 401\b/.test(msg) || /\bMCP HTTP 403\b/.test(msg)
}

/**
 * Ordered auth candidates (env → project → claude → plugin). Deduped by token+url.
 * Exported for tests and validated resolve.
 */
export function listDevspecMcpAuthCandidates(cwd = process.cwd()) {
  const envUrl = resolveEnvMcpUrl()
  const candidates = []
  const seen = new Set()

  function push(entry) {
    if (!entry?.token) return
    const mcp_url = entry.mcp_url || envUrl || DEFAULT_PROD_URL
    const key = `${entry.token}\0${mcp_url}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({
      ok: true,
      token: entry.token,
      mcp_url,
      source: entry.source,
    })
  }

  const envToken = process.env.DEVSPEC_MCP_TOKEN || process.env.DEVSPEC_TOKEN || null
  if (envToken) {
    push({
      token: envToken,
      mcp_url: envUrl || DEFAULT_PROD_URL,
      source: 'env',
    })
  }

  const fromProject = walkMcpJson(cwd)
  if (fromProject?.token) {
    push({
      token: fromProject.token,
      mcp_url: envUrl || fromProject.mcp_url || DEFAULT_PROD_URL,
      source: fromProject.source,
    })
  }

  const fromClaude = fromClaudeJson(cwd)
  if (fromClaude?.token) {
    push({
      token: fromClaude.token,
      mcp_url: envUrl || fromClaude.mcp_url || DEFAULT_PROD_URL,
      source: fromClaude.source,
    })
  }

  const pluginOptionToken =
    process.env.CLAUDE_PLUGIN_OPTION_DEVSPEC_TOKEN ||
    process.env.CLAUDE_PLUGIN_OPTION_devspec_token ||
    null
  if (pluginOptionToken) {
    push({
      token: pluginOptionToken,
      mcp_url: envUrl || fromProject?.mcp_url || DEFAULT_PROD_URL,
      source: 'plugin_user_config',
    })
  }

  return { candidates, fromProject, envUrl }
}

/**
 * Sync resolve — first candidate wins (env still preferred for CI).
 * Does not probe the network; use resolveDevspecMcpAuthValidated when starting
 * a long-lived poller so a stale env token can fall back after 401.
 */
export function resolveDevspecMcpAuth(cwd = process.cwd()) {
  const { candidates, fromProject, envUrl } = listDevspecMcpAuthCandidates(cwd)
  if (candidates.length > 0) {
    return candidates[0]
  }

  // URL-only from project file (token missing)
  if (fromProject?.mcp_url) {
    return {
      ok: false,
      mcp_url: envUrl || fromProject.mcp_url,
      source: fromProject.source,
      error:
        'Found DevSpec MCP URL but no Bearer token. Set DEVSPEC_MCP_TOKEN or add headers.Authorization on the devspec server in .mcp.json.',
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error:
      'No DevSpec MCP token found. Provide your token via the plugin configuration, set DEVSPEC_MCP_TOKEN, or configure mcpServers.devspec.headers.Authorization in project .mcp.json.',
  }
}

/**
 * Probe each auth candidate; on HTTP 401/403 try the next source.
 * `probe` must be async ({ mcpUrl, token, source }) => void and throw on failure
 * (preferably via mcpToolsCall so messages include `MCP HTTP 401:`).
 */
export async function resolveDevspecMcpAuthValidated({
  cwd = process.cwd(),
  probe,
  skipTokens = null,
} = {}) {
  if (typeof probe !== 'function') {
    throw new Error('resolveDevspecMcpAuthValidated requires an async probe({ mcpUrl, token, source })')
  }

  const { candidates, fromProject, envUrl } = listDevspecMcpAuthCandidates(cwd)
  const skip = skipTokens instanceof Set ? skipTokens : new Set(skipTokens || [])

  if (candidates.length === 0) {
    if (fromProject?.mcp_url) {
      return {
        ok: false,
        mcp_url: envUrl || fromProject.mcp_url,
        source: fromProject.source,
        error:
          'Found DevSpec MCP URL but no Bearer token. Set DEVSPEC_MCP_TOKEN or add headers.Authorization on the devspec server in .mcp.json.',
      }
    }
    return {
      ok: false,
      mcp_url: envUrl || DEFAULT_PROD_URL,
      error:
        'No DevSpec MCP token found. Provide your token via the plugin configuration, set DEVSPEC_MCP_TOKEN, or configure mcpServers.devspec.headers.Authorization in project .mcp.json.',
    }
  }

  const failures = []
  for (const c of candidates) {
    if (skip.has(c.token)) continue
    try {
      await probe({ mcpUrl: c.mcp_url, token: c.token, source: c.source })
      return {
        ...c,
        ok: true,
        validated: true,
        fallback_from: failures.length > 0 ? failures : undefined,
      }
    } catch (e) {
      const message = String(e?.message || e)
      failures.push({ source: c.source, message })
      if (isMcpAuthHttpError(e)) {
        continue
      }
      // Non-auth failure (network, 5xx, parse): fail fast — do not silently hop tokens.
      return {
        ok: false,
        mcp_url: c.mcp_url,
        source: c.source,
        error: `Auth smoke failed (${c.source}): ${message}`,
        failures,
      }
    }
  }

  const detail = failures.map((f) => `${f.source}: ${f.message}`).join(' | ')
  return {
    ok: false,
    mcp_url: candidates[0]?.mcp_url || envUrl || DEFAULT_PROD_URL,
    error: `All MCP auth candidates failed auth smoke (401/403). ${detail}`,
    failures,
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('resolve-mcp-auth.mjs')) {
  const result = resolveDevspecMcpAuth(process.cwd())
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.ok ? 0 : 1)
}
