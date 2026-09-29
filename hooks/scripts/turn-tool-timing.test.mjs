#!/usr/bin/env node
/**
 * Live-turn tool timing helpers (item f719e846).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  TURN_TOOL_KIND,
  TURN_TOOL_SOURCE,
  buildTurnToolPayload,
  emitTurnToolTiming,
  handleTurnToolHook,
  pendingKey,
  resolveDurationMs,
  resolveToolIdentity,
  turnToolPendingPath,
} from './turn-tool-timing.mjs'

describe('resolveToolIdentity', () => {
  it('names shell / mcp / generic tools', () => {
    assert.deepEqual(resolveToolIdentity('beforeShellExecution', { command: 'git status' }), {
      channel: 'shell',
      tool: 'git status',
    })
    assert.deepEqual(resolveToolIdentity('afterMCPExecution', { tool_name: 'search_memories' }), {
      channel: 'mcp',
      tool: 'search_memories',
    })
    assert.deepEqual(resolveToolIdentity('postToolUse', { toolName: 'Shell' }), {
      channel: 'tool',
      tool: 'Shell',
    })
  })
})

describe('pendingKey / resolveDurationMs', () => {
  it('pairs on tool_call_id when present', () => {
    assert.equal(
      pendingKey({ tool_call_id: 'abc' }, 'mcp', 'search_memories'),
      'mcp:abc',
    )
  })

  it('prefers reported duration over wall clock', () => {
    assert.equal(resolveDurationMs({ duration: 1234.6 }, 0, 9999), 1235)
    assert.equal(resolveDurationMs({}, 1000, 1400), 400)
    assert.equal(resolveDurationMs({}, null, 1400), 0)
  })
})

describe('buildTurnToolPayload', () => {
  it('builds a lean turn_tool payload', () => {
    const p = buildTurnToolPayload({
      tool: 'search_memories',
      channel: 'mcp',
      duration_ms: 88.2,
      connectionId: 'conn-1',
      sessionId: 'sess-1',
      turn_id: 'turn-1',
      agent: 'Cursor',
    })
    assert.deepEqual(p, {
      phase: 'tool:mcp:search_memories',
      tool: 'search_memories',
      channel: 'mcp',
      outcome: 'ok',
      duration_ms: 88,
      kind: TURN_TOOL_KIND,
      source: TURN_TOOL_SOURCE,
      connectionId: 'conn-1',
      sessionId: 'sess-1',
      turn_id: 'turn-1',
      agent: 'Cursor',
    })
  })
})

describe('emitTurnToolTiming', () => {
  it('ships Remote-control story via /api/log', async () => {
    /** @type {RequestInit | undefined} */
    let seen
    const fetchImpl = async (_url, init) => {
      seen = init
      return { ok: true, status: 200 }
    }
    const r = await emitTurnToolTiming({
      tool: 'Shell',
      channel: 'tool',
      duration_ms: 50,
      connectionId: 'c1',
      mcpUrl: 'https://api.devspec.ai/api/mcp',
      fetchImpl,
    })
    assert.equal(r.axiom.ok, true)
    const body = JSON.parse(String(seen?.body || '{}'))
    assert.equal(body.logs[0].msg, 'Remote-control story')
    assert.equal(body.logs[0].data.kind, 'turn_tool')
    assert.equal(body.logs[0].data.tool, 'Shell')
  })
})

describe('handleTurnToolHook', () => {
  it('records before and emits after with pending start', async () => {
    const connectionId = `test-turn-tool-${Date.now()}`
    const pendingFile = turnToolPendingPath(connectionId)
    try {
      await handleTurnToolHook(
        'beforeMCPExecution',
        { tool_name: 'get_action_item', tool_call_id: 'call-9' },
        { connectionId, sessionId: 's1', ship: false, now: 1_000 },
      )
      const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
      assert.equal(pending['mcp:call-9'].startedAt, 1_000)

      const result = await handleTurnToolHook(
        'afterMCPExecution',
        { tool_name: 'get_action_item', tool_call_id: 'call-9' },
        { connectionId, sessionId: 's1', ship: false, now: 1_250 },
      )
      assert.equal(result.local, true)
      assert.ok(!fs.existsSync(pendingFile) || !JSON.parse(fs.readFileSync(pendingFile, 'utf8'))['mcp:call-9'])
    } finally {
      try {
        fs.rmSync(pendingFile, { force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('skips DevSpec post_session_message recursion', async () => {
    const r = await handleTurnToolHook(
      'afterMCPExecution',
      { tool_name: 'post_session_message' },
      { connectionId: 'c', ship: false },
    )
    assert.deepEqual(r, { skipped: 'post_session' })
  })
})
