import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { nativeInvocation } from '../hooks/scripts/native-agent-spawn.mjs'
import { findNativeCursorCli } from '../hooks/scripts/project-command.mjs'
import * as connectionState from '../hooks/scripts/remote-control-state.mjs'

test('connection helpers belong to the running host, not a removed pre-connect launcher', () => {
  assert.equal('ensurePollerAfterAgentSpawn' in connectionState, false)
  assert.equal('ensureWakeFollowAfterAgentSpawn' in connectionState, false)
  assert.equal(typeof connectionState.ensurePollerForConnection, 'function')
  assert.equal(typeof connectionState.ensureWakeFollowForConnection, 'function')
  assert.equal(typeof connectionState.resolveOwnerPidFromChildTree, 'function')
})
test('Cursor has no launcher payload, installers or automatic setup hook', () => {
  for (const relative of ['../launcher', './setup-launcher.mjs', './open-handler.mjs', './launch-cli-session.mjs', './pin-remote-plugin.mjs']) assert.equal(fs.existsSync(new URL(relative, import.meta.url)), false, relative)
  const hooks = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url)))
  assert.doesNotMatch(JSON.stringify(hooks), /setup-launcher|launcher\//)
  assert.match(JSON.stringify(hooks), /repository-context/)
  assert.match(JSON.stringify(hooks), /mirror-turn/)
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)))
  assert.ok(Object.keys(pkg.scripts).every(name => !/open-handler|open-bridge|handler:/.test(name)))
})
test('the project-choice helper still verifies native Cursor without a launcher import', () => {
  const calls = []
  const binary = findNativeCursorCli({ cwd: '/fixture', spawn: (bin, args) => { calls.push({ bin, args }); return { status: 0, stdout: bin === 'agent' ? 'Start the Cursor Agent' : 'other host' } } })
  assert.equal(binary, 'agent')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, ['--help'])
})
test('native invocation preserves Windows shim support without execution-policy bypass', () => {
  const result = nativeInvocation('C:\\Host\\agent.cmd', { platform: 'win32', exists: file => file === 'C:\\Host\\agent.ps1', systemRoot: 'C:\\Windows' })
  assert.deepEqual(result.args, ['-NoProfile', '-File', 'C:\\Host\\agent.ps1'])
  assert.equal(result.shell, false)
  assert.deepEqual(nativeInvocation('/host/agent', { platform: 'linux' }), { command: '/host/agent', args: [], shell: false })
})
