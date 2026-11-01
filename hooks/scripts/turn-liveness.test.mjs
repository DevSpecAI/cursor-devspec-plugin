#!/usr/bin/env node
/**
 * Working lasts as long as the work, not a fixed hour (item 2b840556, parity with 9e8dda57).
 * Run: node --test hooks/scripts/turn-liveness.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import {
  NO_SIGN_OF_LIFE_MS,
  bondPath,
  connectionsDir,
  readTurnActivity,
  recordTurnActivity,
  touch,
  turnIsLive,
  turnMarkerFile,
} from './turn-liveness.mjs'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const CONVERSATION = '62e52186-8e2f-4fca-81bd-544e89df6d2c'
const NOW = Date.parse('2026-10-06T19:06:35.662Z')
const HOUR = 60 * 60 * 1000
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'turn-liveness.mjs')

const scratch = []
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }) })
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-liveness-'))
  scratch.push(home)
  fs.mkdirSync(connectionsDir(home), { recursive: true })
  return home
}
function bond(home) {
  fs.mkdirSync(path.dirname(bondPath(home, CONVERSATION)), { recursive: true })
  fs.writeFileSync(bondPath(home, CONVERSATION), JSON.stringify({ connection_id: CONNECTION }))
}
function openTurn(home, marker) {
  fs.writeFileSync(turnMarkerFile(CONNECTION, connectionsDir(home)), JSON.stringify(marker))
}

describe('turnIsLive — what Cursor shows decides, not the time since pickup', () => {
  const startedAt = NOW - HOUR - 1

  it('a command past its first hour is live while its tool calls or transcript updates keep coming', () => {
    assert.equal(turnIsLive({ startedAt }, { activity: { turn: startedAt, at: NOW - 30_000 }, now: NOW }), true)
  })

  it('a held command is live however long the agent waits for its own work', () => {
    assert.equal(turnIsLive({ startedAt: NOW - 5 * HOUR, held: true }, { now: NOW }), true)
  })

  it('a turn whose end was never reported goes once nothing has happened for the backstop', () => {
    assert.equal(turnIsLive({ startedAt }, { now: NOW }), false)
    assert.equal(turnIsLive({ startedAt }, { activity: { turn: startedAt, at: NOW - NO_SIGN_OF_LIFE_MS }, now: NOW }), false)
  })

  it('a short turn is unchanged: live from the moment it starts', () => {
    assert.equal(turnIsLive({ startedAt: NOW - 1_000 }, { now: NOW }), true)
  })

  it("a previous turn's activity never keeps the next one alive", () => {
    assert.equal(turnIsLive({ startedAt }, { activity: { turn: startedAt - 1, at: NOW - 1_000 }, now: NOW }), false)
  })

  it('no marker is no turn', () => {
    assert.equal(turnIsLive(null, { now: NOW }), false)
  })
})

describe('recordTurnActivity — a sign of life never opens or reopens a turn', () => {
  it("stamps the open turn's activity with the turn it belongs to", () => {
    const home = tempHome()
    openTurn(home, { startedAt: NOW - HOUR })
    assert.equal(recordTurnActivity(CONNECTION, { dir: connectionsDir(home), now: NOW }), true)
    assert.deepEqual(readTurnActivity(CONNECTION, connectionsDir(home)), { turn: NOW - HOUR, at: NOW })
  })

  it('with no turn open it writes nothing, so a turn that just ended stays ended', () => {
    const home = tempHome()
    assert.equal(recordTurnActivity(CONNECTION, { dir: connectionsDir(home), now: NOW }), false)
    assert.equal(fs.existsSync(turnMarkerFile(CONNECTION, connectionsDir(home))), false)
    assert.equal(readTurnActivity(CONNECTION, connectionsDir(home)), null)
  })

  it('leaves the marker exactly as it was', () => {
    const home = tempHome()
    const marker = { startedAt: NOW - HOUR, held: true }
    openTurn(home, marker)
    recordTurnActivity(CONNECTION, { dir: connectionsDir(home), now: NOW })
    assert.deepEqual(JSON.parse(fs.readFileSync(turnMarkerFile(CONNECTION, connectionsDir(home)), 'utf8')), marker)
  })
})

describe('touch — the PostToolUse hook', () => {
  it("records activity for the conversation's own connection, a subagent's tool call included", () => {
    const home = tempHome()
    bond(home)
    openTurn(home, { startedAt: NOW - HOUR })
    const input = JSON.stringify({ conversation_id: CONVERSATION, session_id: CONVERSATION, agent_id: 'a5d2', hook_event_name: 'postToolUse', tool_name: 'Shell' })
    assert.equal(touch(input, { env: {}, home, now: NOW }), true)
    assert.deepEqual(readTurnActivity(CONNECTION, connectionsDir(home)), { turn: NOW - HOUR, at: NOW })
  })

  it('does nothing for a conversation that is not connected', () => {
    const home = tempHome()
    openTurn(home, { startedAt: NOW - HOUR })
    assert.equal(touch(JSON.stringify({ conversation_id: CONVERSATION }), { env: {}, home, now: NOW }), false)
  })

  it('as a command it always exits 0 and prints nothing, whatever it is given', () => {
    const home = tempHome()
    bond(home)
    openTurn(home, { startedAt: Date.now() - 1_000 })
    for (const stdin of [JSON.stringify({ conversation_id: CONVERSATION }), 'not json', '']) {
      const run = spawnSync(process.execPath, [SCRIPT, 'touch'], { input: stdin, env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' })
      assert.equal(run.status, 0)
      assert.equal(run.stdout, '')
    }
    assert.equal(readTurnActivity(CONNECTION, connectionsDir(home))?.turn > 0, true)
  })
})
