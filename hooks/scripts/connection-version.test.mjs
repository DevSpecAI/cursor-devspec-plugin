import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LOADED_PLUGIN_VERSION, connectionVersions, connectionVersionHook } from './connection-version.mjs'
import { mcpToolsCall } from './mcp-call.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const version = JSON.parse(readFileSync(join(root, '.cursor-plugin/plugin.json'), 'utf8')).version

test('package, plugin, marketplace and executing reporter agree', () => {
  assert.equal(LOADED_PLUGIN_VERSION, version)
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, version)
  assert.equal(JSON.parse(readFileSync(join(root, '.cursor-plugin/marketplace.json'), 'utf8')).plugins[0].version, version)
})
test('internal MCP register/attach requests report the artifact without changing scope', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body).params)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    for (const name of ['register_connection', 'attach_connection']) await mcpToolsCall({ mcpUrl: 'https://fixture.example.test/api/mcp', token: 'fixture', name, arguments: { connection_id: 'c', session_id: 's', plugin_version: 'guess' } })
    for (const call of calls) {
      assert.equal(call.arguments.plugin_version, version)
      assert.equal(call.arguments.connection_id, 'c')
      assert.equal(call.arguments.session_id, 's')
    }
  } finally { globalThis.fetch = original }
})
test('Cursor native updates use updated_input, observed host facts, and no permission override', () => {
  const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'))
  const hook = config.hooks.preToolUse.find(entry => entry.command.includes('connection-version.mjs'))
  assert.ok(hook)
  for (const prefix of ['', 'devspec__', 'devspec.', 'mcp__devspec__', 'mcp__plugin_devspec_devspec__']) {
    for (const verb of ['register_connection', 'attach_connection']) {
      const name = prefix + verb
      assert.match(name, new RegExp(hook.matcher))
      const output = connectionVersionHook({ tool_name: name, cursor_version: '1.7.2', tool_input: { connection_id: 'c', plugin_version: 'guess' } })
      assert.deepEqual(output, { updated_input: { plugin_version: version, host_version: '1.7.2' } })
      // The installed Cursor MCP path merges only these keys; identity survives.
      assert.equal({ connection_id: 'c', ...output.updated_input }.connection_id, 'c')
      assert.equal(output.permission, undefined)
      assert.equal(output.hookSpecificOutput, undefined)
    }
  }
  assert.equal(connectionVersionHook({ tool_name: 'mcp__foreign__register_connection' }), null)
  assert.equal(connectionVersions('not a version').host_version, undefined)
})
test('a commit-keyed cache/junction reads its own artifact and keeps the loaded value', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'cursor-version-artifact-'))
  try {
    const artifact = join(temp, 'cache/devspec/fixture-sha')
    mkdirSync(join(artifact, '.cursor-plugin'), { recursive: true })
    mkdirSync(join(artifact, 'hooks/scripts'), { recursive: true })
    const manifest = join(artifact, '.cursor-plugin/plugin.json')
    writeFileSync(manifest, JSON.stringify({ name: 'devspec-autopilot', version: '1.2.3' }))
    const script = join(artifact, 'hooks/scripts/connection-version.mjs')
    writeFileSync(script, readFileSync(join(here, 'connection-version.mjs')))
    const linked = join(temp, 'junction')
    symlinkSync(artifact, linked, 'junction')
    const linkedScript = join(linked, 'hooks/scripts/connection-version.mjs')
    const env = { ...process.env }; delete env.CURSOR_VERSION
    const output = JSON.parse(execFileSync(process.execPath, [linkedScript], { cwd: temp, env, input: JSON.stringify({ tool_name: 'devspec__register_connection', cursor_version: '1.7.2' }), encoding: 'utf8' }))
    assert.deepEqual(output, { updated_input: { plugin_version: '1.2.3', host_version: '1.7.2' } })
    const loaded = await import(pathToFileURL(linkedScript).href)
    writeFileSync(manifest, JSON.stringify({ name: 'devspec-autopilot', version: '9.9.9' }))
    assert.equal(loaded.connectionVersions().plugin_version, '1.2.3')
    assert.equal(execFileSync(process.execPath, [linkedScript], { input: 'invalid JSON', encoding: 'utf8' }), '')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
