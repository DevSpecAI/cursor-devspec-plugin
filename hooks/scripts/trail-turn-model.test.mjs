#!/usr/bin/env node
/**
 * The model a connected Cursor conversation runs reaches DevSpec from the tool hooks
 * cursor-agent runs on every tool call (item 30cd0424). The prompt-submit and stop hooks
 * that used to be the only reporters are not dependable there: prompt-submit never runs
 * for a room command, and stop is skipped when a turn ends on Cursor's own connection
 * error, so in a live remote-driven session the Agents page showed no model at all.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTrailTurn } from './trail-turn.mjs'
import { telemetryPath } from './agent-telemetry.mjs'

const CONNECTION = '5eec509c-04e4-4e5b-ada6-d735df6b757c'

function hookInput(model) {
  // The common fields Cursor puts on every hook, as recorded live.
  return JSON.stringify({
    conversation_id: 'cursor-chat-1',
    hook_event_name: 'postToolUse',
    model,
    tool_name: 'Shell',
    tool_input: { command: 'git status' },
    cursor_version: '2026.10.22-27dcf5f',
  })
}

function run(dir, model, state = { enabled: true, connection_id: CONNECTION, session_id: null }) {
  return runTrailTurn({
    modeArg: 'postToolUse',
    raw: hookInput(model),
    env: {},
    connectionsDir: dir,
    loadStateFn: () => state,
    call: async () => { throw new Error('no network in this test') },
  })
}

describe('the model reaches DevSpec from tool hooks (item 30cd0424)', () => {
  it('records the model on a tool call, even with no remote turn running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    const result = await run(dir, 'grok-4.7')
    assert.equal(result.reason, 'no_active_turn')
    const report = JSON.parse(fs.readFileSync(telemetryPath(CONNECTION, dir), 'utf8'))
    assert.deepEqual(report.model, { provider: 'cursor', id: 'grok-4.7' })
  })

  it('follows a model change mid-conversation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    await run(dir, 'grok-4.7')
    await run(dir, 'claude-opus-5-5-high')
    assert.equal(JSON.parse(fs.readFileSync(telemetryPath(CONNECTION, dir), 'utf8')).model.id, 'claude-opus-5-5-high')
  })

  it('records nothing for a conversation that is not connected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    await run(dir, 'grok-4.7', null)
    assert.equal(fs.existsSync(telemetryPath(CONNECTION, dir)), false)
  })
})
