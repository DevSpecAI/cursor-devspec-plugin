#!/usr/bin/env node
/**
 * Connect / cold-launch phase timing helpers (item 383de0cd).
 */
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import {
  CONNECT_PHASE_NAMES,
  STORY_MSG,
  buildConnectPhasePayload,
  deriveLogIngestUrl,
  durationMs,
  emitConnectPhase,
  newLaunchId,
  resolveLaunchId,
  shipConnectPhaseToAxiom,
} from './connect-phase-timing.mjs'

describe('CONNECT_PHASE_NAMES', () => {
  it('covers launcher + connect acceptance phases', () => {
    for (const name of [
      'create_chat',
      'expand_stamp',
      'write_stamp',
      'agent_spawn',
      'resolve_local_id',
      'resolve_local',
      'register_connection',
      'attach_connection',
      'write_state',
      'wait_armed',
    ]) {
      assert.ok(CONNECT_PHASE_NAMES.includes(name), name)
    }
  })
})

describe('durationMs', () => {
  it('rounds non-negative elapsed ms', () => {
    assert.equal(durationMs(1000, 1250.4), 250)
    assert.equal(durationMs(2000, 1999), 0)
    assert.equal(durationMs(Number.NaN, 10), 0)
  })
})

describe('resolveLaunchId / newLaunchId', () => {
  it('prefers explicit over env and mints uuid-shaped ids', () => {
    assert.equal(resolveLaunchId(' abc ', { DEVSPEC_LAUNCH_ID: 'env-id' }), 'abc')
    assert.equal(resolveLaunchId(null, { DEVSPEC_LAUNCH_ID: ' env-id ' }), 'env-id')
    assert.equal(resolveLaunchId('', {}), null)
    assert.match(newLaunchId(), /^[0-9a-f-]{36}$/i)
  })
})

describe('deriveLogIngestUrl', () => {
  it('maps /api/mcp to /api/log', () => {
    assert.equal(
      deriveLogIngestUrl('https://staging.devspec.ai/api/mcp'),
      'https://staging.devspec.ai/api/log',
    )
    assert.equal(
      deriveLogIngestUrl('https://devspec.ai/api/mcp/'),
      'https://devspec.ai/api/log',
    )
    assert.equal(deriveLogIngestUrl('https://staging.devspec.ai'), 'https://staging.devspec.ai/api/log')
    assert.equal(deriveLogIngestUrl('not a url'), null)
  })
})

describe('buildConnectPhasePayload', () => {
  it('builds a lean connect_phase payload', () => {
    const p = buildConnectPhasePayload({
      phase: 'create_chat',
      duration_ms: 12.7,
      launch_id: 'launch-1',
      local_id: 'local-1',
      connectionId: 'conn-1',
      agent: 'Cursor',
    })
    assert.deepEqual(p, {
      phase: 'create_chat',
      outcome: 'ok',
      duration_ms: 13,
      kind: 'connect_phase',
      source: 'cursor_plugin',
      launch_id: 'launch-1',
      connectionId: 'conn-1',
      local_id: 'local-1',
      agent: 'Cursor',
    })
  })
})

describe('shipConnectPhaseToAxiom', () => {
  it('POSTs Remote-control story batch to /api/log', async () => {
    /** @type {RequestInit | undefined} */
    let init
    const fetchImpl = async (url, opts) => {
      assert.equal(url, 'https://staging.devspec.ai/api/log')
      init = opts
      return { ok: true, status: 200 }
    }
    const result = await shipConnectPhaseToAxiom(
      'https://staging.devspec.ai/api/log',
      buildConnectPhasePayload({ phase: 'write_stamp', duration_ms: 5, launch_id: 'L' }),
      { fetchImpl },
    )
    assert.equal(result.ok, true)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.logs.length, 1)
    assert.equal(body.logs[0].msg, STORY_MSG)
    assert.equal(body.logs[0].data.phase, 'write_stamp')
    assert.equal(body.logs[0].data.launch_id, 'L')
    assert.equal(body.logs[0].data.kind, 'connect_phase')
  })

  it('returns error when url missing', async () => {
    const result = await shipConnectPhaseToAxiom(null, { phase: 'x', duration_ms: 1 })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no_log_url')
  })
})

describe('emitConnectPhase', () => {
  it('writes local story and ships when ship=true', async () => {
    const writes = []
    const restore = mock.method(process.stderr, 'write', (chunk) => {
      writes.push(String(chunk))
      return true
    })
    let posted = false
    const fetchImpl = async () => {
      posted = true
      return { ok: true, status: 200 }
    }
    try {
      const out = await emitConnectPhase({
        phase: 'resolve_local_id',
        duration_ms: 3,
        launch_id: 'L2',
        local_id: 'loc',
        mcpUrl: 'https://staging.devspec.ai/api/mcp',
        fetchImpl,
      })
      assert.equal(out.local, true)
      assert.equal(out.axiom.ok, true)
      assert.equal(posted, true)
      assert.equal(writes.length, 1)
      assert.match(writes[0], /^story \{/)
      const json = JSON.parse(writes[0].replace(/^story\s+/, '').trim())
      assert.equal(json.phase, 'resolve_local_id')
      assert.equal(json.duration_ms, 3)
      assert.equal(json.launch_id, 'L2')
      assert.equal(json.kind, 'connect_phase')
    } finally {
      restore.mock.restore()
    }
  })
})
