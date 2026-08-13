#!/usr/bin/env node
/**
 * Unit tests for conversation-scoped, CONNECTION-NATIVE remote-control resolve-local.
 * Run: node --test hooks/scripts/remote-control-state.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  detectLocalId,
  ensurePollerForConnection,
  isRecoverableEndReason,
  mintLocalId,
  ownerAlive,
  reapDeadPollers,
  resolveLocalAction,
  isWin32OwnerHostName,
  isWin32ShellName,
  isWin32CursorAgentNodeCommand,
  isWin32DurableOwnerProcess,
  isWin32CliSpawnOwnerProcess,
  shouldIgnoreExplicitWin32Owner,
  resolveOwnerPid,
  resolveOwnerPidAutoWindows,
  resolveOwnerPidFromChildTree,
  walkChildTreeForDurableOwner,
  ensurePollerAfterAgentSpawn,
} from './remote-control-state.mjs'

describe('detectLocalId', () => {
  it('prefers explicit --local-id over env', () => {
    const r = detectLocalId(
      { 'local-id': 'from-arg' },
      { CODEX_THREAD_ID: 'from-env', SHELL_SESSION_ID: 'shell' },
    )
    assert.equal(r.local_id, 'from-arg')
    assert.equal(r.source, 'arg')
  })

  it('prefers CODEX_THREAD_ID over other conversation env', () => {
    const r = detectLocalId({}, { CODEX_THREAD_ID: 'thread-1', GROK_SESSION_ID: 'grok-1' })
    assert.equal(r.local_id, 'thread-1')
    assert.equal(r.source, 'env:CODEX_THREAD_ID')
  })

  it('does NOT bond on SHELL_SESSION_ID / TERM_SESSION_ID (terminal, not conversation)', () => {
    // Regression guard for the Working-stuck bug (Grok a6b3f881, Claude 87117120).
    // A shell id in env hijacked the env leg of resolveHookConversationId, so the
    // correct hook-stdin conversation id was never reached, the bond matched no
    // connection, and the turn marker was never cleared.
    const r = detectLocalId({}, { SHELL_SESSION_ID: 'shell-only', TERM_SESSION_ID: 'term-only' })
    assert.equal(r.local_id, null)
    assert.equal(r.source, null)
  })

  it('uses CLAUDE_CODE_SESSION_ID even when a shell id is also present', () => {
    const r = detectLocalId({}, { CLAUDE_CODE_SESSION_ID: 'claude-conv', SHELL_SESSION_ID: 'shell' })
    assert.equal(r.local_id, 'claude-conv')
    assert.equal(r.source, 'env:CLAUDE_CODE_SESSION_ID')
  })

  it('does not invent an id from cwd or empty env', () => {
    const r = detectLocalId({}, {})
    assert.equal(r.local_id, null)
    assert.equal(r.source, null)
  })

  it('sanitizes unsafe characters', () => {
    const r = detectLocalId({ 'local-id': 'abc/../evil;rm' }, {})
    assert.equal(r.local_id, 'abc..evilrm')
  })
})

describe('isRecoverableEndReason', () => {
  it('accepts local_stop owner_gone idle_timeout auth only', () => {
    assert.equal(isRecoverableEndReason('local_stop'), true)
    assert.equal(isRecoverableEndReason('owner_gone'), true)
    assert.equal(isRecoverableEndReason('idle_timeout'), true)
    assert.equal(isRecoverableEndReason('auth'), true)
    assert.equal(isRecoverableEndReason('ui'), false)
    assert.equal(isRecoverableEndReason(null), false)
  })

  it('owner_gone is recoverable — the host process exiting is the COMMON restart', () => {
    // Regression guard for item 937c78b0. The poller used to stamp owner-death as
    // `local_stop`; splitting it out makes the drop data readable, but if this list
    // did not learn the new value, every Claude Code relaunch would silently register
    // a brand-new connection (new codename, lost bond) instead of resuming.
    assert.equal(isRecoverableEndReason('owner_gone'), true)
  })
})

describe('mintLocalId', () => {
  it('returns a uuid-like string', () => {
    const id = mintLocalId()
    assert.match(id, /^[0-9a-f-]{36}$/i)
  })
})

describe('resolveLocalAction (connection-native)', () => {
  const agent = 'Grok Build'
  const localId = 'conv-aaa'
  const connectionId = '22222222-2222-2222-2222-222222222222'
  const sessionId = '11111111-1111-1111-1111-111111111111'
  const now = Date.parse('2026-07-12T12:00:00.000Z')

  it('register when no local id (fresh terminal, bare remote)', () => {
    const r = resolveLocalAction({ agent, localId: null, now })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
    assert.equal(r.session_id, null)
    assert.match(r.note, /No local conversation id/)
  })

  it('create_and_attach with forceNew even if bond is live', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      forceNew: true,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'live',
        session_codename: 'Colorful Possum',
      }),
      readConnection: () => ({ enabled: true, connection_id: connectionId }),
    })
    assert.equal(r.action, 'create_and_attach')
  })

  it('register when bond missing for this conversation', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => null,
      readConnection: () => null,
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
  })

  it('already_live when this conversation owns an enabled connection', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'live',
        agent_name: agent,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: sessionId,
        enabled: true,
        session_codename: 'Colorful Possum',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'already_live')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, sessionId)
    assert.equal(r.session_codename, 'Colorful Possum')
  })

  it('already_live for a SESSIONLESS connection (no session attached)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: null,
        status: 'live',
        agent_name: agent,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: null,
        enabled: true,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'already_live')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, null)
  })

  it('reconnect after recent local_stop for THIS conversation only', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        agent_name: agent,
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        session_id: sessionId,
        enabled: false,
        end_reason: 'local_stop',
        session_codename: 'Silent Fox',
        updated_at: '2026-07-12T11:50:00.000Z',
        cursor_after_message_id: 'msg-1',
      }),
    })
    assert.equal(r.action, 'reconnect')
    assert.equal(r.connection_id, connectionId)
    assert.equal(r.session_id, sessionId)
    assert.equal(r.cursor_after_message_id, 'msg-1')
  })

  it('register when prior stop is stale (> TTL)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      maxAgeMinutes: 30,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z', // 2h earlier
      }),
      readConnection: () => ({
        connection_id: connectionId,
        enabled: false,
        end_reason: 'local_stop',
        updated_at: '2026-07-12T10:00:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
    assert.equal(r.prior_connection_id, connectionId)
  })

  it('register after UI end (no ambient reattach)', () => {
    const r = resolveLocalAction({
      agent,
      localId,
      now,
      readBond: () => ({
        local_id: localId,
        connection_id: connectionId,
        session_id: sessionId,
        status: 'stopped',
        end_reason: 'ui',
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
      readConnection: () => ({
        connection_id: connectionId,
        enabled: false,
        end_reason: 'ui',
        ended_from_ui: true,
        updated_at: '2026-07-12T11:55:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.match(r.note, /ended from the UI/)
  })

  it('does not reconnect a foreign conversation bond (different localId → no bond)', () => {
    const r = resolveLocalAction({
      agent: 'Grok Build',
      localId: 'grok-fresh-id',
      now,
      readBond: () => null, // no bond for Grok's local id
      readConnection: () => ({
        connection_id: 'bad12d41-229b-4bcf-afee-fa1a093888c8',
        enabled: false,
        end_reason: 'local_stop',
        agent_name: 'Codex',
        updated_at: '2026-07-12T11:50:00.000Z',
      }),
    })
    assert.equal(r.action, 'register')
    assert.equal(r.connection_id, null)
  })

  it('two different local ids never share already_live', () => {
    const bonds = {
      'term-a': {
        local_id: 'term-a',
        connection_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        status: 'live',
        session_codename: 'Amber Otter',
      },
      'term-b': {
        local_id: 'term-b',
        connection_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        status: 'live',
        session_codename: 'Bold Raven',
      },
    }
    const ra = resolveLocalAction({
      agent,
      localId: 'term-a',
      now,
      readBond: (_a, id) => bonds[id],
      readConnection: (cid) => ({ connection_id: cid, enabled: true }),
    })
    const rb = resolveLocalAction({
      agent,
      localId: 'term-b',
      now,
      readBond: (_a, id) => bonds[id],
      readConnection: (cid) => ({ connection_id: cid, enabled: true }),
    })
    assert.equal(ra.action, 'already_live')
    assert.equal(rb.action, 'already_live')
    assert.notEqual(ra.connection_id, rb.connection_id)
  })
})

describe('ownerAlive', () => {
  it('this process is alive; pid 1 / bad input are not adopted', () => {
    assert.equal(ownerAlive(process.pid), true)
    assert.equal(ownerAlive(1), false)
    assert.equal(ownerAlive(0), false)
    assert.equal(ownerAlive(null), false)
    assert.equal(ownerAlive(-5), false)
    assert.equal(ownerAlive(2_147_483_646), false) // implausible pid → ESRCH
  })
})

describe('reapDeadPollers (connection-native)', () => {
  const agent = 'Claude Code'
  // A poller "runs" for every connection by default in these tests.
  const findPidsAll = (cid) => [`pid-${cid}`]
  const noneAlive = () => false
  const allAlive = () => true

  function run(states, opts = {}) {
    const killed = []
    const reaped = reapDeadPollers({
      agent,
      listStates: () => states,
      findPids: opts.findPids || findPidsAll,
      isOwnerAlive: opts.isOwnerAlive || allAlive,
      kill: (pid) => {
        killed.push(pid)
        return true
      },
      ...opts.args,
    })
    return { reaped, killed }
  }

  it('reaps a disabled connection', () => {
    const { reaped, killed } = run([
      { connection_id: 'c-disabled', agent_name: agent, enabled: false },
    ])
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'disabled')
    assert.deepEqual(killed, ['pid-c-disabled'])
  })

  it('reaps an owner-gone connection (owner_pid recorded but dead)', () => {
    const { reaped } = run(
      [{ connection_id: 'c-orphan', agent_name: agent, enabled: true, owner_pid: 4242 }],
      { isOwnerAlive: noneAlive },
    )
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'owner_gone')
  })

  it('reaps an ended-from-ui connection', () => {
    const { reaped } = run([
      { connection_id: 'c-ui', agent_name: agent, enabled: true, ended_from_ui: true, owner_pid: 10 },
    ])
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'ended_from_ui')
  })

  it('NEVER reaps a live connection (enabled + owner alive)', () => {
    const { reaped, killed } = run(
      [{ connection_id: 'c-live', agent_name: agent, enabled: true, owner_pid: 999 }],
      { isOwnerAlive: allAlive },
    )
    assert.equal(reaped.length, 0)
    assert.deepEqual(killed, [])
  })

  it('does NOT reap a no-owner_pid connection with no/fresh timestamp (unknown → leave alone)', () => {
    // No updated_at → staleness unknown → not reaped.
    const noStamp = run([{ connection_id: 'c-legacy', agent_name: agent, enabled: true }])
    assert.equal(noStamp.reaped.length, 0)
    // Fresh updated_at → clearly active → not reaped.
    const fresh = run(
      [
        {
          connection_id: 'c-legacy-fresh',
          agent_name: agent,
          enabled: true,
          updated_at: '2026-07-20T11:59:00.000Z',
        },
      ],
      { args: { now: Date.parse('2026-07-20T12:00:00.000Z') } },
    )
    assert.equal(fresh.reaped.length, 0)
  })

  it('reaps a STALE no-owner_pid connection (legacy backstop — zombie gap 00bd4f6e)', () => {
    const { reaped, killed } = run(
      [
        {
          connection_id: 'c-legacy-stale',
          agent_name: agent,
          enabled: true,
          updated_at: '2026-07-20T10:00:00.000Z', // 2h before `now`, threshold 1h
        },
      ],
      { args: { now: Date.parse('2026-07-20T12:00:00.000Z') } },
    )
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].reason, 'stale_no_owner')
    assert.deepEqual(killed, ['pid-c-legacy-stale'])
  })

  it('skips the exceptConnectionId (the one we are about to (re)use)', () => {
    const { reaped } = run(
      [{ connection_id: 'c-keep', agent_name: agent, enabled: false }],
      { args: { exceptConnectionId: 'c-keep' } },
    )
    assert.equal(reaped.length, 0)
  })

  it('only reaps this agent — a different agent is left alone', () => {
    const { reaped } = run([
      { connection_id: 'c-other', agent_name: 'Grok Build', enabled: false },
      { connection_id: 'c-mine', agent_name: agent, enabled: false },
    ])
    assert.deepEqual(
      reaped.map((r) => r.connection_id),
      ['c-mine'],
    )
  })

  it('skips connections with no running poller', () => {
    const { reaped } = run([{ connection_id: 'c-nopoller', agent_name: agent, enabled: false }], {
      findPids: () => [],
    })
    assert.equal(reaped.length, 0)
  })
})

describe('ensurePollerForConnection (guards)', () => {
  it('rejects a missing/too-short connection id without spawning', () => {
    assert.equal(ensurePollerForConnection('').ok, false)
    assert.equal(ensurePollerForConnection('short').ok, false)
    assert.match(ensurePollerForConnection(null).error, /missing connection id/)
  })

  it('refuses to spawn without a valid --owner-pid (no anchor → would zombie)', () => {
    // Valid-length connection id, script present, but no owner pid → refuse before
    // stopping/spawning anything, so the reaper can always prove a poller dead.
    // resolveOwnerPid stubbed to null: without it, win32's real self-resolver
    // (item 3cddb3b4) would walk up to this test process's own real claude.exe
    // ancestor and actually succeed — proceeding to really spawn a detached
    // poller process as a side effect of running the test suite.
    const r = ensurePollerForConnection('11111111-1111-1111-1111-111111111111', {
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
    const bad = ensurePollerForConnection('11111111-1111-1111-1111-111111111111', {
      ownerPid: 1,
      resolveOwnerPid: () => null,
    })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /owner-pid/)
  })
})

describe('ensurePollerForConnection (reuse, item b9e02835)', () => {
  const connectionId = '11111111-1111-1111-1111-111111111111'

  it('reuses a live poller when reuseRunning is set — no kill, no respawn', () => {
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      findPids: () => [4242],
    })
    assert.equal(r.ok, true)
    assert.equal(r.reused, true)
    assert.equal(r.pid, 4242)
    assert.equal(r.connection_id, connectionId)
  })

  it('reuse carries the sessionId through for the caller result', () => {
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      sessionId: '22222222-2222-2222-2222-222222222222',
      findPids: () => [4242],
    })
    assert.equal(r.reused, true)
    assert.equal(r.session_id, '22222222-2222-2222-2222-222222222222')
  })

  it('reuseRunning with no live poller falls through to the spawn guards', () => {
    // resolveOwnerPid stubbed to null: on win32 the real resolver walks THIS test
    // process's own ancestry, and since it's actually running under a real
    // claude.exe (item 3cddb3b4), it would otherwise find a genuine anchor and
    // this "no anchor" case would flake based on host state.
    const r = ensurePollerForConnection(connectionId, {
      reuseRunning: true,
      findPids: () => [],
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
  })

  it('without reuseRunning the restart path is unchanged (guards still apply)', () => {
    const r = ensurePollerForConnection(connectionId, {
      findPids: () => [4242],
      resolveOwnerPid: () => null,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /owner-pid/)
  })
})

describe('resolveOwnerPid / resolveOwnerPidAutoWindows (items 3cddb3b4 / f3a88333 / c57dc381)', () => {
  it('classifies durable hosts and short-lived shells', () => {
    assert.equal(isWin32OwnerHostName('Cursor.exe'), true)
    assert.equal(isWin32OwnerHostName('agent.exe'), true)
    assert.equal(isWin32OwnerHostName('claude.exe'), true)
    assert.equal(isWin32OwnerHostName('node.exe'), false)
    assert.equal(isWin32OwnerHostName('powershell.exe'), false)
    assert.equal(isWin32ShellName('powershell.exe'), true)
    assert.equal(isWin32ShellName('pwsh.exe'), true)
    assert.equal(isWin32ShellName('cmd.exe'), true)
    assert.equal(isWin32ShellName('bash.exe'), true)
    assert.equal(isWin32ShellName('Cursor.exe'), false)
  })

  it('treats node.exe + cursor-agent CommandLine as durable (item c57dc381)', () => {
    const cursorAgentCmd =
      '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\2026.08.04-aaa8809\\node.exe" ' +
      '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\2026.08.04-aaa8809\\index.js" --resume abc'
    assert.equal(isWin32CursorAgentNodeCommand(cursorAgentCmd), true)
    assert.equal(isWin32DurableOwnerProcess('node.exe', cursorAgentCmd), true)
    assert.equal(shouldIgnoreExplicitWin32Owner('node.exe', cursorAgentCmd), false)

    assert.equal(isWin32CursorAgentNodeCommand(''), false)
    assert.equal(isWin32DurableOwnerProcess('node.exe', ''), false)
    assert.equal(shouldIgnoreExplicitWin32Owner('node.exe', ''), true)

    const ephemeral =
      'C:\\nvm4w\\nodejs\\node.exe C:\\Users\\x\\.cursor\\extensions\\devspecai.devspec-autopilot-0.4.9\\hooks\\scripts\\remote-control-state.mjs ensure-poller'
    assert.equal(isWin32CursorAgentNodeCommand(ephemeral), false)
    assert.equal(shouldIgnoreExplicitWin32Owner('node.exe', ephemeral), true)

    const launcher =
      'C:\\nvm4w\\nodejs\\node.exe C:\\Users\\x\\.cursor\\devspec\\launch-cli-session.mjs --folder x'
    assert.equal(isWin32CursorAgentNodeCommand(launcher), false)
  })

  it('explicit valid non-shell arg wins (mocked name lookup)', () => {
    assert.equal(
      resolveOwnerPid(555, 999, {
        processNameOf: () => 'Cursor.exe',
        resolveAuto: () => {
          throw new Error('auto should not run')
        },
      }),
      555,
    )
  })

  it('explicit cursor-agent node.exe wins; plain/ephemeral node falls through (item c57dc381)', () => {
    if (process.platform !== 'win32') {
      assert.equal(
        resolveOwnerPid(10804, 999, {
          processNameOf: () => 'node.exe',
          processCommandLineOf: () => 'C:\\x\\cursor-agent\\versions\\1\\index.js',
          resolveAuto: () => 777,
        }),
        10804,
      )
      return
    }
    assert.equal(
      resolveOwnerPid(10804, 999, {
        processNameOf: () => 'node.exe',
        processCommandLineOf: () =>
          '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\node.exe" "C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\index.js"',
        resolveAuto: () => {
          throw new Error('auto should not run')
        },
      }),
      10804,
    )
    assert.equal(
      resolveOwnerPid(31240, 999, {
        processNameOf: () => 'node.exe',
        processCommandLineOf: () =>
          'node.exe C:\\ext\\hooks\\scripts\\remote-control-state.mjs ensure-poller',
        resolveAuto: () => 777,
      }),
      777,
    )
    assert.equal(
      resolveOwnerPid(31240, 999, {
        processNameOf: () => 'node.exe',
        processCommandLineOf: () => 'node.exe C:\\proj\\vitest.mjs',
        resolveAuto: () => null,
      }),
      999,
    )
  })

  it('ignores explicit Windows shell pid and falls through to auto/prev (item f3a88333)', () => {
    if (process.platform !== 'win32') {
      // Off Windows, explicit still wins — shell rejection is win32-only.
      assert.equal(
        resolveOwnerPid(31240, 999, {
          processNameOf: () => 'powershell.exe',
          resolveAuto: () => 777,
        }),
        31240,
      )
      return
    }
    assert.equal(
      resolveOwnerPid(31240, 999, {
        processNameOf: () => 'powershell.exe',
        resolveAuto: () => 777,
      }),
      777,
    )
    assert.equal(
      resolveOwnerPid(31240, 999, {
        processNameOf: () => 'pwsh.exe',
        resolveAuto: () => null,
      }),
      999,
    )
  })

  it('never returns an invalid (<=1) explicit arg as-is', () => {
    // 1 fails the >1 validity check, so it must fall through to auto-resolution
    // or prevValue rather than being returned literally.
    assert.notEqual(resolveOwnerPid(1, 999, { resolveAuto: () => null }), 1)
  })

  it('resolveOwnerPidAutoWindows returns null off-Windows and for a made-up start pid', () => {
    if (process.platform !== 'win32') {
      assert.equal(resolveOwnerPidAutoWindows(process.pid), null)
      return
    }
    // A start pid that (almost certainly) does not exist finds no process at all,
    // so the walk ends immediately with nothing to report — deterministic
    // regardless of what real processes happen to be running on this host.
    assert.equal(resolveOwnerPidAutoWindows(999_999_999), null)
  })

  it('resolveOwnerPidAutoWindows walks to a durable host ancestor on win32', { skip: process.platform !== 'win32' }, () => {
    // Under Cursor IDE / cursor-agent / Claude the walk may find a host; under a
    // bare node test runner it may legitimately return null.
    const found = resolveOwnerPidAutoWindows(process.pid)
    assert.ok(found === null || (Number.isInteger(found) && found > 1))
  })

  it(
    'resolveOwnerPidAutoWindows recognizes a live cursor-agent node.exe host (item c57dc381)',
    { skip: process.platform !== 'win32' },
    () => {
      // Prefer a real cursor-agent process on this machine; skip when none are running
      // (CI / bare runners) so the suite stays deterministic.
      let startPid = null
      try {
        const out = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '(?i)[\\\\/]cursor-agent[\\\\/]' -and $_.CommandLine -notmatch 'remote-control-state|launch-cli-session' } | Select-Object -First 1 -ExpandProperty ProcessId; if ($p) { Write-Output $p }`,
          ],
          { encoding: 'utf8', timeout: 8000, windowsHide: true },
        ).trim()
        const n = Number.parseInt(out, 10)
        if (Number.isInteger(n) && n > 1) startPid = n
      } catch {
        /* no host */
      }
      if (startPid == null) return
      assert.equal(resolveOwnerPidAutoWindows(startPid), startPid)
    },
  )
})

