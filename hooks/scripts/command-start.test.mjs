import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  clearWakeListenerNeeded,
  extractRoomCommandsFromWake,
  isWakeListenerActive,
  markWakeListenerNeeded,
  startRoomCommands,
  wakeListenerInfo,
  wakeNeededPath,
} from './command-start.mjs'
import { appendWakeEvents, REMOTE_WAKE_NOTIFY_PATTERN } from './devspec-wake-file.mjs'
import { readWakes } from './devspec-wake-tail.mjs'
import { buildOwnerMessageEvents } from './devspec-remote-wait.mjs'
import { fastConnect } from './fast-connect.mjs'
import { readNoteText } from './hook-context-budget.mjs'
import { readRequestState } from './requests.mjs'
import {
  FIXTURE_ID,
  fixtureCommand,
  fixtureEnvelope,
} from './remote-ingress-test-fixtures.mjs'
import {
  holdForNextStep,
  isStepBatch,
  releaseAtIdle,
  stepDeliveryHook,
} from './step-delivery.mjs'
import { COMMAND_TURN_SENTENCES, transcriptTurnEnd } from './transcript-turn-end.mjs'
import { readTurnCommands } from './turn-commands.mjs'
import { catCall, noteFiles, noteIdIn } from '../../tests/helpers/note-reads.mjs'

