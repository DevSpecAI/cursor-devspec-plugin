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
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { runTrailTurn } from './trail-turn.mjs'
import { agentStatsArgs, telemetryPath } from './agent-telemetry.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const CONNECTION = '5eec509c-04e4-4e5b-ada6-d735df6b757c'

function hookInput(model, { hookEventName = 'postToolUse', conversationId = 'cursor-chat-1', modelParams } = {}) {
  // The common fields Cursor puts on every hook, as recorded live.
  return JSON.stringify({
    conversation_id: conversationId,
    hook_event_name: hookEventName,
    model,
    ...(modelParams ? { model_params: modelParams } : {}),
    tool_name: 'Shell',
    tool_input: { command: 'git status' },
    cursor_version: '2026.10.22-27dcf5f',
  })
}

function writeChatStore(chatsDir, cwd, conversationId, lastUsedModel) {
  const hash = crypto.createHash('md5').update(cwd).digest('hex')
  const convDir = path.join(chatsDir, hash, conversationId)
  fs.mkdirSync(convDir, { recursive: true })
  const db = new DatabaseSync(path.join(convDir, 'store.db'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    const encoded = Buffer.from(JSON.stringify({ agentId: conversationId, lastUsedModel }), 'utf8').toString('hex')
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('0', encoded)
  } finally {
    db.close()
  }
}

function run(
  dir,
  model,
  state = { enabled: true, connection_id: CONNECTION, session_id: null },
  { modeArg = 'postToolUse', chatsDir, conversationId = 'cursor-chat-1', modelParams, now } = {},
) {
  return runTrailTurn({
    modeArg,
    raw: hookInput(model, { hookEventName: modeArg, conversationId, modelParams }),
    env: {},
    connectionsDir: dir,
    ...(chatsDir ? { chatsDir } : {}),
    ...(now !== undefined ? { now } : {}),
    loadStateFn: () => state,
    call: async () => { throw new Error('no network in this test') },
  })
}

describe('the model reaches DevSpec from tool hooks (item 30cd0424)', () => {
  it('records the model on a tool call, even with no remote turn running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-chats-'))
    const result = await run(dir, 'grok-4.7', undefined, { chatsDir })
    assert.equal(result.reason, 'no_active_turn')
    const report = JSON.parse(fs.readFileSync(telemetryPath(CONNECTION, dir), 'utf8'))
    assert.deepEqual(report.model, { provider: 'cursor', id: 'grok-4.7' })
  })

  it('follows a model change mid-conversation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-chats-'))
    await run(dir, 'grok-4.7', undefined, { chatsDir })
    await run(dir, 'claude-opus-5-5-high', undefined, { chatsDir })
    assert.equal(JSON.parse(fs.readFileSync(telemetryPath(CONNECTION, dir), 'utf8')).model.id, 'claude-opus-5-5-high')
  })

  it('records nothing for a conversation that is not connected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-chats-'))
    await run(dir, 'grok-4.7', null, { chatsDir })
    assert.equal(fs.existsSync(telemetryPath(CONNECTION, dir)), false)
  })

  it('does not let a frozen startup model in postToolUse overwrite afterAgentThought (item c2ddefb6)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-chats-'))
    const t0 = Date.parse('2026-11-25T10:00:00.000Z')

    // afterAgentThought reports the live switched model
    await run(dir, 'gemini-4-neon', undefined, {
      modeArg: 'afterAgentThought',
      chatsDir,
      modelParams: [{ id: 'reasoning_effort', value: 'high' }],
      now: t0,
    })
    // postToolUse carries cursor-agent's startup-frozen model
    await run(dir, 'grok-4.7', undefined, {
      modeArg: 'postToolUse',
      chatsDir,
      now: t0 + 1000,
    })

    const stats = agentStatsArgs(CONNECTION, { dir, localId: 'cursor-chat-1', chatsDir }).agent_stats
    assert.equal(stats.model.id, 'gemini-4-neon')
    assert.equal(stats.thinkingLevel, 'high')
  })

  it('reads the live switched model from Cursor chat store during postToolUse (item c2ddefb6)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-model-'))
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-trail-chats-'))
    const cwd = '/tmp/devspec-project'
    const state = { enabled: true, connection_id: CONNECTION, session_id: null, local_id: 'cursor-chat-2', cwd }

    writeChatStore(chatsDir, cwd, 'cursor-chat-2', 'gemini-4-neon')
    // postToolUse arrives with stale startup model grok-4.7
    await run(dir, 'grok-4.7', state, {
      modeArg: 'postToolUse',
      chatsDir,
      conversationId: 'cursor-chat-2',
    })

    assert.equal(JSON.parse(fs.readFileSync(telemetryPath(CONNECTION, dir), 'utf8')).model.id, 'gemini-4-neon')
    assert.equal(
      agentStatsArgs(CONNECTION, { dir, localId: 'cursor-chat-2', cwd, chatsDir }).agent_stats.model.id,
      'gemini-4-neon',
    )
  })
})
