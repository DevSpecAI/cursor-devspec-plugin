#!/usr/bin/env node
/**
 * Cursor reports the model it runs (item cc47378e): hooks write it, the poller sends it.
 * Run: node --test hooks/scripts/agent-telemetry.test.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  CHAT_STORE_BUSY_TIMEOUT_MS,
  agentStatsArgs,
  readCursorChatModel,
  recordRuntimeReport,
  runtimeReportFromHookInput,
  telemetryPath,
} from './agent-telemetry.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const NOW = new Date('2026-10-10T12:00:00.000Z')

function writeCursorChatStore(chatsDir, cwd, conversationId, metaObj, { mtimeMs } = {}) {
  const hash = crypto.createHash('md5').update(cwd).digest('hex')
  const convDir = path.join(chatsDir, hash, conversationId)
  fs.mkdirSync(convDir, { recursive: true })
  const dbPath = path.join(convDir, 'store.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    const encoded = Buffer.from(JSON.stringify(metaObj), 'utf8').toString('hex')
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('0', encoded)
  } finally {
    db.close()
  }
  if (typeof mtimeMs === 'number') {
    const t = new Date(mtimeMs)
    fs.utimesSync(dbPath, t, t)
  }
  return dbPath
}

describe('runtimeReportFromHookInput', () => {
  it('reads the model and effort Cursor hands every hook', () => {
    const report = runtimeReportFromHookInput({
      model: 'claude-4.5-opus',
      model_id: 'claude-opus-5-5',
      model_params: [{ id: 'thinking', value: 'true' }, { id: 'effort', value: 'max' }],
    }, NOW)
    assert.deepEqual(report.model, { provider: 'cursor', id: 'claude-opus-5-5' })
    assert.equal(report.thinkingLevel, 'max')
    assert.equal(report.v, 1)
    assert.equal(report.at, NOW.toISOString())
  })

  it('recognizes reasoning_effort (Gemini/Grok) and reasoning (GPT) model_params', () => {
    const gemini = runtimeReportFromHookInput({
      model: 'gemini-4-neon',
      model_params: [{ id: 'reasoning_effort', value: 'high' }],
    }, NOW)
    assert.equal(gemini.thinkingLevel, 'high')

    const gpt = runtimeReportFromHookInput({
      model: 'gpt-6.2-astra',
      model_params: [{ id: 'reasoning', value: 'xhigh' }],
    }, NOW)
    assert.equal(gpt.thinkingLevel, 'xhigh')
  })

  it('falls back to the legacy model slug', () => {
    assert.deepEqual(runtimeReportFromHookInput({ model: 'composer-1' }, NOW).model, { provider: 'cursor', id: 'composer-1' })
  })

  it('sends no thinking level the server would reject, so the report is not dropped', () => {
    const report = runtimeReportFromHookInput({ model: 'gpt-6', model_params: [{ id: 'effort', value: 'turbo' }] }, NOW)
    assert.equal(report.thinkingLevel, null)
  })

  it('is null when the hook names no model', () => {
    assert.equal(runtimeReportFromHookInput({ conversation_id: 'c' }), null)
    assert.equal(runtimeReportFromHookInput(null), null)
  })
})

describe('the hook writes it and the poll sends it', () => {
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-telemetry-')) })
  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('round-trips a hook payload into poll arguments without leaking internal fields', () => {
    assert.equal(recordRuntimeReport(CONNECTION, JSON.stringify({ model: 'gpt-6-astra' }), { dir, now: NOW }), true)
    const args = agentStatsArgs(CONNECTION, { dir })
    assert.deepEqual(args.agent_stats.model, { provider: 'cursor', id: 'gpt-6-astra' })
    assert.equal('_source' in args.agent_stats, false)
  })

  it('adds nothing to the poll before any hook has run, or for a bad payload', () => {
    const other = '99999999-8888-4777-8666-555555555555'
    assert.deepEqual(agentStatsArgs(other, { dir }), {})
    assert.equal(recordRuntimeReport(other, 'not json', { dir }), false)
    assert.deepEqual(agentStatsArgs(other, { dir }), {})
  })

  it('never writes outside the connections folder for a malformed connection id', () => {
    assert.equal(recordRuntimeReport('../escape', JSON.stringify({ model: 'x' }), { dir }), false)
    assert.deepEqual(agentStatsArgs('../escape', { dir }), {})
  })
})

describe('stale tool hooks never revert a live model switch (item c2ddefb6)', () => {
  let dir
  let chatsDir
  const CWD = '/tmp/devspec-workspace'

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-telemetry-live-'))
    chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-chats-'))
  })
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(chatsDir, { recursive: true, force: true })
  })

  it('reads lastUsedModel from Cursor SQLite chat store by cwd hash and via fallback scan', () => {
    const convId = 'conv-read-1'
    writeCursorChatStore(chatsDir, CWD, convId, { agentId: convId, lastUsedModel: 'gemini-4-neon' }, { mtimeMs: NOW.getTime() })

    const direct = readCursorChatModel(convId, { cwd: CWD, chatsDir })
    assert.equal(direct?.model, 'gemini-4-neon')
    assert.ok(direct.mtimeMs > 0)

    // Works even when cwd is omitted or differs (fallback scan).
    const scanned = readCursorChatModel(convId, { cwd: '/some/other/dir', chatsDir })
    assert.equal(scanned?.model, 'gemini-4-neon')

    // Rejects path traversal safely.
    assert.equal(readCursorChatModel('../escape', { cwd: CWD, chatsDir }), null)
  })

  it('keeps the live model when a stale tool hook fires after a model switch (no chat store)', () => {
    const conn = '22222222-3333-4444-8555-666666666666'
    // Live hook (e.g. afterAgentThought / beforeSubmitPrompt) reports the switched model + reasoning_effort.
    assert.equal(
      recordRuntimeReport(
        conn,
        JSON.stringify({
          conversation_id: 'conv-no-store',
          model: 'gemini-4-neon',
          model_params: [{ id: 'reasoning_effort', value: 'high' }],
        }),
        { dir, chatsDir, now: NOW, authoritative: true },
      ),
      true,
    )
    // Subsequent tool hook carries Cursor's frozen startup model (grok-4.7).
    assert.equal(
      recordRuntimeReport(
        conn,
        JSON.stringify({
          conversation_id: 'conv-no-store',
          model: 'grok-4.7',
        }),
        { dir, chatsDir, now: new Date(NOW.getTime() + 1000), authoritative: false },
      ),
      false,
    )
    const stats = agentStatsArgs(conn, { dir, localId: 'conv-no-store', cwd: CWD, chatsDir }).agent_stats
    assert.equal(stats.model.id, 'gemini-4-neon')
    assert.equal(stats.thinkingLevel, 'high')
  })

  it('tracks repeated model switches via Cursor chat store even when live hooks never fire', () => {
    const conn = '33333333-4444-4555-8666-777777777777'
    const convId = 'conv-multi-switch'
    const t0 = NOW.getTime()

    // Initial startup model in chat store and tool hook: grok-4.7
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'grok-4.7' }, { mtimeMs: t0 })
    assert.equal(
      recordRuntimeReport(conn, JSON.stringify({ conversation_id: convId, model: 'grok-4.7' }), {
        dir,
        chatsDir,
        cwd: CWD,
        now: new Date(t0),
        authoritative: false,
      }),
      true,
    )
    assert.equal(agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats.model.id, 'grok-4.7')

    // User switches to gemini-4-neon; tool hook still reports frozen grok-4.7
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'gemini-4-neon' }, { mtimeMs: t0 + 10_000 })
    assert.equal(
      recordRuntimeReport(conn, JSON.stringify({ conversation_id: convId, model: 'grok-4.7' }), {
        dir,
        chatsDir,
        cwd: CWD,
        now: new Date(t0 + 11_000),
        authoritative: false,
      }),
      true,
    )
    assert.equal(agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats.model.id, 'gemini-4-neon')

    // User switches again to claude-opus-5-5; poller picks it up immediately even before the next tool call
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'claude-opus-5-5' }, { mtimeMs: t0 + 20_000 })
    const polled = agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats
    assert.equal(polled.model.id, 'claude-opus-5-5')
    assert.equal('_source' in polled, false)
  })

  it('preserves thinkingLevel when model matches and clears it when the model switches', () => {
    const conn = '44444444-5555-4666-8777-888888888888'
    const convId = 'conv-effort-switch'
    const t0 = NOW.getTime()

    // Authoritative hook sets gemini-4-neon with reasoning_effort: high
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'gemini-4-neon' }, { mtimeMs: t0 })
    recordRuntimeReport(
      conn,
      JSON.stringify({
        conversation_id: convId,
        model: 'gemini-4-neon',
        model_params: [{ id: 'reasoning_effort', value: 'high' }],
      }),
      { dir, chatsDir, cwd: CWD, now: new Date(t0), authoritative: true },
    )

    // Store mtime advances on same model (e.g. WAL write) -> thinkingLevel preserved
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'gemini-4-neon' }, { mtimeMs: t0 + 5_000 })
    recordRuntimeReport(conn, JSON.stringify({ conversation_id: convId, model: 'grok-4.7' }), {
      dir,
      chatsDir,
      cwd: CWD,
      now: new Date(t0 + 6_000),
      authoritative: false,
    })
    assert.equal(agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats.thinkingLevel, 'high')

    // Store switches to a different model -> stale thinkingLevel cleared
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'claude-opus-5-5' }, { mtimeMs: t0 + 15_000 })
    const switched = agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats
    assert.equal(switched.model.id, 'claude-opus-5-5')
    assert.equal(switched.thinkingLevel, null)
  })

  it('does not downgrade a fresher live hook to an older chat store snapshot', () => {
    const conn = '55555555-6666-4777-8888-999999999999'
    const convId = 'conv-fresher-live-hook'
    const t0 = NOW.getTime()

    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'grok-4.7' }, { mtimeMs: t0 })
    // Live hook fires at t0 + 5s with the newly selected model before Cursor flushes store.db
    recordRuntimeReport(
      conn,
      JSON.stringify({ conversation_id: convId, model: 'gemini-4-neon' }),
      { dir, chatsDir, cwd: CWD, now: new Date(t0 + 5_000), authoritative: true },
    )

    // Tool hook and poll both respect the fresher live hook
    assert.equal(
      recordRuntimeReport(conn, JSON.stringify({ conversation_id: convId, model: 'grok-4.7' }), {
        dir,
        chatsDir,
        cwd: CWD,
        now: new Date(t0 + 6_000),
        authoritative: false,
      }),
      false,
    )
    assert.equal(agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats.model.id, 'gemini-4-neon')
    assert.equal(JSON.parse(fs.readFileSync(telemetryPath(conn, dir), 'utf8')).model.id, 'gemini-4-neon')
  })

  it('degrades gracefully when the chat store is unreadable or lacks lastUsedModel', () => {
    const conn = '66666666-7777-4888-8999-aaaaaaaaaaaa'
    const convCorrupt = 'conv-corrupt'
    const hash = crypto.createHash('md5').update(CWD).digest('hex')
    const corruptDir = path.join(chatsDir, hash, convCorrupt)
    fs.mkdirSync(corruptDir, { recursive: true })
    fs.writeFileSync(path.join(corruptDir, 'store.db'), 'not a sqlite db')

    assert.equal(readCursorChatModel(convCorrupt, { cwd: CWD, chatsDir }), null)

    // Tool hook still acts as initial fallback when no live report exists
    assert.equal(
      recordRuntimeReport(conn, JSON.stringify({ conversation_id: convCorrupt, model: 'grok-4.7' }), {
        dir,
        chatsDir,
        cwd: CWD,
        now: NOW,
        authoritative: false,
      }),
      true,
    )
    assert.equal(agentStatsArgs(conn, { dir, localId: convCorrupt, cwd: CWD, chatsDir }).agent_stats.model.id, 'grok-4.7')
  })

  it('preserves effort reported on a matching tool hook when the chat store is readable', () => {
    const conn = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
    const convId = 'conv-matching-tool-effort'
    const t0 = NOW.getTime()

    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'gemini-4-neon' }, { mtimeMs: t0 })
    assert.equal(
      recordRuntimeReport(
        conn,
        JSON.stringify({
          conversation_id: convId,
          model: 'gemini-4-neon',
          model_params: [{ id: 'reasoning_effort', value: 'high' }],
        }),
        { dir, chatsDir, cwd: CWD, now: new Date(t0), authoritative: false },
      ),
      true,
    )
    const stats = agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats
    assert.equal(stats.model.id, 'gemini-4-neon')
    assert.equal(stats.thinkingLevel, 'high')

    // A stale tool hook carrying a different model's effort must NOT apply to the switched store model
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'claude-opus-5-5' }, { mtimeMs: t0 + 5_000 })
    assert.equal(
      recordRuntimeReport(
        conn,
        JSON.stringify({
          conversation_id: convId,
          model: 'gemini-4-neon',
          model_params: [{ id: 'reasoning_effort', value: 'high' }],
        }),
        { dir, chatsDir, cwd: CWD, now: new Date(t0 + 6_000), authoritative: false },
      ),
      true,
    )
    const switched = agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats
    assert.equal(switched.model.id, 'claude-opus-5-5')
    assert.equal(switched.thinkingLevel, null)
  })

  it('persists last-known-good chat-store telemetry on poll so a later unreadable store never reverts', () => {
    const conn = '88888888-9999-4aaa-8bbb-cccccccccccc'
    const convId = 'conv-last-known-good'
    const t0 = NOW.getTime()

    // Initial tool hook caches grok-4.7
    const dbPath = writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'grok-4.7' }, { mtimeMs: t0 })
    recordRuntimeReport(conn, JSON.stringify({ conversation_id: convId, model: 'grok-4.7' }), {
      dir,
      chatsDir,
      cwd: CWD,
      now: new Date(t0),
      authoritative: false,
    })

    // User switches to claude-opus-5-5; poller observes and persists it
    writeCursorChatStore(chatsDir, CWD, convId, { lastUsedModel: 'claude-opus-5-5' }, { mtimeMs: t0 + 10_000 })
    const firstPoll = agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats
    assert.equal(firstPoll.model.id, 'claude-opus-5-5')

    // SQLite becomes unreadable before the next poll -> must stay on claude-opus-5-5, never revert to grok-4.7
    fs.writeFileSync(dbPath, 'temporarily unreadable')
    const secondPoll = agentStatsArgs(conn, { dir, localId: convId, cwd: CWD, chatsDir }).agent_stats
    assert.equal(secondPoll.model.id, 'claude-opus-5-5')
    assert.equal(secondPoll.at, firstPoll.at)
    assert.equal(typeof CHAT_STORE_BUSY_TIMEOUT_MS, 'number')
    assert.ok(CHAT_STORE_BUSY_TIMEOUT_MS > 0)
  })
})
