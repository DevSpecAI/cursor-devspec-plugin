import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { handleTurnToolHook, emitTurnToolTiming, pendingKey, resolveDurationMs, resolveToolIdentity } from './turn-tool-timing.mjs'
import { fixture, ID, OTHER } from '../../tests/helpers/local-diagnostics.mjs'
import { stopDiagnostics } from './local-diagnostics.mjs'

test('off by default: no pending files or upload, even with legacy ship flags', () => fixture(async ({ root }) => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw Error('Unexpected upload') }
  try {
    assert.deepEqual(await handleTurnToolHook('beforeMCPExecution', { tool_name: 'get_action_item' }, { connectionId: ID }), { skipped: 'disabled' })
    assert.deepEqual(await emitTurnToolTiming({ connectionId: ID, channel: 'mcp', tool: 'read', duration_ms: 1, ship: true }), { local: false })
    assert.equal(fs.existsSync(root), false)
  } finally { globalThis.fetch = original }
}))

test('paired hooks produce local starts/ends with safe names and no command/error prose', () => fixture(async ({ events }) => {
  const data = { command: 'curl -H "Bearer SYMBOLIC_SECRET"', tool_call_id: 'SYMBOLIC_CALL' }
  const now = Date.now()
  await handleTurnToolHook('beforeShellExecution', data, { connectionId: ID, now })
  await handleTurnToolHook('afterShellExecution', { ...data, error: 'SYMBOLIC_ERROR' }, { connectionId: ID, now: now + 125 })
  const rows = events()
  assert.equal(rows.length, 2); assert.equal(rows[0].invocationId, rows[1].invocationId)
  assert.equal(rows[1].duration_ms, 125); assert.equal(rows[1].outcome, 'error')
  assert.equal(rows[1].tool, 'shell'); assert.ok(rows[1].ended_at)
  assert.equal(JSON.stringify(rows).includes('SYMBOLIC'), false)
  assert.deepEqual(await handleTurnToolHook('beforeShellExecution', data, { connectionId: OTHER }), { skipped: 'disabled' })
  stopDiagnostics(ID)
  assert.deepEqual(await handleTurnToolHook('beforeShellExecution', data, { connectionId: ID }), { skipped: 'disabled' })
}, true))

test('missing start stays unmeasured, and hook phases do not invent thinking time', () => fixture(async ({ events }) => {
  await handleTurnToolHook('afterMCPExecution', { tool_name: 'get_action_item' }, { connectionId: ID })
  assert.equal(events()[0].duration_ms, undefined)
  assert.equal(events()[0].started_at, undefined)
}, true))

test('identity and pending keys never contain raw command text', () => {
  assert.deepEqual(resolveToolIdentity('beforeShellExecution', { command: 'private' }), { channel: 'shell', tool: 'shell' })
  assert.match(pendingKey({ command: 'SYMBOLIC_PRIVATE' }, 'shell', 'shell'), /^shell:[a-f0-9]{64}$/)
  assert.equal(resolveDurationMs({}, undefined, 1000), undefined)
  assert.equal(resolveDurationMs({ duration: 12.6 }, 0, 999), 13)
})
