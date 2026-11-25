import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import {
  buildOwnerMessageEvents,
  planOneShot,
  printedRoomCommands,
  printOneShot,
  runOneShotRoomCommandPickup,
} from './devspec-remote-wait.mjs'
import { fastConnect } from './fast-connect.mjs'
import { fitsShellOutput, readNoteText, shellDiagnosticReserve, wakeInNote } from './hook-context-budget.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { ensureWakeFollowForConnection, withWakeFollowLock } from './remote-control-state.mjs'
import { readRequestState } from './requests.mjs'
import {
  FIXTURE_ID,
  fixtureCommand,
  fixtureEnvelope,
} from './remote-ingress-test-fixtures.mjs'
import { canonicalAcceptanceKey } from './remote-ingress-v1.mjs'
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

function ownerBatch(body = 'Please check the failing build', { messageId = null, turnId = null } = {}) {
  const cmd = fixtureCommand(body)
  if (messageId) {
    cmd.message_id = messageId
    cmd.order = { ...cmd.order, message_id: messageId }
  }
  if (turnId) {
    cmd.delivery = { ...cmd.delivery, turn_id: turnId }
  }
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

  it('stepDeliveryHook preserves structured pickup refusal alongside a concurrent delivery note even under a tight share (4e32d1a5)', async () => {
    const { home, dir } = mkHome()
    const batch1 = ownerBatch('First mid-turn room message')
    holdForNextStep(CONN, batch1, buildOwnerMessageEvents(batch1), { dir })
    const raw1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: '' },
      { home, dir, listenerActive: () => true },
    )
    const noteId = noteIdIn(JSON.parse(raw1).additional_context)
    const parts = noteFiles(home, noteId)

    // Queue a second concurrent delivery right before the agent finishes reading the first note.
    const msg2 = '33333333-3333-4333-8333-333333333344'
    const turn2 = '77777777-7777-4777-8777-777777777744'
    const batch2 = ownerBatch('Concurrent second room message', { messageId: msg2, turnId: turn2 })
    holdForNextStep(CONN, batch2, buildOwnerMessageEvents(batch2), { dir })

    const startCommands = async () => ({
      ok: false,
      outcome: 'refused',
      started: [],
      pickedUp: 0,
      refusals: [
        {
          command_message_id: MSG_ID,
          command_turn_id: TURN_ID,
          refusal: {
            code: 'turn_busy',
            retryable: true,
            blocking_turn_id: '88888888-8888-4888-8888-888888888888',
            detail: 'x'.repeat(600),
          },
        },
      ],
    })

    // Tight share big enough for a note pointer (~350 chars) but NOT both pointers inline.
    const tightShare = 420
    let refusalRaw = null
    for (const part of parts) {
      refusalRaw = await stepDeliveryHook(catCall(home, part, { conversation: CONVERSATION }), {
        home,
        dir,
        share: tightShare,
        startCommands,
        listenerActive: () => true,
      })
    }
    assert.ok(refusalRaw)
    const ctx = JSON.parse(refusalRaw).additional_context
    assert.ok(ctx.length <= tightShare, `additional_context (${ctx.length}) must stay within share (${tightShare})`)
    const combinedNoteId = noteIdIn(ctx)
    assert.ok(combinedNoteId, 'combined delivery + refusal must point to a sealed note')
    const saved = readNoteText(combinedNoteId, { home })
    assert.match(saved, /turn_busy/)
    assert.match(saved, /88888888-8888-4888-8888-888888888888/)
    assert.match(saved, /notes\/[0-9a-f]{16}\.md/, 'concurrent delivery note pointer must also be preserved')
  })

  it('readWakes captures startRoomCommands internal logs so near-limit stdout + stderr never crosses fitsShellOutput (3c5147a7 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes.jsonl`)
    for (let i = 0; i < 6; i += 1) {
      const mId = `33333333-3333-4333-8333-33333333335${i}`
      const tId = `77777777-7777-4777-8777-77777777775${i}`
      const b = ownerBatch(`near-limit-${i} ${'z'.repeat(450)}`, { messageId: mId, turnId: tId })
      appendWakeEvents(wakeFile, buildOwnerMessageEvents(b))
    }
    const bigRefusal = {
      ok: false,
      code: 'pickup_conflict',
      retryable: true,
      error: 'refused with large payload',
      detail: 'd'.repeat(6000),
    }
    let stdout = ''
    let stderr = ''
    let leakedRawStderr = ''
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk) => {
      leakedRawStderr += String(chunk)
      return true
    }
    let result
    try {
      result = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home,
        dir,
        settleMs: 10,
        write: async (text) => { stdout += text },
        writeStderr: (text) => { stderr += text },
        // Deliberately do NOT override opts.log so readWakes's own capture is exercised!
        startCommands: (opts) =>
          startRoomCommands({
            ...opts,
            call: async () => bigRefusal,
            seedFn: async () => {},
            ensureWatch: () => ({ started: false }),
          }),
      })
    } finally {
      process.stderr.write = origWrite
    }
    assert.equal(leakedRawStderr, '', 'command-start must not bypass readWakes by writing raw stderr directly')
    assert.equal(result.marked, false)
    assert.ok(fitsShellOutput(stdout + stderr), `combined stdout+stderr (${(stdout + stderr).length}) must fit fitsShellOutput`)
    assert.ok(result.pickup_diagnostic_note?.id)
    const saved = readNoteText(result.pickup_diagnostic_note.id, { home })
    assert.match(saved, /pickup_conflict/)
    assert.match(saved, /d{100}/)
  })

  it('one-shot printOneShot + runOneShotRoomCommandPickup only picks up printed wakes and bounds refusal stderr (3ea2b201 / 3c5147a7 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const msg1 = '33333333-3333-4333-8333-333333333361'
    const turn1 = '77777777-7777-4777-8777-777777777761'
    const msg2 = '33333333-3333-4333-8333-333333333362'
    const turn2 = '77777777-7777-4777-8777-777777777762'
    const wake1 = buildOwnerMessageEvents(ownerBatch('Printed wake ' + 'a'.repeat(400), { messageId: msg1, turnId: turn1 }))
    // Add padding events so wake1 + wake2 exceed 20,000 chars and split into two pages.
    const padWake = [
      ...wake1,
      { type: 'context', body: 'p'.repeat(12_000) },
    ]
    const wake2 = [
      ...buildOwnerMessageEvents(ownerBatch('Remainder wake ' + 'b'.repeat(400), { messageId: msg2, turnId: turn2 })),
      { type: 'context', body: 'q'.repeat(12_000) },
    ]
    let stdout = ''
    const shot = await printOneShot([padWake, wake2], {
      reserve: shellDiagnosticReserve('devspec-remote-wait'),
      home,
      write: async (text) => { stdout += text },
    })
    assert.equal(shot.count, 1, 'second wake must remain in the unprinted remainder')
    const extracted = printedRoomCommands(shot.printedWakes, ROOM)
    assert.deepEqual(
      extracted.commands.map((c) => c.messageId),
      [msg1],
      'must select only the printed command, never the unprinted remainder',
    )

    const pickedUpArgs = []
    let stderr = ''
    const pickup = await runOneShotRoomCommandPickup({
      connectionId: CONN,
      printedWakes: shot.printedWakes,
      printedStdout: shot.text,
      fallbackSessionId: ROOM,
      dir,
      home,
      writeStderr: (text) => { stderr += text },
      startCommands: (opts) =>
        startRoomCommands({
          ...opts,
          call: async (req) => {
            pickedUpArgs.push(req.arguments)
            return {
              ok: false,
              code: 'one_shot_refused',
              retryable: true,
              error: 'refused',
              detail: 'r'.repeat(9000),
            }
          },
          seedFn: async () => {},
          ensureWatch: () => ({ started: false }),
        }),
    })
    assert.equal(pickup.ok, false, 'pickup refusal must fail so one-shot wait leaves offset untouched and exits non-zero')
    assert.equal(pickedUpArgs.length, 1)
    assert.equal(pickedUpArgs[0].command_message_id, msg1)
    assert.ok(fitsShellOutput(stdout + stderr), `one-shot stdout+stderr (${(stdout + stderr).length}) must fit fitsShellOutput`)
    assert.ok(pickup.diagnosticNote?.id)
    const saved = readNoteText(pickup.diagnosticNote.id, { home })
    assert.match(saved, /one_shot_refused/)
    assert.match(saved, /r{100}/)
  })

  it('withWakeFollowLock chains past a dead reclaim guard without unlinking live guards (2df26cd2)', () => {
    const { dir } = mkHome()
    const lockFile = path.join(dir, `${CONN}.follow.lock`)
    // Chain 20 dead reclaim guards (>16) to prove recovery never permanently wedges.
    let currToken = 'aaaa0000aaaa0000'
    fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 999999999, token: currToken })}\n`, { mode: 0o600 })
    const deadFiles = []
    for (let i = 1; i <= 20; i += 1) {
      const nextToken = `bbbb${String(i).padStart(4, '0')}bbbb${String(i).padStart(4, '0')}`
      const guardFile = `${lockFile}.reclaim.${currToken}`
      fs.writeFileSync(guardFile, `${JSON.stringify({ pid: 999999900 + i, token: nextToken })}\n`, { mode: 0o600 })
      deadFiles.push(guardFile)
      currToken = nextToken
    }

    let ran = false
    const res = withWakeFollowLock(
      CONN,
      fs,
      () => {
        ran = true
        for (const f of deadFiles) {
          assert.equal(fs.existsSync(f), false, `dead predecessor ${path.basename(f)} must be cleaned up`)
        }
        return { ok: true }
      },
      { dir },
    )
    assert.equal(ran, true)
    assert.equal(res.ok, true)
    assert.equal(fs.existsSync(lockFile), false)
  })

  it('preserves JSON-RPC error code and structured data from mcpToolsCall through startRoomCommands (4e32d1a5)', async () => {
    const { dir } = mkHome()
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: -32042,
              message: 'Pickup refused.',
              data: { code: 'attempt_active', blocking_attempt_id: '88888888-8888-4888-8888-888888888888' },
            },
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const result = await startRoomCommands({
        connectionId: CONN,
        commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
        sessionId: ROOM,
        dir,
        state: {
          connection_id: CONN,
          session_id: ROOM,
          token: 'dvs_test',
          mcp_url: `http://127.0.0.1:${port}/api/mcp`,
        },
        call: mcpToolsCall,
        seedFn: async () => {},
        ensureWatch: () => ({ started: false }),
        log: () => {},
      })
      assert.equal(result.ok, false)
      assert.equal(result.refusals.length, 1)
      assert.equal(result.refusals[0].refusal.code, -32042)
      assert.equal(result.refusals[0].refusal.data?.code, 'attempt_active')
      assert.equal(
        result.refusals[0].refusal.data?.blocking_attempt_id,
        '88888888-8888-4888-8888-888888888888',
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('defers pickup and wake cursor advance for oversized wake_in_note commands until the agent reads the sealed note whole (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Huge command ' + 'h'.repeat(21_000))
    const built = buildOwnerMessageEvents(batch)
    const wrapped = wakeInNote(built, { home })
    assert.equal(wrapped.events[0].type, 'wake_in_note')
    assert.ok(wrapped.events[0].carries.includes('owner_message'))

    // 1. readWakes prints only the pointer, calls startCommands 0 times, and does NOT advance
    // the read cursor before the agent reads the note body whole.
    const wakeFile = path.join(dir, `${CONN}.wakes.jsonl`)
    appendWakeEvents(wakeFile, wrapped.events)
    let wakePickupCalls = 0
    let firstOut = ''
    const firstRead = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { firstOut = text },
      writeStderr: () => {},
      startCommands: async () => {
        wakePickupCalls += 1
        return { ok: true }
      },
    })
    assert.equal(wakePickupCalls, 0, 'must not call report_pickup while only the wake_in_note pointer was printed')
    assert.equal(firstRead.marked, false, 'must not advance wake position before agent reads the note body')
    assert.equal(firstRead.pending_note_reads?.length, 1)
    assert.match(firstOut, /"type":"wake_in_note"/)

    // A second readWakes before the agent reads the note STILL returns the wake pointer (not 0 wakes).
    let secondOut = ''
    const secondRead = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { secondOut = text },
      writeStderr: () => {},
      startCommands: async () => {
        wakePickupCalls += 1
        return { ok: true }
      },
    })
    assert.equal(wakePickupCalls, 0)
    assert.equal(secondRead.printed, 1, 'unread note-backed wake must remain visible on retry read')
    assert.match(secondOut, /"type":"wake_in_note"/)

    // 2. Once the agent reads every part of the sealed note whole, stepDeliveryHook triggers
    // report_pickup ONCE and advances the wake read cursor so the next read returns 0 wakes.
    const noteId = firstRead.pending_note_reads[0]
    const picked = []
    for (const file of noteFiles(home, noteId)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        startCommands: (opts) =>
          startRoomCommands({
            ...opts,
            call: async (req) => {
              picked.push(req.arguments.command_message_id)
              return { outcome: 'picked_up' }
            },
            seedFn: async () => {},
            ensureWatch: () => ({ started: false }),
          }),
      })
    }
    assert.deepEqual(picked, [MSG_ID], 'report_pickup runs once the agent finishes reading the note whole')

    const thirdRead = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
    })
    assert.equal(thirdRead.printed, 0, 'after full note read + pickup, wake cursor has advanced')
  })

  it('one-shot CLI wait counts startup stderr in combined stdout + stderr Shell ceiling on near-limit wake with pickup refusal (3c5147a7 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({ ok: false, code: 'busy_refusal', retryable: true, error: 'Refused', detail: 'x'.repeat(2000) }),
              }],
            },
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    fs.writeFileSync(
      path.join(dir, `${CONN}.json`),
      JSON.stringify({
        enabled: true,
        connection_id: CONN,
        session_id: ROOM,
        local_id: CONVERSATION,
        agent_name: 'Cursor',
        token: 'dvs_test',
        mcp_url: `http://127.0.0.1:${port}/api/mcp`,
      }),
      { mode: 0o600 },
    )
    const batch = ownerBatch('Near limit body ' + 'm'.repeat(8_800))
    batch.acceptance_key = canonicalAcceptanceKey(batch.ingress.envelope)
    const inbox = path.join(dir, `${CONN}.inbox.jsonl`)
    fs.writeFileSync(inbox, `${JSON.stringify(batch)}\n`, { mode: 0o600 })
    const script = fileURLToPath(new URL('./devspec-remote-wait.mjs', import.meta.url))
    try {
      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [script, '--connection-id', CONN, '--pending', '--poll-ms', '20'],
          { env: { ...process.env, HOME: home, DEVSPEC_REMOTE_CONNECTIONS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => { stdout += c.toString() })
        child.stderr.on('data', (c) => { stderr += c.toString() })
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')) }, 15_000)
        child.on('error', (e) => { clearTimeout(timer); reject(e) })
        child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
      })
      assert.equal(code, 1)
      assert.equal(stdout, '', 'stdout stays empty when pickup refuses so refusal diagnostic gets the full Shell budget')
      assert.match(stderr, /busy_refusal/)
      assert.ok(
        fitsShellOutput(stdout + stderr),
        `combined stdout (${stdout.length}) + stderr (${stderr.length}) = ${(stdout + stderr).length} must fit fitsShellOutput`,
      )
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, `${CONN}.json`), 'utf8'))
      assert.equal(persisted.inbox_byte_offset ?? 0, 0, 'inbox offset must not advance on pickup refusal')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('one-shot CLI wait keeps combined stdout + stderr within fitsShellOutput when near-limit wake gets a non-fatal nothing_open diagnostic (3c5147a7 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({ outcome: 'nothing_open', reason: 'already_closed', detail: 'y'.repeat(500) }),
              }],
            },
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    fs.writeFileSync(
      path.join(dir, `${CONN}.json`),
      JSON.stringify({
        enabled: true,
        connection_id: CONN,
        session_id: ROOM,
        local_id: CONVERSATION,
        agent_name: 'Cursor',
        token: 'dvs_test',
        mcp_url: `http://127.0.0.1:${port}/api/mcp`,
      }),
      { mode: 0o600 },
    )
    const batch = ownerBatch('Near limit nothing_open ' + 'm'.repeat(8_900))
    batch.acceptance_key = canonicalAcceptanceKey(batch.ingress.envelope)
    const inbox = path.join(dir, `${CONN}.inbox.jsonl`)
    fs.writeFileSync(inbox, `${JSON.stringify(batch)}\n`, { mode: 0o600 })
    const script = fileURLToPath(new URL('./devspec-remote-wait.mjs', import.meta.url))
    try {
      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [script, '--connection-id', CONN, '--pending', '--poll-ms', '20'],
          { env: { ...process.env, HOME: home, DEVSPEC_REMOTE_CONNECTIONS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => { stdout += c.toString() })
        child.stderr.on('data', (c) => { stderr += c.toString() })
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')) }, 15_000)
        child.on('error', (e) => { clearTimeout(timer); reject(e) })
        child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
      })
      assert.equal(code, 0, stderr)
      assert.match(stderr, /nothing_open/)
      assert.ok(stdout.length > 0, 'wake is still delivered via sealed note or inline')
      assert.ok(
        fitsShellOutput(stdout + stderr),
        `combined stdout (${stdout.length}) + stderr (${stderr.length}) = ${(stdout + stderr).length} must fit fitsShellOutput`,
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('ensureWakeFollowForConnection kills spawned child when PID file write fails (2df26cd2)', () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, 'wake.jsonl')
    const connId = '22222222-2222-4222-8222-222222222299'
    const killedSignals = []
    const fakeIo = {
      ...fs,
      writeFileSync: (filePath, data, opts) => {
        if (String(filePath).endsWith('.wake-follow.pid')) {
          throw Object.assign(new Error('EACCES: cannot write pid'), { code: 'EACCES' })
        }
        return fs.writeFileSync(filePath, data, opts)
      },
    }
    const res = ensureWakeFollowForConnection(connId, {
      wakeFile,
      ownerPid: process.pid,
      resolveOwnerPid: () => process.pid,
      findPid: () => null,
      io: fakeIo,
      spawn: () => ({
        pid: 987654,
        unref: () => {},
        kill: (sig) => killedSignals.push(sig),
      }),
    })
    assert.equal(res.ok, false)
    assert.equal(res.killed_orphan, true)
    assert.deepEqual(killedSignals, ['SIGTERM'])
  })

  it('does not advance wake position or mark read when a wake_in_note carrying owner_message is missing or unreadable (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes.jsonl`)
    const missingPointer = [{
      type: 'wake_in_note',
      carries: ['owner_message'],
      read: 'cat ~/.devspec/notes/deadbeef12345678.md',
      note: 'Command stored in note.',
    }]
    appendWakeEvents(wakeFile, missingPointer)
    let startCalls = 0
    const stderrChunks = []
    const readRes = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: (t) => stderrChunks.push(t),
      startCommands: async () => {
        startCalls += 1
        return { ok: true }
      },
    })
    assert.equal(readRes.marked, false, 'must not advance wake position when command note is missing')
    assert.equal(startCalls, 0)
    assert.equal(readRes.pickup_refusals?.[0]?.refusal?.code, 'unreadable_command_note')
    assert.match(stderrChunks.join(''), /unreadable_command_note/)

    // Same guarantee for one-shot runOneShotRoomCommandPickup
    const oneShotStderr = []
    const pickup = await runOneShotRoomCommandPickup({
      connectionId: CONN,
      printedWakes: [missingPointer],
      printedStdout: '',
      dir,
      home,
      writeStderr: (t) => oneShotStderr.push(t),
    })
    assert.equal(pickup.ok, false)
    assert.equal(pickup.refusals?.[0]?.refusal?.code, 'unreadable_command_note')
    assert.match(oneShotStderr.join(''), /unreadable_command_note/)
  })

  it('caps repeated one-shot holding-wake retry stderr so combined output stays within fitsShellOutput and still surfaces eventual pickup refusal (3c5147a7 / 91d7b47c / 4e32d1a5)', async () => {
    const { home, dir } = mkHome()
    const notesPath = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(notesPath), { recursive: true })
    // Block note creation transiently by placing a regular file where the notes dir belongs.
    fs.writeFileSync(notesPath, 'blocked')
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  code: 'turn_busy_after_hold',
                  blocking_attempt_id: '99999999-9999-4999-8999-999999999999',
                  error: 'Active turn owns Working',
                }),
              }],
            },
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    fs.writeFileSync(
      path.join(dir, `${CONN}.json`),
      JSON.stringify({
        enabled: true,
        connection_id: CONN,
        session_id: ROOM,
        local_id: CONVERSATION,
        agent_name: 'Cursor',
        token: 'dvs_test',
        mcp_url: `http://127.0.0.1:${port}/api/mcp`,
      }),
      { mode: 0o600 },
    )
    const batch = ownerBatch('Oversized held body ' + 'h'.repeat(21_000))
    batch.acceptance_key = canonicalAcceptanceKey(batch.ingress.envelope)
    fs.writeFileSync(path.join(dir, `${CONN}.inbox.jsonl`), `${JSON.stringify(batch)}\n`, { mode: 0o600 })
    const script = fileURLToPath(new URL('./devspec-remote-wait.mjs', import.meta.url))
    try {
      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [script, '--connection-id', CONN, '--pending', '--poll-ms', '5'],
          { env: { ...process.env, HOME: home, DEVSPEC_REMOTE_CONNECTIONS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let stdout = ''
        let stderr = ''
        let unblocked = false
        child.stdout.on('data', (c) => { stdout += c.toString() })
        child.stderr.on('data', (c) => {
          stderr += c.toString()
          if (!unblocked && stderr.includes('further retry warnings suppressed')) {
            unblocked = true
            fs.rmSync(notesPath, { force: true })
          }
        })
        const fallbackUnblock = setTimeout(() => {
          if (!unblocked) {
            unblocked = true
            fs.rmSync(notesPath, { force: true })
          }
        }, 3000)
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')) }, 15_000)
        child.on('error', (e) => { clearTimeout(timer); clearTimeout(fallbackUnblock); reject(e) })
        child.on('close', (code) => { clearTimeout(timer); clearTimeout(fallbackUnblock); resolve({ stdout, stderr, code }) })
      })
      assert.equal(code, 0)
      assert.match(stderr, /further retry warnings suppressed/)
      assert.ok(
        fitsShellOutput(stdout + stderr),
        `combined stdout (${stdout.length}) + stderr (${stderr.length}) = ${(stdout + stderr).length} must fit fitsShellOutput`,
      )
      assert.match(stdout, /"type":"wake_in_note"/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('planOneShot holds instead of emitting an oversized wake when stderr reserve leaves no room and note write fails (3c5147a7 / 91d7b47c)', () => {
    const { home } = mkHome()
    const notesPath = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(notesPath), { recursive: true })
    fs.writeFileSync(notesPath, 'blocked')
    const nearLimitWake = buildOwnerMessageEvents(ownerBatch('b'.repeat(19_400)))
    const reserve = 'devspec-remote-wait: retry warning\n'.repeat(30)
    const plan = planOneShot([nearLimitWake], { reserve, home })
    assert.equal(plan.held, true, 'must hold instead of emitting > 20,000 combined characters')
    assert.equal(plan.count, 0)
    assert.equal(plan.text, '')
    assert.ok(plan.error)
  })

  it('surfaces structured refusal code and blocking_turn_id even when refusal exceeds Shell ceiling and notes dir is unwritable (4e32d1a5)', async () => {
    const { home, dir } = mkHome()
    const notesPath = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(notesPath), { recursive: true })
    fs.writeFileSync(notesPath, 'blocked')
    const wake = buildOwnerMessageEvents(ownerBatch('Inline command'))
    let capturedStderr = ''
    const res = await runOneShotRoomCommandPickup({
      connectionId: CONN,
      printedWakes: [wake],
      printedStdout: '',
      priorStderr: '',
      fallbackSessionId: ROOM,
      dir,
      home,
      writeStderr: (chunk) => { capturedStderr += chunk },
      startCommands: async () => ({
        ok: false,
        outcome: 'refused',
        refusals: [
          {
            command_message_id: MSG_ID,
            command_turn_id: TURN_ID,
            refusal: {
              code: 'turn_busy',
              retryable: true,
              blocking_turn_id: '88888888-8888-4888-8888-888888888888',
              detail: 'x'.repeat(25_000),
            },
          },
        ],
      }),
    })
    assert.equal(res.ok, false)
    assert.ok(fitsShellOutput(capturedStderr), `fallback stderr (${capturedStderr.length}) must fit fitsShellOutput`)
    assert.match(capturedStderr, /turn_busy/)
    assert.match(capturedStderr, /88888888-8888-4888-8888-888888888888/)
  })

  it('planOneShot never omits wakes_waiting when a near-limit first wake leaves more wakes queued (3c5147a7 / 91d7b47c)', () => {
    const { home } = mkHome()
    // First wake is ~19,900 chars on its own: fits alone, but NOT together with wakes_waiting.
    const nearLimitWake = buildOwnerMessageEvents(ownerBatch('w'.repeat(9_650)))
    const secondWake = buildOwnerMessageEvents(ownerBatch('Second queued wake'))
    // With reserve leaving room for one wake_in_note pointer + wakes_waiting (but not two pointers),
    // planOneShot must note-wrap wake 1 and emit wakes_waiting (count: 1).
    const tightReserve = 'r'.repeat(19_600)
    const planWritable = planOneShot([nearLimitWake, secondWake], { home, reserve: tightReserve })
    assert.equal(planWritable.held, false)
    assert.equal(planWritable.count, 1)
    assert.ok(fitsShellOutput(tightReserve + planWritable.text))
    assert.match(planWritable.text, /"type":"wakes_waiting"/, 'must disclose the remaining queued wake')
    assert.match(planWritable.text, /"count":1/)

    // When notes dir is ALSO unwritable so wake 1 cannot be note-wrapped to make room for wakes_waiting,
    // planOneShot must hold instead of printing wake 1 without disclosing the queued remainder.
    const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-oneshot-broken-'))
    try {
      fs.mkdirSync(path.join(brokenHome, '.devspec'), { recursive: true })
      fs.writeFileSync(path.join(brokenHome, '.devspec', 'notes'), 'blocked')
      const planBlocked = planOneShot([nearLimitWake, secondWake], { home: brokenHome })
      assert.equal(planBlocked.held, true, 'must hold instead of omitting wakes_waiting disclosure')
      assert.equal(planBlocked.count, 0)
    } finally {
      fs.rmSync(brokenHome, { recursive: true, force: true })
    }
  })

  it('two wake_in_note commands on one readWakes page never advance the cursor past an unread or failed sibling note (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes.jsonl`)
    const turnA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const msgA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
    const turnB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    const msgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
    const batchA = {
      ...ownerBatch('A'.repeat(11_000)),
      messages: [{ ...ownerBatch('A'.repeat(11_000)).messages[0], id: msgA, message_id: msgA, turn_id: turnA }],
    }
    const batchB = {
      ...ownerBatch('B'.repeat(11_000)),
      messages: [{ ...ownerBatch('B'.repeat(11_000)).messages[0], id: msgB, message_id: msgB, turn_id: turnB }],
    }
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(batchA))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(batchB))

    let firstOut = ''
    const read1 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (t) => { firstOut += t },
      writeStderr: () => {},
      startCommands: async () => ({ ok: true }),
    })
    assert.equal(read1.printed, 2)
    assert.equal(read1.marked, false)
    assert.equal(read1.pending_note_reads?.length, 2)
    const [noteA, noteB] = read1.pending_note_reads
    assert.notEqual(noteA, noteB)

    // Case 1: Agent reads Note B FIRST (out of order) while Note A is still unread.
    const picked = []
    for (const file of noteFiles(home, noteB)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        startCommands: async (opts) => {
          picked.push(...opts.commands.map((c) => c.messageId))
          return { ok: true }
        },
      })
    }
    assert.deepEqual(picked, [msgB])

    // Cursor must NOT have advanced past Note A!
    let checkOut = ''
    const checkAfterB = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (t) => { checkOut += t },
      writeStderr: () => {},
      startCommands: async () => ({ ok: true }),
    })
    assert.ok(checkAfterB.printed >= 1, 'unread Note A must still be present after out-of-order Note B read')
    assert.match(checkOut, new RegExp(noteA))

    // Case 2: Now agent reads Note A, and its pickup succeeds -> cursor advances past BOTH Note A and Note B!
    for (const file of noteFiles(home, noteA)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        startCommands: async (opts) => {
          picked.push(...opts.commands.map((c) => c.messageId))
          return { ok: true }
        },
      })
    }
    assert.deepEqual(picked, [msgB, msgA])

    const afterBoth = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: async () => ({ ok: true }),
    })
    assert.equal(afterBoth.printed, 0, 'cursor must advance past both notes only after both are read and picked up')
    assert.equal(afterBoth.marked, true)
  })

  it('structured refusal fallback preserves >10 blocking entries and deep nested details, and discloses counts + recovery when array exceeds Shell budget (4e32d1a5 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const notesPath = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(notesPath), { recursive: true })
    fs.writeFileSync(notesPath, 'blocked')

    // 1. 15 blocking entries + depth-6 nested detail + oversized text blob:
    //    must preserve ALL 15 blocking entries and the depth-6 field when they fit inside fitsShellOutput!
    const wake1 = buildOwnerMessageEvents(ownerBatch('Inline command 1'))
    const blocking15 = Array.from({ length: 15 }, (_, idx) => ({ id: `blk-${idx + 1}`, reason: 'active_turn' }))
    let stderr1 = ''
    await runOneShotRoomCommandPickup({
      connectionId: CONN,
      printedWakes: [wake1],
      printedStdout: '',
      priorStderr: '',
      fallbackSessionId: ROOM,
      dir,
      home,
      writeStderr: (chunk) => { stderr1 += chunk },
      startCommands: async () => ({
        ok: false,
        outcome: 'refused',
        refusals: [
          {
            command_message_id: MSG_ID,
            command_turn_id: TURN_ID,
            refusal: {
              code: 'turn_busy',
              blocking: blocking15,
              nested: { l2: { l3: { l4: { l5: { l6_secret_token: 'keep-depth-6' } } } } },
              huge_blob: 'z'.repeat(25_000),
            },
          },
        ],
      }),
    })
    assert.ok(fitsShellOutput(stderr1))
    assert.match(stderr1, /blk-15/, 'must NOT arbitrarily slice blocking list at 10 when all 15 fit')
    assert.match(stderr1, /keep-depth-6/, 'must NOT arbitrarily drop nested fields at depth >= 4')

    // 2. 100 large blocking items (>20,000 chars even without any giant single string):
    //    must keep maximum complete entries with explicit total_count, returned_count, omitted_count, and recovery!
    const blocking100 = Array.from({ length: 100 }, (_, idx) => ({
      id: `item-${idx + 1}`,
      title: `Blocking item ${idx + 1} ${'q'.repeat(250)}`,
    }))
    let stderr2 = ''
    await runOneShotRoomCommandPickup({
      connectionId: CONN,
      printedWakes: [wake1],
      printedStdout: '',
      priorStderr: '',
      fallbackSessionId: ROOM,
      dir,
      home,
      writeStderr: (chunk) => { stderr2 += chunk },
      startCommands: async () => ({
        ok: false,
        outcome: 'refused',
        refusals: [
          {
            command_message_id: MSG_ID,
            command_turn_id: TURN_ID,
            refusal: {
              code: 'multi_block',
              blocking: blocking100,
            },
          },
        ],
      }),
    })
    assert.ok(fitsShellOutput(stderr2))
    assert.match(stderr2, /"total_count":100/)
    assert.match(stderr2, /"omitted_due_to_shell_limit":true/)
    assert.match(stderr2, /"recovery":/)
    assert.doesNotMatch(stderr2, /diagnostic omitted/, 'must surface structured refusal counts & recovery, never generic omission line')
  })

  it('emits a structured omission and recovery diagnostic even with only 350 chars left in the Shell budget and note-write failure (3c5147a7 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const notesPath = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(notesPath), { recursive: true })
    fs.writeFileSync(notesPath, 'blocked')
    const wake = buildOwnerMessageEvents(ownerBatch('Tight budget refusal test'))
    const priorStderr = 'w'.repeat(20_000 - 350)
    let capturedStderr = ''
    const res = await runOneShotRoomCommandPickup({
      connectionId: CONN,
      printedWakes: [wake],
      printedStdout: '',
      priorStderr,
      fallbackSessionId: ROOM,
      dir,
      home,
      writeStderr: (chunk) => { capturedStderr += chunk },
      startCommands: async () => ({
        ok: false,
        outcome: 'refused',
        refusals: [
          {
            command_message_id: MSG_ID,
            command_turn_id: TURN_ID,
            refusal: {
              code: 'turn_busy',
              retryable: true,
              blocking_turn_id: '88888888-8888-4888-8888-888888888888',
              detail: 'x'.repeat(25_000),
            },
          },
        ],
      }),
    })
    assert.equal(res.ok, false)
    assert.ok(capturedStderr.length > 0, 'must NOT silently drop the refusal when 350 chars remain')
    assert.equal(fitsShellOutput(priorStderr + capturedStderr), true, 'combined output must stay within Shell limit')
    const parsed = JSON.parse(capturedStderr.trim())
    assert.equal(parsed.omitted_count, 1)
    assert.equal(parsed.shell_limit_chars, 20_000)
    assert.deepEqual(parsed.codes, ['turn_busy'])
    assert.ok(typeof parsed.recovery === 'string' && parsed.recovery.includes('~/.devspec/notes'))
  })

  it('readWakes does not advance cursor past an older unstarted inline room command when two commands fit on one page (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    const turn1 = '11111111-1111-4111-8111-111111111111'
    const msg1 = '22222222-2222-4222-8222-222222222222'
    const turn2 = TURN_ID
    const msg2 = MSG_ID
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Older command 1', { messageId: msg1, turnId: turn1 })))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Newer command 2', { messageId: msg2, turnId: turn2 })))

    const pickups = []
    const call = async (req) => {
      if (req.name === 'report_pickup') pickups.push(req.arguments.command_message_id)
      return { outcome: 'picked_up' }
    }

    // Read 1: both commands fit on the page; only msg2 receives report_pickup, so cursor MUST NOT advance past msg1.
    const read1 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read1.printed, 2)
    assert.equal(read1.marked, false, 'cursor must not advance past unstarted older command')
    assert.deepEqual(pickups, [msg2])
    assert.deepEqual(read1.unstarted_commands, [{ turnId: turn1, messageId: msg1 }])

    // Read 2: older command msg1 is still unread, receives its own report_pickup, and NOW cursor advances to EOF!
    const read2 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read2.marked, true)
    assert.deepEqual(pickups, [msg2, msg1])

    // Read 3: both commands picked up -> cursor is now at EOF (0 wakes).
    const read3 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read3.printed, 0)
    assert.equal(read3.marked, true)
  })

  it('preserves and surfaces a normal structured refusal from stale-turn report_complete without clearing the local turn marker (4e32d1a5)', async () => {
    const { home, dir } = mkHome()
    const turnPath = path.join(dir, `${CONN}.turn`)
    fs.writeFileSync(turnPath, JSON.stringify({ startedAt: Date.now() - 120_000, connection_id: CONN }))
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('New command after stale turn')))

    const calls = []
    let capturedStderr = ''
    const res = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: (chunk) => { capturedStderr += chunk },
      startCommands: (opts) =>
        startRoomCommands({
          ...opts,
          call: async (req) => {
            calls.push(req.name)
            if (req.name === 'report_complete') {
              return {
                ok: false,
                refused: true,
                code: 'attempt_blocked',
                blocking_attempt: {
                  attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  reason: 'active_tool_call',
                },
              }
            }
            return { outcome: 'picked_up' }
          },
          seedFn: async () => {},
          ensureWatch: () => ({ started: false }),
        }),
    })
    assert.deepEqual(calls, ['report_complete'], 'must not proceed to report_pickup when stale-turn report_complete is refused')
    assert.equal(fs.existsSync(turnPath), true, 'must not clear the local turn marker when report_complete is refused')
    assert.equal(res.marked, false, 'must not advance wake cursor when stale-turn cleanup was refused')
    assert.equal(res.pickup_refusals?.[0]?.step, 'stale_turn_report_complete')
    assert.equal(res.pickup_refusals?.[0]?.refusal?.blocking_attempt?.attempt_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    assert.match(capturedStderr, /attempt_blocked/)
    assert.match(capturedStderr, /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/)
    assert.match(capturedStderr, /active_tool_call/)
  })

  it('stepDeliveryHook surfaces a budget-fitted structured refusal in agent-facing additional_context when refusal exceeds hook share and notes dir is unwritable (3c5147a7 / 91d7b47c / 4e32d1a5)', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Mid-turn refusal with broken notes')
    holdForNextStep(CONN, batch, buildOwnerMessageEvents(batch), { dir })
    const raw1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: '' },
      { home, dir, listenerActive: () => true },
    )
    const noteId = noteIdIn(JSON.parse(raw1).additional_context)
    const parts = noteFiles(home, noteId)
    const partContents = parts.map((file) => catCall(home, file, { conversation: CONVERSATION }))

    // Now make ~/.devspec/notes read-only so readThrough still sees the note parts
    // while writeNote fails with EACCES when stepDeliveryHook tries to save the refusal.
    const notesDir = path.join(home, '.devspec', 'notes')
    fs.chmodSync(notesDir, 0o555)
    let refusalRaw = null
    try {
      for (const callInput of partContents) {
        refusalRaw = await stepDeliveryHook(callInput, {
          home,
          dir,
          share: 1200,
          listenerActive: () => true,
          startCommands: async () => ({
            ok: false,
            outcome: 'refused',
            started: [],
            pickedUp: 0,
            refusals: [
              {
                command_message_id: MSG_ID,
                command_turn_id: TURN_ID,
                refusal: {
                  code: 'turn_busy',
                  retryable: true,
                  blocking_turn_id: '88888888-8888-4888-8888-888888888888',
                  detail: 'x'.repeat(5_000),
                },
              },
            ],
          }),
        })
      }
    } finally {
      fs.chmodSync(notesDir, 0o700)
    }
    assert.ok(refusalRaw, 'hook must NOT silently drop the refusal when note saving fails')
    const ctx = JSON.parse(refusalRaw).additional_context
    assert.ok(ctx.length <= 1200, `additional_context (${ctx.length}) must stay within hook share (1200)`)
    assert.match(ctx, /turn_busy/)
    assert.match(ctx, /88888888-8888-4888-8888-888888888888/)
    assert.match(ctx, /~\/\.devspec\/notes/)
  })

  it('completing a later wake_in_note via stepDeliveryHook never advances wake cursor past an earlier unstarted inline command (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    const turn1 = '11111111-1111-4111-8111-111111111111'
    const msg1 = '22222222-2222-4222-8222-222222222222'
    const turn2 = '33333333-3333-4333-8333-333333333333'
    const msg2 = '44444444-4444-4444-8444-444444444444'
    const turn3 = TURN_ID
    const msg3 = MSG_ID
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Inline cmd 1 (older)', { messageId: msg1, turnId: turn1 })))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Inline cmd 2 (newer)', { messageId: msg2, turnId: turn2 })))
    // Oversized 3rd command goes into a sealed note (`wake_in_note`).
    const bigBatch3 = ownerBatch('Oversized note cmd 3 ' + 'N'.repeat(21_000), { messageId: msg3, turnId: turn3 })
    const noteWrapped3 = wakeInNote(buildOwnerMessageEvents(bigBatch3), { home })
    appendWakeEvents(wakeFile, noteWrapped3.events)

    const pickups = []
    const call = async (req) => {
      if (req.name === 'report_pickup') pickups.push(req.arguments.command_message_id)
      return { outcome: 'picked_up' }
    }

    // Read 1: picks up inline cmd 2, leaves inline cmd 1 unstarted AND registers note cmd 3 pending.
    const read1 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read1.marked, false)
    assert.deepEqual(pickups, [msg2])
    assert.equal(read1.pending_note_reads?.length, 1)
    const noteId3 = read1.pending_note_reads[0]

    // Agent reads later note cmd 3 BEFORE Read 2 runs: cmd 3 gets picked up,
    // BUT cursor MUST NOT advance past unstarted inline cmd 1!
    for (const file of noteFiles(home, noteId3)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
      })
    }
    assert.deepEqual(pickups, [msg2, msg3])

    // Read 2: unstarted inline cmd 1 MUST STILL BE PRESENT, receives its pickup, and cursor now advances to EOF!
    const read2 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read2.marked, true, 'once cmd 1 is picked up and cmd 3 was already completed, cursor advances to EOF')
    assert.deepEqual(pickups, [msg2, msg3, msg1])

    // Read 3: cursor is at EOF (0 wakes).
    const read3 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read3.printed, 0)
    assert.equal(read3.marked, true)
  })
})
