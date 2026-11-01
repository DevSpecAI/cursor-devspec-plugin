import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { mergeMcpConfig, refreshMcpEntry, resolveInputs, fingerprint, parseArgs } from './setup-cursor.mjs'
import { readFileSync } from 'node:fs'

const run = promisify(execFile)
// fileURLToPath, not .pathname: this repo lives under a directory with a space
// in it, and .pathname hands back %20 which node cannot resolve.
const SCRIPT = fileURLToPath(new URL('./setup-cursor.mjs', import.meta.url))
// The released version, from the manifest the script itself reads (item f6566758).
const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../.cursor-plugin/plugin.json', import.meta.url), 'utf8')).version
const IDENTIFICATION = `cursor/${PLUGIN_VERSION}`

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

  it("makes Cursor's own MCP client name this plugin and its manifest version", () => {
    const { config } = mergeMcpConfig(null, { url: 'https://api.devspec.ai/api/mcp', token: 'dvs_abc' })
    assert.equal(config.mcpServers.devspec.headers['x-devspec-plugin'], IDENTIFICATION)
  })

  it('refresh moves the header to the running version and keeps every other header', () => {
    const existing = { url: 'https://old/api/mcp', headers: { Authorization: 'Bearer kept', 'X-Keep': '1', 'x-devspec-plugin': 'cursor/0.0.1' } }
    const { entry, changed } = refreshMcpEntry(existing, { url: 'https://new/api/mcp' })
    assert.equal(changed, true)
    assert.deepEqual(entry.headers, { Authorization: 'Bearer kept', 'X-Keep': '1', 'x-devspec-plugin': IDENTIFICATION })
    assert.equal(existing.headers['x-devspec-plugin'], 'cursor/0.0.1', 'the parsed file is not mutated in place')
    assert.equal(refreshMcpEntry(entry, { url: 'https://new/api/mcp' }).changed, false)
  })

  it('without a readable manifest version it writes no identification rather than a malformed one', () => {
    const { config } = mergeMcpConfig(null, { url: 'https://u/api/mcp', token: 'dvs_abc', identification: {} })
    assert.equal(config.mcpServers.devspec.headers['x-devspec-plugin'], undefined)
    const { entry } = refreshMcpEntry({ url: 'https://u/api/mcp', headers: { Authorization: 'Bearer t' } }, { url: 'https://u/api/mcp', identification: {} })
    assert.deepEqual(entry.headers, { Authorization: 'Bearer t' })
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

  it('selects the host namespace without changing the chosen environment', () => {
    assert.equal(resolveInputs({ args: {}, env: { DEVSPEC_MCP_TOKEN: 'dvs_x' } }).url,
      'https://api.devspec.ai/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection')
    assert.equal(resolveInputs({ args: { apiUrl: 'https://api.devspecstaging.com/' }, env: { DEVSPEC_MCP_TOKEN: 'dvs_x' } }).url,
      'https://api.devspecstaging.com/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection')
  })

  it('refuses without a token rather than writing a broken config', () => {
    assert.throws(() => resolveInputs({ args: {}, env: {} }), /No token/)
  })

  it('links the Agent setup page of the environment being set up, not a breadcrumb', () => {
    const message = (args, env = {}) => {
      try {
        resolveInputs({ args, env })
      } catch (err) {
        return err.message
      }
      throw new Error('expected resolveInputs to refuse without a token')
    }
    assert.match(message({}), /Agent setup page: https:\/\/app\.devspec\.ai\/settings\/agents /)
    assert.match(message({ apiUrl: 'https://api.devspecstaging.com' }), /Agent setup page: https:\/\/app\.devspecstaging\.com\/settings\/agents /)
    assert.match(message({}, { DEVSPEC_API_URL: 'https://api.devspecstaging.com/' }), /https:\/\/app\.devspecstaging\.com\/settings\/agents /)
    assert.doesNotMatch(message({}), /You →|Coding agents/)
  })

  it('refuses a non-URL api base', () => {
    assert.throws(() => resolveInputs({ args: { apiUrl: 'api.devspec.ai' }, env: { DEVSPEC_MCP_TOKEN: 'dvs_x' } }), /http\(s\) URL/)
  })

  it('never echoes the token', () => {
    const fp = fingerprint('dvs_supersecrettokenvalue')
    assert.equal(fp.includes('supersecret'), false)
    assert.match(fp, /^dvs_….*\(\d+ chars\)$/)
  })

  it('parses --flag=value as well as --flag value and flags --token for rejection', () => {
    assert.deepEqual(parseArgs(['--api-url=https://x', '--home', '/tmp/h']), { apiUrl: 'https://x', home: '/tmp/h' })
    assert.deepEqual(parseArgs(['--token=abc', '--api-url', 'https://x']), { rejectedTokenFlag: true, apiUrl: 'https://x' })
    assert.deepEqual(parseArgs(['--token', 'abc', '--api-url', 'https://x']), { rejectedTokenFlag: true, apiUrl: 'https://x' })
  })

  it('rejects --token on the command line so tokens do not land in argv or shell history', () => {
    assert.throws(
      () => resolveInputs({ args: parseArgs(['--token', 'dvs_secret']), env: {} }),
      /Do not pass --token on the command line/,
    )
    assert.throws(
      () => resolveInputs({ args: parseArgs(['--token=dvs_secret']), env: {} }),
      /Do not pass --token on the command line/,
    )
  })

  it('reads token and API URL from ~/.devspec/auth.json or stdin when env is unset', async () => {
    await withHome(async (home) => {
      await fs.mkdir(path.join(home, '.devspec'), { recursive: true })
      await fs.writeFile(
        path.join(home, '.devspec', 'auth.json'),
        JSON.stringify({ token: 'dvs_from_auth_json_file', mcp_url: 'https://api.devspecstaging.com/api/mcp' }),
        'utf8',
      )
      await run('node', [SCRIPT, '--home', home])
      const written = JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
      assert.equal(written.mcpServers.devspec.headers.Authorization, 'Bearer dvs_from_auth_json_file')
      assert.equal(
        written.mcpServers.devspec.url,
        'https://api.devspecstaging.com/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection',
      )
    })
  })

  it('end to end: creates the file from env without --token, preserves a neighbour, and prints no token', async () => {
    await withHome(async (home) => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true })
      await fs.writeFile(
        path.join(home, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { neighbour: { url: 'https://n/mcp' } } }),
        'utf8',
      )
      const { stdout } = await run('node', [SCRIPT, '--home', home], {
        env: { ...process.env, DEVSPEC_MCP_TOKEN: 'dvs_endtoendtokenvalue' },
      })
      const written = JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
      assert.equal(written.mcpServers.devspec.headers.Authorization, 'Bearer dvs_endtoendtokenvalue')
      assert.equal(written.mcpServers.devspec.headers['x-devspec-plugin'], IDENTIFICATION)
      assert.match(stdout, new RegExp(`plugin: ${IDENTIFICATION.replaceAll('.', '\\.')}`))
      assert.equal(written.mcpServers.neighbour.url, 'https://n/mcp')
      assert.equal(stdout.includes('endtoendtokenvalue'), false)
      assert.match(stdout, /left alone: neighbour/)
    })
  })

  it('refreshes an existing server without a token argument or touching credentials/neighbours, and names this plugin version', async () => {
    await withHome(async (home) => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true })
      const file = path.join(home, '.cursor', 'mcp.json')
      const headers = { Authorization: 'Bearer fixture-secret', 'X-Custom': 'keep' }
      await fs.writeFile(file, JSON.stringify({ mcpServers: { devspec: { url: 'https://api.devspecstaging.com/api/mcp', headers }, neighbour: { command: 'unchanged' } } }))
      const { stdout } = await run('node', [SCRIPT, '--refresh', '--home', home])
      const result = JSON.parse(await fs.readFile(file, 'utf8'))
      assert.equal(result.mcpServers.devspec.url, 'https://api.devspecstaging.com/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection')
      assert.deepEqual(result.mcpServers.devspec.headers, { ...headers, 'x-devspec-plugin': IDENTIFICATION })
      assert.deepEqual(result.mcpServers.neighbour, { command: 'unchanged' })
      assert.equal(stdout.includes('fixture-secret'), false)
    })
  })

  it('refuses to overwrite a file it cannot parse', async () => {
    await withHome(async (home) => {
      await fs.mkdir(path.join(home, '.cursor'), { recursive: true })
      const file = path.join(home, '.cursor', 'mcp.json')
      await fs.writeFile(file, '{ this is not json', 'utf8')
      await assert.rejects(
        run('node', [SCRIPT, '--home', home], { env: { ...process.env, DEVSPEC_MCP_TOKEN: 'dvs_token' } }),
        (err) => /could not be parsed/.test(err.stderr),
      )
      assert.equal(await fs.readFile(file, 'utf8'), '{ this is not json')
    })
  })
})