const CONN = FIXTURE_ID.connection
const ROOM = '44444444-4444-4444-8444-444444444444'
const CONVERSATION = 'c5ad9955-d354-4a1e-9b1f-0d3c2a1b0e9f'
const TURN_ID = FIXTURE_ID.turn
const MSG_ID = FIXTURE_ID.message

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cmd-start-'))
  roots.push(home)
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  const localDir = path.join(home, '.devspec', 'remote-control', 'local', 'cursor')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${CONN}.json`),
    JSON.stringify({
      enabled: true,
      connection_id: CONN,
      session_id: ROOM,
      local_id: CONVERSATION,
      agent_name: 'Cursor',
      token: 'dvs_test_token',
      mcp_url: 'http://127.0.0.1:9/api/mcp',
    }),
    { mode: 0o600 },
  )
  fs.writeFileSync(
    path.join(localDir, `${CONVERSATION}.json`),
    JSON.stringify({
      status: 'live',
      connection_id: CONN,
      session_id: ROOM,
    }),
    { mode: 0o600 },
  )
  return { home, dir }
}

function ownerBatch(body = 'Please check the failing build') {
  const cmd = fixtureCommand(body)
  const envelope = fixtureEnvelope({ commands: [cmd] })
  return {
    type: 'owner_messages',
    connection_id: CONN,
    session_id: ROOM,
    received_at: new Date().toISOString(),
    count: 1,
    next_after_message_id: cmd.message_id,
    ingress: { canonical: true, envelope },
    messages: [cmd],
  }
}

describe('room-message mid-turn step delivery, honest Working pickup, and wake listener guard (item 3d327b4a)', () => {
  it('treats canonical owner_messages as a step batch and delivers them mid-turn via postToolUse, calling report_pickup only when read', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Please update the docs before ending')
    assert.equal(isStepBatch(batch), true)
    assert.equal(isStepBatch({ type: 'owner_messages', messages: [] }), false)

    const events = buildOwnerMessageEvents(batch)
    holdForNextStep(CONN, batch, events, { dir })

    const startedCalls = []
    const startCommands = async (opts) => {
      startedCalls.push(opts)
      return { ok: true, started: opts.commands, pickedUp: opts.commands.length }
    }

    // First postToolUse hands over a pointer to the sealed note; command has NOT been read yet, so no pickup!
    const raw1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: '' },
      { home, dir, startCommands, listenerActive: () => true },
    )
    assert.ok(raw1, 'stepDeliveryHook emitted a pointer')
    const ctx1 = JSON.parse(raw1).additional_context
    assert.match(ctx1, /1 room message/)
    assert.equal(startedCalls.length, 0, 'must not call startRoomCommands before the agent reads the note')

    const noteId = noteIdIn(ctx1)
    assert.ok(noteId)
    const noteText = readNoteText(noteId, { home })
    assert.match(noteText, /Please update the docs before ending/)
    assert.match(noteText, /post_session_message/)

    // Now the agent reads every part of the note; startRoomCommands runs right on completion!
    const parts = noteFiles(home, noteId)
    let lastRaw = null
    for (const part of parts) {
      lastRaw = await stepDeliveryHook(catCall(home, part, { conversation: CONVERSATION }), {
        home,
        dir,
        startCommands,
        listenerActive: () => true,
      })
    }
    assert.equal(lastRaw, null, 'pointer clears once read whole')
    assert.equal(startedCalls.length, 1, 'startRoomCommands fires once the agent reads the room message')
    assert.deepEqual(startedCalls[0].commands, [{ turnId: TURN_ID, messageId: MSG_ID }])
  })

  it('releases an unread mid-turn room message to the wake file at idle with holds:["owner_message"] matching REMOTE_WAKE_NOTIFY_PATTERN', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Are you still there?')
    const events = buildOwnerMessageEvents(batch)
    holdForNextStep(CONN, batch, events, { dir })

    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    const released = await releaseAtIdle(CONN, {
      dir,
      home,
      state: { local_id: CONVERSATION, connection_id: CONN },
      wakeFile,
      turnState: 'between',
    })
    assert.ok(released && released.pointed.length === 1)
    const wakeText = fs.readFileSync(wakeFile, 'utf8')
    assert.match(wakeText, new RegExp(REMOTE_WAKE_NOTIFY_PATTERN))
    assert.match(wakeText, /"holds":\["owner_message"\]/)
  })

  it('devspec-wake-tail read starts room commands only when read, records transcript baseline before the wake row, and is idempotent', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    const batch = ownerBatch('Run the build')
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(batch))

    // Write a realistic Cursor wake transcript where Cursor already wrote the command-turn row.
    const transcriptDir = path.join(home, '.cursor', 'projects', 'test-proj', 'agent-transcripts', CONVERSATION)
    fs.mkdirSync(transcriptDir, { recursive: true })
    const transcript = path.join(transcriptDir, `${CONVERSATION}.jsonl`)
    const wakeRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: `<timestamp>Wed, Nov 25, 2026, 6:00 PM (UTC)</timestamp>\n\n<user_query>${COMMAND_TURN_SENTENCES[0]}</user_query>` }] },
    })
    fs.writeFileSync(transcript, `${wakeRow}\n`)

    const mcpCalls = []
    let printed = ''
    await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { printed += text },
      startCommands: (opts) =>
        startRoomCommands({
          ...opts,
          call: async (req) => { mcpCalls.push(req); return { outcome: 'picked_up' } },
          seedFn: async () => {},
          ensureWatch: () => ({ started: false }),
        }),
    })

    assert.match(printed, /Run the build/)
    const pickups = mcpCalls.filter((c) => c.name === 'report_pickup')
    assert.equal(pickups.length, 1)
    assert.deepEqual(pickups[0].arguments, {
      connection_id: CONN,
      command_turn_id: TURN_ID,
      command_message_id: MSG_ID,
    })
    assert.deepEqual(readTurnCommands(CONN, { dir }), [{ turnId: TURN_ID, messageId: MSG_ID }])

    // Verify transcript baseline snapshot was taken BEFORE the wake row so turn_ended matches cleanly!
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'turn_ended', status: 'success' })}\n`)
    const marker = JSON.parse(fs.readFileSync(path.join(dir, `${CONN}.turn`), 'utf8'))
    const afterSec = (marker.startedAt + 100) / 1000
    fs.utimesSync(transcript, afterSec, afterSec)
    const observed = transcriptTurnEnd({ connectionId: CONN, marker, transcriptPath: transcript, dir })
    assert.equal(observed?.attributed, true, 'turn baseline beforeCurrentCommandTurn matches the wake turn end cleanly')

    // Re-calling startRoomCommands for the same command is idempotent (no duplicate pickup).
    const second = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      call: async (req) => { mcpCalls.push(req); return {} },
      seedFn: async () => {},
      ensureWatch: () => ({ started: false }),
    })
    assert.equal(second.duplicate, true)
    assert.equal(mcpCalls.filter((c) => c.name === 'report_pickup').length, 1)

    // Verify extractRoomCommandsFromWake works on printed wake text.
    const extracted = extractRoomCommandsFromWake(printed)
    assert.deepEqual(extracted.commands, [{ turnId: TURN_ID, messageId: MSG_ID }])
    // Request state recorded when batch was started.
    assert.ok(readRequestState(CONN, { dir }))
  })

  it('postToolUse enforces starting the wake listener until a live listener lease exists, and clears automatically once running', async () => {
    const { home, dir } = mkHome()
    markWakeListenerNeeded(CONN, dir)
    assert.equal(fs.existsSync(wakeNeededPath(CONN, dir)), true)

    // While listener is not active, postToolUse reminds the agent with the exact command and notify_on_output.
    const raw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'node remote-control-state.mjs fast-connect' }, tool_output: '{}' },
      { home, dir, listenerActive: () => false },
    )
    assert.ok(raw)
    const ctx = JSON.parse(raw).additional_context
    assert.match(ctx, /wake listener is not running/i)
    assert.match(ctx, /devspec-wake-tail\.mjs/)
    assert.match(ctx, /block_until_ms: 0/)

    // On the exact Shell call starting devspec-wake-tail.mjs, do not echo the reminder.
    const onStart = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: `node '/p/devspec-wake-tail.mjs' --file '/tmp/${CONN}.jsonl'` }, tool_output: '' },
      { home, dir, listenerActive: () => false },
    )
    assert.equal(onStart, null)

    // Once the listener is active, postToolUse clears .wake-needed and emits nothing.
    const afterLive = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: '' },
      { home, dir, listenerActive: () => true },
    )
    assert.equal(afterLive, null)
    assert.equal(fs.existsSync(wakeNeededPath(CONN, dir)), false)

    // wakeListenerInfo reports inactive/active accurately.
    const info = wakeListenerInfo(CONN, { wakeFile: path.join(home, `${CONN}.jsonl`), dir, isAlive: () => false })
    assert.equal(info.active, false)
    assert.match(info.start, /devspec-wake-tail\.mjs/)
    assert.equal(info.notify_on_output.pattern, REMOTE_WAKE_NOTIFY_PATTERN)
    clearWakeListenerNeeded(CONN, dir)
    assert.equal(isWakeListenerActive(CONN, { wakeFile: path.join(home, `${CONN}.jsonl`), dir, isAlive: () => false }), false)
  })

  it('fastConnect reports wake_follow_failed at connect time when wake-follow cannot start, and returns wake_listener on success', async () => {
    const projectHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-fc-wake-'))
    roots.push(projectHome)
    const projectId = '11111111-1111-4111-8111-111111111111'
    const baseOpts = {
      localId: CONVERSATION,
      cwd: process.cwd(),
      ownerPid: process.pid,
      projectId,
      projectHome,
      resolveAuth: () => ({ ok: true, token: 'dvs_test', mcp_url: 'https://api.devspec.ai/api/mcp', source: 'test' }),
      resolveGitRemoteFn: () => 'https://github.com/DevSpecAI/cursor-devspec-plugin.git',
      resolveLocalFn: () => ({ ok: true, action: 'register', connection_id: null, session_id: null }),
      detectLocalIdFn: () => ({ local_id: CONVERSATION, source: 'arg' }),
      registerFn: async () => ({
        ok: true,
        connection_id: CONN,
        codename: 'Swift Fox',
        project_id: projectId,
        created: true,
      }),
      emitPhase: async () => {},
    }

    const failed = await fastConnect({
      ...baseOpts,
      writeFn: async () => ({
        ok: true,
        connection_id: CONN,
        session_codename: 'Swift Fox',
        mcp_url: 'https://api.devspec.ai/api/mcp',
        auth_ok: true,
        poller: { ok: true, pid: 100 },
        wake_follow: {
          ok: false,
          code: 'wake_follow_lock_busy',
          retryable: true,
          lock_wait_ms: 2_000,
          error: 'wake-follow startup lock busy; retry shortly',
        },
      }),
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'wake_follow_lock_busy', 'must preserve structured lock refusal code instead of overwriting it')
    assert.equal(failed.lock_wait_ms, 2_000)
    assert.equal(failed.retryable, true)
    assert.equal(failed.wake_follow.lock_wait_ms, 2_000)
    assert.match(failed.error, /lock busy/)

    const ok = await fastConnect({
      ...baseOpts,
      writeFn: async () => ({
        ok: true,
        connection_id: CONN,
        session_codename: 'Swift Fox',
        mcp_url: 'https://api.devspec.ai/api/mcp',
        auth_ok: true,
        poller: { ok: true, pid: 100 },
        wake_follow: { ok: true, pid: 101, wake_file: `/tmp/${CONN}.jsonl` },
        wake_listener: {
          active: false,
          wake_file: `/tmp/${CONN}.jsonl`,
          follow_pid: 101,
          start: `node '/p/devspec-wake-tail.mjs' --file '/tmp/${CONN}.jsonl'`,
          notify_on_output: { pattern: REMOTE_WAKE_NOTIFY_PATTERN, reason: 'DevSpec wakes' },
        },
      }),
    })
    assert.equal(ok.ok, true)
    assert.equal(ok.wake_listener.active, false)
    assert.equal(ok.wake_listener.follow_pid, 101)
  })

  it('does not mark command started when report_pickup refuses or throws, preserves structured refusal, and retries on next call', async () => {
    const { home, dir } = mkHome()
    const logs = []
    let calls = 0

    const first = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      call: async () => {
        calls += 1
        return { ok: false, status: 'refused', code: 'turn_busy', blocking_turn_id: '99999999-9999-4999-8999-999999999999' }
      },
      seedFn: async () => {},
      ensureWatch: () => ({ started: false }),
      log: (line) => logs.push(line),
    })
    assert.equal(first.ok, false)
    assert.equal(first.pickedUp, 0)
    assert.equal(first.started.length, 0)
    assert.equal(first.refusals.length, 1)
    assert.equal(first.refusals[0].refusal.code, 'turn_busy')
    assert.equal(first.refusals[0].refusal.blocking_turn_id, '99999999-9999-4999-8999-999999999999')

    const second = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      call: async () => {
        calls += 1
        throw Object.assign(new Error('Refused'), { code: 'connection_busy', retryable: true, details: { wait_ms: 500 } })
      },
      seedFn: async () => {},
      ensureWatch: () => ({ started: false }),
      log: (line) => logs.push(line),
    })
    assert.equal(second.ok, false)
    assert.equal(second.duplicate, undefined)
    assert.equal(second.refusals[0].refusal.code, 'connection_busy')
    assert.equal(second.refusals[0].refusal.retryable, true)
    assert.deepEqual(second.refusals[0].refusal.details, { wait_ms: 500 })

    const third = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      call: async () => {
        calls += 1
        return { outcome: 'picked_up' }
      },
      seedFn: async () => {},
      ensureWatch: () => ({ started: false }),
      log: (line) => logs.push(line),
    })
    assert.equal(third.ok, true)
    assert.equal(third.pickedUp, 1)
    assert.equal(calls, 3)
    assert.equal(logs.length, 2)
  })

  it('hands over an over-budget wake-listener reminder as a sealed note rather than slicing the command', async () => {
    const { home, dir } = mkHome()
    markWakeListenerNeeded(CONN, dir)
    const raw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: '' },
      { home, dir, share: 200, listenerActive: () => false },
    )
    assert.ok(raw)
    const ctx = JSON.parse(raw).additional_context
    const noteId = noteIdIn(ctx)
    assert.ok(noteId, 'over-budget reminder must go to a note instead of being sliced')
    const full = readNoteText(noteId, { home })
    assert.match(full, /devspec-wake-tail\.mjs/)
    assert.match(full, /block_until_ms: 0/)
  })

  it('finishes a stale abandoned turn with one single report_complete call rather than looping per saved command', async () => {
    const { home, dir } = mkHome()
    fs.writeFileSync(path.join(dir, `${CONN}.turn`), JSON.stringify({ startedAt: Date.now() - 120_000, connection_id: CONN }))
    fs.writeFileSync(
      path.join(dir, `${CONN}.turn-commands.json`),
      JSON.stringify({
        version: 1,
        commands: [
          { turn_id: '11111111-1111-4111-8111-111111111111', message_id: '22222222-2222-4222-8222-222222222222' },
          { turn_id: '33333333-3333-4333-8333-333333333333', message_id: '44444444-4444-4444-8444-444444444444' },
        ],
      }),
    )
    const completeCalls = []
    const res = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      call: async (req) => {
        if (req.name === 'report_complete') completeCalls.push(req.arguments)
        return { outcome: 'picked_up' }
      },
      seedFn: async () => {},
      ensureWatch: () => ({ started: false }),
    })
    assert.equal(res.ok, true)
    assert.equal(completeCalls.length, 1, 'stale turn cleanup must issue one single attempt-end report_complete call')
    assert.deepEqual(completeCalls[0], { connection_id: CONN, reason: 'max_turn_ms' })
  })

  it('enforces one shared wall-clock budget across stale report_complete, report_pickup, and seedWorkTrailForConnection', async () => {
    const { home, dir } = mkHome()
    let clock = 1_000_000
    fs.writeFileSync(path.join(dir, `${CONN}.turn`), JSON.stringify({ startedAt: clock - 120_000, connection_id: CONN }))
    const seenTimeouts = []
    const res = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      timeoutMs: 12_000,
      now: () => clock,
      call: async (req) => {
        seenTimeouts.push({ name: req.name, timeoutMs: req.timeoutMs })
        clock += 5_000
        return { outcome: 'picked_up' }
      },
      seedFn: async (opts) => {
        seenTimeouts.push({ name: 'seed', timeoutMs: opts.timeoutMs })
      },
      ensureWatch: () => ({ started: false }),
    })
    assert.equal(res.ok, true)
    assert.deepEqual(seenTimeouts, [
      { name: 'report_complete', timeoutMs: 12_000 },
      { name: 'report_pickup', timeoutMs: 7_000 },
      { name: 'seed', timeoutMs: 2_000 },
    ])
  })

  it('issues one single report_pickup call when multiple commands arrive together and only marks the picked-up command started so older waiting commands can still be picked up by name (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const pickups = []
    const cmd1 = { turnId: '11111111-1111-4111-8111-111111111111', messageId: '22222222-2222-4222-8222-222222222222' }
    const cmd2 = { turnId: TURN_ID, messageId: MSG_ID }
    const res = await startRoomCommands({
      connectionId: CONN,
      commands: [cmd1, cmd2],
      dir,
      home,
      call: async (req) => {
        if (req.name === 'report_pickup') pickups.push(req.arguments)
        return { outcome: 'picked_up' }
      },
      seedFn: async () => {},
      ensureWatch: () => ({ started: false }),
    })
    assert.equal(res.ok, true)
    assert.equal(pickups.length, 1, 'must not loop report_pickup once per command')
    assert.equal(pickups[0].command_message_id, MSG_ID)
    assert.deepEqual(res.started, [cmd2], 'only the picked-up command may be recorded as started')
    assert.deepEqual(res.unstarted, [cmd1])

    // Older still-waiting command was NOT marked started and can still be picked up by name later.
    const second = await startRoomCommands({
      connectionId: CONN,
      commands: [cmd1],
      dir,
      home,
      call: async (req) => {
        if (req.name === 'report_pickup') pickups.push(req.arguments)
        return { outcome: 'picked_up' }
      },
      seedFn: async () => {},
      ensureWatch: () => ({ started: false }),
    })
    assert.equal(second.ok, true)
    assert.equal(second.duplicate, undefined)
    assert.equal(pickups.length, 2)
    assert.equal(pickups[1].command_message_id, cmd1.messageId)
  })

  it('keeps readWakes combined stdout + stderr within fitsShellOutput by saving oversized pickup diagnostics to a sealed note (3c5147a7 / 91d7b47c)', async () => {
    const { fitsShellOutput } = await import('./hook-context-budget.mjs')
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    // Multiple wakes pushing stdout near the Shell ceiling (~18,500 chars) plus a refusal
    // payload that would push combined stdout + stderr past CURSOR_SHELL_OUTPUT_MAX_CHARS.
    for (let i = 0; i < 6; i += 1) {
      const batch = ownerBatch(`Near-limit wake ${i}: ${'W'.repeat(450)}`)
      const events = buildOwnerMessageEvents(batch)
      events[0].padding = 'P'.repeat(2_200)
      appendWakeEvents(wakeFile, events)
    }
    let stdout = ''
    let stderr = ''
    const res = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { stdout += text },
      writeStderr: (text) => { stderr += text },
      startCommands: async () => ({
        ok: false,
        outcome: 'refused',
        refusals: [{ code: 'turn_busy', detail: 'D'.repeat(6_000) }],
      }),
    })
    assert.equal(res.marked, false)
    assert.ok(stdout.length > 15_000, `expected near-limit stdout page, got ${stdout.length}`)
    assert.equal(fitsShellOutput(stdout + stderr), true, `combined stdout + stderr (${stdout.length + stderr.length} chars) must fit Cursor Shell ceiling`)
    assert.ok(res.pickup_diagnostic_note?.id, 'oversized pickup refusal must be saved whole to a sealed note')
    assert.match(stderr, new RegExp(res.pickup_diagnostic_note.id))
    const saved = readNoteText(res.pickup_diagnostic_note.id, { home })
    assert.match(saved, /turn_busy/)
    assert.match(saved, /D{100}/)
  })

  it('reclaims a stale wake-follow lock safely without unlinking a live replacement lock (2df26cd2)', async () => {
    const { withWakeFollowLock } = await import('./remote-control-state.mjs')
    const { dir } = mkHome()
    const lockFile = path.join(dir, `${CONN}.follow.lock`)
    // Write a stale lock owned by a dead PID.
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 999_999, token: 'deadbeef00001111' })}\n`, { mode: 0o600 })
    let entered = 0
    const res = withWakeFollowLock(
      CONN,
      fs,
      () => {
        entered += 1
        // Verify our live lock holds our PID and a fresh token while inside the critical section.
        const active = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
        assert.equal(active.pid, process.pid)
        assert.notEqual(active.token, 'deadbeef00001111')
        return { ok: true }
      },
      { dir },
    )
    assert.deepEqual(res, { ok: true })
    assert.equal(entered, 1)
    assert.equal(fs.existsSync(lockFile), false, 'lock released cleanly after work')
  })

  it('preserves nothing_open from report_pickup without marking a turn started or seeding a trail', async () => {
    const { home, dir } = mkHome()
    let seeded = false
    const res = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      call: async () => ({ ok: true, attempt_id: null, outcome: 'nothing_open' }),
      seedFn: async () => { seeded = true },
      ensureWatch: () => ({ started: false }),
      log: () => {},
    })
    assert.equal(res.ok, false)
    assert.equal(res.outcome, 'nothing_open')
    assert.equal(res.pickedUp, 0)
    assert.equal(res.nothingOpen.length, 1)
    assert.equal(res.nothingOpen[0].response.outcome, 'nothing_open')
    assert.equal(seeded, false)
    assert.equal(fs.existsSync(path.join(dir, `${CONN}.turn`)), false)
  })

  it('readWakes does not advance read position on a retryable pickup refusal and retries on the second read', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Retry this wake')))
    let attempts = 0
    const call = async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('Try again'), { code: 'connection_busy', retryable: true, details: { retry_after_ms: 250 } })
      }
      return { outcome: 'picked_up' }
    }
    let firstOut = ''
    const first = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { firstOut += text },
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }), log: () => {} }),
    })
    assert.equal(first.marked, false)
    assert.equal(first.pickup_refusals[0].refusal.code, 'connection_busy')
    assert.equal(first.pickup_refusals[0].refusal.retryable, true)
    assert.match(firstOut, /Retry this wake/)

    let secondOut = ''
    const second = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { secondOut += text },
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }), log: () => {} }),
    })
    assert.equal(second.marked, true)
    assert.match(secondOut, /Retry this wake/)
    assert.equal(attempts, 2)
  })

  it('stepDeliveryHook retains pending pickup on refusal, surfaces structured details, and retries on the next step', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Mid-turn retry test')
    holdForNextStep(CONN, batch, buildOwnerMessageEvents(batch), { dir })
    const raw1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: '' },
      { home, dir, listenerActive: () => true },
    )
    const noteId = noteIdIn(JSON.parse(raw1).additional_context)
    const parts = noteFiles(home, noteId)

    let attempts = 0
    const startCommands = async (opts) => {
      attempts += 1
      if (attempts === 1) {
        return {
          ok: false,
          outcome: 'refused',
          started: [],
          pickedUp: 0,
          refusals: [{ command_message_id: MSG_ID, command_turn_id: TURN_ID, refusal: { code: 'turn_busy', retryable: true, blocking_turn_id: '99999999-9999-4999-8999-999999999999' } }],
        }
      }
      return { ok: true, outcome: 'picked_up', started: opts.commands, pickedUp: 1 }
    }

    let refusalRaw = null
    for (const part of parts) {
      refusalRaw = await stepDeliveryHook(catCall(home, part, { conversation: CONVERSATION }), {
        home,
        dir,
        startCommands,
        listenerActive: () => true,
      })
    }
    assert.equal(attempts, 1)
    assert.ok(refusalRaw, 'structured refusal must be surfaced')
    assert.match(JSON.parse(refusalRaw).additional_context, /turn_busy/)
    assert.match(JSON.parse(refusalRaw).additional_context, /99999999-9999-4999-8999-999999999999/)

    // Next step retries pickup and clears the handed record once pickup succeeds.
    const retryRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'pwd' }, tool_output: '' },
      { home, dir, startCommands, listenerActive: () => true },
    )
    assert.equal(attempts, 2)
    assert.equal(retryRaw, null)
  })
})
