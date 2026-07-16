#!/usr/bin/env node
/**
 * Unit tests for MCP auth resolve + 401 fallback.
 * Run: node --test hooks/scripts/resolve-mcp-auth.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isMcpAuthHttpError,
  listDevspecMcpAuthCandidates,
  mcpUrlFromApiBase,
  resolveDevspecMcpAuth,
  resolveDevspecMcpAuthValidated,
} from './resolve-mcp-auth.mjs'

describe('mcpUrlFromApiBase', () => {
  it('appends /api/mcp to an app origin', () => {
    assert.equal(mcpUrlFromApiBase('https://staging.devspec.ai'), 'https://staging.devspec.ai/api/mcp')
  })

  it('leaves an already-MCP URL alone', () => {
    assert.equal(
      mcpUrlFromApiBase('https://staging.devspec.ai/api/mcp'),
      'https://staging.devspec.ai/api/mcp',
    )
  })

  it('returns null for empty', () => {
    assert.equal(mcpUrlFromApiBase(''), null)
    assert.equal(mcpUrlFromApiBase(null), null)
  })
})

describe('isMcpAuthHttpError', () => {
  it('detects 401 and 403 from mcpToolsCall errors', () => {
    assert.equal(isMcpAuthHttpError(new Error('MCP HTTP 401: {"error":"Invalid"}')), true)
    assert.equal(isMcpAuthHttpError(new Error('MCP HTTP 403: forbidden')), true)
    assert.equal(isMcpAuthHttpError(new Error('MCP HTTP 500: boom')), false)
    assert.equal(isMcpAuthHttpError(new Error('fetch failed')), false)
  })
})

describe('resolveDevspecMcpAuthValidated', () => {
  let tmp
  let prevEnv

  beforeEach(() => {
    prevEnv = {
      DEVSPEC_MCP_TOKEN: process.env.DEVSPEC_MCP_TOKEN,
      DEVSPEC_TOKEN: process.env.DEVSPEC_TOKEN,
      DEVSPEC_MCP_URL: process.env.DEVSPEC_MCP_URL,
      DEVSPEC_API_URL: process.env.DEVSPEC_API_URL,
    }
    delete process.env.DEVSPEC_MCP_TOKEN
    delete process.env.DEVSPEC_TOKEN
    delete process.env.DEVSPEC_MCP_URL
    delete process.env.DEVSPEC_API_URL

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-auth-'))
    fs.writeFileSync(
      path.join(tmp, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          devspec: {
            url: 'https://example.test/api/mcp',
            headers: { Authorization: 'Bearer project-good-token' },
          },
        },
      }),
    )
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('falls back to .mcp.json when env token gets 401', async () => {
    process.env.DEVSPEC_MCP_TOKEN = 'stale-env-token'
    process.env.DEVSPEC_MCP_URL = 'https://example.test/api/mcp'

    const probed = []
    const result = await resolveDevspecMcpAuthValidated({
      cwd: tmp,
      probe: async ({ token, source }) => {
        probed.push({ token, source })
        if (token === 'stale-env-token') {
          throw new Error('MCP HTTP 401: {"error":"Invalid or revoked API token"}')
        }
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.token, 'project-good-token')
    assert.equal(result.validated, true)
    assert.equal(probed.length, 2)
    assert.equal(probed[0].source, 'env')
    assert.ok(String(probed[1].source).endsWith('.mcp.json'))
    assert.ok(result.fallback_from?.length >= 1)
  })

  it('does not fall back on non-auth failures', async () => {
    process.env.DEVSPEC_MCP_TOKEN = 'env-token'
    process.env.DEVSPEC_MCP_URL = 'https://example.test/api/mcp'

    const result = await resolveDevspecMcpAuthValidated({
      cwd: tmp,
      probe: async () => {
        throw new Error('fetch failed')
      },
    })

    assert.equal(result.ok, false)
    assert.match(result.error, /Auth smoke failed \(env\)/)
  })

  it('sync resolve still prefers env first (CI path)', () => {
    process.env.DEVSPEC_MCP_TOKEN = 'env-token'
    process.env.DEVSPEC_API_URL = 'https://staging.example'
    const r = resolveDevspecMcpAuth(tmp)
    assert.equal(r.ok, true)
    assert.equal(r.token, 'env-token')
    assert.equal(r.source, 'env')
    assert.equal(r.mcp_url, 'https://staging.example/api/mcp')
  })

  it('lists env before project candidates', () => {
    process.env.DEVSPEC_MCP_TOKEN = 'env-token'
    process.env.DEVSPEC_MCP_URL = 'https://example.test/api/mcp'
    const { candidates } = listDevspecMcpAuthCandidates(tmp)
    assert.equal(candidates[0].source, 'env')
    assert.equal(candidates[0].token, 'env-token')
    assert.equal(candidates[1].token, 'project-good-token')
  })
})
