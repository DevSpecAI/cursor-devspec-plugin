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
  formatStructuredRefusalsFallback,
  isWakeListenerActive,
  markWakeListenerNeeded,
  startRoomCommands,
  wakeListenerInfo,
  wakeNeededPath,
} from './command-start.mjs'
import { appendWakeEvents, REMOTE_WAKE_NOTIFY_PATTERN, wakeLines } from './devspec-wake-file.mjs'
import { readWakes } from './devspec-wake-tail.mjs'
import {
  buildOwnerMessageEvents,
  planOneShot,
  printedRoomCommands,
  printOneShot,
  runOneShotRoomCommandPickup,
} from './devspec-remote-wait.mjs'
import { fastConnect } from './fast-connect.mjs'
import { CURSOR_SHELL_OUTPUT_MAX_CHARS, fitsShellOutput, readNoteText, shellDiagnosticReserve, wakeInNote, writeNote } from './hook-context-budget.mjs'
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
  registerPendingWakeNote,
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
        if (req.name === 'report_complete') {
          completeCalls.push(req.arguments)
          return { phase: 'done', closed_as: 'completed' }
        }
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
        return req.name === 'report_complete'
          ? { phase: 'done', closed_as: 'completed' }
          : { outcome: 'picked_up' }
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
    const batch = ownerBatch('Near limit body ' + 'm'.repeat(8_500))
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
      assert.ok(stdout.length > 0, 'wake reaches stdout before report_pickup runs (req 3ea2b201)')
      const diagText = /notes\/([0-9a-f]{16})\.md/.test(stderr)
        ? readNoteText(/notes\/([0-9a-f]{16})\.md/.exec(stderr)[1], { home })
        : stderr
      assert.match(diagText, /busy_refusal/, 'structured refusal preserved inline or in sealed diagnostic note')
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
    const batch = ownerBatch('Near limit nothing_open ' + 'm'.repeat(8_550))
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
      const diagText = /notes\/([0-9a-f]{16})\.md/.test(stderr)
        ? readNoteText(/notes\/([0-9a-f]{16})\.md/.exec(stderr)[1], { home })
        : stderr
      assert.match(diagText, /nothing_open/, 'nothing_open diagnostic preserved inline or in sealed diagnostic note')
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
          if (!unblocked && stderr.includes('buffering further retry warnings')) {
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
      assert.match(stderr, /buffering further retry warnings/)
      assert.match(stderr, /saved \d+ omitted retry diagnostic\(s\).*cat /)
      const noteIdMatch = /notes\/([0-9a-f]{16})\.md/.exec(stderr)
      assert.ok(noteIdMatch, `stderr must name saved retry diagnostic note, got:\n${stderr}`)
      const savedRetryText = readNoteText(noteIdMatch[1], { home })
      assert.ok(savedRetryText && savedRetryText.includes('holding a wake:'), 'saved retry note must preserve omitted retry warnings whole')
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
    assert.equal(
      parsed.blocking_turn_id ?? parsed.blocking?.[0]?.blocking_turn_id,
      '88888888-8888-4888-8888-888888888888',
      'tight refusal fallback must preserve actionable blocking_turn_id rather than stripping to bare codes',
    )
    assert.ok(typeof parsed.read === 'string' && parsed.read.startsWith('cat '), 'must retain exact original refusal on disk with a cat command')
    const savedPath = parsed.read.replace(/^cat\s+'|'$/g, '')
    assert.ok(fs.existsSync(savedPath), 'saved original refusal file must exist on disk')
    const savedOriginal = fs.readFileSync(savedPath, 'utf8')
    assert.match(savedOriginal, /88888888-8888-4888-8888-888888888888/)
    assert.match(savedOriginal, /x{500}/)
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

  it('keeps older command queued and discloses remaining pickup work when the newest command on a two-command read returns nothing_open (3c5147a7 / 91d7b47c / 3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    const turn1 = '11111111-1111-4111-8111-111111111111'
    const msg1 = '22222222-2222-4222-8222-222222222222'
    const turn2 = TURN_ID
    const msg2 = MSG_ID
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Older open command 1', { messageId: msg1, turnId: turn1 })))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Newer already-closed command 2', { messageId: msg2, turnId: turn2 })))

    const pickups = []
    const call = async (req) => {
      if (req.name === 'report_pickup') {
        pickups.push(req.arguments.command_message_id)
        if (req.arguments.command_message_id === msg2) {
          return { ok: true, attempt_id: null, outcome: 'nothing_open' }
        }
        return { outcome: 'picked_up' }
      }
      return { ok: true }
    }

    // Read 1: newer msg2 returns nothing_open; older msg1 MUST stay queued, header MUST report
    // remaining > 0 + disclosure note, stderr MUST disclose the skipped older pickup, and cursor stays held!
    let out1 = ''
    let err1 = ''
    const read1 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { out1 += text },
      writeStderr: (text) => { err1 += text },
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read1.marked, false, 'cursor must NOT advance past unchecked older command after newer nothing_open')
    assert.ok(read1.remaining >= 1, `expected remaining >= 1 in read1, got ${read1.remaining}`)
    assert.deepEqual(pickups, [msg2])
    assert.deepEqual(read1.unstarted_commands, [{ turnId: turn1, messageId: msg1 }])
    const header1 = JSON.parse(out1.split('\n')[0])
    assert.ok(header1.devspec_wakes.remaining >= 1, 'stdout header must NOT report remaining: 0 while older pickup is queued')
    assert.match(String(header1.note ?? ''), /remain queued for pickup/i)
    assert.match(err1, /remain queued for pickup/i)
    assert.match(err1, new RegExp(msg1))

    // Read 2: older command msg1 is returned and picked up (msg2 was already resolved as nothing_open),
    // and NOW cursor advances to EOF with remaining: 0!
    let out2 = ''
    const read2 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { out2 += text },
      writeStderr: () => {},
      startCommands: (opts) => startRoomCommands({ ...opts, call, seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read2.marked, true)
    assert.equal(read2.remaining, 0)
    assert.deepEqual(pickups, [msg2, msg1])
    assert.match(out2, /Older open command 1/)

    // Read 3: EOF -> 0 wakes.
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

  it('stepDeliveryHook still returns structured refusal in agent-facing additional_context when saving a concurrent delivery note fails (4e32d1a5)', async () => {
    const { home, dir } = mkHome()
    const batch1 = ownerBatch('Handed-over command whose pickup will be refused')
    holdForNextStep(CONN, batch1, buildOwnerMessageEvents(batch1), { dir })
    const raw1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: '' },
      { home, dir, listenerActive: () => true },
    )
    const noteId = noteIdIn(JSON.parse(raw1).additional_context)
    const parts = noteFiles(home, noteId)
    const partContents = parts.map((file) => catCall(home, file, { conversation: CONVERSATION }))

    // Enqueue a concurrent waiting item BEFORE the agent finishes reading the first note,
    // AND make ~/.devspec/notes read-only so saving the concurrent delivery note throws EACCES.
    const batch2 = ownerBatch('Concurrent arriving command', {
      messageId: '99999999-9999-4999-8999-999999999999',
      turnId: '88888888-8888-4888-8888-888888888888',
    })
    holdForNextStep(CONN, batch2, buildOwnerMessageEvents(batch2), { dir })

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
                  code: 'turn_in_progress',
                  blocking_turn_id: '77777777-7777-4777-8777-777777777777',
                  reason: 'Another turn is currently open on this connection.',
                },
              },
            ],
          }),
        })
      }
    } finally {
      fs.chmodSync(notesDir, 0o700)
    }
    assert.ok(refusalRaw, 'stepDeliveryHook must NOT return null when concurrent delivery note saving fails after a structured pickup refusal')
    const ctx = JSON.parse(refusalRaw).additional_context
    assert.ok(ctx.length <= 1200, `additional_context (${ctx.length}) must stay within hook share (1200)`)
    assert.match(ctx, /turn_in_progress/)
    assert.match(ctx, /77777777-7777-4777-8777-777777777777/)
    assert.match(ctx, /~\/\.devspec\/notes/)
  })

  it('refuses and keeps wake cursor held when local connection state cannot be read during readWakes (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Command while connection state is corrupt')))
    // Corrupt local connection state JSON so reading it fails transiently.
    const statePath = path.join(dir, `${CONN}.json`)
    const goodState = fs.readFileSync(statePath, 'utf8')
    fs.writeFileSync(statePath, '{not valid json')

    let stderr1 = ''
    const read1 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: (text) => { stderr1 += text },
      startCommands: (opts) => startRoomCommands({ ...opts, call: async () => ({ outcome: 'picked_up' }), seedFn: async () => {}, ensureWatch: () => ({ started: false }) }),
    })
    assert.equal(read1.marked, false, 'wake cursor MUST NOT advance when local connection state cannot be read')
    assert.equal(read1.pickup_refusals?.[0]?.refusal?.code, 'unreadable_connection_state')
    assert.match(stderr1, /unreadable_connection_state/)

    // Once connection state is readable again, the next read picks up the command and advances the cursor.
    fs.writeFileSync(statePath, goodState)
    const pickups = []
    const read2 = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async () => {},
      writeStderr: () => {},
      startCommands: (opts) =>
        startRoomCommands({
          ...opts,
          call: async (req) => {
            if (req.name === 'report_pickup') pickups.push(req.arguments.command_message_id)
            return { outcome: 'picked_up' }
          },
          seedFn: async () => {},
          ensureWatch: () => ({ started: false }),
        }),
    })
    assert.equal(read2.marked, true)
    assert.deepEqual(pickups, [MSG_ID])
  })

  it('does NOT advance wake cursor past an earlier wake-note currently renamed to .taken-... by a concurrent hook (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    const posFile = path.join(dir, `${CONN}.wake-pos.json`)
    fs.writeFileSync(posFile, JSON.stringify({ version: 1, file: wakeFile, offset: 0 }), { mode: 0o600 })

    const noteA = writeNote('First oversized command note', { home })
    const noteB = writeNote('Second oversized command note', { home })
    const msgA = '11111111-1111-4111-8111-1111111111aa'
    const turnA = '22222222-2222-4222-8222-2222222222aa'
    const msgB = '33333333-3333-4333-8333-3333333333bb'
    const turnB = '44444444-4444-4444-8444-4444444444bb'

    registerPendingWakeNote(
      CONN,
      {
        noteId: noteA.id,
        commands: [{ turnId: turnA, messageId: msgA }],
        messages: [{ message_id: msgA }],
        sessionId: ROOM,
        wakeFile,
        wakePositionPath: posFile,
        wakeStart: 0,
        wakeThrough: 100,
      },
      { dir },
    )
    registerPendingWakeNote(
      CONN,
      {
        noteId: noteB.id,
        commands: [{ turnId: turnB, messageId: msgB }],
        messages: [{ message_id: msgB }],
        sessionId: ROOM,
        wakeFile,
        wakePositionPath: posFile,
        wakeStart: 100,
        wakeThrough: 200,
      },
      { dir },
    )

    // Simulate Hook 1 currently holding Note A as `.taken-<livePid>-<hex>` while awaiting report_pickup.
    const steps = path.join(dir, `${CONN}.steps`)
    const noteAFile = path.join(steps, `wake-note-${noteA.id}.json`)
    const noteATaken = `${noteAFile}.taken-${process.pid}-deadbeef`
    fs.renameSync(noteAFile, noteATaken)

    // Hook 2 finishes reading and picking up Note B concurrently.
    const noteBParts = noteFiles(home, noteB.id)
    for (const part of noteBParts) {
      await stepDeliveryHook(catCall(home, part, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands: async (opts) => ({ ok: true, outcome: 'picked_up', started: opts.commands, pickedUp: 1 }),
      })
    }

    // Wake cursor MUST STILL BE 0 because Note A (0..100) is still in-flight (.taken-...).
    const posAfterB = JSON.parse(fs.readFileSync(posFile, 'utf8'))
    assert.equal(posAfterB.offset, 0, 'completing Note B must NOT advance wake cursor past in-flight .taken Note A')

    // Now Hook 1 returns Note A and completes it -> cursor advances cleanly to 200!
    fs.renameSync(noteATaken, noteAFile)
    const noteAParts = noteFiles(home, noteA.id)
    for (const part of noteAParts) {
      await stepDeliveryHook(catCall(home, part, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands: async (opts) => ({ ok: true, outcome: 'picked_up', started: opts.commands, pickedUp: 1 }),
      })
    }
    const posAfterA = JSON.parse(fs.readFileSync(posFile, 'utf8'))
    assert.equal(posAfterA.offset, 200, 'wake cursor must advance to 200 once both Note A and Note B complete')
  })

  it('formatStructuredRefusalsFallback never strips fields inside retained blocking items, never drops read when saved, and returns null instead of bare omission without details (3c5147a7 / 4e32d1a5 / 91d7b47c)', () => {
    const refusal = [
      {
        command_message_id: MSG_ID,
        command_turn_id: TURN_ID,
        refusal: {
          code: 'turn_busy',
          blocking_turn_id: '99999999-9999-4999-8999-999999999999',
          blocking_items: [
            {
              id: 'item-1',
              owner: 'Ali Price',
              extra_context: 'must-not-be-silently-discarded',
            },
            {
              id: 'item-2',
              owner: 'Ali Price',
              extra_context: 'second-item-full-fields',
            },
          ],
          error: 'e'.repeat(10_000),
        },
      },
    ]
    const saved = { command: "cat '/tmp/devspec-notes-1000/0123456789abcdef.md'", parts: 1 }

    // 1. Medium budget: retained blocking_items keep ALL their fields (owner + extra_context) intact!
    const med = formatStructuredRefusalsFallback(refusal, { maxChars: 900, savedNote: saved })
    assert.ok(med && med.length <= 900)
    assert.match(med, /must-not-be-silently-discarded/)
    assert.match(med, /0123456789abcdef\.md/)

    // 2. Tight budget (~200 chars) WITH savedNote: MUST preserve `read` (never drop `read` for bare omission).
    const tightWithSaved = formatStructuredRefusalsFallback(refusal, { maxChars: 240, savedNote: saved })
    assert.ok(tightWithSaved && tightWithSaved.length <= 240)
    const parsedTight = JSON.parse(tightWithSaved)
    assert.equal(parsedTight.read, saved.command)
    assert.ok(parsedTight.omitted_field_count >= 1, 'omitted top-level fields must be disclosed explicitly')

    // 3. Ultra-tight budget (100 chars) WITH savedNote: returns null (so fitShellDiagnostic emits shellDiagnosticPointer), NEVER drops `read`.
    assert.equal(formatStructuredRefusalsFallback(refusal, { maxChars: 100, savedNote: saved }), null)

    // 4. Ultra-tight budget (110 chars) WITHOUT savedNote: returns null rather than a bare omission count with neither blocking fields nor read!
    assert.equal(formatStructuredRefusalsFallback(refusal, { maxChars: 110, savedNote: null }), null)

    // 5. 350-char budget WITHOUT savedNote (neither note store writable): MUST keep real
    // non-empty blocking_items (NEVER `items: []` and NEVER code-only without blockers!) (4e32d1a5).
    const blockingOnlyRefusal = [
      {
        command_message_id: MSG_ID,
        command_turn_id: TURN_ID,
        refusal: {
          code: 'turn_busy',
          blocking_items: [
            { id: 'blk-1', reason: 'active_edit' },
            { id: 'blk-2', reason: 'pending_review' },
            { id: 'blk-3', reason: 'lock_held' },
          ],
          error: 'e'.repeat(10_000),
        },
      },
    ]
    const at350 = formatStructuredRefusalsFallback(blockingOnlyRefusal, { maxChars: 350, savedNote: null })
    assert.ok(at350 && at350.length <= 350, `expected <= 350 chars, got ${at350?.length}`)
    const parsed350 = JSON.parse(at350)
    const items350 = Array.isArray(parsed350.blocking_items)
      ? parsed350.blocking_items
      : parsed350.blocking_items?.items
    assert.ok(Array.isArray(items350) && items350.length >= 1, `must keep >= 1 real blocking item at 350 chars, got: ${at350}`)
    assert.equal(items350[0].id, 'blk-1')
    assert.equal(items350[0].reason, 'active_edit')

    // When a tight budget WITHOUT savedNote cannot fit even 1 blocking item, return null
    // instead of returning `blocking_items: []` or code-only omission counts (4e32d1a5).
    const hugeItemRefusal = [
      {
        command_message_id: MSG_ID,
        command_turn_id: TURN_ID,
        refusal: {
          code: 'turn_busy',
          blocking_items: [
            { id: 'b1', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17, r: 18, s: 19, t: 20 },
          ],
        },
      },
    ]
    assert.equal(
      formatStructuredRefusalsFallback(hugeItemRefusal, { maxChars: 220, savedNote: null }),
      null,
      'must return null rather than dropping all blocking items to empty list when no note store is writable',
    )
  })

  it('readWakes does NOT call report_pickup, persist started-command, or write .turn if stdout write fails (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wake.jsonl`)
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Wake whose stdout fails')))

    let pickupCalls = 0
    await assert.rejects(
      () =>
        readWakes({
          file: wakeFile,
          connectionId: CONN,
          home,
          dir,
          settleMs: 10,
          write: async () => {
            throw new Error('simulated EPIPE on stdout')
          },
          writeStderr: () => {},
          startCommands: (opts) =>
            startRoomCommands({
              ...opts,
              call: async () => {
                pickupCalls += 1
                return { outcome: 'picked_up' }
              },
              seedFn: async () => {},
              ensureWatch: () => ({ started: false }),
            }),
        }),
      /simulated EPIPE/,
    )
    assert.equal(pickupCalls, 0, 'must NOT call report_pickup when stdout write fails')
    assert.equal(fs.existsSync(path.join(dir, `${CONN}.started-commands.json`)), false, 'must NOT persist started command on stdout failure')
    assert.equal(fs.existsSync(path.join(dir, `${CONN}.turn`)), false, 'must NOT write Working .turn marker on stdout failure')

    // Subsequent successful read hands the wake over, starts the command once, and advances the cursor.
    let delivered = ''
    const okRead = await readWakes({
      file: wakeFile,
      connectionId: CONN,
      home,
      dir,
      settleMs: 10,
      write: async (text) => { delivered += text },
      writeStderr: () => {},
      startCommands: (opts) =>
        startRoomCommands({
          ...opts,
          call: async () => {
            pickupCalls += 1
            return { outcome: 'picked_up' }
          },
          seedFn: async () => {},
          ensureWatch: () => ({ started: false }),
        }),
    })
    assert.equal(okRead.marked, true)
    assert.equal(pickupCalls, 1, 'next read must start the previously undelivered command cleanly')
    assert.match(delivered, /Wake whose stdout fails/)
  })

  it('createOneShotRetryStderrWriter saves omitted retry diagnostics whole to a sealed note (and tmpDir fallback) with continuation command (3c5147a7 / 91d7b47c)', async () => {
    const { createOneShotRetryStderrWriter } = await import('./devspec-remote-wait.mjs')
    const { home } = mkHome()
    const blockedHome = path.join(home, 'blocked-home')
    fs.mkdirSync(path.join(blockedHome, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(blockedHome, '.devspec', 'notes'), 'blocked')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-retry-diag-tmp-'))
    const blockedTmp = path.join(tmpDir, 'not-a-dir')
    fs.writeFileSync(blockedTmp, 'blocked')
    try {
      // 1. Primary ~/.devspec/notes unwritable -> saves all omitted retry lines to tmpDir private note!
      let emitted = ''
      const writer = createOneShotRetryStderrWriter({
        writeStderr: (chunk) => { emitted += chunk },
        getEmittedStderr: () => emitted,
        home: blockedHome,
        tmpDir,
      })
      for (let i = 0; i < 120; i += 1) {
        writer.write(`devspec-remote-wait: retry error #${i}: EACCES detail-${'d'.repeat(160)}\n`)
      }
      assert.ok(writer.suppressedCount() > 0)
      const flushed = writer.flush()
      assert.ok(flushed.savedNote?.command?.startsWith('cat '))
      assert.ok(fitsShellOutput(emitted), `emitted stderr (${emitted.length}) must fit fitsShellOutput`)
      const savedContent = fs.readFileSync(flushed.savedNote.file, 'utf8')
      assert.match(savedContent, /retry error #119: EACCES/)

      // 2. Neither ~/.devspec/notes nor tmpDir writable -> emits explicit omission count + recovery, never silent drop!
      let emitted2 = ''
      const writer2 = createOneShotRetryStderrWriter({
        writeStderr: (chunk) => { emitted2 += chunk },
        getEmittedStderr: () => emitted2,
        home: blockedHome,
        tmpDir: blockedTmp,
      })
      for (let i = 0; i < 120; i += 1) {
        writer2.write(`devspec-remote-wait: retry error #${i}: EROFS detail-${'e'.repeat(160)}\n`)
      }
      const flushed2 = writer2.flush()
      assert.equal(flushed2.savedNote, null)
      assert.ok(flushed2.omittedCount > 0)
      assert.ok(fitsShellOutput(emitted2))
      assert.match(emitted2, /"retry_diagnostics_omitted":true/)
      assert.match(emitted2, /Fix .*~\/\.devspec\/notes/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('startRoomCommands rejects an unrecognized report_pickup reply without recording started-command ledger or .turn (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    fs.writeFileSync(
      path.join(dir, `${CONN}.json`),
      JSON.stringify({
        enabled: true,
        connection_id: CONN,
        session_id: ROOM,
        local_id: CONVERSATION,
        agent_name: 'Cursor',
        token: 'dvs_test',
        mcp_url: 'http://127.0.0.1:9/api/mcp',
      }),
      { mode: 0o600 },
    )
    const cmd = { turnId: TURN_ID, messageId: MSG_ID }
    const logs = []
    const res = await startRoomCommands({
      connectionId: CONN,
      commands: [cmd],
      sessionId: ROOM,
      dir,
      home,
      call: async () => ({ unexpected: 'payload_without_pickup_outcome' }),
      seedFn: async () => { throw new Error('must not seed trail on unrecognized pickup reply') },
      ensureWatch: () => { throw new Error('must not ensure watch on unrecognized pickup reply') },
      log: (line) => logs.push(line),
    })
    assert.equal(res.ok, false)
    assert.equal(res.outcome, 'refused')
    assert.deepEqual(res.started, [])
    assert.equal(res.pickedUp, 0)
    assert.equal(res.refusals[0].refusal.code, 'unrecognized_pickup_response')
    assert.deepEqual(res.refusals[0].refusal.response, { unexpected: 'payload_without_pickup_outcome' })
    assert.equal(fs.existsSync(path.join(dir, `${CONN}.turn`)), false, '.turn must not be written')
    const startedFile = path.join(dir, `${CONN}.started-commands.json`)
    assert.equal(fs.existsSync(startedFile), false, 'started-command ledger must not advance on unconfirmed reply')

    // Bare `{ ok: true }` without explicit pickup outcome (`picked_up` / `already_working` / `started`)
    // or working-attempt receipt (`phase: 'working'` + `attempt_id`) MUST also be rejected.
    const bareOkRes = await startRoomCommands({
      connectionId: CONN,
      commands: [cmd],
      sessionId: ROOM,
      dir,
      home,
      call: async () => ({ ok: true }),
      seedFn: async () => { throw new Error('must not seed trail on bare { ok: true }') },
      ensureWatch: () => { throw new Error('must not ensure watch on bare { ok: true }') },
      log: (line) => logs.push(line),
    })
    assert.equal(bareOkRes.ok, false)
    assert.equal(bareOkRes.outcome, 'refused')
    assert.deepEqual(bareOkRes.started, [])
    assert.equal(bareOkRes.pickedUp, 0)
    assert.equal(bareOkRes.refusals[0].refusal.code, 'unrecognized_pickup_response')
    assert.deepEqual(bareOkRes.refusals[0].refusal.response, { ok: true })
    assert.equal(fs.existsSync(path.join(dir, `${CONN}.turn`)), false)
    assert.equal(fs.existsSync(startedFile), false)
  })

  it('startRoomCommands preserves stale .turn and turn-commands and does not call report_pickup on an unrecognized report_complete reply (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const staleTurnFile = path.join(dir, `${CONN}.turn`)
    const staleCmdsFile = path.join(dir, `${CONN}.turn-commands.json`)
    fs.writeFileSync(staleTurnFile, JSON.stringify({ startedAt: Date.now() - 120_000, connection_id: CONN }))
    fs.writeFileSync(
      staleCmdsFile,
      JSON.stringify({
        version: 1,
        commands: [{ turn_id: '11111111-1111-4111-8111-111111111111', message_id: '22222222-2222-4222-8222-222222222222' }],
      }),
    )
    const calls = []
    const res = await startRoomCommands({
      connectionId: CONN,
      commands: [{ turnId: TURN_ID, messageId: MSG_ID }],
      dir,
      home,
      call: async (req) => {
        calls.push(req.name)
        return { ok: true }
      },
      seedFn: async () => { throw new Error('must not seed on unrecognized report_complete') },
      ensureWatch: () => { throw new Error('must not ensure watch on unrecognized report_complete') },
      log: () => {},
    })
    assert.equal(res.ok, false)
    assert.equal(res.outcome, 'refused')
    assert.deepEqual(calls, ['report_complete'], 'must NOT call report_pickup when stale report_complete was unconfirmed')
    assert.equal(res.refusals[0].refusal.code, 'unrecognized_complete_response')
    assert.equal(fs.existsSync(staleTurnFile), true, 'stale .turn marker must remain intact for retry')
    assert.equal(fs.existsSync(staleCmdsFile), true, 'stale turn-commands record must remain intact for retry')
  })

  it('readWakes reserves space for a long connections-directory diagnostic-notes fallback path so near-ceiling refusal pointers never disappear (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-wake-long-dir-'))
    const blockedHome = path.join(base, 'home')
    fs.mkdirSync(path.join(blockedHome, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(blockedHome, '.devspec', 'notes'), 'not-a-directory\n')
    const blockedTmp = path.join(base, 'tmp-not-a-dir')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    // Create a deeply nested writable connections directory whose fallback note path exceeds 600 chars!
    const deepSegments = Array.from({ length: 12 }, (_, i) => `nested-connections-segment-${String(i).padStart(2, '0')}-${'x'.repeat(45)}`)
    const longDir = path.join(base, ...deepSegments)
    fs.mkdirSync(longDir, { recursive: true })
    const wakeFile = path.join(longDir, `${CONN}.wakes.jsonl`)
    // Size the wake right at the maximum inline ceiling allowed beside the dynamic
    // `longDir/diagnostic-notes` reserve so without accounting for `longDir`, the saved
    // refusal's `cat` read command would overflow fitsShellOutput and vanish.
    const reserveLen = shellDiagnosticReserve('devspec-wake-tail', {
      fallbackDir: path.join(longDir, 'diagnostic-notes'),
    }).length
    const targetWakeLen = CURSOR_SHELL_OUTPUT_MAX_CHARS - reserveLen - 250
    let bodyLen = 8_000
    for (let pass = 0; pass < 6; pass += 1) {
      const measured = wakeLines(buildOwnerMessageEvents(ownerBatch('L'.repeat(bodyLen)))).length
      bodyLen = Math.max(100, bodyLen + Math.floor((targetWakeLen - measured) / 2))
    }
    const batch = ownerBatch('L'.repeat(bodyLen))
    const built = buildOwnerMessageEvents(batch)
    appendWakeEvents(wakeFile, built)

    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    try {
      let stdout = ''
      let stderr = ''
      const res = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home: blockedHome,
        dir: longDir,
        settleMs: 10,
        write: async (text) => { stdout += text },
        writeStderr: (text) => { stderr += text },
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
                code: 'turn_busy_long_dir',
                blocking_items: [{ id: 'blk-long-1', reason: 'active_edit' }],
                detail: 'd'.repeat(3_000),
              },
            },
          ],
        }),
      })
      assert.equal(res.marked, false)
      assert.equal(res.pickup_diagnostic_written, true, `expected diagnostic to be written; stderr=${stderr}`)
      assert.ok(stderr.trim().length > 0, 'stderr must NOT be empty with a long connections fallback path')
      assert.ok(fitsShellOutput(stdout + stderr), `combined stdout (${stdout.length}) + stderr (${stderr.length}) must fit fitsShellOutput`)
      const catMatch = /cat '([^']+)'/.exec(stderr)
      assert.ok(catMatch, `stderr must contain the exact cat read command; got: ${stderr}`)
      const saved = fs.readFileSync(catMatch[1], 'utf8')
      assert.match(saved, /turn_busy_long_dir/)
      assert.match(saved, /blk-long-1/)
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('readWakes reserves BOTH max UTF-16 chars AND max UTF-8 bytes when TMPDIR is longer in ASCII chars while connections fallback path is longer in UTF-8 bytes (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-wake-utf8-'))
    const blockedHome = path.join(base, 'home')
    fs.mkdirSync(path.join(blockedHome, '.devspec'), { recursive: true })
    fs.writeFileSync(path.join(blockedHome, '.devspec', 'notes'), 'not-a-directory\n')
    // Unavailable ASCII TMPDIR: longer in UTF-16 characters (~550 ASCII chars = 550 bytes).
    const longAsciiTmpParent = path.join(base, 'a'.repeat(180), 'b'.repeat(180), 'c'.repeat(180))
    fs.mkdirSync(longAsciiTmpParent, { recursive: true })
    const blockedTmp = path.join(longAsciiTmpParent, 'tmp-file')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    // Writable fallback dir: SHORTER in UTF-16 characters (~250 CJK chars) but LONGER in UTF-8 bytes (~750+ bytes)!
    const utf8Dir = path.join(base, '中'.repeat(80), '文'.repeat(80), '径'.repeat(80))
    fs.mkdirSync(utf8Dir, { recursive: true })

    const wakeFile = path.join(utf8Dir, `${CONN}.wakes.jsonl`)
    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    try {
      const reserve = shellDiagnosticReserve('devspec-wake-tail', {
        fallbackDir: path.join(utf8Dir, 'diagnostic-notes'),
      })
      const reserveBytes = Buffer.byteLength(reserve, 'utf8')
      assert.ok(reserveBytes >= 800, `expected UTF-8 byte reserve >= 800, got ${reserveBytes}`)
      // Build a CJK wake near the 40,000-byte UTF-8 Shell ceiling (fits under 20,000 chars!).
      const targetBytes = 40_000 - reserveBytes - 300
      let cjkCount = 5_000
      for (let pass = 0; pass < 6; pass += 1) {
        const measured = Buffer.byteLength(wakeLines(buildOwnerMessageEvents(ownerBatch('あ'.repeat(cjkCount)))), 'utf8')
        cjkCount = Math.max(100, cjkCount + Math.floor((targetBytes - measured) / 6))
      }
      const built = buildOwnerMessageEvents(ownerBatch('あ'.repeat(cjkCount)))
      appendWakeEvents(wakeFile, built)

      let stdout = ''
      let stderr = ''
      const res = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home: blockedHome,
        dir: utf8Dir,
        settleMs: 10,
        write: async (text) => { stdout += text },
        writeStderr: (text) => { stderr += text },
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
                code: 'turn_busy_utf8_fallback',
                blocking_items: [{ id: 'blk-utf8-1', reason: 'active_edit' }],
                detail: 'd'.repeat(3_000),
              },
            },
          ],
        }),
      })
      assert.equal(res.marked, false)
      assert.equal(res.pickup_diagnostic_written, true, `expected diagnostic to be written; stderr=${stderr}`)
      assert.ok(fitsShellOutput(stdout + stderr))
      const catMatch = /cat '([^']+)'/.exec(stderr)
      assert.ok(catMatch, `stderr must contain exact cat read command; got: ${stderr}`)
      const saved = fs.readFileSync(catMatch[1], 'utf8')
      assert.match(saved, /turn_busy_utf8_fallback/)
      assert.match(saved, /blk-utf8-1/)
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('stepDeliveryHook defers report_pickup for an oversized mid-turn command until the inner wake_in_note body is read whole (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Huge mid-turn command ' + 'm'.repeat(21_000))
    const built = buildOwnerMessageEvents(batch)
    // Simulate devspec-remote-wait wrapping the oversized command into an inner wake_in_note before holding for step!
    const innerWrapped = wakeInNote(built, { home })
    assert.equal(innerWrapped.events[0].type, 'wake_in_note')
    const innerNoteId = innerWrapped.note.id

    const held = holdForNextStep(CONN, batch, innerWrapped.events, { dir })
    assert.equal(held.held, true)

    const pickupCalls = []
    const startCommands = async (opts) => {
      pickupCalls.push(opts.commands)
      return { ok: true, outcome: 'picked_up', started: opts.commands, pickedUp: opts.commands.length }
    }

    // Step 1: postToolUse hands over the OUTER step note pointing at the inner wake_in_note.
    const handOverRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo work' }, tool_output: 'work' },
      { home, dir, listenerActive: () => true, startCommands },
    )
    assert.ok(handOverRaw, 'expected outer step note hook output')
    const handOverCtx = JSON.parse(handOverRaw).additional_context
    assert.ok(handOverCtx)
    const outerMatch = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(handOverCtx)
    assert.ok(outerMatch, `expected outer step note command; got: ${handOverCtx}`)
    const outerNoteId = outerMatch[1]
    assert.notEqual(outerNoteId, innerNoteId)
    assert.equal(pickupCalls.length, 0, 'handing over outer pointer must NOT trigger report_pickup')

    // Step 2: Agent reads ONLY the OUTER step note (which contains ONLY the inner wake_in_note pointer!).
    for (const file of noteFiles(home, outerNoteId)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands,
      })
    }
    assert.equal(pickupCalls.length, 0, 'reading ONLY the outer step note must NOT trigger report_pickup before inner note is read')
    const pendingInnerFile = path.join(dir, `${CONN}.steps`, `wake-note-${innerNoteId}.json`)
    assert.equal(fs.existsSync(pendingInnerFile), true, 'inner wake_in_note must stay pending in steps dir until read whole')

    // Step 3: Agent reads every part of the INNER wake_in_note whole -> NOW report_pickup runs once and clears pending!
    for (const file of noteFiles(home, innerNoteId)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands,
      })
    }
    assert.equal(pickupCalls.length, 1, 'reading inner wake_in_note whole must trigger report_pickup once')
    assert.equal(pickupCalls[0][0].messageId, MSG_ID)
    assert.equal(fs.existsSync(pendingInnerFile), false, 'pending inner wake-note record must clear once picked up')
  })

  it('stepDeliveryHook keeps unreadable inner wake_in_note as pending read (never triggering report_pickup on next unrelated step) until inner note is readable and read whole (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Oversized missing inner note ' + 'u'.repeat(21_000))
    const built = buildOwnerMessageEvents(batch)
    const innerWrapped = wakeInNote(built, { home })
    const innerNoteId = innerWrapped.note.id
    const innerFiles = noteFiles(home, innerNoteId)
    const innerBackups = innerFiles.map((file) => ({ file, content: fs.readFileSync(file, 'utf8') }))

    holdForNextStep(CONN, batch, innerWrapped.events, { dir })

    let pickupCalls = 0
    const startCommands = async (opts) => {
      pickupCalls += 1
      return { ok: true, outcome: 'picked_up', started: opts.commands, pickedUp: opts.commands.length }
    }

    // Step 1: hand over outer step note.
    const handOverRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true, startCommands },
    )
    const outerNoteId = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOverRaw).additional_context)[1]

    // Remove the inner note files BEFORE the outer note is read so the inner note is unreadable!
    for (const file of innerFiles) fs.rmSync(file, { force: true })

    // Step 2: Agent reads outer step note while inner note is missing -> MUST NOT call startCommands!
    for (const file of noteFiles(home, outerNoteId)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands,
      })
    }
    assert.equal(pickupCalls, 0, 'reading outer note while inner note is missing must NOT call report_pickup')

    // Step 3: Next UNRELATED tool step while inner note is STILL missing -> STILL must NOT call startCommands!
    const retryRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo unrelated' }, tool_output: 'ok' },
      { home, dir, listenerActive: () => true, startCommands },
    )
    assert.equal(pickupCalls, 0, 'next unrelated step while inner note is still missing must NOT call report_pickup')
    assert.ok(retryRaw, 'should continue surfacing the unreadable inner-note refusal')

    // Step 4: Restore inner note files -> next unrelated step registers pending inner wake note (STILL no pickup before reading inner note!).
    for (const { file, content } of innerBackups) fs.writeFileSync(file, content, { mode: 0o600 })
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo check' }, tool_output: 'ok' },
      { home, dir, listenerActive: () => true, startCommands },
    )
    assert.equal(pickupCalls, 0, 'restoring inner note must register pending read, NOT immediately call report_pickup')
    const pendingInnerFile = path.join(dir, `${CONN}.steps`, `wake-note-${innerNoteId}.json`)
    assert.equal(fs.existsSync(pendingInnerFile), true)

    // Step 5: Agent reads inner note whole -> NOW report_pickup runs once!
    for (const file of innerFiles) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands,
      })
    }
    assert.equal(pickupCalls, 1)
    assert.equal(fs.existsSync(pendingInnerFile), false)
  })

  it('stepDeliveryHook uses connections-directory diagnostic-notes fallback when HOME and TMPDIR note stores are unwritable so oversized refusals still return agent-facing context (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Mid-turn refusal with blocked HOME and TMPDIR')
    const built = buildOwnerMessageEvents(batch)
    holdForNextStep(CONN, batch, built, { dir })

    // Hand over step note while HOME is still writable.
    const handOverRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo hi' }, tool_output: 'hi' },
      { home, dir, listenerActive: () => true },
    )
    const outerNoteId = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOverRaw).additional_context)[1]
    const outerParts = noteFiles(home, outerNoteId).map((file) => ({
      file,
      call: catCall(home, file, { conversation: CONVERSATION }),
    }))

    // Make TMPDIR unwritable now, and make ~/.devspec/notes unwritable inside startCommands
    // (after readThrough verifies the outer note, right before formatPickupRefusals writes),
    // leaving ONLY `dir/diagnostic-notes` writable!
    const blockedTmp = path.join(dir, 'tmp-not-a-dir')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    try {
      let lastRaw = null
      for (const part of outerParts) {
        lastRaw = await stepDeliveryHook(part.call, {
          home,
          dir,
          share: 400,
          listenerActive: () => true,
          startCommands: async () => {
            fs.rmSync(path.join(home, '.devspec', 'notes'), { recursive: true, force: true })
            fs.writeFileSync(path.join(home, '.devspec', 'notes'), 'not-a-directory\n')
            return {
              ok: false,
              outcome: 'refused',
              started: [],
              pickedUp: 0,
              refusals: [
                {
                  command_message_id: MSG_ID,
                  command_turn_id: TURN_ID,
                  refusal: {
                    code: 'turn_busy_step_fallback',
                    blocking_items: [
                      {
                        id: 'blk-step-huge-1',
                        reason: 'active_edit',
                        f1: 'a', f2: 'b', f3: 'c', f4: 'd', f5: 'e', f6: 'f', f7: 'g', f8: 'h',
                        f9: 'i', f10: 'j', f11: 'k', f12: 'l', f13: 'm', f14: 'n', f15: 'o', f16: 'p',
                      },
                    ],
                    detail: 'x'.repeat(4_000),
                  },
                },
              ],
            }
          },
        })
      }
      assert.ok(lastRaw, 'stepDeliveryHook must NEVER return null when connections-directory fallback note store is writable')
      const ctx = JSON.parse(lastRaw).additional_context
      assert.ok(ctx && ctx.length <= 400, `context must fit hook share (400); got len=${ctx?.length}`)
      const catMatch = /cat '([^']+)'/.exec(ctx)
      assert.ok(catMatch, `hook context must include exact cat read command from connections fallback store; got: ${ctx}`)
      const saved = fs.readFileSync(catMatch[1], 'utf8')
      assert.match(saved, /turn_busy_step_fallback/)
      assert.match(saved, /blk-step-huge-1/)
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('stepDeliveryHook preserves BOTH an unreadable inner note refusal and a refused inline command refusal, and retries BOTH on the next step (3ea2b201 / 4e32d1a5)', async () => {
    const { home, dir } = mkHome()
    const INLINE_MSG_ID = '33333333-3333-4333-8333-3333333333a1'
    const INLINE_TURN_ID = '77777777-7777-4777-8777-7777777777a1'
    const INNER_MSG_ID = '33333333-3333-4333-8333-3333333333a2'
    const INNER_TURN_ID = '77777777-7777-4777-8777-7777777777a2'

    // Inner wake_in_note carries one command; inline event carries a second command in the same delivery.
    const innerBatch = ownerBatch('Inner note command', { messageId: INNER_MSG_ID, turnId: INNER_TURN_ID })
    const innerWakeText = wakeLines(buildOwnerMessageEvents(innerBatch))
    const innerNote = writeNote(innerWakeText, { home })
    const innerNoteFile = noteFiles(home, innerNote.id)[0]
    const savedInnerContent = fs.readFileSync(innerNoteFile, 'utf8')
    const mixedBatch = ownerBatch('Inline command alongside unreadable inner note', {
      messageId: INLINE_MSG_ID,
      turnId: INLINE_TURN_ID,
    })
    const mixedEvents = [
      {
        type: 'wake_in_note',
        carries: ['owner_message'],
        read: innerNote.command,
        note: innerNote.id,
      },
      ...buildOwnerMessageEvents(mixedBatch),
    ]
    holdForNextStep(CONN, mixedBatch, mixedEvents, { dir })

    // Hand over outer step note.
    const handOverRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo hi' }, tool_output: 'hi' },
      { home, dir, listenerActive: () => true },
    )
    const outerNoteId = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOverRaw).additional_context)[1]
    const outerParts = noteFiles(home, outerNoteId).map((file) => ({
      file,
      call: catCall(home, file, { conversation: CONVERSATION }),
    }))

    // Remove inner note so it is unreadable when the outer note finishes reading, AND refuse the inline command.
    fs.rmSync(innerNoteFile, { force: true })
    const pickupAttemptCommands = []
    let failInline = true
    const startCommands = async ({ commands }) => {
      pickupAttemptCommands.push(commands.map((c) => c.messageId))
      if (failInline) {
        return {
          ok: false,
          outcome: 'refused',
          started: [],
          pickedUp: 0,
          refusals: [
            {
              command_message_id: INLINE_MSG_ID,
              command_turn_id: INLINE_TURN_ID,
              refusal: { code: 'turn_busy_mixed', blocking_turn_id: 'blk-mixed-1' },
            },
          ],
        }
      }
      return {
        ok: true,
        outcome: 'picked_up',
        started: commands,
        pickedUp: commands.length,
        refusals: [],
      }
    }

    let step1Raw = null
    for (const part of outerParts) {
      step1Raw = await stepDeliveryHook(part.call, { home, dir, listenerActive: () => true, startCommands })
    }
    assert.equal(pickupAttemptCommands.length, 1)
    assert.deepEqual(pickupAttemptCommands[0], [INLINE_MSG_ID])
    assert.ok(step1Raw, 'step 1 must surface BOTH structured refusals')
    const step1Ctx = JSON.parse(step1Raw).additional_context
    assert.match(step1Ctx, /turn_busy_mixed/, 'must include inline pickup refusal')
    assert.match(step1Ctx, /blk-mixed-1/, 'must include inline blocking_turn_id')
    assert.match(step1Ctx, new RegExp(innerNote.id), 'must ALSO preserve unreadable inner note refusal and its read reference')

    // On the next step: inner note becomes readable again AND inline pickup now succeeds!
    fs.writeFileSync(innerNoteFile, savedInnerContent)
    failInline = false
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo retry' }, tool_output: 'retry' },
      { home, dir, listenerActive: () => true, startCommands },
    )
    assert.equal(pickupAttemptCommands.length, 2, 'refused inline command MUST be retried on the next step')
    assert.deepEqual(pickupAttemptCommands[1], [INLINE_MSG_ID])
    const pendingInnerFile = path.join(dir, `${CONN}.steps`, `wake-note-${innerNote.id}.json`)
    assert.equal(fs.existsSync(pendingInnerFile), true, 'newly readable inner note must be registered awaiting full read')
  })

  it('stepDeliveryHook emits an explicit omission and recovery notice instead of null when ALL THREE note stores reject writes and blocking items exceed hook share (3c5147a7 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const batch = ownerBatch('Mid-turn refusal with ALL note stores unwritable')
    const built = buildOwnerMessageEvents(batch)
    holdForNextStep(CONN, batch, built, { dir })

    const handOverRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo hi' }, tool_output: 'hi' },
      { home, dir, listenerActive: () => true },
    )
    const outerNoteId = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOverRaw).additional_context)[1]
    const outerParts = noteFiles(home, outerNoteId).map((file) => ({
      file,
      call: catCall(home, file, { conversation: CONVERSATION }),
    }))

    // Block TMPDIR, dir/diagnostic-notes, and steps/diagnostic-notes now, and block
    // ~/.devspec/notes inside startCommands so ALL note stores reject writes when
    // formatPickupRefusals runs.
    const blockedTmp = path.join(dir, 'tmp-all-blocked')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    fs.writeFileSync(path.join(dir, 'diagnostic-notes'), 'not-a-directory\n')
    fs.writeFileSync(path.join(dir, `${CONN}.steps`, 'diagnostic-notes'), 'not-a-directory\n')
    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    try {
      let lastRaw = null
      for (const part of outerParts) {
        lastRaw = await stepDeliveryHook(part.call, {
          home,
          dir,
          share: 320,
          listenerActive: () => true,
          startCommands: async () => {
            fs.rmSync(path.join(home, '.devspec', 'notes'), { recursive: true, force: true })
            fs.writeFileSync(path.join(home, '.devspec', 'notes'), 'not-a-directory\n')
            const hugeBlocker = { id: 'blk-too-large-for-share', reason: 'active_edit' }
            for (let i = 0; i < 30; i += 1) hugeBlocker[`field_${i}`] = i
            return {
              ok: false,
              outcome: 'refused',
              started: [],
              pickedUp: 0,
              refusals: [
                {
                  command_message_id: MSG_ID,
                  command_turn_id: TURN_ID,
                  refusal: {
                    code: 'turn_busy_all_unwritable',
                    blocking_items: [hugeBlocker],
                    detail: 'x'.repeat(4_000),
                  },
                },
              ],
            }
          },
        })
      }
      assert.ok(lastRaw, 'stepDeliveryHook must NEVER drop the entire diagnostic silently when all 3 note stores reject writes')
      const ctx = JSON.parse(lastRaw).additional_context
      assert.ok(ctx && ctx.length <= 320, `omission notice must fit hook share (320); got len=${ctx?.length}`)
      const parsed = JSON.parse(ctx)
      assert.equal(parsed.note_write_failed, true)
      assert.equal(parsed.omitted_due_to_hook_limit, true)
      assert.equal(parsed.omitted_count, 1)
      assert.equal(parsed.limit_chars, 320)
      assert.ok(parsed.actual_chars > 320)
      assert.deepEqual(parsed.codes, ['turn_busy_all_unwritable'])
      assert.match(parsed.recovery, /stderr/)
      assert.match(parsed.recovery, /~\/\.devspec\/notes/)
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('stepDeliveryHook merges concurrent HANDED note written while an earlier hook awaits a refused pickup so reading the fresh note triggers pickup for the fresh command too (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const MSG_1 = '33333333-3333-4333-8333-3333333333b1'
    const TURN_1 = '77777777-7777-4777-8777-7777777777b1'
    const MSG_2 = '33333333-3333-4333-8333-3333333333b2'
    const TURN_2 = '77777777-7777-4777-8777-7777777777b2'

    // Hand over command 1 first.
    const batch1 = ownerBatch('First command', { messageId: MSG_1, turnId: TURN_1 })
    holdForNextStep(CONN, batch1, buildOwnerMessageEvents(batch1), { dir })
    const handOver1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )
    const note1Id = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOver1).additional_context)[1]
    const note1Parts = noteFiles(home, note1Id).map((file) => catCall(home, file, { conversation: CONVERSATION }))

    // Hook 1 reads note 1 and awaits startCommands (which refuses). While Hook 1 is awaiting,
    // command 2 arrives and Hook 2 hands over note 2 into HANDED!
    let note2Id = null
    let hook2Raw = null
    let hook1Raw = null
    for (const partCall of note1Parts) {
      hook1Raw = await stepDeliveryHook(partCall, {
        home,
        dir,
        listenerActive: () => true,
        startCommands: async () => {
          const batch2 = ownerBatch('Second fresh command', { messageId: MSG_2, turnId: TURN_2 })
          holdForNextStep(CONN, batch2, buildOwnerMessageEvents(batch2), { dir })
          hook2Raw = await stepDeliveryHook(
            { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
            { home, dir, listenerActive: () => true },
          )
          note2Id = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(hook2Raw).additional_context)[1]
          return {
            ok: false,
            outcome: 'refused',
            started: [],
            pickedUp: 0,
            refusals: [
              {
                command_message_id: MSG_1,
                command_turn_id: TURN_1,
                refusal: { code: 'turn_busy_race', blocking_turn_id: 'blk-race-1' },
              },
            ],
          }
        },
      })
    }
    assert.ok(note2Id, 'Hook 2 must have handed over note 2')
    assert.ok(hook1Raw, 'Hook 1 must return context')

    // Now the agent reads note 2: Hook 3 MUST trigger pickup with BOTH MSG_1 (retry) AND MSG_2 (fresh)!
    const note2Parts = noteFiles(home, note2Id).map((file) => catCall(home, file, { conversation: CONVERSATION }))
    const pickedBatches = []
    for (const partCall of note2Parts) {
      await stepDeliveryHook(partCall, {
        home,
        dir,
        listenerActive: () => true,
        startCommands: async ({ commands }) => {
          pickedBatches.push(commands.map((c) => c.messageId))
          return { ok: true, outcome: 'picked_up', started: commands, pickedUp: commands.length, refusals: [] }
        },
      })
    }
    assert.equal(pickedBatches.length, 1)
    assert.ok(pickedBatches[0].includes(MSG_1), 'older refused command 1 must be retried')
    assert.ok(pickedBatches[0].includes(MSG_2), 'fresh concurrent command 2 must NOT be overwritten and MUST be picked up')
  })

  it('stepDeliveryHook surfaces BOTH a small refusal and an oversized blocking refusal together (shrinking only huge text) when all note stores reject writes (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const INLINE_MSG_ID = '33333333-3333-4333-8333-3333333333c1'
    const INLINE_TURN_ID = '77777777-7777-4777-8777-7777777777c1'
    const INNER_MSG_ID = '33333333-3333-4333-8333-3333333333c2'
    const INNER_TURN_ID = '77777777-7777-4777-8777-7777777777c2'

    const innerBatch = ownerBatch('Inner command for two-refusal check', { messageId: INNER_MSG_ID, turnId: INNER_TURN_ID })
    const innerNote = writeNote(wakeLines(buildOwnerMessageEvents(innerBatch)), { home })
    const innerNoteFile = noteFiles(home, innerNote.id)[0]
    const mixedBatch = ownerBatch('Inline command for two-refusal check', { messageId: INLINE_MSG_ID, turnId: INLINE_TURN_ID })
    const mixedEvents = [
      { type: 'wake_in_note', carries: ['owner_message'], read: innerNote.command, note: innerNote.id },
      ...buildOwnerMessageEvents(mixedBatch),
    ]
    holdForNextStep(CONN, mixedBatch, mixedEvents, { dir })

    const handOverRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo hi' }, tool_output: 'hi' },
      { home, dir, listenerActive: () => true },
    )
    const outerNoteId = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOverRaw).additional_context)[1]
    const outerParts = noteFiles(home, outerNoteId).map((file) => catCall(home, file, { conversation: CONVERSATION }))

    // Remove inner note AND block all 4 diagnostic note stores.
    fs.rmSync(innerNoteFile, { force: true })
    const blockedTmp = path.join(dir, 'tmp-two-refusals')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    fs.writeFileSync(path.join(dir, 'diagnostic-notes'), 'not-a-directory\n')
    fs.writeFileSync(path.join(dir, `${CONN}.steps`, 'diagnostic-notes'), 'not-a-directory\n')
    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    try {
      let lastRaw = null
      for (const partCall of outerParts) {
        lastRaw = await stepDeliveryHook(partCall, {
          home,
          dir,
          listenerActive: () => true,
          startCommands: async () => {
            fs.rmSync(path.join(home, '.devspec', 'notes'), { recursive: true, force: true })
            fs.writeFileSync(path.join(home, '.devspec', 'notes'), 'not-a-directory\n')
            return {
              ok: false,
              outcome: 'refused',
              started: [],
              pickedUp: 0,
              refusals: [
                {
                  command_message_id: INLINE_MSG_ID,
                  command_turn_id: INLINE_TURN_ID,
                  refusal: {
                    code: 'turn_busy_second_refusal',
                    blocking_items: [{ id: 'blk-second-1', reason: 'active_edit' }],
                    detail: 'y'.repeat(4_500),
                  },
                },
              ],
            }
          },
        })
      }
      assert.ok(lastRaw)
      const ctx = JSON.parse(lastRaw).additional_context
      assert.ok(ctx.length <= 3_300, `must fit normal hook share; got len=${ctx.length}`)
      assert.match(ctx, new RegExp(innerNote.id), 'must preserve Refusal 1 (unreadable inner note + read ref)')
      assert.match(ctx, /turn_busy_second_refusal/, 'must ALSO surface Refusal 2 code')
      assert.match(ctx, /blk-second-1/, 'must ALSO surface Refusal 2 blocking_items')
      assert.match(ctx, /"omitted_count":0/, 'both refusals must be returned with zero refusals dropped')
      assert.match(ctx, /"omitted_large_text":true/, 'only the oversized string leaf should be marked omitted')
      assert.match(ctx, /stderr/, 'recovery must honestly name hook stderr when all note stores rejected writes')
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('stepDeliveryHook logs ALL unreadable inner-note refusals (every note_id and read command) to stderr when no startCommands runs and all note stores reject writes (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    // Build a delivery containing 25 unreadable inner wake_in_note pointers (no inline command).
    const innerEvents = []
    const expectedIds = []
    for (let i = 0; i < 25; i += 1) {
      const fakeId = String(i).padStart(16, 'a')
      expectedIds.push(fakeId)
      innerEvents.push({
        type: 'wake_in_note',
        carries: ['owner_message'],
        read: `cat ~/.devspec/notes/${fakeId}.md`,
        note: fakeId,
      })
    }
    const batch = ownerBatch('Unreadable inner notes only')
    holdForNextStep(CONN, batch, innerEvents, { dir })

    const handOverRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo hi' }, tool_output: 'hi' },
      { home, dir, listenerActive: () => true },
    )
    const outerNoteId = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOverRaw).additional_context)[1]
    const outerParts = noteFiles(home, outerNoteId).map((file) => catCall(home, file, { conversation: CONVERSATION }))

    // Block all 4 note stores (make ~/.devspec/notes read-only 0o500 so outerNoteId can still be read!).
    const notesDir = path.join(home, '.devspec', 'notes')
    const blockedTmp = path.join(dir, 'tmp-unreadable-only')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    fs.writeFileSync(path.join(dir, 'diagnostic-notes'), 'not-a-directory\n')
    fs.writeFileSync(path.join(dir, `${CONN}.steps`, 'diagnostic-notes'), 'not-a-directory\n')
    fs.chmodSync(notesDir, 0o500)
    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    const stderrChunks = []
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(String(chunk))
      return origStderrWrite(chunk, ...rest)
    }
    try {
      let lastRaw = null
      for (const partCall of outerParts) {
        lastRaw = await stepDeliveryHook(partCall, { home, dir, listenerActive: () => true })
      }
      assert.ok(lastRaw)
      const ctx = JSON.parse(lastRaw).additional_context
      assert.match(ctx, /stderr/, 'fallback must direct agent to stderr when all note stores reject writes')
      const logged = stderrChunks.join('')
      for (const id of expectedIds) {
        assert.ok(logged.includes(id), `stderr MUST contain every omitted unreadable note_id (${id})`)
        assert.ok(logged.includes(`cat ~/.devspec/notes/${id}.md`), `stderr MUST contain read command for ${id}`)
      }
    } finally {
      process.stderr.write = origStderrWrite
      fs.chmodSync(notesDir, 0o700)
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('stepDeliveryHook preserves the older refused command retry even when saving the merged HANDED record fails after a parallel hook wrote a fresh note (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const MSG_1 = '33333333-3333-4333-8333-3333333333d1'
    const TURN_1 = '77777777-7777-4777-8777-7777777777d1'
    const MSG_2 = '33333333-3333-4333-8333-3333333333d2'
    const TURN_2 = '77777777-7777-4777-8777-7777777777d2'
    const stepsFolder = path.join(dir, `${CONN}.steps`)

    const batch1 = ownerBatch('Older command before concurrent write failure', { messageId: MSG_1, turnId: TURN_1 })
    holdForNextStep(CONN, batch1, buildOwnerMessageEvents(batch1), { dir })
    const handOver1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )
    const note1Id = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOver1).additional_context)[1]
    const note1Parts = noteFiles(home, note1Id).map((file) => catCall(home, file, { conversation: CONVERSATION }))

    let note2Id = null
    let chmodApplied = false
    try {
      for (const partCall of note1Parts) {
        await stepDeliveryHook(partCall, {
          home,
          dir,
          listenerActive: () => true,
          startCommands: async () => {
            const batch2 = ownerBatch('Fresh command during concurrent write failure', { messageId: MSG_2, turnId: TURN_2 })
            holdForNextStep(CONN, batch2, buildOwnerMessageEvents(batch2), { dir })
            const hook2Raw = await stepDeliveryHook(
              { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
              { home, dir, listenerActive: () => true },
            )
            note2Id = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(hook2Raw).additional_context)[1]
            // Make steps folder read-only right before Hook 1 tries to save the merged HANDED!
            fs.chmodSync(stepsFolder, 0o500)
            chmodApplied = true
            return {
              ok: false,
              outcome: 'refused',
              started: [],
              pickedUp: 0,
              refusals: [
                {
                  command_message_id: MSG_1,
                  command_turn_id: TURN_1,
                  refusal: { code: 'turn_busy_write_err', blocking_turn_id: 'blk-write-err-1' },
                },
              ],
            }
          },
        })
      }
    } finally {
      if (chmodApplied) fs.chmodSync(stepsFolder, 0o700)
    }

    assert.ok(note2Id)
    // Now the write error clears and the agent reads note 2: BOTH MSG_1 AND MSG_2 MUST be picked up!
    const note2Parts = noteFiles(home, note2Id).map((file) => catCall(home, file, { conversation: CONVERSATION }))
    const picked = []
    for (const partCall of note2Parts) {
      await stepDeliveryHook(partCall, {
        home,
        dir,
        listenerActive: () => true,
        startCommands: async ({ commands }) => {
          picked.push(commands.map((c) => c.messageId))
          return { ok: true, outcome: 'picked_up', started: commands, pickedUp: commands.length, refusals: [] }
        },
      })
    }
    assert.equal(picked.length, 1)
    assert.ok(picked[0].includes(MSG_1), 'older refused command MUST NOT be discarded when merged HANDED write fails')
    assert.ok(picked[0].includes(MSG_2), 'fresh concurrent command MUST still be picked up')
  })

  it('stepDeliveryHook NEVER picks up a reclaimed abandoned unread note on an unrelated tool step; it re-offers both commands until the note is read whole (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const MSG_OLD = '33333333-3333-4333-8333-3333333333e1'
    const TURN_OLD = '77777777-7777-4777-8777-7777777777e1'
    const MSG_NEW = '33333333-3333-4333-8333-3333333333e2'
    const TURN_NEW = '77777777-7777-4777-8777-7777777777e2'
    const stepsFolder = path.join(dir, `${CONN}.steps`)
    const handedPath = path.join(stepsFolder, 'handed.json')

    // Step 1: hand over older unread note 1 into HANDED and snapshot it as a dead hook's taken file.
    const batchOld = ownerBatch('Older unread command from dead hook', { messageId: MSG_OLD, turnId: TURN_OLD })
    holdForNextStep(CONN, batchOld, buildOwnerMessageEvents(batchOld), { dir })
    const handOverOld = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )
    assert.ok(handOverOld)
    const deadTakenJson = fs.readFileSync(handedPath, 'utf8')
    fs.rmSync(handedPath, { force: true })

    // Step 2: a parallel hook hands over newer command 2 into a fresh unread `handed.json`.
    const batchNew = ownerBatch('Newer unread command from parallel hook', { messageId: MSG_NEW, turnId: TURN_NEW })
    holdForNextStep(CONN, batchNew, buildOwnerMessageEvents(batchNew), { dir })
    const handOverNew = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
      { home, dir, listenerActive: () => true },
    )
    assert.ok(handOverNew)

    // Place the dead hook's unread `handed.json.taken-<deadPid>-...` alongside the newer `handed.json`
    // so `reclaimAbandoned()` MUST move it to `retry-*.json` and `consumeOverflowEntry()` drains it!
    const deadTakenPath = path.join(stepsFolder, 'handed.json.taken-99999999-deadbeef')
    fs.writeFileSync(deadTakenPath, deadTakenJson, { mode: 0o600 })

    // Unrelated tool step: MUST NOT call startCommands for the reclaimed unread note!
    const picked = []
    const spyStart = async ({ commands }) => {
      picked.push(commands.map((c) => c.messageId))
      return { ok: true, outcome: 'picked_up', started: commands, pickedUp: commands.length, refusals: [] }
    }
    const unrelatedRaw = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo unrelated' }, tool_output: 'unrelated' },
      { home, dir, listenerActive: () => true, startCommands: spyStart },
    )
    assert.equal(picked.length, 0, 'unrelated tool step MUST NOT call startCommands for an unread reclaimed note')
    assert.ok(unrelatedRaw, 'unrelated step must re-offer the combined unread note')
    const mergedHanded = JSON.parse(fs.readFileSync(handedPath, 'utf8'))
    assert.equal(mergedHanded.note_read, false, 'merged HANDED must remain unread until read whole')
    const combinedNoteId = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(unrelatedRaw).additional_context)[1]
    const combinedText = readNoteText(combinedNoteId, { home })
    assert.ok(combinedText.includes(MSG_OLD), 'combined unread note must contain the older reclaimed command')
    assert.ok(combinedText.includes(MSG_NEW), 'combined unread note must contain the newer command')

    // Once the agent actually reads the combined note whole, BOTH commands are picked up together.
    const combinedParts = noteFiles(home, combinedNoteId).map((file) => catCall(home, file, { conversation: CONVERSATION }))
    for (const partCall of combinedParts) {
      await stepDeliveryHook(partCall, { home, dir, listenerActive: () => true, startCommands: spyStart })
    }
    assert.equal(picked.length, 1, 'reading the combined note whole must trigger pickup once')
    assert.ok(picked[0].includes(MSG_OLD))
    assert.ok(picked[0].includes(MSG_NEW))
  })

  it('readWakes emits a Shell-bounded omission + recovery notice when the last writable diagnostic store fails after preflight on a near-ceiling wake with an oversized refusal (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    // Make ~/.devspec/notes and TMPDIR unwritable BEFORE preflight so ONLY dir/diagnostic-notes
    // lets preflight pass; then block dir/diagnostic-notes DURING startCommands!
    const blockedNotes = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(blockedNotes), { recursive: true, mode: 0o700 })
    fs.writeFileSync(blockedNotes, 'not-a-directory\n')
    const blockedTmp = path.join(dir, 'tmp-midflight-blocked')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    const diagDir = path.join(dir, 'diagnostic-notes')

    // Build a near-ceiling wake that fits right beside readerHeader + pickupDiagnosticReserve.
    const reserveLen = shellDiagnosticReserve('devspec-wake-tail', { fallbackDir: diagDir }).length
    const baseLen = wakeLines(buildOwnerMessageEvents(ownerBatch(''))).length
    const perChar = (wakeLines(buildOwnerMessageEvents(ownerBatch('x'.repeat(100)))).length - baseLen) / 100
    const padLen = Math.max(500, Math.floor((CURSOR_SHELL_OUTPUT_MAX_CHARS - reserveLen - baseLen - 200) / perChar))
    const batch = ownerBatch('x'.repeat(padLen))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(batch))

    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    const stdoutChunks = []
    const stderrChunks = []
    try {
      const page = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home,
        dir,
        settleMs: 1,
        scriptPath: '/tmp/tail.mjs',
        write: async (text) => {
          stdoutChunks.push(text)
        },
        writeStderr: (text) => {
          stderrChunks.push(text)
        },
        startCommands: async () => {
          // Last writable diagnostic store becomes unwritable AFTER preflight!
          fs.rmSync(diagDir, { recursive: true, force: true })
          fs.writeFileSync(diagDir, 'not-a-directory\n')
          const hugeBlocker = { id: 'blk-wake-midflight', reason: 'active_edit' }
          for (let i = 0; i < 120; i += 1) hugeBlocker[`field_${i}`] = i
          return {
            ok: false,
            outcome: 'refused',
            started: [],
            pickedUp: 0,
            refusals: [
              {
                command_message_id: MSG_ID,
                command_turn_id: TURN_ID,
                refusal: {
                  code: 'turn_busy_midflight_unwritable',
                  blocking_items: [hugeBlocker],
                  detail: 'z'.repeat(4_500),
                },
              },
            ],
          }
        },
      })
      const printedOut = stdoutChunks.join('')
      const printedErr = stderrChunks.join('')
      assert.equal(page.printed, 1, 'near-ceiling wake must have printed inline before startCommands')
      assert.ok(printedOut.length > 18_500, `wake output must be near Shell ceiling; got ${printedOut.length}`)
      assert.equal(page.marked, false, 'wake cursor must NOT advance on refused pickup')
      assert.equal(page.pickup_diagnostic_written, true, 'must mark pickup_diagnostic_written=true so stderr notice is reported')
      assert.ok(printedErr.length > 0, 'must NEVER silently drop stderr diagnostic when last note store fails mid-pickup')
      assert.ok(
        fitsShellOutput(printedOut + printedErr),
        `combined stdout+stderr must fit Shell ceiling (${CURSOR_SHELL_OUTPUT_MAX_CHARS}); got ${(printedOut + printedErr).length}`,
      )
      assert.ok(page.pickup_diagnostic_note?.file, 'must save the original oversized refusal to a preflight-reserved slot')
      assert.ok(
        printedErr.includes(page.pickup_diagnostic_note.command),
        `stderr must include the exact read command for the original refusal; got: ${printedErr}`,
      )
      const savedOriginal = fs.readFileSync(page.pickup_diagnostic_note.file, 'utf8')
      assert.match(savedOriginal, /turn_busy_midflight_unwritable/, 'saved file must preserve refusal code verbatim')
      assert.match(savedOriginal, /blk-wake-midflight/, 'saved file must preserve blocking_items verbatim')
      assert.match(savedOriginal, /field_119/, 'saved file must preserve every field of the oversized blocking record')
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('stepDeliveryHook retains inner_note_pending when finishing a reclaimed outer note while its inner wake_in_note is temporarily unavailable, and triggers pickup once the inner note returns (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const INNER_MSG = '33333333-3333-4333-8333-3333333333f1'
    const INNER_TURN = '77777777-7777-4777-8777-7777777777f1'
    const OTHER_MSG = '33333333-3333-4333-8333-3333333333f2'
    const OTHER_TURN = '77777777-7777-4777-8777-7777777777f2'
    const stepsFolder = path.join(dir, `${CONN}.steps`)
    const handedPath = path.join(stepsFolder, 'handed.json')

    // Outer note 1 carries an inner wake_in_note pointer.
    const innerBatch = ownerBatch('Reclaimed inner note command', { messageId: INNER_MSG, turnId: INNER_TURN })
    const innerNote = writeNote(wakeLines(buildOwnerMessageEvents(innerBatch)), { home })
    const innerNoteFile = noteFiles(home, innerNote.id)[0]
    const savedInnerContent = fs.readFileSync(innerNoteFile, 'utf8')
    const outerEvents = [
      { type: 'wake_in_note', carries: ['owner_message'], read: innerNote.command, note: innerNote.id },
    ]
    holdForNextStep(CONN, innerBatch, outerEvents, { dir })
    const handOver1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )
    const outerNote1Id = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOver1).additional_context)[1]
    const outer1Json = fs.readFileSync(handedPath, 'utf8')
    fs.rmSync(handedPath, { force: true })

    // Parallel hook hands over a second note into HANDED, then hook 1 dies leaving outer1 as a dead taken file.
    const otherBatch = ownerBatch('Other command', { messageId: OTHER_MSG, turnId: OTHER_TURN })
    holdForNextStep(CONN, otherBatch, buildOwnerMessageEvents(otherBatch), { dir })
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
      { home, dir, listenerActive: () => true },
    )
    // Remove HANDED? No, keep HANDED with otherBatch (or read it) and put outer1 as dead taken file:
    // Actually simulate exact scenario where HANDED exists (so reclaimAbandoned moves outer1 to retry-*.json),
    // AND remove innerNoteFile before the agent finishes reading outerNote1Id!
    fs.writeFileSync(path.join(stepsFolder, 'handed.json.taken-99999999-deadbeef'), outer1Json, { mode: 0o600 })
    fs.rmSync(innerNoteFile, { force: true })

    const picked = []
    const spyStart = async ({ commands }) => {
      picked.push(commands.map((c) => c.messageId))
      return { ok: true, outcome: 'picked_up', started: commands, pickedUp: commands.length, refusals: [] }
    }
    const outer1Parts = noteFiles(home, outerNote1Id).map((file) => catCall(home, file, { conversation: CONVERSATION }))
    for (const partCall of outer1Parts) {
      await stepDeliveryHook(partCall, { home, dir, listenerActive: () => true, startCommands: spyStart })
    }
    assert.equal(picked.length, 0, 'unavailable inner note must not trigger pickup yet')
    const afterHanded = JSON.parse(fs.readFileSync(handedPath, 'utf8'))
    assert.equal(afterHanded.inner_note_pending, true, 'inner_note_pending MUST be retained on HANDED after reading reclaimed outer note')

    // Restore the inner note, run a step to register wake-note-<innerId>.json, then read the inner note whole!
    fs.writeFileSync(innerNoteFile, savedInnerContent)
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo retry' }, tool_output: 'retry' },
      { home, dir, listenerActive: () => true, startCommands: spyStart },
    )
    const innerParts = noteFiles(home, innerNote.id).map((file) => catCall(home, file, { conversation: CONVERSATION }))
    for (const partCall of innerParts) {
      await stepDeliveryHook(partCall, { home, dir, listenerActive: () => true, startCommands: spyStart })
    }
    assert.equal(picked.length, 1, 'reading the restored inner note MUST trigger pickup')
    assert.ok(picked[0].includes(INNER_MSG))
  })

  it('readWakes reserved diagnostic slot paginates a 60,000-character refusal with exact Shell-bounded continuation commands so following them recovers the blocking record at the end (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const { execSync } = await import('node:child_process')
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    const blockedNotes = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(blockedNotes), { recursive: true, mode: 0o700 })
    fs.writeFileSync(blockedNotes, 'not-a-directory\n')
    const blockedTmp = path.join(dir, 'tmp-60k-blocked')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    const diagDir = path.join(dir, 'diagnostic-notes')

    const reserveLen = shellDiagnosticReserve('devspec-wake-tail', { fallbackDir: diagDir }).length
    const baseLen = wakeLines(buildOwnerMessageEvents(ownerBatch(''))).length
    const perChar = (wakeLines(buildOwnerMessageEvents(ownerBatch('x'.repeat(100)))).length - baseLen) / 100
    const padLen = Math.max(500, Math.floor((CURSOR_SHELL_OUTPUT_MAX_CHARS - reserveLen - baseLen - 200) / perChar))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('x'.repeat(padLen))))

    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    const stdoutChunks = []
    const stderrChunks = []
    try {
      const page = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home,
        dir,
        settleMs: 1,
        scriptPath: '/tmp/tail.mjs',
        write: async (text) => { stdoutChunks.push(text) },
        writeStderr: (text) => { stderrChunks.push(text) },
        startCommands: async () => {
          fs.rmSync(diagDir, { recursive: true, force: true })
          fs.writeFileSync(diagDir, 'not-a-directory\n')
          return {
            ok: false,
            outcome: 'refused',
            started: [],
            pickedUp: 0,
            refusals: [
              {
                command_message_id: MSG_ID,
                command_turn_id: TURN_ID,
                refusal: {
                  code: 'turn_busy_60k',
                  padding: 'p'.repeat(58_000),
                  blocking_items: [{ id: 'blk-tail-end-marker', reason: 'active_edit_at_tail' }],
                },
              },
            ],
          }
        },
      })
      const printedOut = stdoutChunks.join('')
      const printedErr = stderrChunks.join('')
      assert.equal(page.marked, false)
      assert.ok(fitsShellOutput(printedOut + printedErr), 'combined stdout+stderr must fit Shell ceiling')
      const firstCmd = page.pickup_diagnostic_note?.command
      assert.ok(firstCmd && firstCmd.startsWith('head -c '), `expected paged head -c command; got ${firstCmd}`)
      assert.ok(printedErr.includes(firstCmd), 'stderr must advertise the exact first-page read command')

      // Follow the exact advertised command and every `next part` continuation command!
      let currentCmd = firstCmd
      let pagesRead = 0
      let collected = ''
      while (currentCmd) {
        const out = execSync(currentCmd, { encoding: 'utf8' })
        assert.ok(fitsShellOutput(out), `page ${pagesRead + 1} (${out.length} chars) must fit Shell ceiling`)
        collected += out
        pagesRead += 1
        assert.ok(pagesRead <= 10, 'must terminate cleanly within expected part count')
        const nextMatch = /next part \(\d+\/\d+\): (tail -c \+\d+ '[^']+' \| head -c \d+) ---/.exec(out)
        currentCmd = nextMatch ? nextMatch[1] : null
      }
      assert.ok(pagesRead >= 4, `60k refusal must span multiple Shell-sized pages; read ${pagesRead}`)
      assert.match(collected, /turn_busy_60k/, 'must recover refusal code')
      assert.match(collected, /blk-tail-end-marker/, 'following continuations MUST recover the blocking record at the end of the 60k payload')
      assert.match(collected, /active_edit_at_tail/)
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('releaseAtIdle preserves a refused command awaiting pickup retry when handing over fresh unread commands at idle (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    const MSG_REFUSED = '33333333-3333-4333-8333-333333333391'
    const TURN_REFUSED = '77777777-7777-4777-8777-777777777791'
    const MSG_FRESH_1 = '33333333-3333-4333-8333-333333333392'
    const TURN_FRESH_1 = '77777777-7777-4777-8777-777777777792'
    const MSG_FRESH_2 = '33333333-3333-4333-8333-333333333393'
    const TURN_FRESH_2 = '77777777-7777-4777-8777-777777777793'

    // Step 1: deliver and read command 1, whose report_pickup refuses so HANDED has pickup_pending=true.
    const batch1 = ownerBatch('Refused command awaiting retry', { messageId: MSG_REFUSED, turnId: TURN_REFUSED })
    holdForNextStep(CONN, batch1, buildOwnerMessageEvents(batch1), { dir })
    const handOver1 = await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )
    const note1Id = /~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(JSON.parse(handOver1).additional_context)[1]
    for (const file of noteFiles(home, note1Id)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands: async () => ({
          ok: false,
          outcome: 'refused',
          started: [],
          pickedUp: 0,
          refusals: [{ command_message_id: MSG_REFUSED, command_turn_id: TURN_REFUSED, refusal: { code: 'turn_busy' } }],
        }),
      })
    }

    // Step 2: two fresh commands arrive in waiting files right as Cursor goes idle!
    const fresh1 = ownerBatch('Fresh idle command 1', { messageId: MSG_FRESH_1, turnId: TURN_FRESH_1 })
    const fresh2 = ownerBatch('Fresh idle command 2', { messageId: MSG_FRESH_2, turnId: TURN_FRESH_2 })
    holdForNextStep(CONN, fresh1, buildOwnerMessageEvents(fresh1), { dir })
    holdForNextStep(CONN, fresh2, buildOwnerMessageEvents(fresh2), { dir })

    const released = await releaseAtIdle(CONN, {
      dir,
      state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
      wakeFile,
      home,
      turnState: 'between',
    })
    assert.ok(released?.note, 'releaseAtIdle must hand over the fresh unread commands')
    const wakeNoteText = readNoteText(released.note, { home })
    assert.ok(wakeNoteText.includes(MSG_FRESH_1))
    assert.ok(wakeNoteText.includes(MSG_FRESH_2))

    // Step 3: when the agent wakes and reads the idle wake note, BOTH the previously refused
    // command (from pickup_pending retry!) AND the two fresh commands MUST be passed to startCommands!
    const picked = []
    for (const file of noteFiles(home, released.note)) {
      await stepDeliveryHook(catCall(home, file, { conversation: CONVERSATION }), {
        home,
        dir,
        listenerActive: () => true,
        startCommands: async ({ commands }) => {
          picked.push(...commands.map((c) => c.messageId))
          return { ok: true, outcome: 'picked_up', started: commands, pickedUp: commands.length, refusals: [] }
        },
      })
    }
    assert.ok(picked.includes(MSG_REFUSED), 'refused command MUST NOT be dropped from retry queue by releaseAtIdle')
    assert.ok(picked.includes(MSG_FRESH_1), 'fresh command 1 must be picked up once read')
    assert.ok(picked.includes(MSG_FRESH_2), 'fresh command 2 must be picked up once read')
  })

  it('readWakes reserved diagnostic slot keeps EVERY page + continuation footer inside fitsShellOutput even under a 2,500-char deep directory path (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const { execSync } = await import('node:child_process')
    const { home } = mkHome()
    // Build a valid ~2,500-char deep directory path inside home so the quoted path inside
    // each continuation footer would have pushed 18,000 + footer > 20,000 chars!
    const deepSegments = Array.from({ length: 12 }, (_, i) => `nested-dir-segment-${String(i).padStart(2, '0')}-${'a'.repeat(180)}`)
    const deepDir = path.join(home, ...deepSegments)
    fs.mkdirSync(deepDir, { recursive: true, mode: 0o700 })
    const wakeFile = path.join(deepDir, `${CONN}.wakes`)
    const blockedNotes = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(blockedNotes), { recursive: true, mode: 0o700 })
    fs.writeFileSync(blockedNotes, 'not-a-directory\n')
    const blockedTmp = path.join(deepDir, 'tmp-deep-blocked')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    const diagDir = path.join(deepDir, 'diagnostic-notes')

    const reserveLen = shellDiagnosticReserve('devspec-wake-tail', { fallbackDir: diagDir }).length
    const baseLen = wakeLines(buildOwnerMessageEvents(ownerBatch(''))).length
    const perChar = (wakeLines(buildOwnerMessageEvents(ownerBatch('x'.repeat(100)))).length - baseLen) / 100
    const padLen = Math.max(500, Math.floor((CURSOR_SHELL_OUTPUT_MAX_CHARS - reserveLen - baseLen - 200) / perChar))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('x'.repeat(padLen))))

    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    const stdoutChunks = []
    const stderrChunks = []
    try {
      const page = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home,
        dir: deepDir,
        settleMs: 1,
        scriptPath: '/tmp/tail.mjs',
        write: async (text) => { stdoutChunks.push(text) },
        writeStderr: (text) => { stderrChunks.push(text) },
        startCommands: async () => {
          fs.rmSync(diagDir, { recursive: true, force: true })
          fs.writeFileSync(diagDir, 'not-a-directory\n')
          return {
            ok: false,
            outcome: 'refused',
            started: [],
            pickedUp: 0,
            refusals: [
              {
                command_message_id: MSG_ID,
                command_turn_id: TURN_ID,
                refusal: {
                  code: 'turn_busy_deep_path',
                  padding: 'q'.repeat(58_000),
                  blocking_items: [{ id: 'blk-deep-path-tail', reason: 'deep_path_preserved' }],
                },
              },
            ],
          }
        },
      })
      const printedOut = stdoutChunks.join('')
      const printedErr = stderrChunks.join('')
      assert.equal(page.marked, false)
      assert.ok(fitsShellOutput(printedOut + printedErr), 'combined stdout+stderr must fit Shell ceiling')
      const firstCmd = page.pickup_diagnostic_note?.command
      assert.ok(firstCmd && firstCmd.startsWith('head -c '))
      assert.ok(printedErr.includes(firstCmd))

      let currentCmd = firstCmd
      let pagesRead = 0
      let collected = ''
      while (currentCmd) {
        const out = execSync(currentCmd, { encoding: 'utf8' })
        assert.ok(
          fitsShellOutput(out),
          `deep-path page ${pagesRead + 1} (${out.length} chars) MUST fit Shell ceiling (${CURSOR_SHELL_OUTPUT_MAX_CHARS})`,
        )
        collected += out
        pagesRead += 1
        assert.ok(pagesRead <= 12)
        const nextMatch = /next part \(\d+\/\d+\): (tail -c \+\d+ '[^']+' \| head -c \d+) ---/.exec(out)
        currentCmd = nextMatch ? nextMatch[1] : null
      }
      assert.ok(pagesRead >= 4)
      assert.match(collected, /turn_busy_deep_path/)
      assert.match(collected, /blk-deep-path-tail/)
      assert.match(collected, /deep_path_preserved/)
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('releaseAtIdle merges a concurrent HANDED note written by a parallel tool hook while awaiting isOpen instead of overwriting it (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    const MSG_OLD = '33333333-3333-4333-8333-3333333333a1'
    const TURN_OLD = '77777777-7777-4777-8777-7777777777a1'
    const MSG_CONCURRENT = '33333333-3333-4333-8333-3333333333a2'
    const TURN_CONCURRENT = '77777777-7777-4777-8777-7777777777a2'

    // Hand over older command 1 first.
    const batchOld = ownerBatch('Older command checked by releaseAtIdle', { messageId: MSG_OLD, turnId: TURN_OLD })
    holdForNextStep(CONN, batchOld, buildOwnerMessageEvents(batchOld), { dir })
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )

    // While releaseAtIdle awaits `isOpen` on the older item, a parallel tool hook hands over
    // a newer command into HANDED!
    let concurrentHanded = false
    const released = await releaseAtIdle(CONN, {
      dir,
      state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
      wakeFile,
      home,
      turnState: 'between',
      isOpen: async () => {
        if (!concurrentHanded) {
          concurrentHanded = true
          const batchNew = ownerBatch('Newer concurrent command during releaseAtIdle', {
            messageId: MSG_CONCURRENT,
            turnId: TURN_CONCURRENT,
          })
          holdForNextStep(CONN, batchNew, buildOwnerMessageEvents(batchNew), { dir })
          await stepDeliveryHook(
            { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
            { home, dir, listenerActive: () => true },
          )
        }
        return true
      },
    })

    assert.ok(released?.note, 'releaseAtIdle must write combined idle wake note')
    const combinedText = readNoteText(released.note, { home })
    assert.ok(combinedText.includes(MSG_OLD), 'idle note must retain older command')
    assert.ok(combinedText.includes(MSG_CONCURRENT), 'idle note MUST preserve concurrent command handed over while awaiting isOpen')
    const handedRecord = JSON.parse(fs.readFileSync(path.join(dir, `${CONN}.steps`, 'handed.json'), 'utf8'))
    assert.ok(
      handedRecord.items.some((item) => item.events.some((e) => e.message?.message_id === MSG_CONCURRENT)),
      'HANDED record MUST still track the concurrent newer command',
    )
  })

  it('reserveDiagnosticNoteSlots handles partial fs.writeSync writes (loops to completion, and rejects/falls back if a slot cannot write all bytes) (3c5147a7 / 91d7b47c)', async () => {
    const { execSync } = await import('node:child_process')
    const { reserveDiagnosticNoteSlots } = await import('./hook-context-budget.mjs')
    const { home, dir } = mkHome()
    const payload = JSON.stringify({
      code: 'turn_busy_partial_write',
      padding: 'w'.repeat(45_000),
      blocking_items: [{ id: 'blk-partial-write-tail', reason: 'must_reach_disk_whole' }],
    })

    // 1. Chunked short writes (1,200 bytes per writeSync call) -> MUST loop until all bytes reach disk!
    const store1 = reserveDiagnosticNoteSlots({ home, fallbackDir: path.join(dir, 'diagnostic-notes'), backupDir: dir })
    assert.equal(store1.ok, true)
    const origWriteSync = fs.writeSync
    let writeCalls = 0
    fs.writeSync = (fd, buffer, offset, length, position) => {
      if (fd === store1.slots[0].fd) {
        writeCalls += 1
        return origWriteSync(fd, buffer, offset, Math.min(length, 1200), position)
      }
      return origWriteSync(fd, buffer, offset, length, position)
    }
    let note1 = null
    try {
      note1 = store1.write(payload)
    } finally {
      fs.writeSync = origWriteSync
      store1.release()
    }
    assert.ok(writeCalls > 20, `expected chunked write loop (>20 calls); got ${writeCalls}`)
    assert.ok(note1?.command?.startsWith('head -c '), `expected paginated command; got ${note1?.command}`)
    let cmd = note1.command
    let collected = ''
    while (cmd) {
      const out = execSync(cmd, { encoding: 'utf8' })
      assert.ok(fitsShellOutput(out))
      collected += out
      const next = /next part \(\d+\/\d+\): (tail -c \+\d+ '[^']+' \| head -c \d+) ---/.exec(out)
      cmd = next ? next[1] : null
    }
    assert.match(collected, /blk-partial-write-tail/, 'looped short writes must deliver full blocking record at tail')

    // 2. Primary slot writes ONLY 1,200 bytes then stops (returns 0) -> MUST NOT advertise truncated primary, falls back to complete backup slot!
    const store2 = reserveDiagnosticNoteSlots({ home, fallbackDir: path.join(dir, 'diagnostic-notes'), backupDir: dir })
    assert.equal(store2.ok, true)
    assert.ok(store2.slots.length >= 2, 'must have primary + backup slot')
    const primaryFd = store2.slots[0].fd
    const primaryFile = store2.slots[0].filePath
    const backupFile = store2.slots[1].filePath
    let primaryFirstDone = false
    fs.writeSync = (fd, buffer, offset, length, position) => {
      if (fd === primaryFd) {
        if (!primaryFirstDone) {
          primaryFirstDone = true
          return origWriteSync(fd, buffer, offset, Math.min(length, 1200), position)
        }
        return 0
      }
      return origWriteSync(fd, buffer, offset, length, position)
    }
    let note2 = null
    try {
      note2 = store2.write(payload)
    } finally {
      fs.writeSync = origWriteSync
      store2.release()
    }
    assert.ok(note2, 'must succeed via backup slot when primary short-writes')
    assert.equal(note2.file, backupFile, 'must advertise accessible complete backup slot, NEVER truncated primary')
    assert.notEqual(note2.file, primaryFile)
    let cmd2 = note2.command
    let collected2 = ''
    while (cmd2) {
      const out = execSync(cmd2, { encoding: 'utf8' })
      assert.ok(fitsShellOutput(out))
      collected2 += out
      const next = /next part \(\d+\/\d+\): (tail -c \+\d+ '[^']+' \| head -c \d+) ---/.exec(out)
      cmd2 = next ? next[1] : null
    }
    assert.match(collected2, /blk-partial-write-tail/, 'backup slot must carry full blocking record and continuations')

    // 3. ALL slots short-write (only 1,200 bytes) -> MUST return null rather than advertising an unmarked fragment!
    const store3 = reserveDiagnosticNoteSlots({ home, fallbackDir: path.join(dir, 'diagnostic-notes'), backupDir: dir })
    const allFds = new Set(store3.slots.map((s) => s.fd))
    const doneOnce = new Set()
    fs.writeSync = (fd, buffer, offset, length, position) => {
      if (allFds.has(fd)) {
        if (!doneOnce.has(fd)) {
          doneOnce.add(fd)
          return origWriteSync(fd, buffer, offset, Math.min(length, 1200), position)
        }
        return 0
      }
      return origWriteSync(fd, buffer, offset, length, position)
    }
    let note3 = null
    try {
      note3 = store3.write(payload)
    } finally {
      fs.writeSync = origWriteSync
      store3.release()
    }
    assert.equal(note3, null, 'must return null instead of advertising a truncated 1,200-byte fragment')
  })

  it('readWakes falls back to the accessible backup slot when primary notes dir loses read access (chmod 0o000) during pickup so the advertised command is actually readable (4e32d1a5)', async () => {
    const { execSync } = await import('node:child_process')
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    const blockedNotes = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(blockedNotes), { recursive: true, mode: 0o700 })
    fs.writeFileSync(blockedNotes, 'not-a-directory\n')
    const blockedTmp = path.join(dir, 'tmp-chmod000-blocked')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    const diagDir = path.join(dir, 'diagnostic-notes')

    const reserveLen = shellDiagnosticReserve('devspec-wake-tail', { home, fallbackDir: diagDir }).length
    const baseLen = wakeLines(buildOwnerMessageEvents(ownerBatch(''))).length
    const perChar = (wakeLines(buildOwnerMessageEvents(ownerBatch('x'.repeat(100)))).length - baseLen) / 100
    const padLen = Math.max(500, Math.floor((CURSOR_SHELL_OUTPUT_MAX_CHARS - reserveLen - baseLen - 200) / perChar))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('x'.repeat(padLen))))

    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    const stderrChunks = []
    let chmodApplied = false
    try {
      const page = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home,
        dir,
        settleMs: 1,
        scriptPath: '/tmp/tail.mjs',
        write: async () => {},
        writeStderr: (text) => { stderrChunks.push(text) },
        startCommands: async () => {
          // Primary diagnostic dir loses ALL read/traverse access during pickup!
          fs.chmodSync(diagDir, 0o000)
          chmodApplied = true
          return {
            ok: false,
            outcome: 'refused',
            started: [],
            pickedUp: 0,
            refusals: [
              {
                command_message_id: MSG_ID,
                command_turn_id: TURN_ID,
                refusal: {
                  code: 'turn_busy_chmod000',
                  padding: 'r'.repeat(5_000),
                  blocking_items: [{ id: 'blk-readable-backup-item', reason: 'must_not_permission_denied' }],
                },
              },
            ],
          }
        },
      })
      assert.equal(page.marked, false)
      assert.ok(page.pickup_diagnostic_note?.command, 'must advertise readable backup slot command')
      assert.equal(
        path.dirname(page.pickup_diagnostic_note.file),
        dir,
        'must use accessible backup slot in dir rather than unreadable chmod-000 primary dir',
      )
      assert.ok(stderrChunks.join('').includes(page.pickup_diagnostic_note.command))
      // Running the advertised command RIGHT NOW (while diagDir is STILL 0o000!) MUST succeed!
      const readOut = execSync(page.pickup_diagnostic_note.command, { encoding: 'utf8' })
      assert.match(readOut, /turn_busy_chmod00/)
      assert.match(readOut, /blk-readable-backup-item/)
      assert.match(readOut, /must_not_permission_denied/)
    } finally {
      if (chmodApplied) fs.chmodSync(diagDir, 0o700)
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('releaseAtIdle preserves BOTH the older unread command AND the concurrent newer command when appending the merged idle wake fails (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    const MSG_OLD = '33333333-3333-4333-8333-3333333333b1'
    const TURN_OLD = '77777777-7777-4777-8777-7777777777b1'
    const MSG_NEW = '33333333-3333-4333-8333-3333333333b2'
    const TURN_NEW = '77777777-7777-4777-8777-7777777777b2'

    // Step 1: hand over older unread command 1 into HANDED.
    const batchOld = ownerBatch('Older unread command before failed append', { messageId: MSG_OLD, turnId: TURN_OLD })
    holdForNextStep(CONN, batchOld, buildOwnerMessageEvents(batchOld), { dir })
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )

    // Step 2: releaseAtIdle runs; while awaiting isOpen, a second hook hands over newer command 2;
    // then appendWakeEvents throws!
    let concurrentHanded = false
    await assert.rejects(
      () =>
        releaseAtIdle(CONN, {
          dir,
          state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
          wakeFile,
          home,
          turnState: 'between',
          isOpen: async () => {
            if (!concurrentHanded) {
              concurrentHanded = true
              const batchNew = ownerBatch('Newer concurrent command before failed append', {
                messageId: MSG_NEW,
                turnId: TURN_NEW,
              })
              holdForNextStep(CONN, batchNew, buildOwnerMessageEvents(batchNew), { dir })
              await stepDeliveryHook(
                { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
                { home, dir, listenerActive: () => true },
              )
            }
            return true
          },
          append: () => {
            throw new Error('simulated transient wake file EIO')
          },
        }),
      /simulated transient wake file EIO/,
    )

    // Step 3: Subsequent successful releaseAtIdle MUST deliver BOTH the older AND the newer unread commands!
    const released = await releaseAtIdle(CONN, {
      dir,
      state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
      wakeFile,
      home,
      turnState: 'between',
    })
    assert.ok(released?.note, 'subsequent releaseAtIdle must produce merged idle wake note')
    const combinedText = readNoteText(released.note, { home })
    assert.ok(combinedText.includes(MSG_OLD), 'older unread command MUST NOT be dropped by rollback after append failure')
    assert.ok(combinedText.includes(MSG_NEW), 'newer concurrent command MUST also be present in idle wake note')
    const handedRecord = JSON.parse(fs.readFileSync(path.join(dir, `${CONN}.steps`, 'handed.json'), 'utf8'))
    assert.ok(
      handedRecord.items.some((item) => item.events.some((e) => e.message?.message_id === MSG_OLD)),
      'HANDED record must still track older command',
    )
    assert.ok(
      handedRecord.items.some((item) => item.events.some((e) => e.message?.message_id === MSG_NEW)),
      'HANDED record must still track newer command',
    )
  })

  it('writeNote and writeFallbackDiagnosticNote never reuse a cached multi-part note whose continuation page is missing: repair when writable, fall back when read-only (3c5147a7 / 4e32d1a5 / 91d7b47c)', async () => {
    const { fitShellDiagnostic, writeFallbackDiagnosticNote } = await import('./hook-context-budget.mjs')
    const { home, dir } = mkHome()
    const refusalText = JSON.stringify({
      code: 'turn_busy_cached_note',
      padding: 'k'.repeat(25_000),
      blocking_items: [{ id: 'blk-second-page-tail', reason: 'must_reach_part_2' }],
    })

    // 1. Primary ~/.devspec/notes: seed cached 2-part note, delete part 2, make notes dir read-only -> fitShellDiagnostic MUST fall back to writable store!
    const seeded = writeNote(refusalText, { home })
    assert.ok(seeded.parts >= 2)
    const part2Primary = path.join(home, '.devspec', 'notes', `${seeded.id}.2.md`)
    assert.equal(fs.existsSync(part2Primary), true)
    fs.rmSync(part2Primary)
    const notesDir = path.join(home, '.devspec', 'notes')
    const fallbackDir = path.join(dir, 'diagnostic-notes')
    fs.chmodSync(notesDir, 0o500)
    let fittedPrimary = null
    try {
      fittedPrimary = fitShellDiagnostic('x'.repeat(18_000), refusalText, {
        home,
        label: 'devspec-wake-tail',
        fallbackDir,
      })
    } finally {
      fs.chmodSync(notesDir, 0o700)
    }
    assert.ok(fittedPrimary.note?.fallback, 'must NOT reuse broken cached primary note when part 2 is missing and notes dir is read-only')
    const fbPart1 = fs.readFileSync(fittedPrimary.note.file, 'utf8')
    const fbNextMatch = /cat '([^']+)'/.exec(fbPart1)
    assert.ok(fbNextMatch, 'fallback note part 1 must point to part 2')
    const fbPart2 = fs.readFileSync(fbNextMatch[1], 'utf8')
    assert.match(fbPart2, /blk-second-page-tail/, 'fallback note part 2 must be present and carry the blocking record')

    // 2. When ~/.devspec/notes IS writable again and part 2 is still missing: writeNote MUST repair part 2!
    assert.equal(fs.existsSync(part2Primary), false)
    const repaired = writeNote(refusalText, { home })
    assert.equal(fs.existsSync(part2Primary), true, 'writeNote must recreate missing part 2 when writable')
    assert.match(readNoteText(repaired.id, { home }), /blk-second-page-tail/)

    // 3. Fallback store cached 2-part note with part 2 deleted and fallback dir read-only -> throws so fitShellDiagnostic moves to next store!
    const fbDirA = path.join(dir, 'fb-store-a')
    const fbDirB = path.join(dir, 'fb-store-b')
    const seededFb = writeFallbackDiagnosticNote(refusalText, { baseDir: fbDirA })
    assert.ok(seededFb.parts >= 2)
    const fbAPart2 = path.join(fbDirA, `${seededFb.id}-part-2.md`)
    assert.equal(fs.existsSync(fbAPart2), true)
    fs.rmSync(fbAPart2)
    fs.chmodSync(fbDirA, 0o500)
    try {
      assert.throws(
        () => writeFallbackDiagnosticNote(refusalText, { baseDir: fbDirA }),
        /EACCES|ENOENT|permission/i,
        'writeFallbackDiagnosticNote MUST NOT return broken cached note when part 2 is missing and dir is read-only',
      )
    } finally {
      fs.chmodSync(fbDirA, 0o700)
    }
    // And when fbDirA is writable again, writeFallbackDiagnosticNote repairs part 2!
    const repairedFb = writeFallbackDiagnosticNote(refusalText, { baseDir: fbDirA })
    assert.equal(fs.existsSync(fbAPart2), true, 'writeFallbackDiagnosticNote must recreate missing part 2 when writable')
    assert.match(fs.readFileSync(fbAPart2, 'utf8'), /blk-second-page-tail/)
    assert.ok(repairedFb.command.includes(seededFb.id))
    assert.ok(fbDirB)
  })

  it('releaseAtIdle keeps an unreadable retry overflow file queued and reports the skip rather than deleting it, then delivers the older command once readable again (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    const MSG_OLD = '33333333-3333-4333-8333-3333333333c1'
    const TURN_OLD = '77777777-7777-4777-8777-7777777777c1'
    const MSG_NEW = '33333333-3333-4333-8333-3333333333c2'
    const TURN_NEW = '77777777-7777-4777-8777-7777777777c2'

    // Step 1: hand over older unread command 1 into HANDED.
    const batchOld = ownerBatch('Older unread command moved to retry file', { messageId: MSG_OLD, turnId: TURN_OLD })
    holdForNextStep(CONN, batchOld, buildOwnerMessageEvents(batchOld), { dir })
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )

    // Step 2: fail idle append after concurrent hook hands over newer command 2 -> older command goes to retry-*.json!
    let concurrentHanded = false
    await assert.rejects(
      () =>
        releaseAtIdle(CONN, {
          dir,
          state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
          wakeFile,
          home,
          turnState: 'between',
          isOpen: async () => {
            if (!concurrentHanded) {
              concurrentHanded = true
              const batchNew = ownerBatch('Newer concurrent command', { messageId: MSG_NEW, turnId: TURN_NEW })
              holdForNextStep(CONN, batchNew, buildOwnerMessageEvents(batchNew), { dir })
              await stepDeliveryHook(
                { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
                { home, dir, listenerActive: () => true },
              )
            }
            return true
          },
          append: () => {
            throw new Error('simulated append failure')
          },
        }),
      /simulated append failure/,
    )

    const stepsFolder = path.join(dir, `${CONN}.steps`)
    const retryFiles = fs.readdirSync(stepsFolder).filter((n) => n.startsWith('retry-'))
    assert.equal(retryFiles.length, 1, 'rollback must place older unread command in retry-*.json')
    const retryName = retryFiles[0]

    // Step 3: simulate transient EIO when reading the retry file during the next idle sweep!
    const origReadFileSync = fs.readFileSync
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    const stderrLogs = []
    fs.readFileSync = (filePath, ...rest) => {
      if (String(filePath).includes(retryName)) {
        throw Object.assign(new Error('transient EIO reading retry file'), { code: 'EIO' })
      }
      return origReadFileSync(filePath, ...rest)
    }
    process.stderr.write = (chunk, ...rest) => {
      stderrLogs.push(String(chunk))
      return origStderrWrite(chunk, ...rest)
    }
    let sweep1 = null
    try {
      sweep1 = await releaseAtIdle(CONN, {
        dir,
        state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
        wakeFile,
        home,
        turnState: 'between',
      })
    } finally {
      fs.readFileSync = origReadFileSync
      process.stderr.write = origStderrWrite
    }

    assert.ok(sweep1?.note, 'sweep 1 delivers newer command')
    assert.deepEqual(sweep1.skipped_unreadable_overflows, [retryName], 'sweep 1 must report the skipped unreadable retry file')
    assert.ok(
      stderrLogs.some((l) => l.includes(retryName) && /could not be read/i.test(l)),
      'sweep 1 must log that the retry file could not be read and stayed queued',
    )
    assert.equal(
      fs.existsSync(path.join(stepsFolder, retryName)),
      true,
      'unreadable retry file MUST NOT be deleted after delivering only the newer command',
    )

    // Step 4: once the transient read error clears, the next idle sweep delivers the older command!
    const sweep2 = await releaseAtIdle(CONN, {
      dir,
      state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
      wakeFile,
      home,
      turnState: 'between',
    })
    assert.ok(sweep2?.note, 'next sweep must wake and deliver the previously unreadable retry command')
    const sweep2Text = readNoteText(sweep2.note, { home })
    assert.ok(sweep2Text.includes(MSG_OLD), 'older command MUST be delivered once retry file is readable again')
    assert.ok(sweep2Text.includes(MSG_NEW), 'newer command remains preserved too')
    assert.equal(fs.existsSync(path.join(stepsFolder, retryName)), false, 'retry file is deleted ONLY once actually read and delivered')
  })

  it('readWakes preflight refusal enforces fitsShellOutput even with deep backslash paths (91d7b47c)', async () => {
    const { home, dir } = mkHome()
    // Construct deep directory paths with backslashes so raw JSON-escaped error messages exceed 20,000 chars.
    const backslashSeg = `deep\\segment\\${'b'.repeat(80)}`
    const deepBase = path.join(home, ...Array.from({ length: 18 }, (_, i) => `${i}-${backslashSeg}`))
    fs.mkdirSync(deepBase, { recursive: true, mode: 0o700 })
    const deepHome = path.join(deepBase, 'home')
    const deepDir = path.join(deepBase, 'conn')
    const blockedTmp = path.join(deepBase, 'tmp')
    fs.mkdirSync(path.join(deepHome, '.devspec'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(deepHome, '.devspec', 'notes'), 'blocked')
    fs.mkdirSync(deepDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(deepDir, 'diagnostic-notes'), 'blocked')
    fs.writeFileSync(blockedTmp, 'blocked')

    const wakeFile = path.join(dir, `${CONN}.wakes`)
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('Preflight backslash overflow test')))

    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    const stderrChunks = []
    try {
      const page = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home: deepHome,
        dir: deepDir,
        settleMs: 1,
        scriptPath: '/tmp/tail.mjs',
        write: async () => {},
        writeStderr: (text) => { stderrChunks.push(text) },
      })
      assert.equal(page.marked, false)
      assert.equal(page.printed, 0)
      const errOut = stderrChunks.join('')
      assert.ok(errOut.length > 0, 'preflight refusal must emit a diagnostic')
      assert.ok(
        fitsShellOutput(errOut),
        `preflight refusal (${errOut.length} chars) MUST stay inside fitsShellOutput (<= ${CURSOR_SHELL_OUTPUT_MAX_CHARS})`,
      )
      assert.match(errOut, /no_writable_diagnostic_note_store/)
      assert.match(errOut, /recovery/)
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('readWakes recovers an unabridged oversized refusal once a diagnostic store is restored after all stores and pre-opened slots disappeared mid-pickup, even if the retry pickup succeeds (3c5147a7 / 4e32d1a5)', async () => {
    const { execSync } = await import('node:child_process')
    const { home, dir } = mkHome()
    const wakeFile = path.join(home, `${CONN}.wakes`)
    const blockedNotes = path.join(home, '.devspec', 'notes')
    fs.mkdirSync(path.dirname(blockedNotes), { recursive: true, mode: 0o700 })
    fs.writeFileSync(blockedNotes, 'not-a-directory\n')
    const blockedTmp = path.join(home, 'tmp-all-vanished')
    fs.writeFileSync(blockedTmp, 'not-a-directory\n')
    const diagDir = path.join(dir, 'diagnostic-notes')

    const reserveLen = shellDiagnosticReserve('devspec-wake-tail', { home, fallbackDir: diagDir }).length
    const baseLen = wakeLines(buildOwnerMessageEvents(ownerBatch(''))).length
    const perChar = (wakeLines(buildOwnerMessageEvents(ownerBatch('x'.repeat(100)))).length - baseLen) / 100
    const padLen = Math.max(500, Math.floor((CURSOR_SHELL_OUTPUT_MAX_CHARS - reserveLen - baseLen - 200) / perChar))
    appendWakeEvents(wakeFile, buildOwnerMessageEvents(ownerBatch('x'.repeat(padLen))))

    const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = blockedTmp
    process.env.TMP = blockedTmp
    process.env.TEMP = blockedTmp
    const stderr1 = []
    let dirChmod = false
    try {
      // Run 1: EVERY store + pre-opened backup slot vanishes during startCommands!
      const page1 = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home,
        dir,
        settleMs: 1,
        scriptPath: '/tmp/tail.mjs',
        write: async () => {},
        writeStderr: (text) => { stderr1.push(text) },
        startCommands: async () => {
          fs.rmSync(diagDir, { recursive: true, force: true })
          fs.writeFileSync(diagDir, 'not-a-directory\n')
          // Also delete the pre-opened backup slot in `dir` and make `dir` read-only!
          for (const name of fs.readdirSync(dir)) {
            if (name.startsWith('d-') && name.endsWith('.md')) fs.rmSync(path.join(dir, name), { force: true })
          }
          fs.chmodSync(dir, 0o500)
          dirChmod = true
          return {
            ok: false,
            outcome: 'refused',
            started: [],
            pickedUp: 0,
            refusals: [
              {
                command_message_id: MSG_ID,
                command_turn_id: TURN_ID,
                refusal: {
                  code: 'turn_busy_all_vanished',
                  padding: 'v'.repeat(6_000),
                  blocking_items: [{ id: 'blk-final-recovered-item', reason: 'must_survive_store_restore' }],
                },
              },
            ],
          }
        },
      })
      assert.equal(page1.marked, false)
      assert.equal(page1.pickup_diagnostic_note, null)
      assert.ok(stderr1.join('').length > 0)

      // Restore diagnostic store permissions and re-run readWakes where pickup now SUCCEEDS!
      fs.chmodSync(dir, 0o700)
      dirChmod = false
      fs.rmSync(blockedNotes, { force: true })
      fs.mkdirSync(blockedNotes, { recursive: true, mode: 0o700 })

      const stdout2 = []
      const stderr2 = []
      const page2 = await readWakes({
        file: wakeFile,
        connectionId: CONN,
        home,
        dir,
        settleMs: 1,
        scriptPath: '/tmp/tail.mjs',
        write: async (t) => { stdout2.push(t) },
        writeStderr: (t) => { stderr2.push(t) },
        startCommands: async ({ commands }) => ({
          ok: true,
          outcome: 'picked_up',
          started: commands,
          pickedUp: commands.length,
          refusals: [],
        }),
      })
      assert.equal(page2.marked, true)
      const out2 = stdout2.join('')
      const err2 = stderr2.join('')
      assert.ok(fitsShellOutput(out2 + err2), 'recovered stderr pointer + stdout must fit fitsShellOutput')
      assert.ok(page2.pickup_diagnostic_note?.command, 'retry MUST emit a saved diagnostic note pointer for the previously unsaved refusal')
      assert.ok(err2.includes(page2.pickup_diagnostic_note.command))
      const recovered = execSync(page2.pickup_diagnostic_note.command.replace('~', home), { encoding: 'utf8' })
      assert.match(recovered, /turn_busy_all_vanished/)
      assert.match(recovered, /blk-final-recovered-item/, 'restoring the store and retrying MUST recover the omitted blocking record')
      assert.match(recovered, /must_survive_store_restore/)
    } finally {
      if (dirChmod) fs.chmodSync(dir, 0o700)
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('releaseAtIdle fails closed without overwriting a concurrently written handed.json when reading it hits a transient error, then delivers both commands once readable (3ea2b201)', async () => {
    const { home, dir } = mkHome()
    const wakeFile = path.join(dir, `${CONN}.wakes`)
    const MSG_OLD = '33333333-3333-4333-8333-3333333333d9'
    const TURN_OLD = '77777777-7777-4777-8777-7777777777d9'
    const MSG_NEW = '33333333-3333-4333-8333-3333333333da'
    const TURN_NEW = '77777777-7777-4777-8777-7777777777da'
    const stepsFolder = path.join(dir, `${CONN}.steps`)
    const handedPath = path.join(stepsFolder, 'handed.json')

    // Step 1: hand over older command 1 into HANDED.
    const batchOld = ownerBatch('Older unread command', { messageId: MSG_OLD, turnId: TURN_OLD })
    holdForNextStep(CONN, batchOld, buildOwnerMessageEvents(batchOld), { dir })
    await stepDeliveryHook(
      { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 1' }, tool_output: '1' },
      { home, dir, listenerActive: () => true },
    )

    // Step 2: while releaseAtIdle awaits isOpen, a concurrent hook writes newer command 2 into handed.json,
    // and then reading handed.json inside withStepsLock hits a transient EIO!
    let concurrentWritten = false
    const origReadFileSync = fs.readFileSync
    let failHandedRead = false
    fs.readFileSync = (filePath, ...rest) => {
      if (failHandedRead && String(filePath) === handedPath) {
        throw Object.assign(new Error('transient EIO on concurrent handed.json'), { code: 'EIO' })
      }
      return origReadFileSync(filePath, ...rest)
    }
    try {
      await assert.rejects(
        () =>
          releaseAtIdle(CONN, {
            dir,
            state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
            wakeFile,
            home,
            turnState: 'between',
            isOpen: async () => {
              if (!concurrentWritten) {
                concurrentWritten = true
                const batchNew = ownerBatch('Newer concurrent unread command', { messageId: MSG_NEW, turnId: TURN_NEW })
                holdForNextStep(CONN, batchNew, buildOwnerMessageEvents(batchNew), { dir })
                await stepDeliveryHook(
                  { conversation_id: CONVERSATION, tool_name: 'Shell', tool_input: { command: 'echo 2' }, tool_output: '2' },
                  { home, dir, listenerActive: () => true },
                )
                failHandedRead = true
              }
              return true
            },
          }),
        /unreadable|refusing to overwrite/i,
      )
    } finally {
      failHandedRead = false
      fs.readFileSync = origReadFileSync
    }

    // Newer command MUST still be intact in handed.json, and older command preserved in retry-*.json!
    const preservedHanded = JSON.parse(fs.readFileSync(handedPath, 'utf8'))
    assert.ok(
      preservedHanded.items.some((item) => item.events.some((e) => e.message?.message_id === MSG_NEW)),
      'concurrent handed.json MUST NOT be overwritten when unreadable',
    )

    // Next idle sweep once readable delivers BOTH older and newer commands!
    const released = await releaseAtIdle(CONN, {
      dir,
      state: { enabled: true, connection_id: CONN, local_id: CONVERSATION, session_id: ROOM },
      wakeFile,
      home,
      turnState: 'between',
    })
    assert.ok(released?.note)
    const combinedText = readNoteText(released.note, { home })
    assert.ok(combinedText.includes(MSG_OLD), 'older command must be delivered on next sweep')
    assert.ok(combinedText.includes(MSG_NEW), 'newer concurrent command must be delivered on next sweep')
  })
})
