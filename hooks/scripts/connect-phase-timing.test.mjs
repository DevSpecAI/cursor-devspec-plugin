import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { emitConnectPhase, timeConnectPhase, durationMs, resolveLaunchId, newLaunchId } from './connect-phase-timing.mjs'
import { fixture, ID, OTHER } from '../../tests/helpers/local-diagnostics.mjs'

test('connect timing is off by default, with no network, stderr or files even with legacy ship=true', () => fixture(async ({ root }) => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw Error('Unexpected diagnostic upload') }
  try {
    assert.deepEqual(await emitConnectPhase({ phase: 'write_state', connectionId: ID, duration_ms: 10, ship: true, mcpUrl: 'https://invalid.test/api/mcp' }), { local: false })
    assert.equal(fs.existsSync(root), false)
  } finally { globalThis.fetch = original }
}))

test('opted-in connect spans stay local and contain measured start/end and correlation', () => fixture(async ({ events }) => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw Error('Unexpected diagnostic upload') }
  try {
    const value = await timeConnectPhase('write_state', () => 42, { connectionId: ID })
    assert.equal(value, 42)
    const rows = events(); assert.equal(rows.length, 2)
    assert.equal(rows[0].phase, 'start'); assert.equal(rows[1].phase, 'end')
    assert.equal(rows[0].invocationId, rows[1].invocationId)
    assert.equal(rows[1].operation, 'write_state'); assert.ok(rows[1].duration_ms >= 0)
    assert.equal(rows[1].connectionId, ID)
    assert.deepEqual(await emitConnectPhase({ phase: 'write_state', connectionId: OTHER, duration_ms: 1 }), { local: false })
  } finally { globalThis.fetch = original }
}, true))

test('failure diagnostics preserve the original exception and exclude its text', () => fixture(async ({ events }) => {
  const error = new Error('SYMBOLIC_PRIVATE bearer SYMBOLIC_SECRET')
  await assert.rejects(timeConnectPhase('attach_connection', () => { throw error }, { connectionId: ID }), e => e === error)
  assert.equal(events()[1].outcome, 'error')
  assert.equal(JSON.stringify(events()).includes('SYMBOLIC'), false)
}, true))

test('duration and launch identity helpers remain compatible', () => {
  assert.equal(durationMs(100, 125.3), 25)
  assert.equal(durationMs('invalid', 200), 0)
  assert.equal(resolveLaunchId(' explicit ', {}), 'explicit')
  assert.equal(resolveLaunchId(null, { DEVSPEC_LAUNCH_ID: 'x' }), 'x')
  assert.match(newLaunchId(), /^[a-f0-9-]{36}$/)
})
