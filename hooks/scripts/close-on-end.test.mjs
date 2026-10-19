#!/usr/bin/env node
/**
 * End from DevSpec closes the local Cursor session (item 2b840556, parity with 973124bd).
 * Run: node --test hooks/scripts/close-on-end.test.mjs
 *
 * What matters most is what must NOT close a terminal: a stop typed in that terminal,
 * a detach, a recoverable server end, an end that happened before this process served
 * the connection (a resumed conversation), and a window the conversation moved away from.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { closeCursorOnEnd, closeOnEndDecision } from './close-on-end.mjs'
import { disabledStatePatch } from './devspec-remote-poll.mjs'

const CURSOR = 4242
const live = { enabled: true, owner_pid: CURSOR, session_id: 'room-1' }
const ownsAll = () => true

function run(state, overrides = {}) {
  const kills = []
  const outcome = closeCursorOnEnd({
    state,
    sawLive: true,
    env: {},
    platform: 'linux',
    resolvePid: () => CURSOR,
    owns: ownsAll,
    kill: (pid, signal) => kills.push([pid, signal]),
    ...overrides,
  })
  return { outcome, kills }
}

describe('closing Cursor when a person ends the agent from DevSpec', () => {
  it('closes on the state the poller writes for an Agents-page End', () => {
    const { outcome, kills } = run({ ...live, ...disabledStatePatch('ui') })
    assert.equal(outcome.closed, true)
    assert.deepEqual(kills, [[CURSOR, 'SIGTERM']])
  })

  it('does not close on /devspec.remote-stop typed in this terminal', () => {
    const { outcome, kills } = run({ ...live, ...disabledStatePatch('local_stop') })
    assert.equal(outcome.closed, false)
    assert.equal(outcome.reason, 'not_a_person_end')
    assert.deepEqual(kills, [])
  })

  it('does not close on a recoverable server end or an idle sweep', () => {
    for (const reason of ['server_ended', 'idle_timeout', 'owner_gone', null]) {
      const { kills } = run({ ...live, ...disabledStatePatch(reason) })
      assert.deepEqual(kills, [], `reason ${reason}`)
    }
  })

  it('does not close on a detach: the connection is still live, just out of the room', () => {
    const { kills } = run({ ...live, session_id: null })
    assert.deepEqual(kills, [])
  })

  it('does not close a conversation whose connection was ended before this process served it', () => {
    const { outcome, kills } = run({ ...live, ...disabledStatePatch('ui') }, { sawLive: false })
    assert.equal(outcome.reason, 'ended_before_this_process_served_it')
    assert.deepEqual(kills, [])
  })

  it('does not close a window the conversation was resumed away from', () => {
    const { outcome, kills } = run({ ...live, ...disabledStatePatch('ui') }, { owns: () => false })
    assert.equal(outcome.reason, 'not_the_owner')
    assert.deepEqual(kills, [])
  })

  it('does not close when no Cursor process can be proved by ancestry', () => {
    const { outcome, kills } = run({ ...live, ...disabledStatePatch('ui') }, { resolvePid: () => null })
    assert.equal(outcome.reason, 'no_cursor_process')
    assert.deepEqual(kills, [])
  })

  it('does not close on Windows, where a signal is a hard kill', () => {
    const { outcome, kills } = run({ ...live, ...disabledStatePatch('ui') }, { platform: 'win32' })
    assert.equal(outcome.reason, 'unsupported_platform')
    assert.deepEqual(kills, [])
  })

  it('reports a signal that could not be sent instead of claiming it closed', () => {
    const { outcome } = run({ ...live, ...disabledStatePatch('ui') }, {
      kill: () => {
        throw Object.assign(new Error('nope'), { code: 'EPERM' })
      },
    })
    assert.equal(outcome.closed, false)
    assert.match(outcome.reason, /EPERM/)
  })

  it('judges ownership against the pid resolved now, never the recorded one alone', () => {
    const seen = []
    closeOnEndDecision({
      state: { ...live, ...disabledStatePatch('ui') },
      sawLive: true,
      cursorPid: 777,
      platform: 'linux',
      owns: (state, pid) => {
        seen.push(pid)
        return true
      },
    })
    assert.deepEqual(seen, [777])
  })
})
