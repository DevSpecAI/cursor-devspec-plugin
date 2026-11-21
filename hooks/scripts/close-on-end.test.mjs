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
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'

import {
  closeCursorOnEnd,
  closeOnEndDecision,
  commandsStartedBy,
  COMMAND_STOP_GRACE_MS,
  cursorProcessOf,
  parseReapPlan,
  processIdentity,
  processTable,
  reapCommands,
} from './close-on-end.mjs'
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
    // Never the real process table or a real reaper here: the pid above is made up.
    listCommands: () => [],
    reap: () => null,
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

  it('does not close on /devspec-remote-stop typed in this terminal', () => {
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

/**
 * End stops the commands Cursor started, too (item b7523464). Signalling Cursor alone
 * left a shell command it was running (a `sleep 240` in the live check) behind.
 */
describe('stopping the commands the closed Cursor started', () => {
  const ended = { ...live, ...disabledStatePatch('ui') }

  it('signals Cursor first, then each command it started, and hands them to the reaper', () => {
    const reaped = []
    const { outcome, kills } = run(ended, {
      listCommands: () => [{ pid: 5001, identity: 'a' }, { pid: 5002, identity: 'b' }],
      reap: (commands, { graceMs }) => {
        reaped.push([commands.map((c) => c.pid), graceMs])
        return 6001
      },
    })
    assert.deepEqual(kills, [[CURSOR, 'SIGTERM'], [5001, 'SIGTERM'], [5002, 'SIGTERM']])
    assert.deepEqual(reaped, [[[5001, 5002], COMMAND_STOP_GRACE_MS]])
    assert.deepEqual(outcome.commands, { stopped: [5001, 5002], failed: [], reaper: 6001, forceAfterMs: COMMAND_STOP_GRACE_MS })
  })

  it('lists the commands before Cursor is signalled, while they are still its children', () => {
    const order = []
    run(ended, {
      listCommands: () => { order.push('list'); return [] },
      kill: (pid) => order.push(`kill ${pid}`),
    })
    assert.deepEqual(order, ['list', `kill ${CURSOR}`])
  })

  it('touches no command when it does not close Cursor, or when Cursor could not be signalled', () => {
    const listed = []
    const listCommands = (pid) => { listed.push(pid); return [{ pid: 5001, identity: 'a' }] }
    for (const overrides of [{ sawLive: false }, { owns: () => false }, { platform: 'win32' }]) {
      const { kills } = run(ended, { ...overrides, listCommands })
      assert.deepEqual(kills, [])
    }
    run({ ...live, ...disabledStatePatch('local_stop') }, { listCommands })
    assert.deepEqual(listed, [], 'nothing is even listed unless End closes Cursor')
    const signalled = []
    const { outcome } = run(ended, {
      listCommands,
      kill: (pid) => {
        signalled.push(pid)
        if (pid === CURSOR) throw Object.assign(new Error('nope'), { code: 'EPERM' })
      },
    })
    assert.equal(outcome.closed, false)
    assert.deepEqual(signalled, [CURSOR])
  })

  it('reports a command it could not signal, and treats one that already exited as stopped', () => {
    const { outcome } = run(ended, {
      listCommands: () => [{ pid: 5001, identity: 'a' }, { pid: 5002, identity: 'b' }],
      kill: (pid) => {
        if (pid === 5001) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        if (pid === 5002) throw Object.assign(new Error('not yours'), { code: 'EPERM' })
      },
    })
    assert.equal(outcome.closed, true)
    assert.deepEqual(outcome.commands.stopped, [])
    assert.deepEqual(outcome.commands.failed, [{ pid: 5002, reason: 'EPERM' }])
    assert.equal(outcome.commands.reaper, null)
  })

  it('the reaper kills only what is still the process it was given, after the grace', async () => {
    const identities = new Map([[11, 'start-11'], [12, 'start-12'], [13, 'reused']])
    const killed = []
    let clock = 0
    const result = await reapCommands(
      { graceMs: 300, targets: [{ pid: 11, identity: 'start-11' }, { pid: 12, identity: 'start-12' }, { pid: 13, identity: 'start-13' }] },
      {
        identityOf: (pid) => identities.get(pid) ?? null,
        kill: (pid, signal) => killed.push([pid, signal]),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
          if (clock >= 100) identities.delete(12) // 12 stops on its own during the grace
        },
      },
    )
    assert.deepEqual(killed, [[11, 'SIGKILL']], '13 is someone else now, 12 exited')
    assert.deepEqual(result.killed, [11])
    assert.ok(clock >= 300, 'it waited out the grace before killing')
  })

  it('the reaper returns at once when everything already stopped', async () => {
    let slept = 0
    const result = await reapCommands({ graceMs: 5_000, targets: [{ pid: 11, identity: 'x' }] }, {
      identityOf: () => null,
      kill: () => assert.fail('nothing to kill'),
      sleep: async () => { slept++ },
    })
    assert.deepEqual(result.killed, [])
    assert.equal(slept, 0)
  })

  it('the reaper accepts only a well-formed plan', () => {
    assert.equal(parseReapPlan('not json'), null)
    assert.equal(parseReapPlan(JSON.stringify({ graceMs: -1, targets: [] })), null)
    assert.equal(parseReapPlan(JSON.stringify({ graceMs: 1e9, targets: [] })), null)
    assert.deepEqual(
      parseReapPlan(JSON.stringify({ graceMs: 10, targets: [{ pid: 1, identity: 'init' }, { pid: 42, identity: '' }, { pid: 43, identity: 'ok', extra: 1 }, { pid: '44', identity: 'x' }] })),
      { graceMs: 10, targets: [{ pid: 43, identity: 'ok' }] },
    )
  })

  it('the grace period is a few seconds, stated once', () => {
    assert.equal(COMMAND_STOP_GRACE_MS, 5_000)
  })
})

/**
 * The same with real processes: a stand-in "cursor-agent" that, like the real one,
 * exits on SIGTERM and leaves its children behind; a long `sleep` it started through a
 * shell; a command that ignores SIGTERM; and an unrelated `sleep` that must survive.
 */
describe('End with real processes', { skip: process.platform === 'win32' && 'no signals on Windows' }, () => {
  const running = (pid) => processIdentity(pid) !== null
  const until = async (check, ms) => {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    return check()
  }
  const FAKE_CURSOR = [
    "const { spawn } = require('node:child_process')",
    "const shell = spawn('sh', ['-c', 'sleep 240 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] })",
    "const stubborn = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "process.on('SIGTERM', () => process.exit(0))",
    "shell.stdout.once('data', (d) => process.stdout.write(JSON.stringify({ shell: shell.pid, sleep: Number(String(d).trim()), stubborn: stubborn.pid }) + '\\n'))",
    'setInterval(() => {}, 1000)',
  ].join('\n')

  async function startFakeCursor() {
    // The trailing `cursor-agent` argument is what makes it look like Cursor by its command line.
    const cursor = spawn(process.execPath, ['-e', FAKE_CURSOR, 'cursor-agent'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pids = await new Promise((resolve, reject) => {
      cursor.stdout.once('data', (d) => resolve(JSON.parse(String(d))))
      cursor.once('error', reject)
    })
    // Wait until the stubborn command has installed its handler (it would die on SIGTERM before).
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { cursor, pids: { cursor: cursor.pid, ...pids } }
  }

  function cleanUp(pids) {
    for (const pid of pids) {
      try { if (running(pid)) process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }

  it('lists what Cursor started, sparing the closing process and the shell it runs in', async () => {
    const { pids } = await startFakeCursor()
    try {
      assert.equal(cursorProcessOf(pids.cursor), pids.cursor, 'the stand-in is recognised as Cursor')
      const all = commandsStartedBy(pids.cursor).map((c) => c.pid).sort()
      assert.deepEqual(all, [pids.shell, pids.sleep, pids.stubborn].sort())
      assert.ok(commandsStartedBy(pids.cursor).every((c) => typeof c.identity === 'string' && c.identity))
      // Closing from inside the shell: that shell is spared, the sleep it started is not.
      const fromShell = commandsStartedBy(pids.cursor, { selfPid: pids.shell, table: processTable() }).map((c) => c.pid).sort()
      assert.deepEqual(fromShell, [pids.sleep, pids.stubborn].sort())
    } finally {
      cleanUp(Object.values(pids))
    }
  })

  it('after End, the long command Cursor was running is gone, and nothing else is touched', async () => {
    const unrelated = spawn('sleep', ['240'], { stdio: 'ignore' })
    const { pids } = await startFakeCursor()
    try {
      assert.ok(running(pids.sleep) && running(pids.stubborn) && running(unrelated.pid))
      const outcome = closeCursorOnEnd({
        state: { ...live, owner_pid: pids.cursor, ...disabledStatePatch('ui') },
        sawLive: true,
        ownerPid: pids.cursor,
        // Resolve only the stand-in: never walk this test's own ancestry to a real agent.
        resolvePid: (pid) => cursorProcessOf(Number(pid)),
        graceMs: 1_500,
      })
      assert.equal(outcome.closed, true, outcome.reason)
      assert.equal(outcome.pid, pids.cursor)
      assert.deepEqual([...outcome.commands.stopped].sort(), [pids.shell, pids.sleep, pids.stubborn].sort())
      assert.ok(Number.isInteger(outcome.commands.reaper), 'a reaper took the stubborn ones')

      assert.ok(await until(() => !running(pids.cursor), 3_000), 'Cursor closed')
      assert.ok(await until(() => !running(pids.sleep) && !running(pids.shell), 3_000), 'the sleep Cursor started is gone')
      assert.ok(running(pids.stubborn), 'it ignored SIGTERM, and the grace has not run out yet')
      assert.ok(await until(() => !running(pids.stubborn), 6_000), 'the command that ignored SIGTERM was killed after the grace')
      assert.ok(running(unrelated.pid), 'an unrelated sleep is untouched')
    } finally {
      cleanUp([...Object.values(pids), unrelated.pid])
    }
  })
})