describe('resolveOwnerPidFromChildTree (item f099fc6e)', () => {
  const cursorAgentCmd =
    '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\2026.08.11-e8db854\\node.exe" ' +
    '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\2026.08.11-e8db854\\index.js" --resume abc'
  const launcherCmd =
    'C:\\nvm4w\\nodejs\\node.exe C:\\Users\\x\\.cursor\\extensions\\devspecai.devspec-autopilot-0.5.1\\scripts\\launch-cli-session.mjs --folder x'
  const treeOpts = (tree) => ({
    platform: 'win32',
    timeoutMs: 0,
    sleepMs: () => {},
    processInfoOf: (pid) => {
      const n = tree[pid]
      return n ? { name: n.name, commandLine: n.commandLine || '' } : null
    },
    childrenOf: (pid) => tree[pid]?.children ?? [],
  })

  it('prefers a cursor-agent descendant over a powershell wrapper PID', () => {
    const found = resolveOwnerPidFromChildTree(
      100,
      treeOpts({
        100: { name: 'powershell.exe', commandLine: 'powershell -File agent.ps1', children: [200] },
        200: { name: 'node.exe', commandLine: cursorAgentCmd, children: [] },
      }),
    )
    assert.equal(found, 200)
  })

  it('accepts agent.exe as a CLI spawn owner', () => {
    assert.equal(
      resolveOwnerPidFromChildTree(
        50,
        treeOpts({
          50: { name: 'cmd.exe', children: [51] },
          51: { name: 'agent.exe', commandLine: 'agent.exe --resume x', children: [] },
        }),
      ),
      51,
    )
  })

  it('rejects ephemeral launch-cli-session as the owner', () => {
    assert.equal(isWin32CliSpawnOwnerProcess('node.exe', launcherCmd), false)
    assert.equal(
      resolveOwnerPidFromChildTree(
        10,
        treeOpts({
          10: { name: 'node.exe', commandLine: launcherCmd, children: [] },
        }),
      ),
      null,
    )
  })

  it('rejects Cursor.exe the IDE even if it appears in the spawn tree', () => {
    assert.equal(isWin32CliSpawnOwnerProcess('Cursor.exe', ''), false)
    assert.equal(isWin32DurableOwnerProcess('Cursor.exe'), true)
    assert.equal(
      resolveOwnerPidFromChildTree(
        100,
        treeOpts({
          100: { name: 'powershell.exe', children: [300] },
          300: { name: 'Cursor.exe', commandLine: 'Cursor.exe', children: [] },
        }),
      ),
      null,
    )
  })

  it('does not treat powershell with no durable child as an owner', () => {
    assert.equal(
      resolveOwnerPidFromChildTree(
        100,
        treeOpts({
          100: { name: 'powershell.exe', commandLine: 'powershell -File agent.ps1', children: [] },
        }),
      ),
      null,
    )
  })

  it('retries until a cursor-agent child appears', () => {
    let ticks = 0
    const found = resolveOwnerPidFromChildTree(100, {
      platform: 'win32',
      timeoutMs: 1000,
      intervalMs: 1,
      now: () => {
        ticks += 1
        return ticks
      },
      sleepMs: () => {},
      processInfoOf: (pid) => {
        if (pid === 100) return { name: 'powershell.exe', commandLine: '' }
        if (pid === 200 && ticks >= 3) return { name: 'node.exe', commandLine: cursorAgentCmd }
        return null
      },
      childrenOf: (pid) => (pid === 100 && ticks >= 3 ? [200] : []),
    })
    assert.equal(found, 200)
    assert.ok(ticks >= 3)
  })

  it('POSIX spawn PID is the owner when no injectors are used', () => {
    assert.equal(resolveOwnerPidFromChildTree(4242, { platform: 'linux' }), 4242)
    assert.equal(resolveOwnerPidFromChildTree(1, { platform: 'linux' }), null)
  })

  it('walkChildTreeForDurableOwner does not pick the wrapper itself', () => {
    assert.equal(
      walkChildTreeForDurableOwner(100, {
        processInfoOf: (pid) =>
          pid === 100
            ? { name: 'powershell.exe', commandLine: '' }
            : { name: 'node.exe', commandLine: cursorAgentCmd },
        childrenOf: (pid) => (pid === 100 ? [200] : []),
      }),
      200,
    )
  })

  it('ensurePollerAfterAgentSpawn passes the descendant owner pid', () => {
    const r = ensurePollerAfterAgentSpawn('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100, {
      cwd: '/tmp',
      sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      resolveOwnerPidFromChildTree: () => 200,
      ensurePoller: (connectionId, opts) => {
        assert.equal(connectionId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        assert.equal(opts.ownerPid, 200)
        assert.equal(opts.sessionId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
        return { ok: true, pid: 999 }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.owner_pid, 200)
    assert.equal(r.pid, 999)
  })

  it('ensurePollerAfterAgentSpawn fails closed when the child tree has no owner', () => {
    const r = ensurePollerAfterAgentSpawn('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100, {
      resolveOwnerPidFromChildTree: () => null,
      ensurePoller: () => {
        throw new Error('must not spawn')
      },
    })
    assert.equal(r.ok, false)
    assert.equal(r.owner_pid, null)
    assert.match(r.error, /spawned agent tree/)
  })
})
