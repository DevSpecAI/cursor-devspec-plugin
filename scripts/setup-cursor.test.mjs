import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { mergeMcpConfig, resolveInputs, fingerprint, parseArgs } from './setup-cursor.mjs'

const run = promisify(execFile)
// fileURLToPath, not .pathname: this repo lives under a directory with a space
// in it, and .pathname hands back %20 which node cannot resolve.
const SCRIPT = fileURLToPath(new URL('./setup-cursor.mjs', import.meta.url))

const withHome = async (fn) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devspec-setup-'))
  try {
    return await fn(home)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

describe('setup-cursor', () => {
  it('writes the shape resolve-mcp-auth reads', () => {
    const { config } = mergeMcpConfig(null, { url: 'https://api.devspec.ai/api/mcp', token: 'dvs_abc' })
    assert.equal(config.mcpServers.devspec.url, 'https://api.devspec.ai/api/mcp')
    assert.equal(config.mcpServers.devspec.headers.Authorization, 'Bearer dvs_abc')
  })

  it('leaves other servers and other headers alone', () => {
    const existing = {
      mcpServers: {
        other: { url: 'https://example.test/mcp' },
        devspec: { url: 'old', headers: { 'X-Keep': '1', Authorization: 'Bearer stale' } },
      },
    }
    const { config } = mergeMcpConfig(existing, { url: 'https://new/api/mcp', token: 'dvs_new' })
    assert.deepEqual(config.mcpServers.other, { url: 'https://example.test/mcp' })
    assert.equal(config.mcpServers.devspec.headers['X-Keep'], '1')
    assert.equal(config.mcpServers.devspec.headers.Authorization, 'Bearer dvs_new')
    assert.equal(config.mcpServers.devspec.url, 'https://new/api/mcp')
  })

  it('reports no change on a re-run, so "registered" means something happened', () => {
    const first = mergeMcpConfig(null, { url: 'https://u/api/mcp', token: 't0ken-long-enough' })
    assert.equal(first.changed, true)
    const second = mergeMcpConfig(first.config, { url: 'https://u/api/mcp', token: 't0ken-long-enough' })
    assert.equal(second.changed, false)
  })

  it('defaults to production and appends /api/mcp exactly once', () => {
    assert.equal(resolveInputs({ args: {}, env: { DEVSPEC_MCP_TOKEN: 'dvs_x' } }).url,
      'https://api.devspec.ai/api/mcp')
    assert.equal(resolveInputs({ args: { apiUrl: 'https://api.devspecstaging.com/' }, env: { DEVSPEC_MCP_TOKEN: 'dvs_x' } }).url,
      'https://api.devspecstaging.com/api/mcp')
  })

  it('refuses without a token rather than writing a broken config', () => {
    assert.throws(() => resolveInputs({ args: {}, env: {} }), /No token/)
  })

  it('refuses a non-URL api base', () => {
    assert.throws(() => resolveInputs({ args: { apiUrl: 'api.devspec.ai' }, env: { DEVSPEC_MCP_TOKEN: 'dvs_x' } }), /http\(s\) URL/)
  })

  it('never echoes the token', () => {
    const fp = fingerprint('dvs_supersecrettokenvalue')
    assert.equal(fp.includes('supersecret'), false)
    assert.match(fp, /^dvs_….*\(\d+ chars\)$/)
  })

  it('parses --flag=value as well as --flag value', () => {
    assert.deepEqual(parseArgs(['--token=abc', '--api-url', 'https://x']), { token: 'abc', apiUrl: 'https://x' })
  })

  it('end to end: creates the file, preserves a neighbour, and prints no token', async () => {
    await withHome(async (home) => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true })
      await fs.writeFile(
        path.join(home, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { neighbour: { url: 'https://n/mcp' } } }),
        'utf8',
      )
      const { stdout } = await run('node', [SCRIPT, '--token', 'dvs_endtoendtokenvalue', '--home', home])
      const written = JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
      assert.equal(written.mcpServers.devspec.headers.Authorization, 'Bearer dvs_endtoendtokenvalue')
      assert.equal(written.mcpServers.neighbour.url, 'https://n/mcp')
      assert.equal(stdout.includes('endtoendtokenvalue'), false)
      assert.match(stdout, /left alone: neighbour/)
    })
  })

  it('refuses to overwrite a file it cannot parse', async () => {
    await withHome(async (home) => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true })
      const file = path.join(home, '.cursor', 'mcp.json')
      await fs.writeFile(file, '{ this is not json', 'utf8')
      await assert.rejects(
        run('node', [SCRIPT, '--token', 'dvs_token', '--home', home]),
        (err) => /could not be parsed/.test(err.stderr),
      )
      assert.equal(await fs.readFile(file, 'utf8'), '{ this is not json')
    })
  })
})
