#!/usr/bin/env node
/**
 * Unit tests for the Cursor DevSpec MCP auth resolver.
 * Run: node --test hooks/scripts/resolve-mcp-auth.test.mjs
 *
 * The load-bearing property: the Cursor extension writes the token to Cursor's own
 * MCP config (~/.cursor/mcp.json, or a project .cursor/mcp.json), so that MUST win
 * over a generic project .mcp.json — otherwise the poller heartbeats a different
 * token and the server rejects "connection belongs to a different token".
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveDevspecMcpAuth, hostTokenFromEnv } from './resolve-mcp-auth.mjs'

let root
let fakeHome
const savedEnv = {}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorres-'))
  fakeHome = path.join(root, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  for (const k of ['HOME', 'USERPROFILE', 'DEVSPEC_MCP_TOKEN', 'DEVSPEC_TOKEN', 'DEVSPEC_MCP_URL']) savedEnv[k] = process.env[k]
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  delete process.env.DEVSPEC_MCP_TOKEN
  delete process.env.DEVSPEC_TOKEN
  delete process.env.DEVSPEC_MCP_URL
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function proj(name) {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}
function cursorJson(dir, token, url = 'https://devspec.ai/api/mcp') {
  const c = path.join(dir, '.cursor')
  fs.mkdirSync(c, { recursive: true })
  fs.writeFileSync(
    path.join(c, 'mcp.json'),
    JSON.stringify({ mcpServers: { devspec: { url, headers: { Authorization: `Bearer ${token}` } } } }),
  )
}
function mcpJson(dir, token, url = 'https://devspec.ai/api/mcp') {
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { devspec: { url, headers: { Authorization: `Bearer ${token}` } } } }),
  )
}

function realWorktree() {
  const main = proj('main')
  const linked = path.join(root, 'linked')
  execFileSync('git', ['-C', main, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', main, 'config', 'user.name', 'Cursor Auth Test'])
  execFileSync('git', ['-C', main, 'config', 'user.email', 'cursor-auth@example.invalid'])
  execFileSync('git', ['-C', main, 'commit', '--allow-empty', '-q', '-m', 'initial'])
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'linked', linked])
  return { main, linked }
}

describe('resolveDevspecMcpAuth (Cursor)', () => {
  it('prefers .cursor/mcp.json over a generic project .mcp.json (the fix)', () => {
    const d = proj('both')
    mcpJson(d, 'dvs_from_mcpjson')
    cursorJson(d, 'dvs_from_cursor')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'dvs_from_cursor')
    assert.match(auth.source, /\.cursor[\\/]mcp\.json$/)
  })

  it('reads ~/.cursor/mcp.json (home) when the project has none', () => {
    const d = proj('homeonly')
    cursorJson(fakeHome, 'dvs_home_cursor')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_home_cursor')
    assert.equal(hostTokenFromEnv(process.env), null)
  })

  it('project .cursor/mcp.json wins over home ~/.cursor/mcp.json', () => {
    const d = proj('projwins')
    cursorJson(fakeHome, 'dvs_home')
    cursorJson(d, 'dvs_project')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_project')
  })

  it('falls back to .mcp.json when no .cursor config token is reachable', () => {
    const d = proj('mcponly')
    mcpJson(d, 'dvs_only_mcp')
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_only_mcp')
    assert.match(auth.source, /\.mcp\.json$/)
  })

  it('DEVSPEC_MCP_TOKEN overrides the config files', () => {
    const d = proj('envwin')
    cursorJson(d, 'dvs_cursor')
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_env_override'
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.token, 'dvs_env_override')
    assert.equal(auth.source, 'env')
  })

  it('an explicit opts.hostToken wins over the Cursor config (below env)', () => {
    const d = proj('hosttok')
    cursorJson(d, 'dvs_cursor')
    const auth = resolveDevspecMcpAuth(d, { hostToken: 'dvs_explicit_host' })
    assert.equal(auth.token, 'dvs_explicit_host')
    assert.equal(auth.source, 'host')
  })

  it('walks upward to repository-root .cursor/mcp.json from a nested target', () => {
    const repo = proj('nested')
    const nested = path.join(repo, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    cursorJson(repo, 'dvs_repo_cursor')
    assert.equal(resolveDevspecMcpAuth(nested).token, 'dvs_repo_cursor')
  })

  it('inherits main-worktree Cursor credentials before home credentials', () => {
    const { main, linked } = realWorktree()
    cursorJson(main, 'dvs_main_cursor', 'https://staging.example/mcp')
    cursorJson(fakeHome, 'dvs_home_cursor', 'https://prod.example/mcp')
    const auth = resolveDevspecMcpAuth(linked, { mainWorktree: main })
    assert.equal(auth.token, 'dvs_main_cursor')
    assert.equal(auth.mcp_url, 'https://staging.example/mcp')
  })

  it('prefers target-worktree project credentials over main-worktree credentials', () => {
    const { main, linked } = realWorktree()
    cursorJson(main, 'dvs_main_cursor')
    cursorJson(linked, 'dvs_linked_cursor')
    assert.equal(resolveDevspecMcpAuth(linked, { mainWorktree: main }).token, 'dvs_linked_cursor')
  })

  it('uses main-worktree generic .mcp.json only after Cursor-specific sources', () => {
    const { main, linked } = realWorktree()
    mcpJson(main, 'dvs_main_generic', 'https://generic.example/mcp')
    const auth = resolveDevspecMcpAuth(linked, { mainWorktree: main, env: { HOME: fakeHome } })
    assert.equal(auth.token, 'dvs_main_generic')
    assert.equal(auth.mcp_url, 'https://generic.example/mcp')
  })

  it('honors an injected environment without borrowing ambient credentials', () => {
    const d = path.join(fakeHome, 'ambient-project')
    fs.mkdirSync(d, { recursive: true })
    cursorJson(fakeHome, 'dvs_ambient_home')
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_ambient'
    const isolated = resolveDevspecMcpAuth(d, { env: {} })
    assert.equal(isolated.ok, false)
    const injected = resolveDevspecMcpAuth(d, {
      env: { DEVSPEC_MCP_TOKEN: 'dvs_injected', DEVSPEC_MCP_URL: 'https://injected.example/mcp' },
    })
    assert.equal(injected.token, 'dvs_injected')
    assert.equal(injected.mcp_url, 'https://injected.example/mcp')
    assert.equal(hostTokenFromEnv({ DEVSPEC_MCP_TOKEN: 'dvs_explicit' }), 'dvs_explicit')
  })

  it('reports a Cursor-shaped error when a URL is present but no token', () => {
    const d = proj('urlonly')
    const c = path.join(d, '.cursor')
    fs.mkdirSync(c, { recursive: true })
    fs.writeFileSync(
      path.join(c, 'mcp.json'),
      JSON.stringify({ mcpServers: { devspec: { url: 'https://devspec.ai/api/mcp' } } }),
    )
    // Stop walkMcpJson from climbing into a real ancestor ~/.mcp.json that has a
    // token (common on developer machines) — project .mcp.json with URL-only wins
    // the walk without a bearer.
    fs.writeFileSync(
      path.join(d, '.mcp.json'),
      JSON.stringify({ mcpServers: { devspec: { url: 'https://devspec.ai/api/mcp' } } }),
    )
    const auth = resolveDevspecMcpAuth(d)
    assert.equal(auth.ok, false)
    assert.match(auth.error, /DevSpec: Set MCP token/)
  })
})
