#!/usr/bin/env node
/**
 * Tests for typed-turn-sync.mjs (item da03801e): registering a terminal-typed
 * Cursor turn from the conversation transcript when Cursor CLI skips
 * beforeSubmitPrompt, clearing stale requests on failure, and closing finished
 * requests between turns when Cursor CLI skips stop.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  finishIdleRequests,
  recordConnectTurnBaseline,
  syncTypedTurnFromTranscript,
} from './typed-turn-sync.mjs'
import {
  appendRequestEvent,
  promptArrival,
  provenanceRefForWrite,
  readRequestState,
  requestRefForWrite,
} from './requests.mjs'
import { stampRequest } from './request-ref.mjs'

const CONN = '11111111-1111-4111-8111-111111111111'
const ROOM = '22222222-2222-4222-8222-222222222222'
const ATTACH = '33333333-3333-4333-8333-333333333333'
const ALI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CMD_A = '0000000a-0000-4000-8000-00000000000a'
const MSG_A = '1000000a-0000-4000-8000-00000000000a'
const DELIVERY_A = '2000000a-0000-4000-8000-00000000000a'
const HOOK_TYPED = '0000000d-0000-4000-8000-00000000000d'
const CONV = 'conv-da03801e'

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-typed-sync-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  const transcriptPath = path.join(home, `${CONV}.jsonl`)
  return { home, dir, transcriptPath }
}

function typedRow(prompt) {
  return JSON.stringify({
    role: 'user',
    message: {
      content: [{ type: 'text', text: `<timestamp>Wednesday, Nov 25, 2026, 5:10 PM (UTC)</timestamp>\n<user_query>\n${prompt}\n</user_query>` }],
    },
  })
}

function commandRow() {
  return JSON.stringify({
    role: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: '<timestamp>Wednesday, Nov 25, 2026, 5:09 PM (UTC)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>',
        },
      ],
    },
  })
}

function turnEndedRow(status = 'success') {
  return JSON.stringify({ type: 'turn_ended', status })
}

describe('typed-turn-sync (item da03801e)', () => {
  it('opens a typed_prompt request for a terminal message after an answered room command, admits local_turn, and never stamps the old command', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    // Prior room command was delivered and answered.
    appendRequestEvent(CONN, { op: 'open', id: CMD_A, kind: 'command', message_id: MSG_A, provenance_ref: DELIVERY_A, requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_A }, { dir })
    appendRequestEvent(CONN, { op: 'answered', id: CMD_A }, { dir })

    // Transcript now shows the answered command turn followed by a new live typed prompt.
    fs.writeFileSync(transcriptPath, `${commandRow()}\n${typedRow('Start task 3d327b4a')}\n`)

    const reqCalls = []
    const pickupCalls = []
    let patched = null
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state: {
        connection_id: CONN,
        session_id: ROOM,
        speech_attachment_id: ATTACH,
        attached_at: '2026-11-25T17:00:00.000Z',
      },
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        reqCalls.push(args)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      callPickup: async (args) => {
        pickupCalls.push(args)
        return {
          status: 'working',
          connection_id: CONN,
          attempt_id: args.attempt_id,
          expected_session_id: ROOM,
        }
      },
      patchState: (patch) => { patched = patch; return true },
      dir,
    })

    assert.equal(res.action, 'opened')
    assert.equal(reqCalls.length, 1)
    assert.equal(reqCalls[0].kind, 'typed_prompt')
    assert.equal(pickupCalls.length, 1)
    assert.equal(pickupCalls[0].local_turn, true)
    assert.equal(patched?.local_turn?.session_id, ROOM)

    const state = readRequestState(CONN, { dir })
    assert.equal(state.current, res.requestId)
    assert.equal(state.open.get(res.requestId)?.kind, 'typed_prompt')
    assert.equal(state.open.get(res.requestId)?.requested_by, ALI)
    assert.equal(requestRefForWrite(state), res.requestId)
    assert.equal(provenanceRefForWrite(state), null)

    // claim_work_item goes out without provenance_ref; record_implementation stamps the typed_prompt request_ref.
    assert.deepEqual(stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home, includeProvenance: true }), {
      args: { task_id: 'x' },
    })
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home, includeProvenance: true }), {
      args: { task_id: 'x', request_ref: res.requestId },
    })

    // Repeated sync on the same turn is a fast no-op (no duplicate openRequest).
    const second = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('must not open twice') },
      dir,
    })
    assert.equal(second.action, 'already_synced')
  })

  it('skips the connect turn baseline and opens a request for the next typed message', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('/devspec-remote')}\n`)
    assert.equal(recordConnectTurnBaseline(CONN, transcriptPath, { dir }), true)

    const first = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('must not open for connect turn') },
      dir,
    })
    assert.equal(first.action, 'already_synced')

    // Next typed prompt has a new row index and opens normally.
    fs.writeFileSync(transcriptPath, `${typedRow('/devspec-remote')}\n${typedRow('Please claim task X')}\n`)
    const second = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      dir,
    })
    assert.equal(second.action, 'opened')
    assert.equal(readRequestState(CONN, { dir }).current, second.requestId)
  })

  it('adopts a typed_prompt already opened by beforeSubmitPrompt instead of opening a duplicate', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Run tests')}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('must not duplicate hook request') },
      dir,
    })
    assert.equal(res.action, 'adopted_hook_request')
    assert.equal(res.requestId, HOOK_TYPED)
  })

  it('leaves live room command turns untouched so writes still carry command provenance', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: CMD_A, kind: 'command', message_id: MSG_A, provenance_ref: DELIVERY_A, requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_A }, { dir })
    fs.writeFileSync(transcriptPath, `${commandRow()}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('must not open for room command') },
      dir,
    })
    assert.equal(res.action, 'not_typed_live')
    assert.equal(stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home, includeProvenance: true }).args.provenance_ref, DELIVERY_A)
    assert.equal(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home, includeProvenance: true }).args.request_ref, CMD_A)
  })

  it('clears stale foreground request when openRequest fails so writes go out unstamped', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: CMD_A, kind: 'command', message_id: MSG_A, provenance_ref: DELIVERY_A, requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_A }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Claim task offline')}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('network down') },
      dir,
    })
    assert.equal(res.action, 'cleared_stale')
    assert.deepEqual(stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home, includeProvenance: true }), {
      args: { task_id: 'x' },
    })
  })

  it('closes the ended turn\'s finished typed_prompt and completes local_turn once turn_ended is written', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Done')}\n${turnEndedRow('success')}\n`)

    const closedIds = []
    const completed = []
    let patched = null
    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state: { session_id: ROOM, local_turn: { attempt_id: '44444444-4444-4444-8444-444444444444', session_id: ROOM } },
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        if (args.action === 'close') closedIds.push(args.request_id)
        return { status: 'closed' }
      },
      callComplete: async (args) => {
        completed.push(args)
        return { phase: 'done', closed_as: 'completed' }
      },
      patchState: (patch) => { patched = patch; return true },
      dir,
    })

    assert.deepEqual(closedIds, [HOOK_TYPED])
    assert.deepEqual(res.closed, [HOOK_TYPED])
    assert.equal(res.localCompleted, true)
    assert.equal(completed.length, 1)
    assert.deepEqual(patched, { local_turn: null })
    assert.equal(readRequestState(CONN, { dir }).open.size, 0)
  })

  it('clears earlier typed_prompt from foreground current when a timestamp-only wake arrives before idle cleanup', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    const timestampOnly = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 6:05 PM (UTC)</timestamp>' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Earlier typed prompt')}\n${timestampOnly}\n`)

    let opened = 0
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { opened += 1; return { request_id: HOOK_TYPED } },
      dir,
    })
    assert.equal(res.action, 'cleared_for_wake')
    assert.equal(res.active.kind, 'timestamp')
    assert.equal(opened, 0, 'timestamp-only wake must not reuse earlier typed prompt')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }), {
      args: { task_id: 'x' },
    })
  })

  it('preserves structured refusal fields when callPickup throws a structured MCP error', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Start task thrown refusal')}\n`)
    const memo = { stamp: null, synced: false }
    const logs = []
    const state = {
      connection_id: CONN,
      session_id: ROOM,
      speech_attachment_id: '55555555-5555-4555-8555-555555555555',
      attached_at: '2026-11-25T17:00:00.000Z',
    }

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      callPickup: async () => {
        throw Object.assign(new Error('Refused by server'), {
          code: 'turn_conflict',
          details: { blocking_request_id: CMD_A, reason: 'active_room_turn' },
        })
      },
      dir,
      memo,
      log: (line) => logs.push(line),
    })

    assert.equal(res.action, 'admission_failed')
    assert.equal(res.refusal.code, 'turn_conflict')
    assert.deepEqual(res.refusal.details, { blocking_request_id: CMD_A, reason: 'active_room_turn' })
    assert.equal(memo.synced, false)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /blocking_request_id/)
  })

  it('leaves memo unsynced when writing the transcript binding fails', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Write failure check')}\n`)
    const logFile = path.join(dir, `${CONN}.requests.jsonl`)
    fs.chmodSync(logFile, 0o400)
    const memo = { stamp: null, synced: false }
    try {
      const res = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => { throw new Error('must not open') },
        dir,
        memo,
      })
      assert.equal(res.action, 'binding_write_failed')
      assert.equal(memo.synced, false, 'memo must stay unsynced when binding write fails')
    } finally {
      fs.chmodSync(logFile, 0o600)
    }
  })

  it('keeps an open request with a recorded scheduled wake from closing in finishIdleRequests', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'schedule', id: 'cron-1', prompt: 'Check build status', request: HOOK_TYPED, also: [] }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Watch the build')}\n${turnEndedRow('success')}\n`)

    const closedIds = []
    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        if (args.action === 'close') closedIds.push(args.request_id)
        return { status: 'closed' }
      },
      dir,
    })
    assert.deepEqual(closedIds, [])
    assert.deepEqual(res.closed, [])
    assert.equal(readRequestState(CONN, { dir }).open.has(HOOK_TYPED), true)
  })

  it('preserves structured admission refusal, leaves turn unsynced until admission succeeds, and retries without duplicating open_request', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Start task 123')}\n`)
    const memo = { stamp: null, synced: false }
    const logs = []
    let openCalls = 0
    let pickupCalls = 0
    const state = {
      connection_id: CONN,
      session_id: ROOM,
      speech_attachment_id: '55555555-5555-4555-8555-555555555555',
      attached_at: '2026-11-25T17:00:00.000Z',
    }
    const structuredRefusal = {
      connection_id: CONN,
      expected_session_id: ROOM,
      status: 'foreground_owned_by_command',
      blocking_turn_id: '66666666-6666-4666-8666-666666666666',
    }

    const first = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => { openCalls += 1; return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI } },
      callPickup: async (args) => {
        pickupCalls += 1
        return { ...structuredRefusal, attempt_id: args.attempt_id }
      },
      dir,
      memo,
      log: (line) => logs.push(line),
    })

    assert.equal(first.action, 'admission_failed')
    assert.equal(first.refusal.status, 'foreground_owned_by_command')
    assert.equal(first.refusal.blocking_turn_id, '66666666-6666-4666-8666-666666666666')
    assert.equal(memo.synced, false, 'memo must not be marked synced while admission failed')
    assert.equal(readRequestState(CONN, { dir }).seenTranscriptTurns.size, 0, 'turn must not be recorded as synced while admission failed')
    assert.equal(logs.length, 1)
    assert.match(logs[0], /foreground_owned_by_command/)

    // Second call retries admission without duplicating open_request, then marks synced!
    let patched = null
    const second = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => { openCalls += 1; return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI } },
      callPickup: async (args) => {
        pickupCalls += 1
        return {
          connection_id: CONN,
          expected_session_id: ROOM,
          attempt_id: args.attempt_id,
          status: 'working',
        }
      },
      patchState: (patch) => { patched = patch; return true },
      dir,
      memo,
      log: (line) => logs.push(line),
    })

    assert.equal(second.action, 'adopted_hook_request')
    assert.equal(second.requestId, first.requestId)
    assert.equal(openCalls, 1, 'must reuse already-opened typed_prompt request instead of duplicating')
    assert.equal(pickupCalls, 2)
    assert.equal(memo.synced, true)
    assert.ok(patched?.local_turn?.attempt_id)
    assert.equal(readRequestState(CONN, { dir }).seenTranscriptTurns.size, 1)
  })

  it('clears an earlier typed_prompt on an unrelated timestamp-only wake even when it has a future scheduled run, then restores it when the schedule fires (2fcd26bd / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'schedule', id: 'cron-1', prompt: 'Check deploy', request: HOOK_TYPED, also: [] }, { dir })
    const timestampOnly = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 6:10 PM (UTC)</timestamp>' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Schedule deploy check')}\n${timestampOnly}\n`)

    const unrelated = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(unrelated.action, 'cleared_for_wake')
    const afterUnrelated = readRequestState(CONN, { dir })
    assert.equal(afterUnrelated.current, null, 'unrelated timestamp-only wake must not inherit earlier typed_prompt')
    assert.equal(afterUnrelated.open.has(HOOK_TYPED), true, 'scheduled typed_prompt stays open for its future firing')
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }), {
      args: { task_id: 'x' },
    })

    // Later, the real scheduled wake fires via promptArrival and restores HOOK_TYPED.
    const arrival = promptArrival({
      fromAPerson: false,
      origin: 'scheduled-trigger',
      text: 'Check deploy',
      state: afterUnrelated,
    })
    for (const event of arrival.events) appendRequestEvent(CONN, event, { dir })
    const scheduledRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 6:20 PM (UTC)</timestamp>' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Schedule deploy check')}\n${timestampOnly}\n${scheduledRow}\n`)

    const scheduledSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(scheduledSync.action, 'preserved_wake_request')
    assert.equal(scheduledSync.requestId, HOOK_TYPED)
    assert.equal(readRequestState(CONN, { dir }).current, HOOK_TYPED)
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }), {
      args: { task_id: 'x', request_ref: HOOK_TYPED },
    })
  })

  it('preserves a typed_prompt restored by a real background completion wake even after the launch is marked notified, and still clears a later unrelated wake (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bg-job-1', kind: 'shell', notifies: true, request: HOOK_TYPED, also: [] }, { dir })

    // Real wake bookkeeping: background job completes, restores HOOK_TYPED and marks bg-job-1 notified.
    const arrival = promptArrival({
      fromAPerson: false,
      origin: 'task-notification',
      text: '<task-notification><task-id>bg-job-1</task-id><status>completed</status></task-notification>',
      state: readRequestState(CONN, { dir }),
    })
    for (const event of arrival.events) appendRequestEvent(CONN, event, { dir })
    const afterWake = readRequestState(CONN, { dir })
    assert.equal(afterWake.launches.get('bg-job-1').notified, true)
    assert.equal(afterWake.current, HOOK_TYPED)
    assert.equal(afterWake.currentFromWake, true)

    fs.writeFileSync(transcriptPath, `${typedRow('Run background job')}\n${commandRow()}\n`)
    const wakeSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wakeSync.action, 'preserved_wake_request')
    assert.equal(wakeSync.requestId, HOOK_TYPED)
    assert.equal(readRequestState(CONN, { dir }).current, HOOK_TYPED)
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }), {
      args: { task_id: 'x', request_ref: HOOK_TYPED },
    })

    // A later unrelated timestamp-only wake does NOT inherit the already-consumed wake request.
    const laterUnrelated = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 6:30 PM (UTC)</timestamp>' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Run background job')}\n${commandRow()}\n${laterUnrelated}\n`)
    const thirdSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(thirdSync.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
  })

  it('opens a new typed_prompt when a human types a recorded schedule prompt verbatim in the terminal (2fcd26bd / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'schedule', id: 'cron-cli', prompt: 'Check deploy health', request: HOOK_TYPED, also: [] }, { dir })
    // Simulate current cleared earlier, then the human types the exact same text at the terminal.
    appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Check deploy health')}\n`)

    const opened = []
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        opened.push(args)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
    })
    assert.equal(res.action, 'opened')
    assert.equal(opened.length, 1, 'must open a new typed_prompt for human terminal input')
    assert.notEqual(res.requestId, HOOK_TYPED, 'must never hijack a human typed turn to an earlier scheduled request')
    assert.equal(readRequestState(CONN, { dir }).current, res.requestId)
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }), {
      args: { task_id: 'x', request_ref: res.requestId },
    })
  })

  it('restores a host-injected non-typed <task-notification> wake row on Cursor CLI without beforeSubmitPrompt (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bg-task-9', kind: 'shell', notifies: true, request: HOOK_TYPED, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })
    const taskNotifRow = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>bg-task-9</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${taskNotifRow}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('must restore launching request for host task-notification') },
      dir,
    })
    assert.equal(res.action, 'restored_wake_request')
    assert.equal(res.requestId, HOOK_TYPED)
    assert.equal(readRequestState(CONN, { dir }).current, HOOK_TYPED)
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }), {
      args: { task_id: 'x', request_ref: HOOK_TYPED },
    })
  })

  it('bounds lock retry sleep by remaining budgetMs so a held lock cannot overrun the deadline (3c5147a7 / 91d7b47c)', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Lock budget check')}\n`)
    // Hold the typed-sync lock with our own live PID.
    const lockFile = path.join(dir, `${CONN}.typed-sync.lock`)
    fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600 })
    try {
      const started = Date.now()
      const res = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        budgetMs: 60,
        attempts: 1,
        dir,
      })
      const elapsed = Date.now() - started
      assert.equal(res.action, 'lock_busy')
      // Allow modest scheduling jitter, but must NOT sleep a full extra retry interval past 60ms.
      assert.ok(elapsed < 120, `held lock must stop at budgetMs=60, took ${elapsed}ms`)
    } finally {
      fs.rmSync(lockFile, { force: true })
    }
  })

  it('does not bind or mark synced when local open record fails to persist after DevSpec accepts open (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Transient local open persist failure')}\n`)
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)
    // Make requests.jsonl read-only so readRequestState succeeds while appendFileSync fails transiently.
    fs.writeFileSync(reqLog, '', { mode: 0o400 })
    const memo = { stamp: null, synced: false }
    const logs = []
    let openCalls = 0
    let first
    try {
      first = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          openCalls += 1
          return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
        },
        dir,
        memo,
        log: (line) => logs.push(line),
      })
      assert.equal(first.action, 'open_write_failed')
      assert.equal(first.refusal?.code, 'local_open_persist_failed')
      assert.equal(memo.synced, false, 'memo must stay unsynced so next pass retries')
      assert.equal(openCalls, 1)
    } finally {
      try { fs.chmodSync(reqLog, 0o600) } catch { /* ignore */ }
      fs.rmSync(reqLog, { recursive: true, force: true })
    }

    // Once transient write failure clears, the next pass persists the SAME already-opened
    // server request without issuing a second report_request(open) call (req 3ea2b201).
    const second = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        openCalls += 1
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
      log: (line) => logs.push(line),
    })
    assert.equal(second.action, 'opened')
    assert.equal(second.requestId, first.requestId, 'retry must persist the exact first opened server request id')
    assert.equal(memo.synced, true)
    assert.equal(readRequestState(CONN, { dir }).open.has(first.requestId), true)
    assert.equal(openCalls, 1, 'must not open a second orphaned server request on retry')
  })

  it('preserves structured completion and close refusals in finishIdleRequests without dropping details (4e32d1a5)', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Idle refusal check')}\n${turnEndedRow('success')}\n`)
    const state = {
      connection_id: CONN,
      session_id: ROOM,
      local_turn: { attempt_id: '99999999-9999-4999-8999-999999999999', session_id: ROOM },
    }
    let closeCalled = false
    const logs = []
    const completeRefused = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callComplete: async () => ({
        ok: false,
        code: 'attempt_mismatch',
        blocking_attempt_id: '88888888-8888-4888-8888-888888888888',
        error: 'Another attempt owns Working',
      }),
      callRequest: async () => {
        closeCalled = true
        return { status: 'closed' }
      },
      dir,
      log: (line) => logs.push(line),
    })
    assert.equal(completeRefused.localCompleted, false)
    assert.equal(completeRefused.localCompleteRefusal?.code, 'attempt_mismatch')
    assert.equal(completeRefused.localCompleteRefusal?.blocking_attempt_id, '88888888-8888-4888-8888-888888888888')
    assert.equal(closeCalled, false, 'must not continue silently to close requests after a structured completion refusal')
    assert.match(logs.join(''), /attempt_mismatch/)

    // When completion succeeds but closeRequest returns a structured refusal, surface it too.
    const closeRefused = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state: { connection_id: CONN, session_id: ROOM, local_turn: null },
      connectionCapability: 'cap-secret',
      callRequest: async () => ({
        ok: false,
        code: 'request_locked',
        blocking_turn_id: '77777777-7777-4777-8777-777777777777',
        error: 'Request cannot close right now',
      }),
      dir,
      log: (line) => logs.push(line),
    })
    assert.deepEqual(closeRefused.closed, [])
    assert.equal(closeRefused.closeRefusal?.code, 'request_locked')
    assert.equal(closeRefused.closeRefusal?.blocking_turn_id, '77777777-7777-4777-8777-777777777777')
    assert.match(logs.join(''), /request_locked/)
  })

  it('does NOT let an unrelated timestamp-only or command_turn wake inherit an earlier request merely because an unnotified background launch exists (2fcd26bd / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bg-cli-1', kind: 'shell', notifies: true, request: HOOK_TYPED, also: [] }, { dir })
    // Unrelated timestamp-only wake without any <task-notification> tying it to bg-cli-1.
    const tsOnlyRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>Wed, Nov 25, 2026, 8:40 PM (UTC)</timestamp>' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Start background build')}\n${tsOnlyRow}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(res.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(
      stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }),
      { args: { task_id: 'x' } },
      'write on an unrelated wake must stay unstamped rather than inheriting an unnotified launch',
    )
  })

  it('enforces budgetMs mid-row on a single huge transcript row so sync stops at the deadline (3c5147a7 / 91d7b47c)', async () => {
    const { dir, transcriptPath } = makeEnv()
    // Build a single ~35 MB JSONL user row whose synchronous monolithic parse would exceed a tight budget.
    const hugeRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: `<timestamp>Wed, Nov 25, 2026, 8:41 PM (UTC)</timestamp>\n<user_query>\n${'z'.repeat(35 * 1024 * 1024)}\n</user_query>`,
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${hugeRow}\n`)
    const started = Date.now()
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      budgetMs: 60,
      attempts: 1,
      dir,
      log: () => {},
    })
    const elapsed = Date.now() - started
    assert.equal(res.action, 'budget_exhausted')
    assert.ok(elapsed < 105, `single huge row must stop near budgetMs=60, took ${elapsed}ms`)
  })

  it('enforces budgetMs during synchronous transcript reading so a half-written transcript cannot overrun the hook timeout (3c5147a7 / 91d7b47c)', async () => {
    const { dir, transcriptPath } = makeEnv()
    // Half-written line without trailing newline forces readTranscriptTurns retries.
    fs.writeFileSync(transcriptPath, '{"role":"user","message":')
    const logs = []
    const started = Date.now()
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      budgetMs: 40,
      dir,
      log: (line) => logs.push(line),
    })
    const elapsed = Date.now() - started
    assert.equal(res.action, 'budget_exhausted')
    assert.equal(res.budget_ms, 40)
    assert.ok(elapsed < 200, `transcript read must stop within budgetMs=40, took ${elapsed}ms`)
    assert.equal(logs.length, 1)
  })

  it('retries closing an answered room command in finishIdleRequests even after mark-explicit-reply cleared current (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: CMD_A, kind: 'command', message_id: MSG_A, provenance_ref: DELIVERY_A, requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_A }, { dir })
    // mark-explicit-reply marked CMD_A answered (clearing current to null) and its immediate closeRequest failed.
    appendRequestEvent(CONN, { op: 'answered', id: CMD_A }, { dir })
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.equal(readRequestState(CONN, { dir }).open.has(CMD_A), true)

    fs.writeFileSync(transcriptPath, `${commandRow()}\n${turnEndedRow('success')}\n`)
    const closedIds = []
    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        if (args.action === 'close') closedIds.push(args.request_id)
        return { status: 'closed' }
      },
      dir,
    })
    assert.deepEqual(closedIds, [CMD_A])
    assert.deepEqual(res.closed, [CMD_A])
    assert.equal(readRequestState(CONN, { dir }).open.size, 0)
  })

  it('leaves turn unsynced when patchState fails, returns undefined (swallowed write error), or throws (3ea2b201)', async () => {
    for (const [label, patchState] of [
      ['returns false', () => false],
      ['returns undefined (swallowed error)', () => {}],
      ['throws error', () => { throw new Error('EACCES') }],
    ]) {
      const { dir, transcriptPath } = makeEnv()
      fs.writeFileSync(transcriptPath, `${typedRow(`Persist state check: ${label}`)}\n`)
      const memo = { stamp: null, synced: false }
      const state = {
        connection_id: CONN,
        session_id: ROOM,
        speech_attachment_id: ATTACH,
        attached_at: '2026-11-25T17:00:00.000Z',
      }
      const res = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        state,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
        callPickup: async (args) => ({ status: 'working', connection_id: CONN, attempt_id: args.attempt_id, expected_session_id: ROOM }),
        patchState,
        dir,
        memo,
        log: () => {},
      })
      assert.equal(res.action, 'state_write_failed', label)
      assert.equal(memo.synced, false, label)
      assert.equal(readRequestState(CONN, { dir }).seenTranscriptTurns.size, 0, label)
    }
  })

  it('preserves and logs structured refusals from report_request instead of dropping them on cleared_stale (4e32d1a5)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: CMD_A, kind: 'command', message_id: MSG_A, provenance_ref: DELIVERY_A, requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_A }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Open request refusal check')}\n`)
    const logs = []
    const memo = { stamp: null, synced: false }

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        throw Object.assign(new Error('MCP HTTP 401: invalid connection capability'), {
          status: 401,
          serverCode: 'invalid_connection_capability',
          retryable: false,
          credentialType: 'connection_capability',
        })
      },
      dir,
      memo,
      log: (line) => logs.push(line),
    })

    assert.equal(res.action, 'cleared_stale')
    assert.equal(res.refusal.status, 401)
    assert.equal(res.refusal.serverCode, 'invalid_connection_capability')
    assert.equal(res.refusal.retryable, false)
    assert.equal(res.refusal.credentialType, 'connection_capability')
    assert.equal(memo.synced, false)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /invalid_connection_capability/)
    assert.match(logs[0], /"retryable":false/)
    assert.deepEqual(stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home, includeProvenance: true }), {
      args: { task_id: 'x' },
    })
  })

  it('preserves a retry thrown refusal instead of returning the earlier attempt response (4e32d1a5)', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Retry refusal check')}\n`)
    const state = {
      connection_id: CONN,
      session_id: ROOM,
      speech_attachment_id: ATTACH,
      attached_at: '2026-11-25T17:00:00.000Z',
    }
    let attempt = 0
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      callPickup: async (args) => {
        attempt += 1
        if (attempt === 1) {
          return {
            connection_id: CONN,
            attempt_id: args.attempt_id,
            expected_session_id: ROOM,
            status: 'predecessor_changed',
            previous_attempt_id: '77777777-7777-4777-8777-777777777777',
          }
        }
        throw Object.assign(new Error('Final retry refused'), { code: 'retry_blocked', details: { blocker: 'room_locked' } })
      },
      dir,
      log: () => {},
    })
    assert.equal(attempt, 2)
    assert.equal(res.action, 'admission_failed')
    assert.equal(res.refusal.code, 'retry_blocked')
    assert.deepEqual(res.refusal.details, { blocker: 'room_locked' })
  })

  it('bounds 35 MB trailing whitespace inside trimSliceBounds at deadlineMs (3c5147a7 / 91d7b47c)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const rowWithTrailingWs = `${JSON.stringify({ role: 'assistant', message: { content: 'ok' } })}${' '.repeat(35 * 1024 * 1024)}\n`
    fs.writeFileSync(transcriptPath, rowWithTrailingWs)
    const started = Date.now()
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      budgetMs: 65,
      attempts: 1,
      dir,
      log: () => {},
    })
    const elapsed = Date.now() - started
    assert.equal(res.action, 'budget_exhausted')
    assert.ok(elapsed < 120, `35 MB trailing whitespace row must stop near budgetMs=65, took ${elapsed}ms`)
  })

  it('recovers and closes a server-accepted open whose local append failed even if the turn ends before retry (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Turn that ends after local open fail')}\n`)
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)
    fs.writeFileSync(reqLog, '', { mode: 0o400 }) // block appendRequestEvent while keeping log readable
    const memo = {}
    let openedId = null
    try {
      const first = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          openedId = args.request_id
          return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
        },
        dir,
        memo,
        log: () => {},
      })
      assert.equal(first.action, 'open_write_failed')
      assert.ok(openedId)
      assert.equal(memo.synced, false)

      // Now the turn ends BEFORE disk recovers.
      fs.writeFileSync(transcriptPath, `${typedRow('Turn that ends after local open fail')}\n${turnEndedRow('success')}\n`)
      const endedSync = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
        log: () => {},
      })
      assert.equal(endedSync.action, 'open_write_failed')
      assert.equal(memo.synced, false, 'must NOT mark memo synced while an unpersisted server open remains')

      // While append is still blocked, idle cleanup closes on DevSpec but refuses to
      // report completion or drop the recovery entry until the local close persists (3ea2b201).
      const closedIds = []
      const idleBlocked = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          if (args.action === 'close') closedIds.push(args.request_id)
          return { status: 'closed' }
        },
        dir,
        log: () => {},
      })
      assert.deepEqual(closedIds, [openedId])
      assert.deepEqual(idleBlocked.closed, [], 'must NOT report close complete while local close append fails')
      assert.equal(idleBlocked.closeRefusal?.code, 'local_close_persist_failed')

      // Once the request log is writable again, retry persists the local close and finishes cleanly.
      fs.chmodSync(reqLog, 0o600)
      const idle = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          if (args.action === 'close') closedIds.push(args.request_id)
          return { status: 'closed' }
        },
        dir,
        log: () => {},
      })
      assert.deepEqual(idle.closed, [openedId])
      assert.equal(idle.closeRefusal, undefined)
    } finally {
      try { fs.chmodSync(reqLog, 0o600) } catch { /* ignore */ }
      fs.rmSync(reqLog, { recursive: true, force: true })
    }
  })

  it('leaves a generic ID-less Cursor completion row unstated rather than guessing from an unrelated pending launch (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bg-cli-noid', kind: 'shell', notifies: true, request: HOOK_TYPED, also: [] }, { dir })
    const completionRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<timestamp>Wed, Nov 25, 2026, 8:42 PM (UTC)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Start background task')}\n${completionRow}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(res.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(
      stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }),
      { args: { task_id: 'x' } },
      'generic ID-less completion row must leave requester unstated instead of guessing from pending launches',
    )
  })

  it('preserves multi-byte UTF-8 characters split across the 64 KiB bounded-parser step boundary (3c5147a7 / 91d7b47c)', async () => {
    const { dir, transcriptPath } = makeEnv()
    // Craft a user row so 'é' (2-byte UTF-8) and '😀' (4-byte UTF-8) straddle 65,536-byte boundaries.
    const prefix = 'a'.repeat(65_450)
    const prompt = `${prefix}é${'b'.repeat(65_530)}😀end`
    const row = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: `<timestamp>Wed, Nov 25, 2026, 8:42 PM (UTC)</timestamp>\n<user_query>\n${prompt}\n</user_query>`,
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${row}\n`)
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const unbounded = activeTranscriptTurn(transcriptPath, { attempts: 1 })
    const bounded = activeTranscriptTurn(transcriptPath, { attempts: 1, deadlineMs: Date.now() + 5_000 })
    assert.equal(bounded.kind, 'typed')
    assert.equal(bounded.rawText, unbounded.rawText, 'bounded UTF-8 decoding must match unbounded read identically')
    assert.ok(!bounded.rawText.includes('\uFFFD'), 'must not introduce UTF-8 replacement characters')
    assert.ok(bounded.rawText.includes('é'))
    assert.ok(bounded.rawText.includes('😀'))
  })

  it('typedTurnSyncPending stays true after a refused open_request so the poller keeps retrying (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    fs.writeFileSync(transcriptPath, `${typedRow('Refused open retry')}\n`)
    const memo = { stamp: null, synced: false }
    const first = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => ({ ok: false, error: 'temporary outage', retryable: true }),
      dir,
      memo,
      log: () => {},
    })
    assert.equal(first.action, 'cleared_stale')
    assert.equal(memo.synced, false)
    assert.equal(
      typedTurnSyncPending({ transcriptPath, memo }),
      true,
      'poller must still see this transcript turn as pending retry after a failed open_request',
    )

    // Once a retry succeeds, memo.synced becomes true and typedTurnSyncPending turns false.
    const second = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      dir,
      memo,
      log: () => {},
    })
    assert.equal(second.action, 'opened')
    assert.equal(memo.synced, true)
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
  })

  it('bounds a valid large transcript row with a multi-megabyte numeric field at deadlineMs (3c5147a7 / 91d7b47c)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const bigNum = '1' + '0'.repeat(35 * 1024 * 1024)
    const row = `{"role":"user","big":${bigNum},"message":{"content":[{"type":"text","text":"<timestamp>Wed, Nov 25, 2026, 8:42 PM (UTC)</timestamp>\\n<user_query>\\nhi\\n</user_query>"}]}}\n`
    fs.writeFileSync(transcriptPath, row)

    const start = Date.now()
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      budgetMs: 65,
      log: () => {},
    })
    const elapsed = Date.now() - start
    assert.equal(res.action, 'budget_exhausted')
    assert.ok(elapsed < 100, `expected bounded numeric scan to stop near 65 ms deadline, took ${elapsed} ms`)
  })

  it('marks a recovered pending open as started when disk recovers before an ended turn so finishIdleRequests closes it (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Turn whose disk recovers before end')}\n`)
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)
    fs.writeFileSync(reqLog, '', { mode: 0o400 })
    const memo = { stamp: null, synced: false }
    let openedId = null
    try {
      const first = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          openedId = args.request_id
          return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
        },
        dir,
        memo,
        log: () => {},
      })
      assert.equal(first.action, 'open_write_failed')
      assert.ok(openedId)

      // Disk recovers and the turn ends BEFORE the next sync runs.
      fs.chmodSync(reqLog, 0o600)
      fs.rmSync(reqLog, { recursive: true, force: true })
      fs.writeFileSync(transcriptPath, `${typedRow('Turn whose disk recovers before end')}\n${turnEndedRow('success')}\n`)

      const endedSync = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
        log: () => {},
      })
      assert.equal(endedSync.action, 'not_typed_live')
      assert.equal(memo.synced, true)
      const afterFlush = readRequestState(CONN, { dir })
      assert.equal(afterFlush.open.has(openedId), true, 'recovered open must be persisted')
      assert.equal(afterFlush.started.has(openedId), true, 'recovered open must be marked started for idle cleanup')
      assert.equal(afterFlush.current, null, 'ended recovered open must not linger as foreground current')

      // Normal idle cleanup must now pick up and close the recovered request on DevSpec.
      const closedIds = []
      const idle = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          if (args.action === 'close') closedIds.push(args.request_id)
          return { status: 'closed' }
        },
        dir,
        log: () => {},
      })
      assert.deepEqual(closedIds, [openedId])
      assert.deepEqual(idle.closed, [openedId])
      assert.equal(readRequestState(CONN, { dir }).open.has(openedId), false)
    } finally {
      fs.rmSync(reqLog, { recursive: true, force: true })
    }
  })

  it('never borrows unrelated pending launches when a task-notification names an unmatched explicit ID (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'known-job', kind: 'shell', notifies: true, request: HOOK_TYPED, also: [] }, { dir })
    const otherJobWake = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>different-unrecorded-job</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Start known job')}\n${turnEndedRow()}\n${otherJobWake}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(res.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(
      stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }),
      { args: { task_id: 'x' } },
      'unmatched explicit notification ID must leave next write unstamped instead of borrowing an unrelated launch',
    )
  })

  it('restores prior foreground state on retry when a disk error interrupts ended-turn recovery after marking started (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const PRIOR_CMD = '77777777-7777-4777-8777-777777777777'
    const JOINED_REQ = '88888888-8888-4888-8888-888888888888'
    fs.writeFileSync(transcriptPath, `${typedRow('Turn whose restore hits disk error')}\n`)
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)
    fs.writeFileSync(reqLog, '', { mode: 0o400 })
    const memo = { stamp: null, synced: false }
    let openedId = null
    const origAppend = fs.appendFileSync
    try {
      const first = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          openedId = args.request_id
          return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
        },
        dir,
        memo,
        log: () => {},
      })
      assert.equal(first.action, 'open_write_failed')
      assert.ok(openedId)

      // Disk recovers with an unrelated live foreground command + joined request, and the typed turn ends.
      fs.chmodSync(reqLog, 0o600)
      fs.rmSync(reqLog, { recursive: true, force: true })
      appendRequestEvent(CONN, { op: 'open', id: PRIOR_CMD, kind: 'command', requested_by: ALI }, { dir })
      appendRequestEvent(CONN, { op: 'open', id: JOINED_REQ, kind: 'typed_prompt', requested_by: ALI }, { dir })
      appendRequestEvent(CONN, { op: 'current', ref: PRIOR_CMD }, { dir })
      appendRequestEvent(CONN, { op: 'joined', id: JOINED_REQ }, { dir })
      fs.writeFileSync(transcriptPath, `${typedRow('Turn whose restore hits disk error')}\n${turnEndedRow('success')}\n`)

      // Inject a disk error right after `{ op: 'current', ref: openedId }` is written, so the
      // restore `{ op: 'current', ref: PRIOR_CMD }` fails on the first flush attempt.
      let failNext = false
      fs.appendFileSync = (filePath, data, options) => {
        const text = String(data)
        if (filePath === reqLog && failNext) {
          failNext = false
          const err = new Error('ENOSPC: injected restore failure')
          err.code = 'ENOSPC'
          throw err
        }
        if (filePath === reqLog && text.includes('"op":"current"') && text.includes(openedId)) {
          failNext = true
        }
        return origAppend(filePath, data, options)
      }

      const interrupted = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
        log: () => {},
      })
      assert.equal(interrupted.action, 'open_write_failed')
      assert.equal(memo.synced, false, 'interrupted restore must leave memo unsynced so poller retries')
      const midState = readRequestState(CONN, { dir })
      assert.equal(midState.started.has(openedId), true, 'started write succeeded before disk error')
      assert.equal(midState.current, openedId, 'ended request was left current by injected error')

      // Restore normal disk writes and retry: poller must restore PRIOR_CMD + JOINED_REQ before syncing.
      fs.appendFileSync = origAppend
      const recovered = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
        log: () => {},
      })
      assert.equal(recovered.action, 'not_typed_live')
      assert.equal(memo.synced, true)
      const finalState = readRequestState(CONN, { dir })
      assert.equal(finalState.started.has(openedId), true)
      assert.equal(finalState.current, PRIOR_CMD, 'retry must restore prior foreground current')
      assert.equal(finalState.joined.has(JOINED_REQ), true, 'retry must restore prior joined requests')
    } finally {
      fs.appendFileSync = origAppend
      fs.rmSync(reqLog, { recursive: true, force: true })
    }
  })

  it('clears an answered room command restored by a matched background wake when an unrelated timestamp-only wake arrives next (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const ROOM_CMD = '99999999-9999-4999-8999-999999999999'
    appendRequestEvent(CONN, { op: 'open', id: ROOM_CMD, kind: 'command', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: ROOM_CMD }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'cmd-bg-1', kind: 'shell', notifies: true, request: ROOM_CMD, also: [] }, { dir })
    // Room command was answered; DevSpec closed delivery so current became null, while ROOM_CMD stays open for background work.
    appendRequestEvent(CONN, { op: 'answered', id: ROOM_CMD }, { dir })
    assert.equal(readRequestState(CONN, { dir }).current, null)

    // Wake 1: matched <task-notification> restores ROOM_CMD for its background completion turn.
    const matchedWake = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>cmd-bg-1</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${matchedWake}\n`)
    const wake1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake1.action, 'restored_wake_request')
    assert.equal(wake1.requestId, ROOM_CMD)
    assert.equal(readRequestState(CONN, { dir }).current, ROOM_CMD)
    assert.deepEqual(stampRequest('create_task', { title: 'Follow-up from wake 1' }, CONN, null, { home }), {
      args: { title: 'Follow-up from wake 1', request_ref: ROOM_CMD },
    })

    // Wake 2: unrelated timestamp-only wake must clear the answered room command so writes stay unstamped.
    const unrelatedWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 9:15 PM (UTC)</timestamp>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${matchedWake}\n${unrelatedWake}\n`)
    const wake2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake2.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(
      stampRequest('create_task', { title: 'Unrelated wake write' }, CONN, null, { home }),
      { args: { title: 'Unrelated wake write' } },
      'second unrelated wake must leave requester unknown instead of stamping the answered room command',
    )
  })

  it('retries a refused typed-turn registration even after turn_ended is appended and stays unsynced while still refused (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    fs.writeFileSync(transcriptPath, `${typedRow('Turn refused then ended')}\n`)
    const memo = { stamp: null, synced: false }
    let attempts = 0

    // Attempt 1 (live): retryable refusal leaves memo unsynced.
    const first = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        attempts += 1
        return { ok: false, error: 'temporary outage', retryable: true }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(first.action, 'cleared_stale')
    assert.equal(memo.synced, false)
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true)

    // Turn ends before retry runs.
    fs.writeFileSync(transcriptPath, `${typedRow('Turn refused then ended')}\n${turnEndedRow('success')}\n`)

    // Attempt 2 (ended, still refused): MUST actually retry and keep memo.synced === false!
    const second = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        attempts += 1
        return { ok: false, error: 'still unavailable', retryable: true }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(attempts, 2, 'appending turn_ended must NOT skip retrying the refused turn')
    assert.equal(second.action, 'cleared_stale')
    assert.equal(memo.synced, false, 'ended refused turn must stay unsynced until registration succeeds')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true)

    // Attempt 3 (ended, DevSpec recovers): registration succeeds, marks synced, does not leave ended turn as current.
    const third = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        attempts += 1
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(attempts, 3)
    assert.equal(third.action, 'opened')
    assert.equal(memo.synced, true)
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.open.has(third.requestId), true)
    assert.equal(after.started.has(third.requestId), true)
    assert.equal(after.current, null, 'ended retried turn must not linger as foreground current')
  })

  it('keeps an open request with a recorded Monitor launch open in finishIdleRequests so later monitor events resolve to the launching request (ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'mon-1', kind: 'monitor', notifies: false, request: HOOK_TYPED, also: [] }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Start monitor')}\n${turnEndedRow('success')}\n`)

    const monitorWakeText = '<task-notification><task-id>mon-1</task-id><event>disk usage 95%</event></task-notification>'
    const { requestForWake } = await import('./requests.mjs')
    assert.equal(
      requestForWake({ origin: 'task-notification', text: monitorWakeText, state: readRequestState(CONN, { dir }) }).ref,
      HOOK_TYPED,
    )

    let closeCalled = false
    const idle = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        closeCalled = true
        return { status: 'closed' }
      },
      dir,
      log: () => {},
    })
    assert.equal(closeCalled, false, 'finishIdleRequests must NOT close a request while its recorded monitor can still wake the agent')
    assert.deepEqual(idle.closed, [])
    assert.equal(readRequestState(CONN, { dir }).open.has(HOOK_TYPED), true)
    assert.equal(
      requestForWake({ origin: 'task-notification', text: monitorWakeText, state: readRequestState(CONN, { dir }) }).ref,
      HOOK_TYPED,
      'monitor wake after idle cleanup must still resolve to the launching request',
    )

    // Event 1 from the recorded monitor restores HOOK_TYPED (and promptArrival marks mon-1 notified),
    // then Event 1 finishes and idle cleanup runs: HOOK_TYPED MUST STILL STAY OPEN so Event 2 from
    // the same monitor also resolves to HOOK_TYPED (decision ce71a72b).
    const monEvent1 = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<task-notification><task-id>mon-1</task-id><event>disk usage 95%</event></task-notification>' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Start monitor')}\n${turnEndedRow('success')}\n${monEvent1}\n`)
    const wake1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake1.action, 'restored_wake_request')
    assert.equal(wake1.requestId, HOOK_TYPED)
    assert.equal(readRequestState(CONN, { dir }).launches.get('mon-1')?.notified, true)

    // Event 1 turn ends -> idle cleanup runs.
    fs.writeFileSync(
      transcriptPath,
      `${typedRow('Start monitor')}\n${turnEndedRow('success')}\n${monEvent1}\n${turnEndedRow('success')}\n`,
    )
    const idleAfterEvent1 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        closeCalled = true
        return { status: 'closed' }
      },
      dir,
      log: () => {},
    })
    assert.equal(closeCalled, false, 'finishIdleRequests must NOT close the request after a monitor fires its first event')
    assert.deepEqual(idleAfterEvent1.closed, [])
    assert.equal(readRequestState(CONN, { dir }).open.has(HOOK_TYPED), true)

    // Event 2 from the same recorded monitor MUST still resolve to HOOK_TYPED!
    const monEvent2 = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<task-notification><task-id>mon-1</task-id><event>disk usage 98%</event></task-notification>' }] },
    })
    fs.writeFileSync(
      transcriptPath,
      `${typedRow('Start monitor')}\n${turnEndedRow('success')}\n${monEvent1}\n${turnEndedRow('success')}\n${monEvent2}\n`,
    )
    const wake2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake2.action, 'restored_wake_request')
    assert.equal(wake2.requestId, HOOK_TYPED)
    assert.equal(readRequestState(CONN, { dir }).current, HOOK_TYPED)
  })

  it('retries an earlier refused typed turn even after a second typed turn succeeds, and only marks synced once both complete (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending, deterministicTypedTurnRequestId } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const row1 = typedRow('First typed turn that hits a retryable refusal')
    const row2 = typedRow('Second typed turn that succeeds immediately')
    fs.writeFileSync(transcriptPath, `${row1}\n`)
    const key1 = activeTranscriptTurn(transcriptPath, { attempts: 1 }).key
    const req1Id = deterministicTypedTurnRequestId(CONN, key1)
    const memo = { stamp: null, synced: false }
    const openedIds = []
    let failReq1Count = 2

    // Tick 1: Turn 1 fails with a retryable refusal -> stays queued, memo.synced stays false.
    const t1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        if (args.request_id === req1Id && failReq1Count > 0) {
          failReq1Count -= 1
          return { ok: false, error: 'temporary outage', retryable: true }
        }
        openedIds.push(args.request_id)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(t1.action, 'cleared_stale')
    assert.equal(memo.synced, false)

    // Tick 2: Turn 2 arrives and succeeds, while retrying Turn 1 STILL hits its second refusal.
    // Turn 2 must become foreground current, Turn 1 must be retried, AND memo.synced MUST STAY FALSE!
    fs.writeFileSync(transcriptPath, `${row1}\n${row2}\n`)
    const key2 = activeTranscriptTurn(transcriptPath, { attempts: 1 }).key
    const req2Id = deterministicTypedTurnRequestId(CONN, key2)
    const t2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        if (args.request_id === req1Id && failReq1Count > 0) {
          failReq1Count -= 1
          return { ok: false, error: 'still temporary outage', retryable: true }
        }
        openedIds.push(args.request_id)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(t2.action, 'opened')
    assert.equal(t2.requestId, req2Id)
    assert.equal(t2.retriedFailedTurn?.action, 'cleared_stale', 'must actually attempt to retry Turn 1')
    assert.equal(t2.retriedFailedTurn?.key, key1)
    assert.equal(memo.synced, false, 'must NOT mark transcript synced while Turn 1 is still failed')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true)
    assert.equal(readRequestState(CONN, { dir }).current, req2Id, 'Turn 2 stays foreground current')

    // Tick 3 (same unchanged transcript file): poller retries Turn 1, DevSpec accepts it,
    // foreground current stays Turn 2, Turn 1 is open + started + bound, and memo.synced turns true.
    const t3 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        openedIds.push(args.request_id)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(t3.action, 'opened')
    assert.equal(t3.requestId, req1Id)
    assert.equal(t3.key, key1)
    assert.equal(memo.synced, true, 'memo.synced turns true once BOTH Turn 1 and Turn 2 succeed')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
    assert.deepEqual(openedIds, [req2Id, req1Id])
    const finalState = readRequestState(CONN, { dir })
    assert.equal(finalState.current, req2Id, 'retrying Turn 1 must preserve Turn 2 as foreground current')
    assert.equal(finalState.open.has(req1Id), true)
    assert.equal(finalState.started.has(req1Id), true)
    assert.equal(finalState.seenTranscriptTurns.get(key1), req1Id)
    assert.equal(finalState.seenTranscriptTurns.get(key2), req2Id)
  })

  it('persists refused typed-turn registration across processes so the poller retries after a hook refusal and turn_ended (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { deterministicTypedTurnRequestId } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const row = typedRow('Hook refused then separate poller process runs after turn_ended')
    fs.writeFileSync(transcriptPath, `${row}\n`)
    const key = activeTranscriptTurn(transcriptPath, { attempts: 1 }).key
    const expectedId = deterministicTypedTurnRequestId(CONN, key)

    // Simulate Process 1 (preToolUse hook) failing open_request and exiting: writes typed_turn_failed to disk.
    const hookRes = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => ({ ok: false, error: 'temporary outage', retryable: true }),
      dir,
      log: () => {},
    })
    assert.equal(hookRes.action, 'cleared_stale')
    assert.equal(readRequestState(CONN, { dir }).failedTranscriptTurns.has(key), true)

    // Turn ends before Process 2 (fresh poller process with zero shared in-memory state) runs.
    fs.writeFileSync(transcriptPath, `${row}\n${turnEndedRow('success')}\n`)
    const { spawnSync } = await import('node:child_process')
    const syncModuleUrl = new URL('./typed-turn-sync.mjs', import.meta.url).href
    const probeScript = `
      import { syncTypedTurnFromTranscript } from ${JSON.stringify(syncModuleUrl)};
      const memo = { stamp: null, synced: false };
      let attempts = 0;
      const first = await syncTypedTurnFromTranscript({
        connectionId: ${JSON.stringify(CONN)},
        transcriptPath: ${JSON.stringify(transcriptPath)},
        connectionCapability: 'cap-secret',
        callRequest: async () => { attempts += 1; return { ok: false, error: 'still refused', retryable: true }; },
        dir: ${JSON.stringify(dir)},
        memo,
        log: () => {},
      });
      const firstSynced = memo.synced;
      const second = await syncTypedTurnFromTranscript({
        connectionId: ${JSON.stringify(CONN)},
        transcriptPath: ${JSON.stringify(transcriptPath)},
        connectionCapability: 'cap-secret',
        callRequest: async (args) => { attempts += 1; return { request_id: args.request_id, status: 'open', requested_by_user_id: ${JSON.stringify(ALI)} }; },
        dir: ${JSON.stringify(dir)},
        memo,
        log: () => {},
      });
      console.log(JSON.stringify({ attempts, firstAction: first.action, firstSynced, secondAction: second.action, secondId: second.requestId, secondSynced: memo.synced }));
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const out = JSON.parse(child.stdout.trim())
    assert.equal(out.attempts, 2, 'fresh poller process must retry the hook-refused turn even after turn_ended')
    assert.equal(out.firstAction, 'cleared_stale')
    assert.equal(out.firstSynced, false, 'fresh poller process must NOT mark transcript synced while refused')
    assert.equal(out.secondAction, 'opened')
    assert.equal(out.secondId, expectedId)
    assert.equal(out.secondSynced, true)
    assert.equal(readRequestState(CONN, { dir }).failedTranscriptTurns.size, 0)
  })

  it('clears NO_REQUEST (none) after a recognized automation wake ends so a subsequent timestamp-only wake stays unstated (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const autoWake = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>auto-1</task-id><event>{"type":"automation_run","session_id":null,"authoritative":true}</event></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${autoWake}\n`)
    const wake1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake1.action, 'restored_wake_request')
    assert.equal(wake1.requestId, 'none')
    assert.deepEqual(stampRequest('create_task', { title: 'Automation write' }, CONN, null, { home }), {
      args: { title: 'Automation write', request_ref: 'none' },
    })

    // Automation turn ends, then a separate unrelated timestamp-only wake arrives:
    // it MUST clear `none` so writes go out unstamped (unknown requester) instead of stamping `none`.
    const tsWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 10:45 PM (UTC)</timestamp>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${autoWake}\n${turnEndedRow('success')}\n${tsWake}\n`)
    const wake2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake2.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(
      stampRequest('create_task', { title: 'Unrelated timestamp wake write' }, CONN, null, { home }),
      { args: { title: 'Unrelated timestamp wake write' } },
      'unrelated timestamp-only wake after an automation wake must remain unstated, never stamped none',
    )
  })

  it('clears an UNANSWERED room command restored by a matched background wake when a later timestamp-only wake arrives (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const ROOM_CMD = '77777777-7777-4777-8777-777777777777'
    appendRequestEvent(CONN, { op: 'open', id: ROOM_CMD, kind: 'command', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: ROOM_CMD }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'unans-bg-1', kind: 'shell', notifies: true, request: ROOM_CMD, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'unans-bg-2', kind: 'shell', notifies: true, request: ROOM_CMD, also: [] }, { dir })
    // Room command is still UNANSWERED; its first foreground turn cleared current (e.g. another turn ran).
    appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })

    // Wake 1: matched <task-notification> restores the unanswered room command.
    const matchedWake1 = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>unans-bg-1</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${matchedWake1}\n`)
    const wake1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake1.action, 'restored_wake_request')
    assert.equal(wake1.requestId, ROOM_CMD)
    assert.equal(readRequestState(CONN, { dir }).current, ROOM_CMD)
    assert.deepEqual(stampRequest('create_task', { title: 'Matched wake 1 write' }, CONN, null, { home }), {
      args: { title: 'Matched wake 1 write', request_ref: ROOM_CMD },
    })

    // Wake 1 ends, then Wake 2 (a later unrelated timestamp-only wake) arrives while ROOM_CMD is still unanswered:
    // Wake 2 MUST clear ROOM_CMD from foreground current so writes go out unstamped (unknown requester).
    const tsWake2 = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 11:05 PM (UTC)</timestamp>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${matchedWake1}\n${turnEndedRow('success')}\n${tsWake2}\n`)
    const wake2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake2.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(
      stampRequest('create_task', { title: 'Unrelated timestamp wake 2 write' }, CONN, null, { home }),
      { args: { title: 'Unrelated timestamp wake 2 write' } },
      'second timestamp-only wake must not inherit an unanswered room command from an earlier wake turn',
    )

    // ROOM_CMD remains open, so a later matched completion for unans-bg-2 still restores it.
    const matchedWake3 = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>unans-bg-2</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${matchedWake1}\n${tsWake2}\n${matchedWake3}\n`)
    const wake3 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wake3.action, 'restored_wake_request')
    assert.equal(wake3.requestId, ROOM_CMD)
  })

  it('persists server-opened typed requests across separate OS processes when local open fails before turn_ended (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)
    fs.writeFileSync(reqLog, '', { mode: 0o400 }) // force appendRequestEvent to fail while keeping log readable
    fs.writeFileSync(transcriptPath, `${typedRow('Cross-process local open failure')}\n`)
    let openedId = null
    const memo1 = {}
    try {
      const first = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          openedId = args.request_id
          return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
        },
        dir,
        memo: memo1,
        log: () => {},
      })
      assert.equal(first.action, 'open_write_failed')
      assert.ok(openedId)
      assert.equal(memo1.synced, false)

      // Turn ends before a fresh OS poller process starts.
      fs.writeFileSync(transcriptPath, `${typedRow('Cross-process local open failure')}\n${turnEndedRow('success')}\n`)
      const { execFileSync } = await import('node:child_process')
      const { fileURLToPath } = await import('node:url')
      const syncModulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'typed-turn-sync.mjs')
      const runFreshPoller = () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `
                import { syncTypedTurnFromTranscript } from ${JSON.stringify(syncModulePath)};
                const memo = {};
                const res = await syncTypedTurnFromTranscript({
                  connectionId: ${JSON.stringify(CONN)},
                  transcriptPath: ${JSON.stringify(transcriptPath)},
                  connectionCapability: 'cap-secret',
                  dir: ${JSON.stringify(dir)},
                  memo,
                  log: () => {},
                });
                process.stdout.write(JSON.stringify({ res, synced: memo.synced }));
              `,
            ],
            { encoding: 'utf8' },
          ),
        )

      // Fresh process #1 while requests.jsonl is still blocked: MUST NOT mark transcript synced!
      const blockedRun = runFreshPoller()
      assert.equal(blockedRun.res.action, 'open_write_failed')
      assert.equal(blockedRun.res.requestId, openedId)
      assert.equal(blockedRun.synced, false)

      // Restore disk writability; fresh process #2 MUST persist the server-opened request & mark synced.
      fs.chmodSync(reqLog, 0o600)
      fs.rmSync(reqLog, { recursive: true, force: true })
      const recoveredRun = runFreshPoller()
      assert.equal(recoveredRun.synced, true)
      const persisted = readRequestState(CONN, { dir })
      assert.equal(persisted.open.has(openedId), true, 'fresh poller must persist open event for server-accepted request')
      assert.equal(persisted.started.has(openedId), true, 'fresh poller must mark recovered request started so idle cleanup closes it')
      assert.equal(persisted.seenTranscriptTurns.size, 1)
      assert.equal(fs.existsSync(path.join(dir, `${CONN}.pending-opens.json`)), false, 'sidecar must be cleaned up after flush')
    } finally {
      fs.rmSync(reqLog, { recursive: true, force: true })
    }
  })

  it('queues and registers a typed turn first seen after turn_ended rather than marking synced while skipped (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    // Transcript already contains an unseen typed turn followed immediately by turn_ended.
    fs.writeFileSync(transcriptPath, `${typedRow('Fast typed turn that ended before first poll')}\n${turnEndedRow('success')}\n`)
    const memo = {}

    // Pass 1 without capability/callRequest: MUST NOT mark transcript synced; must stay queued and pending!
    const skipped = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: null,
      dir,
      memo,
      log: () => {},
    })
    assert.equal(skipped.action, 'cleared_stale')
    assert.equal(memo.synced, false, 'must NOT mark transcript synced when ended typed turn was not registered')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true, 'typedTurnSyncPending must report pending work')
    assert.equal(readRequestState(CONN, { dir }).failedTranscriptTurns.size, 1)

    // Pass 2 with capability + callRequest: registers the ended typed turn, persists open+started+transcript_turn, and marks synced!
    const opened = []
    const recovered = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        opened.push(args)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(recovered.action, 'opened')
    assert.equal(recovered.ended, true)
    assert.equal(memo.synced, true)
    assert.equal(opened.length, 1)
    const state = readRequestState(CONN, { dir })
    assert.equal(state.open.has(recovered.requestId), true)
    assert.equal(state.started.has(recovered.requestId), true)
    assert.equal(state.failedTranscriptTurns.size, 0)
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
  })

  it('preserves live room command and two-person ambiguity when replaying a background notification already joined by the prompt hook (ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111aa'
    const REQ_BOB = '22222222-2222-4222-8222-2222222222bb'

    appendRequestEvent(CONN, { op: 'open', id: REQ_BOB, kind: 'typed_prompt', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bob-bg-1', kind: 'shell', notifies: true, request: REQ_BOB, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
    // Prompt hook already joined Bob's completing background job into Alice's live room command turn:
    appendRequestEvent(CONN, { op: 'joined', id: REQ_BOB }, { dir })
    appendRequestEvent(CONN, { op: 'notified', key: 'bob-bg-1' }, { dir })
    assert.ok(turnAmbiguity(readRequestState(CONN, { dir })), 'precondition: two-person ambiguity must exist')

    const notifRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>bob-bg-1</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${notifRow}\n`)
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(res.action, 'already_carried_wake')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'must NOT overwrite live room command with already-joined launcher request')
    assert.equal(after.joined.has(REQ_BOB), true, 'must keep joined launcher request distinct')
    assert.ok(turnAmbiguity(after), 'two-person ambiguity must remain intact so writes ask which person they serve')
  })

  it('queues and registers ALL previously unseen typed turns that finish between poller reads without marking synced early (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    fs.writeFileSync(
      transcriptPath,
      `${typedRow('First unseen typed turn')}\n${typedRow('Second unseen typed turn')}\n${turnEndedRow('success')}\n`,
    )
    const memo = {}
    const opened = []
    const callRequest = async (args) => {
      opened.push(args)
      return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
    }

    // Poll 1: registers Turn 1, MUST leave Turn 2 queued and memo.synced === false!
    const first = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest,
      dir,
      memo,
      log: () => {},
    })
    assert.equal(first.action, 'opened')
    assert.equal(first.ended, true)
    assert.equal(opened.length, 1)
    assert.equal(memo.synced, false, 'must NOT mark transcript synced while a second unseen typed turn remains queued')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true, 'typedTurnSyncPending must remain true until all unseen turns are registered')
    assert.equal(readRequestState(CONN, { dir }).failedTranscriptTurns.size, 1)

    // Poll 2 (same unchanged transcript snapshot): registers Turn 2 and ONLY THEN marks synced!
    const second = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest,
      dir,
      memo,
      log: () => {},
    })
    assert.equal(second.action, 'opened')
    assert.equal(second.ended, true)
    assert.notEqual(second.requestId, first.requestId)
    assert.equal(opened.length, 2, 'both unseen typed turns must be registered')
    assert.equal(memo.synced, true, 'transcript may mark synced once every unseen typed turn is registered')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
    const finalState = readRequestState(CONN, { dir })
    assert.equal(finalState.failedTranscriptTurns.size, 0)
    assert.equal(finalState.open.has(first.requestId), true)
    assert.equal(finalState.open.has(second.requestId), true)
    assert.equal(finalState.started.has(first.requestId), true)
    assert.equal(finalState.started.has(second.requestId), true)
  })

  it('joins a matched background completion into a live terminal-typed turn instead of replacing it when prompt hook is absent (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111ac'

    // Alice's earlier room command launched a background job and finished its own turn.
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-bg-1', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'answered', id: CMD_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })

    // Bob types a prompt in the terminal (Cursor CLI without beforeSubmitPrompt hook).
    const bobRow = typedRow('Bob starts a new terminal task')
    fs.writeFileSync(transcriptPath, `${bobRow}\n`)
    const bobSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
    })
    assert.equal(bobSync.action, 'opened')
    const TYPED_BOB = bobSync.requestId
    assert.equal(readRequestState(CONN, { dir }).current, TYPED_BOB)

    // While Bob's terminal turn is STILL LIVE (no turn_ended), Alice's background completion arrives.
    const aliceNotifRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>alice-bg-1</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${bobRow}\n${aliceNotifRow}\n`)
    const wakeSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wakeSync.action, 'restored_wake_request')
    assert.equal(wakeSync.midTurn, true)
    assert.equal(wakeSync.requestId, TYPED_BOB)

    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, TYPED_BOB, 'mid-turn background completion must NOT replace Bob’s live typed request')
    assert.equal(after.joined.has(CMD_ALICE), true, 'mid-turn background completion must JOIN the live typed turn')
    assert.equal(after.launches.get('alice-bg-1')?.notified, true)
    const amb = turnAmbiguity(after)
    assert.ok(amb && amb.length === 2, 'two-person attribution ambiguity must be preserved')
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'next write must NOT silently stamp Alice’s background requester over Bob’s live typed turn')
    assert.notEqual(stamped.args?.request_ref, CMD_ALICE)
  })

  it('clears ended typed_prompt foreground in finishIdleRequests so a later background wake after turn end starts a clean new turn (ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111ad'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-bg-2', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })

    // Bob's typed turn launches its own background job and ENDS (turn_ended).
    const bobRow = typedRow('Bob launches his own background job')
    fs.writeFileSync(transcriptPath, `${bobRow}\n`)
    const bobSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
    })
    const TYPED_BOB = bobSync.requestId
    appendRequestEvent(CONN, { op: 'launch', key: 'bob-bg-2', kind: 'shell', notifies: true, request: TYPED_BOB, also: [] }, { dir })
    fs.writeFileSync(transcriptPath, `${bobRow}\n${turnEndedRow('success')}\n`)
    await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => ({ status: 'closed' }),
      dir,
      log: () => {},
    })
    // TYPED_BOB stays open for bob-bg-2, but is no longer foreground current.
    assert.equal(readRequestState(CONN, { dir }).open.has(TYPED_BOB), true)
    assert.equal(readRequestState(CONN, { dir }).current, null)

    // Cursor rewrites the transcript without turn_ended when Alice's background completion starts a NEW turn.
    const aliceNotifRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>alice-bg-2</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${bobRow}\n${aliceNotifRow}\n`)
    const wakeSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(wakeSync.action, 'restored_wake_request')
    assert.equal(wakeSync.requestId, CMD_ALICE)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE)
    assert.equal(turnAmbiguity(after), null, 'ended typed turn must not falsely join a later turn')
  })

  it('binds a hook-created request to the later ended typed prompt and still registers the earlier unseen typed prompt without duplicating the later one (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending, deterministicTypedTurnRequestId } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const row1 = typedRow('Earlier unseen typed prompt without hook')
    const row2 = typedRow('Later typed prompt that beforeSubmitPrompt already opened')
    fs.writeFileSync(transcriptPath, `${row1}\n${row2}\n${turnEndedRow('success')}\n`)
    const { typedTurnKeys } = activeTranscriptTurn(transcriptPath, { attempts: 1 })
    assert.equal(typedTurnKeys.length, 2)
    const [key1, key2] = typedTurnKeys

    // Hook opened HOOK_TYPED ONLY for the later typed prompt (key2).
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })

    const memo = {}
    const opened = []
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        opened.push(args)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
      log: () => {},
    })
    assert.equal(res.action, 'opened')
    assert.equal(res.key, key1, 'must register the EARLIER unseen prompt, never skip it')
    assert.equal(res.requestId, deterministicTypedTurnRequestId(CONN, key1))
    assert.equal(opened.length, 1, 'must NOT open a duplicate request for the hook-covered later prompt')
    const state = readRequestState(CONN, { dir })
    assert.equal(state.seenTranscriptTurns.get(key2), HOOK_TYPED, 'later prompt must be explicitly bound to HOOK_TYPED')
    assert.equal(state.seenTranscriptTurns.get(key1), res.requestId, 'earlier prompt must be explicitly bound to its newly opened request')
    assert.equal(state.failedTranscriptTurns.size, 0)
    assert.equal(memo.synced, true)
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
  })

  it('preserves currentBoundByWake when recovering an older typed prompt after a matched background wake so a later unrelated timestamp-only wake still clears it (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const ROOM_CMD = '99999999-9999-4999-8999-999999999999'
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    // Unanswered room command with a background launch.
    appendRequestEvent(CONN, { op: 'open', id: ROOM_CMD, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'wake-bg-1', kind: 'shell', notifies: true, request: ROOM_CMD, also: [] }, { dir })

    // Transcript contains an older unseen typed prompt, followed by a turn_ended,
    // followed by a matched <task-notification> wake for ROOM_CMD.
    const olderTyped = typedRow('Older unseen typed prompt before background wake')
    const wakeRow = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>wake-bg-1</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${olderTyped}\n${turnEndedRow('success')}\n${wakeRow}\n`)

    const opened = []
    const wakeRes = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        opened.push(args)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
    })
    assert.equal(wakeRes.action, 'restored_wake_request')
    assert.equal(wakeRes.requestId, ROOM_CMD)
    assert.equal(opened.length, 1, 'older unseen typed prompt is recovered on the same pass')
    const afterWake = readRequestState(CONN, { dir })
    assert.equal(afterWake.current, ROOM_CMD)
    assert.equal(afterWake.currentBoundByWake, true, 'restoring ROOM_CMD after older typed prompt recovery MUST preserve currentBoundByWake')

    // Next unrelated timestamp-only wake MUST clear ROOM_CMD rather than stamping writes for Alice!
    const tsOnly = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 7:15 PM (UTC)</timestamp>' }] },
    })
    fs.writeFileSync(transcriptPath, `${olderTyped}\n${turnEndedRow('success')}\n${wakeRow}\n${tsOnly}\n`)
    const unrelatedRes = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(unrelatedRes.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    assert.deepEqual(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }), {
      args: { task_id: 'x' },
    })
  })

  it('retries refused room admission for a live typed prompt even after a same-turn background wake arrives instead of marking synced without admission (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111ae'
    const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-bg-adm', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })

    const bobRow = typedRow('Bob live terminal prompt with refused admission')
    const aliceWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>alice-bg-adm</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${bobRow}\n`)

    const memo = { stamp: null, synced: false }
    const state = {
      connection_id: CONN,
      session_id: SESSION,
      speech_attachment_id: '55555555-5555-4555-8555-555555555555',
      attached_at: '2026-11-25T17:00:00.000Z',
      local_turn: null,
    }
    let openCalls = 0
    let pickupCalls = 0
    let allowAdmission = false
    const callRequest = async (args) => {
      openCalls += 1
      return { request_id: args.request_id, status: 'open', requested_by_user_id: BOB }
    }
    const callPickup = async (args) => {
      pickupCalls += 1
      if (!allowAdmission) {
        throw Object.assign(new Error('Refused by server'), { code: 'turn_busy' })
      }
      return {
        status: 'working',
        connection_id: CONN,
        attempt_id: args.attempt_id,
        expected_session_id: SESSION,
      }
    }
    const patchState = (patch) => {
      Object.assign(state, patch)
      return true
    }

    // Poll 1: opens Bob's request, room admission refused -> stays unsynced.
    const poll1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest,
      callPickup,
      patchState,
      dir,
      memo,
      log: () => {},
    })
    assert.equal(poll1.action, 'admission_failed')
    assert.equal(memo.synced, false)
    assert.equal(openCalls, 1)
    assert.equal(pickupCalls, 1)
    const TYPED_BOB = poll1.requestId

    // Same-turn background wake arrives while admission is STILL refused!
    fs.writeFileSync(transcriptPath, `${bobRow}\n${aliceWake}\n`)
    const poll2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest,
      callPickup,
      patchState,
      dir,
      memo,
      log: () => {},
    })
    assert.equal(poll2.action, 'restored_wake_request')
    assert.equal(poll2.midTurn, true)
    assert.equal(openCalls, 1, 'must NOT open a second request for Bob')
    assert.equal(pickupCalls, 2, 'must retry room admission on Poll 2')
    assert.equal(memo.synced, false, 'must NOT mark transcript synced while room admission is still refused')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true)
    const midState = readRequestState(CONN, { dir })
    assert.equal(midState.current, TYPED_BOB)
    assert.equal(midState.joined.has(CMD_ALICE), true)
    assert.ok(turnAmbiguity(midState))

    // Poll 3 (same unchanged transcript, admission now succeeds): retries admission, preserves ambiguity, and ONLY THEN marks synced!
    allowAdmission = true
    const poll3 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest,
      callPickup,
      patchState,
      dir,
      memo,
      log: () => {},
    })
    assert.notEqual(poll3.action, 'unchanged', 'must NOT return unchanged while admission was pending')
    assert.equal(pickupCalls, 3, 'must retry and complete room admission on Poll 3')
    assert.ok(state.local_turn?.attempt_id, 'local_turn admission must be persisted')
    assert.equal(memo.synced, true)
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
    const finalState = readRequestState(CONN, { dir })
    assert.equal(finalState.current, TYPED_BOB)
    assert.equal(finalState.joined.has(CMD_ALICE), true, 'retried admission must preserve joined Alice request and ambiguity')
    assert.ok(turnAmbiguity(finalState))
  })

  it('opens a live terminal prompt and joins another person’s same-turn background notification when both arrive before the first sync (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111af'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-bg-both', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })

    const bobRow = typedRow('Bob prompt written right before Alice wake')
    const aliceWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>alice-bg-both</task-id><status>completed</status></task-notification>' }],
      },
    })
    // Both rows arrive BEFORE the first sync with NO turn_ended between them!
    fs.writeFileSync(transcriptPath, `${bobRow}\n${aliceWake}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo,
    })
    assert.equal(res.action, 'restored_wake_request')
    assert.equal(res.midTurn, true)
    const after = readRequestState(CONN, { dir })
    assert.notEqual(after.current, CMD_ALICE, 'must NOT make Alice’s room request sole current over Bob’s same-turn prompt')
    assert.equal(after.open.get(after.current)?.kind, 'typed_prompt')
    assert.equal(after.joined.has(CMD_ALICE), true, 'Alice’s background wake must JOIN Bob’s live typed prompt')
    assert.ok(turnAmbiguity(after)?.length === 2, 'two-person ambiguity must be preserved')
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'next write must ask which person it serves instead of stamping Alice’s room request')
    assert.notEqual(stamped.args?.request_ref, CMD_ALICE)
    assert.equal(memo.synced, true)
  })

  it('processes ALL same-turn background notifications (not only the last) so earlier launches are notified and two-person ambiguity is preserved (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111b1'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222b2'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-first-bg', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bob-second-bg', kind: 'shell', notifies: true, request: CMD_BOB, also: [] }, { dir })

    const bobRow = typedRow('Bob live prompt before two background notifications')
    const aliceWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>alice-first-bg</task-id><status>completed</status></task-notification>' }],
      },
    })
    const bobWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>bob-second-bg</task-id><status>completed</status></task-notification>' }],
      },
    })
    // Terminal prompt + Alice notification + Bob notification all arrive between reads in the same turn.
    fs.writeFileSync(transcriptPath, `${bobRow}\n${aliceWake}\n${bobWake}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo,
    })
    assert.equal(res.action, 'restored_wake_request')
    assert.equal(res.midTurn, true)
    assert.equal(memo.synced, true)

    const after = readRequestState(CONN, { dir })
    assert.equal(after.open.get(after.current)?.kind, 'typed_prompt')
    assert.equal(after.joined.has(CMD_ALICE), true, 'earlier Alice notification must be joined, not skipped')
    assert.equal(after.joined.has(CMD_BOB), true, 'later Bob notification must also be joined')
    assert.equal(after.launches.get('alice-first-bg')?.notified, true, 'earlier launch must be marked notified')
    assert.equal(after.launches.get('bob-second-bg')?.notified, true, 'later launch must be marked notified')
    assert.ok(turnAmbiguity(after)?.length >= 2, 'two-person ambiguity must survive when last wake belongs to terminal owner')

    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'implementation write must ask which person it serves instead of stamping terminal owner')
  })

  it('processes two back-to-back same-turn notifications without a typed prompt and preserves both launches and ambiguity (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111c1'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222c2'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-bare-1', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bob-bare-2', kind: 'shell', notifies: true, request: CMD_BOB, also: [] }, { dir })

    const aliceWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>alice-bare-1</task-id><status>completed</status></task-notification>' }],
      },
    })
    const bobWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>bob-bare-2</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${aliceWake}\n${bobWake}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(res.action, 'restored_wake_request')
    assert.equal(res.midTurn, true)
    assert.equal(memo.synced, true)

    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'first notification establishes current')
    assert.equal(after.joined.has(CMD_BOB), true, 'second same-turn notification joins instead of overwriting current')
    assert.equal(after.launches.get('alice-bare-1')?.notified, true)
    assert.equal(after.launches.get('bob-bare-2')?.notified, true)
    assert.ok(turnAmbiguity(after)?.length === 2)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny)
  })

  it('reconciles completed launch notifications even when turn_ended is already written by the first poll (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111d1'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222d2'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'ended-launch-1', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'ended-launch-2', kind: 'shell', notifies: true, request: CMD_BOB, also: [] }, { dir })

    const wake1 = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>ended-launch-1</task-id><status>completed</status></task-notification>' }],
      },
    })
    const wake2 = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>ended-launch-2</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${wake1}\n${wake2}\n${turnEndedRow()}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(res.action, 'not_typed_live')
    assert.equal(memo.synced, true)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.launches.get('ended-launch-1')?.notified, true, 'first ended-turn launch must be marked notified')
    assert.equal(after.launches.get('ended-launch-2')?.notified, true, 'second ended-turn launch must be marked notified')
  })

  it('does not treat a second same-turn notification as already carried when it adds another person via also (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111e1'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222e2'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    // Both launches share primary request CMD_BOB, while the second ALSO carries CMD_ALICE!
    appendRequestEvent(CONN, { op: 'launch', key: 'shared-primary-1', kind: 'shell', notifies: true, request: CMD_BOB, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'shared-primary-2', kind: 'shell', notifies: true, request: CMD_BOB, also: [CMD_ALICE] }, { dir })

    const bobRow = typedRow('Bob prompt before two notifications sharing primary request')
    const wake1 = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>shared-primary-1</task-id><status>completed</status></task-notification>' }],
      },
    })
    const wake2 = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>shared-primary-2</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${bobRow}\n${wake1}\n${wake2}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo,
    })
    assert.equal(res.action, 'restored_wake_request')
    assert.equal(res.midTurn, true)
    assert.equal(memo.synced, true)

    const after = readRequestState(CONN, { dir })
    assert.equal(after.joined.has(CMD_BOB), true)
    assert.equal(after.joined.has(CMD_ALICE), true, 'secondary requester in also must be joined, not skipped as already_carried')
    assert.equal(after.launches.get('shared-primary-1')?.notified, true)
    assert.equal(after.launches.get('shared-primary-2')?.notified, true)
    assert.ok(turnAmbiguity(after)?.length >= 2)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'next write must ask which person it serves instead of stamping terminal owner')
  })

  it('re-checks a completion notification once its delayed launch record arrives in .requests.jsonl instead of staying unchanged (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f1'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    const wakeRow = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>delayed-launch-1</task-id><status>completed</status></task-notification>' }],
      },
    })
    // Notification arrives BEFORE the matching launch record is written!
    fs.writeFileSync(transcriptPath, `${wakeRow}\n`)

    const memo = {}
    const poll1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(poll1.action, 'not_typed_live')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)

    // Matching launch record lands in .requests.jsonl afterward (transcript unchanged!).
    appendRequestEvent(CONN, { op: 'launch', key: 'delayed-launch-1', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true, 'adding launch record must invalidate memo pending check')

    const poll2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(poll2.action, 'restored_wake_request', 'must retry and restore instead of returning unchanged')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.launches.get('delayed-launch-1')?.notified, true, 'delayed launch must be marked notified')
    assert.equal(after.current, CMD_ALICE)
  })

  it('clears a prompt-hook-restored room command from an earlier background completion when transcript sync first runs on a later unrelated wake (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { promptArrival } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f2'
    const PROV_ALICE = '99999999-9999-4999-8999-9999999999f2'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE, provenance_ref: PROV_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'hook-restored-bg', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })

    // Turn 1: prompt hook restores CMD_ALICE for the background completion (`from_wake: true`).
    const wakeText = '<task-notification><task-id>hook-restored-bg</task-id><status>completed</status></task-notification>'
    const hookEvents = promptArrival({
      fromAPerson: false,
      origin: 'task-notification',
      text: wakeText,
      midTurn: false,
      state: readRequestState(CONN, { dir }),
    }).events
    for (const ev of hookEvents) appendRequestEvent(CONN, ev, { dir })
    assert.equal(readRequestState(CONN, { dir }).current, CMD_ALICE)
    assert.equal(readRequestState(CONN, { dir }).currentFromWake, true)

    // Turn 1 finishes and Turn 2 starts with an unrelated timestamp-only wake BEFORE transcript sync ever ran!
    const turn1Wake = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: wakeText }] },
    })
    const turn2Unrelated = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '[Thu Nov 26 2026 00:30:00 GMT+0000]' }] },
    })
    fs.writeFileSync(transcriptPath, `${turn1Wake}\n${turnEndedRow()}\n${turn2Unrelated}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(res.action, 'cleared_for_wake', 'unrelated wake must clear the earlier turn’s hook-restored room command')
    assert.equal(readRequestState(CONN, { dir }).current, null)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.deepEqual(stamped, { args: { task_id: 'x' } }, 'next write must NOT receive the previous command’s provenance_ref')
  })

  it('does not mark memo synced when a matching launch is appended to .requests.jsonl while sync awaits a later request (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f3'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })

    // Turn 1 (ended): completion notification whose launch record has NOT been written yet.
    // Turn 2 (live): typed prompt whose open_request is async.
    const histWake = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>race-launch-1</task-id><status>completed</status></task-notification>' }],
      },
    })
    const liveTyped = typedRow('Bob types while race-launch-1 lands mid-await')
    fs.writeFileSync(transcriptPath, `${histWake}\n${turnEndedRow()}\n${liveTyped}\n`)

    const memo = {}
    const pass1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        // Append the matching launch DURING the async await for the later typed turn!
        appendRequestEvent(
          CONN,
          { op: 'launch', key: 'race-launch-1', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] },
          { dir },
        )
        return { request_id: args.request_id, status: 'open', requested_by_user_id: BOB }
      },
      dir,
      memo,
    })
    assert.equal(pass1.action, 'opened')
    assert.equal(memo.synced, false, 'memo must NOT be marked synced while an appended launch matches an unexamined notification')
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true, 'next pass must be pending, never unchanged')

    const pass2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('typed turn already opened') },
      dir,
      memo,
    })
    assert.notEqual(pass2.action, 'unchanged', 'second pass must reconcile the earlier completion instead of returning unchanged')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.launches.get('race-launch-1')?.notified, true, 'earlier launch completion must be recorded as notified')
    assert.equal(memo.synced, true)
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)
  })

  it('preserves a scheduled wake’s prompt-hook provenance when an older historical background completion for the same request is reconciled (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { promptArrival } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f4'
    const PROV_ALICE = '99999999-9999-4999-8999-9999999999f4'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE, provenance_ref: PROV_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'older-bg-same-req', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'schedule', id: 'sched-1', prompt: 'check deploy status', request: CMD_ALICE, also: [] }, { dir })

    // Turn 1: earlier background completion for CMD_ALICE (ended before sync ran).
    const turn1WakeText = '<task-notification><task-id>older-bg-same-req</task-id><status>completed</status></task-notification>'
    const turn1Wake = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: turn1WakeText }] },
    })

    // Turn 2: scheduled wake for the SAME request CMD_ALICE, attributed by the prompt hook!
    const schedEvents = promptArrival({
      fromAPerson: false,
      origin: 'scheduled-trigger',
      text: 'check deploy status',
      midTurn: false,
      state: readRequestState(CONN, { dir }),
    }).events
    for (const ev of schedEvents) appendRequestEvent(CONN, ev, { dir })
    assert.equal(readRequestState(CONN, { dir }).current, CMD_ALICE)
    assert.equal(readRequestState(CONN, { dir }).currentFromWake, true)

    const turn2Scheduled = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'check deploy status' }] },
    })
    fs.writeFileSync(transcriptPath, `${turn1Wake}\n${turnEndedRow()}\n${turn2Scheduled}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(res.action, 'preserved_wake_request', 'scheduled wake must keep its prompt-hook attribution')
    assert.equal(res.requestId, CMD_ALICE)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'current request must remain CMD_ALICE for the scheduled wake')
    assert.equal(after.launches.get('older-bg-same-req')?.notified, true, 'older historical completion must still be marked notified')
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.args?.request_ref, CMD_ALICE, 'writes during scheduled wake must still carry CMD_ALICE request_ref')
  })

  it('does not seal an unmatched live completion while preserving a scheduled wake and joins the second person once its late launch lands (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { promptArrival, turnAmbiguity } = await import('./requests.mjs')
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f5'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222f5'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'schedule', id: 'sched-alice-2', prompt: 'watch alice deploy', request: CMD_ALICE, also: [] }, { dir })

    // Turn 1 starts with Alice's scheduled wake, attributed by the prompt hook (`from_wake: true`).
    const schedEvents = promptArrival({
      fromAPerson: false,
      origin: 'scheduled-trigger',
      text: 'watch alice deploy',
      midTurn: false,
      state: readRequestState(CONN, { dir }),
    }).events
    for (const ev of schedEvents) appendRequestEvent(CONN, ev, { dir })

    const schedRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'watch alice deploy' }] },
    })
    // Mid-turn (no turn_ended): Bob's background completion arrives BEFORE Bob's launch record lands!
    const bobNotifRow = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>bob-late-during-sched</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${schedRow}\n${bobNotifRow}\n`)

    const memo = {}
    const pass1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(pass1.action, 'preserved_wake_request')
    assert.equal(readRequestState(CONN, { dir }).current, CMD_ALICE)

    // Bob's matching launch record lands in `.requests.jsonl` afterward!
    appendRequestEvent(
      CONN,
      { op: 'launch', key: 'bob-late-during-sched', kind: 'shell', notifies: true, request: CMD_BOB, also: [] },
      { dir },
    )
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true)

    const pass2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(pass2.action, 'restored_wake_request', 'must reconcile Bob’s late completion instead of skipping as already_synced')
    assert.equal(pass2.midTurn, true, 'Bob’s mid-turn completion must JOIN Alice’s scheduled turn rather than replace it')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'Alice’s scheduled wake stays foreground current')
    assert.equal(after.joined.has(CMD_BOB), true, 'Bob’s request must be carried in joined')
    assert.equal(after.launches.get('bob-late-during-sched')?.notified, true, 'Bob’s launch must be marked notified')
    assert.ok(turnAmbiguity(after)?.length === 2, 'two-person ambiguity must be detected')
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'writes must ask which person they serve instead of stamping Alice alone')
  })

  it('finishIdleRequests rejects an unrecognized report_complete reply without erasing local_turn or closing the request (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const TYPED = '11111111-1111-4111-8111-1111111111f6'
    const ATTEMPT = '99999999-9999-4999-8999-9999999999f6'
    appendRequestEvent(CONN, { op: 'open', id: TYPED, kind: 'typed_prompt' }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: TYPED }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Finish this turn')}\n${turnEndedRow()}\n`)

    const state = {
      session_id: 'sess-idle-unrec',
      local_turn: { attempt_id: ATTEMPT, session_id: 'sess-idle-unrec' },
    }
    let patched = null
    let closeCalls = 0
    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callComplete: async () => ({ ok: true }),
      callRequest: async () => { closeCalls += 1; return { status: 'closed' } },
      patchState: (patch) => { patched = patch; return true },
      dir,
      log: () => {},
    })
    assert.equal(res.localCompleted, false)
    assert.deepEqual(res.closed, [])
    assert.equal(res.localCompleteRefusal?.code, 'unrecognized_complete_response')
    assert.equal(patched, null, 'must NOT clear local_turn retry state on unconfirmed report_complete')
    assert.equal(closeCalls, 0, 'must NOT close request when report_complete was unconfirmed')
    assert.equal(readRequestState(CONN, { dir }).current, TYPED, 'must NOT erase current foreground on unconfirmed completion')
  })

  it('preserves a live terminal-typed request across an unmatched mid-turn notification so the second person joins once its launch lands (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f7'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })

    // Turn 1 starts with Bob's terminal-typed prompt, and Alice's background notification
    // arrives mid-turn (no turn_ended) BEFORE Alice's launch record lands in .requests.jsonl!
    const bobRow = typedRow('Bob types a live terminal prompt')
    const aliceNotifRow = JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<task-notification><task-id>alice-late-mid-typed</task-id><status>completed</status></task-notification>' }],
      },
    })
    fs.writeFileSync(transcriptPath, `${bobRow}\n${aliceNotifRow}\n`)

    const memo = {}
    const pass1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo,
    })
    assert.equal(pass1.action, 'not_typed_live')
    const afterPass1 = readRequestState(CONN, { dir })
    assert.ok(afterPass1.current, 'Bob’s live typed_prompt must NOT be cleared by an unmatched mid-turn notification')
    assert.equal(afterPass1.open.get(afterPass1.current)?.kind, 'typed_prompt')
    const bobTypedId = afterPass1.current

    // Alice's launch record lands in .requests.jsonl afterward!
    appendRequestEvent(
      CONN,
      { op: 'launch', key: 'alice-late-mid-typed', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] },
      { dir },
    )
    assert.equal(typedTurnSyncPending({ transcriptPath, memo }), true)

    const pass2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('typed prompt already open') },
      dir,
      memo,
    })
    assert.equal(pass2.action, 'restored_wake_request')
    assert.equal(pass2.midTurn, true, 'Alice’s late mid-turn completion must JOIN Bob’s live typed prompt')
    const afterPass2 = readRequestState(CONN, { dir })
    assert.equal(afterPass2.current, bobTypedId, 'Bob’s live typed prompt stays foreground current')
    assert.equal(afterPass2.joined.has(CMD_ALICE), true, 'Alice’s request must join the live typed turn')
    assert.equal(afterPass2.launches.get('alice-late-mid-typed')?.notified, true)
    assert.ok(turnAmbiguity(afterPass2)?.length === 2)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'writes must ask which person they serve instead of stamping Alice alone')
  })

  it('finishIdleRequests does not report localCompleted when patchState fails, and a stale local_turn never suppresses admission for the next typed turn (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const ATTEMPT_1 = '99999999-9999-4999-8999-9999999999f8'
    const ATTEMPT_2 = '88888888-8888-4888-8888-8888888888f8'
    const SESSION = '77777777-7777-4777-8777-7777777777f8'
    const state = {
      connection_id: CONN,
      session_id: SESSION,
      speech_attachment_id: '55555555-5555-4555-8555-5555555555f8',
      attached_at: '2026-11-26T00:00:00.000Z',
      local_turn: null,
    }
    fs.writeFileSync(transcriptPath, `${typedRow('Turn 1')}\n`)
    const sync1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      callPickup: async (args) => ({ status: 'working', connection_id: CONN, attempt_id: args.attempt_id, expected_session_id: SESSION }),
      patchState: (patch) => { Object.assign(state, patch); return true },
      dir,
    })
    assert.equal(sync1.action, 'opened')
    const firstAttemptId = state.local_turn?.attempt_id
    assert.ok(firstAttemptId)

    fs.appendFileSync(transcriptPath, `${turnEndedRow()}\n`)
    let closeCalls = 0
    const idleRes = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callComplete: async () => ({ phase: 'done', closed_as: 'completed' }),
      callRequest: async () => { closeCalls += 1; return { status: 'closed' } },
      patchState: () => false,
      dir,
      log: () => {},
    })
    assert.equal(idleRes.localCompleted, false, 'must NOT report localCompleted when saving cleared local_turn fails')
    assert.equal(idleRes.localCompleteRefusal?.code, 'state_write_failed')
    assert.equal(closeCalls, 0, 'must NOT close request when clearing local_turn failed to persist')

    // Even with stale state.local_turn still present, Turn 2 MUST still send report_pickup!
    fs.appendFileSync(transcriptPath, `${typedRow('Turn 2 after failed state write')}\n`)
    const pickupCalls = []
    const sync2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      callPickup: async (args) => {
        pickupCalls.push(args)
        return { status: 'working', connection_id: CONN, attempt_id: args.attempt_id, expected_session_id: SESSION }
      },
      patchState: (patch) => { Object.assign(state, patch); return true },
      dir,
    })
    assert.equal(sync2.action, 'opened')
    assert.equal(pickupCalls.length, 1, 'stale local_turn from previous turn must NOT suppress admission for Turn 2')
    assert.ok(state.local_turn?.attempt_id && state.local_turn.attempt_id !== firstAttemptId)
  })

  it('finishIdleRequests never clears a new live typed request opened while awaiting the previous request’s close receipt (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const TYPED_1 = '11111111-1111-4111-8111-1111111111f9'
    const TYPED_2 = '22222222-2222-4222-8222-2222222222f9'
    appendRequestEvent(CONN, { op: 'open', id: TYPED_1, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: TYPED_1 }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Turn 1 finished')}\n${turnEndedRow()}\n`)

    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state: { session_id: ROOM, local_turn: null },
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        // While awaiting closeRequest for Turn 1, Turn 2 arrives and opens TYPED_2!
        fs.appendFileSync(transcriptPath, `${typedRow('Turn 2 opened mid-cleanup')}\n`)
        appendRequestEvent(CONN, { op: 'open', id: TYPED_2, kind: 'typed_prompt', requested_by: ALI }, { dir })
        appendRequestEvent(CONN, { op: 'current', ref: TYPED_2 }, { dir })
        return { status: 'closed' }
      },
      dir,
      log: () => {},
    })
    assert.deepEqual(res.closed, [TYPED_1])
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, TYPED_2, 'cleanup must NOT clear newly opened live typed request TYPED_2')
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.args?.request_ref, TYPED_2, 'writes during Turn 2 must keep TYPED_2 attribution')
  })

  it('finishIdleRequests does not erase a newer turn’s saved local_turn admitted while awaiting the previous turn’s completion receipt (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const SESSION = '77777777-7777-4777-8777-7777777777fa'
    const state = {
      connection_id: CONN,
      session_id: SESSION,
      speech_attachment_id: '55555555-5555-4555-8555-5555555555fa',
      attached_at: '2026-11-26T00:00:00.000Z',
      local_turn: null,
    }
    const persistState = (patch) => {
      Object.assign(state, patch)
      fs.writeFileSync(path.join(dir, `${CONN}.json`), JSON.stringify(state))
      return true
    }

    // Turn 1 opens and gets admitted as firstAttemptId, then ends.
    fs.writeFileSync(transcriptPath, `${typedRow('Turn 1')}\n`)
    const sync1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      callPickup: async (args) => ({ status: 'working', connection_id: CONN, attempt_id: args.attempt_id, expected_session_id: SESSION }),
      patchState: persistState,
      dir,
    })
    assert.equal(sync1.action, 'opened')
    const firstAttemptId = state.local_turn?.attempt_id
    assert.ok(firstAttemptId)
    fs.appendFileSync(transcriptPath, `${turnEndedRow()}\n`)

    // Start idle cleanup for Turn 1. While awaiting Turn 1's report_complete receipt,
    // Turn 2 starts and is admitted with a brand-new attempt_id.
    let secondAttemptId = null
    const completedAttempts = []
    let patchNullCalled = false
    const idle1 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callComplete: async (args) => {
        completedAttempts.push(args.attempt_id)
        fs.appendFileSync(transcriptPath, `${typedRow('Turn 2 admitted mid-complete')}\n`)
        const sync2 = await syncTypedTurnFromTranscript({
          connectionId: CONN,
          transcriptPath,
          state,
          connectionCapability: 'cap-secret',
          callRequest: async (r) => ({ request_id: r.request_id, status: 'open', requested_by_user_id: ALI }),
          callPickup: async (p) => ({ status: 'working', connection_id: CONN, attempt_id: p.attempt_id, expected_session_id: SESSION }),
          patchState: persistState,
          dir,
        })
        assert.equal(sync2.action, 'opened')
        secondAttemptId = state.local_turn?.attempt_id
        assert.ok(secondAttemptId && secondAttemptId !== firstAttemptId)
        return { phase: 'done', closed_as: 'completed' }
      },
      callRequest: async () => ({ status: 'closed' }),
      patchState: (patch) => {
        if (patch.local_turn === null) patchNullCalled = true
        return persistState(patch)
      },
      dir,
      log: () => {},
    })
    assert.equal(idle1.localCompleted, true)
    assert.equal(patchNullCalled, false, 'cleanup for Turn 1 must NOT overwrite Turn 2’s saved local_turn with null')
    assert.equal(state.local_turn?.attempt_id, secondAttemptId, 'Turn 2’s saved attempt must remain intact')

    // Now Turn 2 ends: idle cleanup MUST send report_complete for Turn 2’s attempt_id!
    fs.appendFileSync(transcriptPath, `${turnEndedRow()}\n`)
    const idle2 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callComplete: async (args) => {
        completedAttempts.push(args.attempt_id)
        return { phase: 'done', closed_as: 'completed' }
      },
      callRequest: async () => ({ status: 'closed' }),
      patchState: persistState,
      dir,
      log: () => {},
    })
    assert.equal(idle2.localCompleted, true)
    assert.deepEqual(completedAttempts, [firstAttemptId, secondAttemptId], 'both Turn 1 and Turn 2 must receive their own completion calls')
    assert.equal(state.local_turn, null, 'local_turn clears once Turn 2 completes with no newer turn')
  })

  it('new terminal prompt after turn_ended replaces an ended room command as sole current even when its lingering .turn marker remains on disk (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ROOM = '44444444-4444-4444-8444-4444444444fb'
    appendRequestEvent(CONN, { op: 'open', id: CMD_ROOM, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ROOM }, { dir })
    // Lingering .turn marker left on disk because Cursor CLI did not run the stop hook.
    fs.writeFileSync(path.join(dir, `${CONN}.turn`), JSON.stringify({ remoteTurn: true, startedAt: Date.now() - 5_000 }))

    // Transcript shows the room command turn ENDED, followed by a brand-new terminal prompt.
    const cmdRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'Your background command finished: wake' }] },
    })
    fs.writeFileSync(transcriptPath, `${cmdRow}\n${turnEndedRow()}\n${typedRow('Fresh terminal task after room turn ended')}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      dir,
    })
    assert.equal(res.action, 'opened')
    assert.equal(res.midTurn, false, 'terminal prompt after turn_ended must NOT join the ended room command')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, res.requestId, 'new terminal prompt must replace ended room command as sole current')
    assert.equal(after.joined.size, 0, 'must NOT treat the new turn as serving two people')
    assert.equal(turnAmbiguity(after), null)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.deny, undefined)
    assert.equal(stamped.args?.request_ref, res.requestId, 'writes in the new turn must stamp only the terminal prompt')
  })

  it('summary row between an ended room turn and a new terminal prompt still forgets the ended room marker and attributes solely to the terminal prompt (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ROOM = '44444444-4444-4444-8444-4444444444fc'
    appendRequestEvent(CONN, { op: 'open', id: CMD_ROOM, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ROOM }, { dir })
    fs.writeFileSync(path.join(dir, `${CONN}.turn`), JSON.stringify({ remoteTurn: true, startedAt: Date.now() - 5_000 }))

    const cmdRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'Your background command finished: wake' }] },
    })
    const summaryRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<available_subagent_types>summary</available_subagent_types>\n<dynamic_tool_catalog>tools</dynamic_tool_catalog>',
          },
        ],
      },
    })
    fs.writeFileSync(
      transcriptPath,
      `${cmdRow}\n${turnEndedRow()}\n${summaryRow}\n${typedRow('Terminal prompt after summary row')}\n`,
    )

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      dir,
    })
    assert.equal(res.action, 'opened')
    assert.equal(res.midTurn, false, 'summary row after turn_ended must NOT revive the ended room turn marker')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, res.requestId, 'terminal prompt after summary must replace ended room command as sole current')
    assert.equal(after.joined.size, 0, 'must NOT report two requesters')
    assert.equal(turnAmbiguity(after), null)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.deny, undefined)
    assert.equal(stamped.args?.request_ref, res.requestId)
  })

  it('transient request-log read error never marks transcript memo synced so recovery with unchanged files still reconciles the completion notification (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const CMD_ALICE = '55555555-5555-4555-8555-5555555555fd'
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'bg-transient-1', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    const notifRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<task-notification><task-id>bg-transient-1</task-id></task-notification>' }] },
    })
    fs.writeFileSync(transcriptPath, `${notifRow}\n`)

    const reqFile = path.join(dir, `${CONN}.requests.jsonl`)
    const origStat = fs.statSync(reqFile)
    const memo = {}

    // Simulate a transient request-log read error (EACCES) while leaving file content unchanged.
    fs.chmodSync(reqFile, 0o000)
    try {
      const failedPass = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => { throw new Error('should not open') },
        dir,
        memo,
      })
      assert.equal(failedPass.action, 'request_log_unreadable')
      assert.equal(memo.synced, false, 'transient request-log read error must NEVER mark memo synced')
    } finally {
      fs.chmodSync(reqFile, 0o600)
      fs.utimesSync(reqFile, origStat.atime, origStat.mtime)
    }

    // With BOTH files completely unchanged after read recovery, typedTurnSyncPending MUST return true!
    assert.equal(
      typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }),
      true,
      'poller must still see pending sync after transient request-log read error recovers with unchanged files',
    )
    const recoveredPass = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('should not open') },
      dir,
      memo,
    })
    assert.equal(recoveredPass.action, 'restored_wake_request')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE)
    assert.equal(after.launches.get('bg-transient-1')?.notified, true)
    assert.equal(memo.synced, true)
  })

  it('transient write-only request-log read failure during queued older-turn recovery never clears another person’s live room command or marks sync complete (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_BOB = '66666666-6666-4666-8666-6666666666fe'
    const reqFile = path.join(dir, `${CONN}.requests.jsonl`)

    // Turn 1 (typed) ended unseen before sync; now Turn 2 is Bob's live room command!
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_BOB }, { dir })
    const cmdRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'Your background command finished: wake' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Earlier missed terminal turn')}\n${turnEndedRow()}\n${cmdRow}\n`)

    const memo = {}
    let chmodApplied = false
    try {
      const pass1 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          // Simulate a transient write-only read failure (`0o200`: appendFileSync works,
          // readFileSync fails with EACCES!) right after DevSpec accepts the older turn open
          // and right before flushPendingLocalOpenEntry runs!
          fs.chmodSync(reqFile, 0o200)
          chmodApplied = true
          return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
        },
        dir,
        memo,
      })
      assert.equal(pass1.retriedFailedTurn?.action, 'open_write_failed')
      assert.equal(memo.synced, false, 'memo must stay unsynced after transient read failure in recovery')
    } finally {
      if (chmodApplied) fs.chmodSync(reqFile, 0o600)
    }

    // Bob's live room command MUST still be current (NOT wiped to null!)
    const midState = readRequestState(CONN, { dir })
    assert.equal(midState.current, CMD_BOB, 'live room command attribution MUST survive transient read failure during older-turn retry')
    const midStamped = stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home })
    assert.equal(midStamped.args?.request_ref, CMD_BOB, 'claims must still carry Bob’s live room command')

    // Next pass after read recovery completes the older turn AND preserves Bob’s live room command!
    assert.equal(typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }), true)
    const pass2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('already opened on DevSpec') },
      dir,
      memo,
    })
    assert.equal(pass2.action, 'not_typed_live')
    assert.equal(memo.synced, true)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_BOB, 'Bob’s live room command must remain current after older turn finishes flushing')
    const afterStamped = stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home })
    assert.equal(afterStamped.args?.request_ref, CMD_BOB)
  })

  it('retrying an older terminal request preserves joined second-person room command and two-person ambiguity on the live turn (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111e1'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222e2'

    // Turn 1 (older terminal turn) ended unseen; live Turn 2 carries BOTH Alice's room command
    // AND Bob's joined room command (two-person ambiguity).
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'joined', id: CMD_BOB }, { dir })

    const beforeStamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(beforeStamped.deny, 'before retry, write must ask which person it serves')

    const cmdRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'Your background command finished: wake' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Older missed turn')}\n${turnEndedRow()}\n${cmdRow}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      dir,
    })
    assert.equal(res.retriedFailedTurn?.action, 'opened')

    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'first person foreground request must remain current')
    assert.equal(after.joined.has(CMD_BOB), true, 'second person joined room command MUST survive older-turn retry')
    assert.equal(turnAmbiguity(after)?.length, 2, 'two-person ambiguity must remain intact after retry')
    const afterStamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(afterStamped.deny, 'after retry, write must STILL ask which person it serves instead of auto-stamping person 1')
  })

  it('unreadable pending-opens retry queue file never marks sync complete so recovery with unchanged files still flushes the queued request (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const QUEUED_REQ = '77777777-7777-4777-8777-7777777777e3'
    const turnText = 'Earlier queued turn in sidecar'
    fs.writeFileSync(transcriptPath, `${typedRow(turnText)}\n${turnEndedRow()}\n`)
    // Discover the turn key for the ended turn via a dry transcript read.
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const active = activeTranscriptTurn(transcriptPath)
    const turnKey = active.typedTurnKeys[0]
    assert.ok(turnKey)

    // Write the pending-opens sidecar file on disk (as a prior process would have done)
    // and then make it transiently unreadable (chmod 0o000).
    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: QUEUED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )
    const origStat = fs.statSync(sidecar)
    const memo = {}

    fs.chmodSync(sidecar, 0o000)
    try {
      const failedPass = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => { throw new Error('should not open a duplicate') },
        dir,
        memo,
      })
      assert.equal(failedPass.action, 'pending_opens_unreadable')
      assert.equal(memo.synced, false, 'unreadable retry queue must NEVER mark transcript sync complete')
    } finally {
      fs.chmodSync(sidecar, 0o600)
      fs.utimesSync(sidecar, origStat.atime, origStat.mtime)
    }

    // After reads recover with files unchanged, typedTurnSyncPending MUST return true and flush QUEUED_REQ!
    assert.equal(typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }), true)
    const recovered = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('already opened on server') },
      dir,
      memo,
    })
    assert.equal(recovered.action, 'not_typed_live')
    assert.equal(memo.synced, true)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.open.has(QUEUED_REQ), true, 'queued request must be persisted once retry queue reads recover')
    assert.equal(after.seenTranscriptTurns.get(turnKey), QUEUED_REQ)
  })

  it('failed request-log read in the retry index logs the error, keeps memo unsynced, and retries the queued request once readable (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')

    // Turn 1 failed earlier and is queued via typed_turn_failed in .requests.jsonl;
    // Transcript is now ended on a non-typed row so sync runs retryQueuedFailedTurn().
    fs.writeFileSync(transcriptPath, `${typedRow('Earlier failed turn')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)
    appendRequestEvent(CONN, { op: 'typed_turn_failed', key: turnKey }, { dir })
    const assistantRow = JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'Idle turn complete' }] },
    })
    fs.writeFileSync(transcriptPath, `${assistantRow}\n${turnEndedRow()}\n`)

    const reqFile = path.join(dir, `${CONN}.requests.jsonl`)
    const origReadFileSync = fs.readFileSync
    let reqReads = 0
    let injectedFail = false
    const logs = []
    const memo = {}
    let openedIds = []

    // Let the initial startReqState read succeed, then inject a transient EACCES read error
    // specifically when the failed-turn retry index reads .requests.jsonl!
    fs.readFileSync = (targetPath, ...rest) => {
      if (String(targetPath) === reqFile) {
        reqReads += 1
        if (reqReads === 2) {
          injectedFail = true
          const err = new Error('EACCES: permission denied reading retry index')
          err.code = 'EACCES'
          throw err
        }
      }
      return origReadFileSync.call(fs, targetPath, ...rest)
    }
    try {
      const failedPass = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          openedIds.push(args.request_id)
          return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
        },
        dir,
        memo,
        log: (line) => logs.push(line),
      })
      assert.equal(injectedFail, true, 'must have injected read error on retry index read')
      assert.equal(failedPass.action, 'request_log_unreadable')
      assert.equal(memo.synced, false, 'poller must NOT mark sync complete when retry index read fails')
      assert.ok(
        logs.some((l) => /retry index unreadable|EACCES/i.test(l)),
        `must log the retry index read error; got logs=${JSON.stringify(logs)}`,
      )
      assert.equal(openedIds.length, 0)
    } finally {
      fs.readFileSync = origReadFileSync
    }

    // Next pending-sync probe MUST report work still pending, and next pass MUST open the queued turn!
    assert.equal(typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }), true)
    const recovered = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        openedIds.push(args.request_id)
        return { request_id: args.request_id, status: 'open', requested_by_user_id: ALI }
      },
      dir,
      memo,
    })
    assert.equal(recovered.action, 'opened')
    assert.equal(openedIds.length, 1, 'queued request must be opened once retry index reads recover')
    assert.equal(memo.synced, true)
  })

  it('interrupted older-turn recovery after currentRestored never reapplies previous sender selection or joined onto a different live turn (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f1'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222f2'
    const CMD_CAROL = '33333333-3333-4333-8333-3333333333f3'
    const OLDER_REQ = '77777777-7777-4777-8777-7777777777f4'

    // Older terminal turn had already been opened and started, then recovery was interrupted
    // right after `currentRestored: true` (restoring CMD_ALICE) and BEFORE restoring `joined`
    // and `serve CMD_ALICE`. Before retry runs, a DIFFERENT live room turn from Carol starts!
    const cmdRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'Your background command finished: wake' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Earlier terminal turn')}\n${turnEndedRow()}\n${cmdRow}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: OLDER_REQ, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: OLDER_REQ }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
    // New live room turn from Carol arrives before interrupted recovery retries!
    appendRequestEvent(CONN, { op: 'open', id: CMD_CAROL, kind: 'command', requested_by: CAROL }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_CAROL }, { dir })

    const beforeStamped = stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home })
    assert.equal(beforeStamped.args?.request_ref, CMD_CAROL, 'live claim before retry carries Carol’s reference')

    // Persist the interrupted recovery state in `.pending-opens.json` with `currentRestored: true`.
    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({
        [turnKey]: {
          requestId: OLDER_REQ,
          requestedBy: ALI,
          turnKey,
          restoreForeground: {
            current: CMD_ALICE,
            fromWake: false,
            boundByWake: false,
            wakeNotifiedKeys: [],
            joined: [CMD_BOB],
            chosen: true,
            currentRestored: true,
          },
        },
      }),
      { mode: 0o600 },
    )

    await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('already opened on DevSpec') },
      dir,
    })

    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_CAROL, 'Carol’s live room command MUST remain current')
    assert.equal(after.joined.has(CMD_BOB), false, 'previous turn’s joined sender MUST NOT be reapplied onto Carol’s live turn')
    assert.equal(after.chosen, false, 'previous turn’s serve selection MUST NOT be reapplied onto Carol’s live turn')
    const afterStamped = stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home })
    assert.equal(
      afterStamped.args?.request_ref,
      CMD_CAROL,
      'the same claim MUST still carry Carol’s reference, never reverting to Alice’s previous turn',
    )
    assert.equal(after.seenTranscriptTurns.get(turnKey), OLDER_REQ)
  })

  it('finishIdleRequests re-checks pending launches after awaiting report_complete so a launch recorded mid-wait keeps the request open for its wake (3ea2b201 / ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { requestForWake } = await import('./requests.mjs')
    const REQ_ID = '55555555-5555-4555-8555-5555555555a1'
    const ATTEMPT_ID = '66666666-6666-4666-8666-6666666666a1'

    fs.writeFileSync(transcriptPath, `${typedRow('Run background job')}\n${turnEndedRow()}\n`)
    appendRequestEvent(CONN, { op: 'open', id: REQ_ID, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ID }, { dir })

    const closeCalls = []
    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state: { session_id: ROOM, local_turn: { attempt_id: ATTEMPT_ID, session_id: ROOM } },
      connectionCapability: 'cap-secret',
      callComplete: async () => {
        // Record a background launch on REQ_ID WHILE awaiting report_complete!
        appendRequestEvent(
          CONN,
          { op: 'launch', key: 'bg-task-midwait', kind: 'background_task', request: REQ_ID },
          { dir },
        )
        return { outcome: 'completed', phase: 'done' }
      },
      callRequest: async (args) => {
        closeCalls.push(args)
        return { status: 'closed' }
      },
      patchState: () => true,
      dir,
    })

    assert.equal(res.localCompleted, true)
    assert.deepEqual(closeCalls, [], 'MUST NOT close REQ_ID once a background launch was recorded during report_complete')
    assert.deepEqual(res.closed, [])
    const after = readRequestState(CONN, { dir })
    assert.equal(after.open.has(REQ_ID), true, 'REQ_ID must stay open for its pending background launch')
    const wakeMatch = requestForWake({
      origin: 'task-notification',
      text: '<task-notification><task-id>bg-task-midwait</task-id></task-notification>',
      state: after,
    })
    assert.equal(wakeMatch.ref, REQ_ID, 'later background wake must still resolve its requester')
  })

  it('retrying an older terminal request preserves NO_REQUEST (independent-work choice) joined with a room command on a live turn (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { NO_REQUEST, turnAmbiguity } = await import('./requests.mjs')
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f9'

    // Live turn carries BOTH Alice's room command AND independent work (NO_REQUEST) in joined!
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'joined', id: NO_REQUEST }, { dir })

    const beforeStamped = stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home, includeProvenance: true })
    assert.ok(beforeStamped.deny, 'before retry, claim must ask which work (Alice vs independent work) it serves')

    const cmdRow = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'Your background command finished: wake' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Earlier missed terminal prompt')}\n${turnEndedRow()}\n${cmdRow}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: ALI }),
      dir,
    })
    assert.equal(res.retriedFailedTurn?.action, 'opened')

    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE)
    assert.equal(after.joined.has(NO_REQUEST), true, 'independent-work choice (NO_REQUEST) MUST remain in joined after older-turn retry')
    assert.equal(turnAmbiguity(after)?.length, 2)
    const afterStamped = stampRequest('claim_work_item', { task_id: 'x' }, CONN, null, { home, includeProvenance: true })
    assert.ok(afterStamped.deny, 'after retry, the same claim MUST STILL ask which work it serves instead of auto-stamping Alice')
  })

  it('finishIdleRequests does not close a pending-opens recovered request when a pending launch is recorded before or during report_complete (3ea2b201 / ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const { requestForWake } = await import('./requests.mjs')
    const RECOVERED_REQ = '55555555-5555-4555-8555-5555555555b2'
    const ATTEMPT_ID = '66666666-6666-4666-8666-6666666666b2'

    fs.writeFileSync(transcriptPath, `${typedRow('Run background job from recovered open')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    // Server-opened request lives in `.pending-opens.json` (not yet in `.requests.jsonl`).
    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: RECOVERED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )

    const closeCalls = []
    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state: { session_id: ROOM, local_turn: { attempt_id: ATTEMPT_ID, session_id: ROOM } },
      connectionCapability: 'cap-secret',
      callComplete: async () => {
        // While awaiting report_complete, the open + background launch land in `.requests.jsonl`!
        appendRequestEvent(CONN, { op: 'open', id: RECOVERED_REQ, kind: 'typed_prompt', requested_by: ALI }, { dir })
        appendRequestEvent(CONN, { op: 'current', ref: RECOVERED_REQ }, { dir })
        appendRequestEvent(
          CONN,
          { op: 'launch', key: 'bg-task-recovered-midwait', kind: 'background_task', request: RECOVERED_REQ },
          { dir },
        )
        return { outcome: 'completed', phase: 'done' }
      },
      callRequest: async (args) => {
        closeCalls.push(args)
        return { status: 'closed' }
      },
      patchState: () => true,
      dir,
    })

    assert.equal(res.localCompleted, true)
    assert.deepEqual(closeCalls, [], 'MUST NOT close recovered request once a pending launch exists in .requests.jsonl')
    assert.deepEqual(res.closed, [])
    const after = readRequestState(CONN, { dir })
    assert.equal(after.open.has(RECOVERED_REQ), true)
    const wakeMatch = requestForWake({
      origin: 'task-notification',
      text: '<task-notification><task-id>bg-task-recovered-midwait</task-id></task-notification>',
      state: after,
    })
    assert.equal(wakeMatch.ref, RECOVERED_REQ, 'later wake for recovered request must still resolve its requester')
  })

  it('finishIdleRequests fails closed with closeRefusal when the request log returns EISDIR before the final check of a recovered request (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const RECOVERED_REQ = '55555555-5555-4555-8555-5555555555c1'
    const ATTEMPT_ID = '66666666-6666-4666-8666-6666666666c1'
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)

    fs.writeFileSync(transcriptPath, `${typedRow('Recovered request with EISDIR mid-sweep')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: RECOVERED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )

    const closeCalls = []
    const logs = []
    try {
      const res = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        state: { session_id: ROOM, local_turn: { attempt_id: ATTEMPT_ID, session_id: ROOM } },
        connectionCapability: 'cap-secret',
        callComplete: async () => {
          // Make `.requests.jsonl` return EISDIR right before the final pre-close check!
          fs.rmSync(reqLog, { recursive: true, force: true })
          fs.mkdirSync(reqLog, { recursive: true })
          return { outcome: 'completed', phase: 'done' }
        },
        callRequest: async (args) => {
          closeCalls.push(args)
          return { status: 'closed' }
        },
        patchState: () => true,
        dir,
        log: (line) => logs.push(line),
      })
      assert.deepEqual(closeCalls, [], 'MUST NOT close recovered request when request log returns EISDIR')
      assert.deepEqual(res.closed, [])
      assert.equal(res.closeRefusal?.code, 'request_log_unreadable')
      assert.equal(fs.existsSync(sidecar), true, 'retry entry MUST remain in .pending-opens.json')
      assert.ok(logs.some((l) => /request_log_unreadable|unreadable/i.test(l)))
    } finally {
      fs.rmSync(reqLog, { recursive: true, force: true })
    }
  })

  it('closing one recovered request never rotates .requests.jsonl while another recovered request still awaits recovery with a recorded launch (ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const { requestForWake } = await import('./requests.mjs')
    const REQ_1 = '55555555-5555-4555-8555-5555555555d1'
    const REQ_2 = '55555555-5555-4555-8555-5555555555d2'

    fs.writeFileSync(
      transcriptPath,
      `${typedRow('First recovered turn')}\n${turnEndedRow()}\n${typedRow('Second recovered turn with launch')}\n${turnEndedRow()}\n`,
    )
    const keys = activeTranscriptTurn(transcriptPath).typedTurnKeys
    assert.equal(keys.length, 2)
    const [turnKey1, turnKey2] = keys

    // Pad .requests.jsonl past ROTATE_BYTES (64 KB) and record a pending background launch for REQ_2!
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)
    const padLine = JSON.stringify({ op: 'note', pad: 'p'.repeat(4_000) }) + '\n'
    fs.writeFileSync(reqLog, padLine.repeat(20), { mode: 0o600 })
    appendRequestEvent(
      CONN,
      { op: 'launch', key: 'bg-launch-for-req-2', kind: 'background_task', request: REQ_2 },
      { dir },
    )

    // Both REQ_1 (no pending work) and REQ_2 (has recorded launch in .requests.jsonl!) sit in .pending-opens.json.
    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({
        [turnKey1]: { requestId: REQ_1, requestedBy: ALI, turnKey: turnKey1 },
        [turnKey2]: { requestId: REQ_2, requestedBy: ALI, turnKey: turnKey2 },
      }),
      { mode: 0o600 },
    )

    // Idle pass closes REQ_1, MUST NOT rotate .requests.jsonl and MUST NOT drop REQ_2's recorded launch!
    const closedIds = []
    const idle1 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        if (args.action === 'close') closedIds.push(args.request_id)
        return { status: 'closed' }
      },
      dir,
      log: () => {},
    })
    assert.deepEqual(idle1.closed, [REQ_1])
    assert.equal(fs.existsSync(`${reqLog}.1`), false, 'MUST NOT rotate .requests.jsonl while REQ_2 awaits recovery')

    // Now sync restores REQ_2 into .requests.jsonl: its recorded launch MUST STILL resolve its wake
    // and the next idle pass MUST NOT close REQ_2!
    await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('already opened') },
      dir,
    })
    const stateAfterRestore = readRequestState(CONN, { dir })
    assert.equal(stateAfterRestore.open.has(REQ_2), true)
    const wakeMatch = requestForWake({
      origin: 'task-notification',
      text: '<task-notification><task-id>bg-launch-for-req-2</task-id></task-notification>',
      state: stateAfterRestore,
    })
    assert.equal(wakeMatch.ref, REQ_2, 'REQ_2 wake MUST still resolve to REQ_2 after REQ_1 closed')

    const idle2 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        if (args.action === 'close') closedIds.push(args.request_id)
        return { status: 'closed' }
      },
      dir,
      log: () => {},
    })
    assert.deepEqual(idle2.closed, [], 'next idle pass MUST NOT close REQ_2 while its launch is pending')
  })

  it('finishIdleRequests does NOT report fallback close complete or remove .pending-opens.json when persisting the local close fails (ENOSPC / read-only), and retries cleanly once writable (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const RECOVERED_REQ = '55555555-5555-4555-8555-5555555555e1'
    const reqLog = path.join(dir, `${CONN}.requests.jsonl`)

    fs.writeFileSync(transcriptPath, `${typedRow('Fallback close with ENOSPC on local write')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: RECOVERED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )
    // Make `.requests.jsonl` readable but unwritable (simulates ENOSPC/EACCES on local close append).
    fs.writeFileSync(reqLog, '', { mode: 0o400 })
    const logs = []
    try {
      const idle1 = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: (line) => logs.push(line),
      })
      assert.deepEqual(idle1.closed, [], 'MUST NOT report fallback close complete when local close write fails')
      assert.equal(idle1.closeRefusal?.code, 'local_close_persist_failed')
      assert.equal(fs.existsSync(sidecar), true, 'recovery entry MUST remain in .pending-opens.json for retry')
      assert.ok(logs.some((l) => /local_close_persist_failed|local close failed/i.test(l)))
    } finally {
      fs.chmodSync(reqLog, 0o600)
    }

    // Once disk is writable again, the next idle pass persists the local close, removes the recovery entry, and reports closed!
    const idle2 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => ({ status: 'closed' }),
      dir,
      log: () => {},
    })
    assert.deepEqual(idle2.closed, [RECOVERED_REQ])
    assert.equal(idle2.closeRefusal, undefined)
    assert.equal(fs.existsSync(sidecar), false, 'recovery entry is removed ONLY after local close persists')
    assert.match(fs.readFileSync(reqLog, 'utf8'), new RegExp(`"op":"close","id":"${RECOVERED_REQ}"`))
  })

  it('finishIdleRequests does NOT accept a fallback close locally if a pending launch for that request lands while awaiting DevSpec’s close reply (ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const { requestForWake } = await import('./requests.mjs')
    const RECOVERED_REQ = '55555555-5555-4555-8555-5555555555e2'

    fs.writeFileSync(transcriptPath, `${typedRow('Fallback close racing pending launch during callRequest')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: RECOVERED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )

    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        // While waiting for DevSpec's close reply, the open + pending launch land locally!
        appendRequestEvent(CONN, { op: 'open', id: RECOVERED_REQ, kind: 'typed_prompt', requested_by: ALI }, { dir })
        appendRequestEvent(CONN, { op: 'current', ref: RECOVERED_REQ }, { dir })
        appendRequestEvent(
          CONN,
          { op: 'launch', key: 'bg-launch-during-close-reply', kind: 'background_task', request: RECOVERED_REQ },
          { dir },
        )
        const duringWait = readRequestState(CONN, { dir })
        assert.equal(
          requestForWake({
            origin: 'task-notification',
            text: '<task-notification><task-id>bg-launch-during-close-reply</task-id></task-notification>',
            state: duringWait,
          }).ref,
          RECOVERED_REQ,
        )
        return { status: 'closed' }
      },
      dir,
      log: () => {},
    })

    assert.deepEqual(res.closed, [], 'MUST NOT accept fallback close when a pending launch landed while awaiting reply')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.open.has(RECOVERED_REQ), true, 'request MUST remain open locally while its launch is pending')
    const wakeAfter = requestForWake({
      origin: 'task-notification',
      text: '<task-notification><task-id>bg-launch-during-close-reply</task-id></task-notification>',
      state: after,
    })
    assert.equal(
      wakeAfter.ref,
      RECOVERED_REQ,
      'wake for pending launch MUST STILL resolve to the original request (not UNSTATED)',
    )
  })

  it('finishIdleRequests reports closeRefusal when removing .pending-opens.json fails and subsequent sync NEVER resurrects the closed request into open (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const RECOVERED_REQ = '55555555-5555-4555-8555-5555555555f1'

    fs.writeFileSync(transcriptPath, `${typedRow('Fallback close where pending-opens unlink fails')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: RECOVERED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )

    // Simulate unlink/rm failure on `.pending-opens.json` while `.requests.jsonl` is writable!
    const origRmSync = fs.rmSync
    fs.rmSync = (targetPath, ...rest) => {
      if (String(targetPath) === sidecar) {
        throw Object.assign(new Error('EPERM removing pending-opens.json'), { code: 'EPERM' })
      }
      return origRmSync(targetPath, ...rest)
    }
    const logs = []
    let idle1 = null
    try {
      idle1 = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: (line) => logs.push(line),
      })
      assert.deepEqual(idle1.closed, [], 'MUST NOT report closed when removing .pending-opens.json fails')
      assert.equal(idle1.closeRefusal?.code, 'pending_open_cleanup_failed')
      assert.equal(fs.existsSync(sidecar), true)
      assert.ok(logs.some((l) => /pending_open_cleanup_failed/i.test(l)))

      // Even if sync runs while the stale `.pending-opens.json` still exists, it MUST NOT resurrect RECOVERED_REQ into open!
      const memo = {}
      await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => { throw new Error('must not reopen closed request') },
        dir,
        memo,
      })
      assert.equal(readRequestState(CONN, { dir }).open.has(RECOVERED_REQ), false, 'stale pending-opens entry MUST NOT resurrect already-closed request')
      assert.equal(memo.synced, false, 'sync must remain unsynced until stale recovery entry is cleaned up')
    } finally {
      fs.rmSync = origRmSync
    }

    // Once unlink works again, next idle sweep removes the recovery entry and completes cleanly!
    const idle2 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => ({ status: 'closed' }),
      dir,
      log: () => {},
    })
    assert.deepEqual(idle2.closed, [RECOVERED_REQ])
    assert.equal(idle2.closeRefusal, undefined)
    assert.equal(fs.existsSync(sidecar), false)
    assert.equal(readRequestState(CONN, { dir }).open.has(RECOVERED_REQ), false)
  })

  it('finishIdleRequests does NOT close a request that joined a different person’s live terminal turn while awaiting DevSpec’s close reply (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111f8'
    const TYPED_BOB = '22222222-2222-4222-8222-2222222222f8'

    // Alice's command had a background launch that already notified and finished Turn 1.
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'answered', id: CMD_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-bg-join-race', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'notified', key: 'alice-bg-join-race' }, { dir })
    fs.writeFileSync(transcriptPath, `${typedRow('Earlier ended turn')}\n${turnEndedRow()}\n`)

    const res = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        // While close for CMD_ALICE is in flight, Bob opens a live terminal turn AND
        // Alice's background completion joins Bob's live turn!
        fs.appendFileSync(transcriptPath, `${typedRow('Bob starts a new terminal turn')}\n`)
        appendRequestEvent(CONN, { op: 'open', id: TYPED_BOB, kind: 'typed_prompt', requested_by: BOB }, { dir })
        appendRequestEvent(CONN, { op: 'current', ref: TYPED_BOB }, { dir })
        appendRequestEvent(CONN, { op: 'joined', id: CMD_ALICE }, { dir })
        assert.ok(turnAmbiguity(readRequestState(CONN, { dir }))?.length === 2)
        return { status: 'closed' }
      },
      dir,
      log: () => {},
    })

    assert.deepEqual(res.closed, [], 'MUST NOT close CMD_ALICE after it joined Bob’s live turn during close wait')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, TYPED_BOB)
    assert.equal(after.open.has(CMD_ALICE), true, 'CMD_ALICE must remain open while carried in Bob’s live turn')
    assert.equal(after.joined.has(CMD_ALICE), true, 'CMD_ALICE must remain in joined')
    assert.equal(turnAmbiguity(after)?.length, 2, 'two-person ambiguity must remain intact')
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'writes MUST STILL require a choice instead of auto-stamping Bob alone')
  })

  it('live-turn pending-open recovery reports pending_open_cleanup_failed and leaves turn unsynced when removing .pending-opens.json fails, then retries and completes after disk recovers (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const RECOVERED_REQ = '55555555-5555-4555-8555-5555555555f9'

    fs.writeFileSync(transcriptPath, `${typedRow('Live turn whose pending-open cleanup fails')}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).key
    assert.ok(turnKey)

    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: RECOVERED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )

    const origRmSync = fs.rmSync
    fs.rmSync = (targetPath, ...rest) => {
      if (String(targetPath) === sidecar) {
        throw Object.assign(new Error('EPERM removing pending-opens.json'), { code: 'EPERM' })
      }
      return origRmSync(targetPath, ...rest)
    }

    const logs = []
    const memo = {}
    let openCalls = 0
    const callRequest = async () => {
      openCalls += 1
      throw new Error('must not reopen an already recovered live request')
    }
    try {
      const pass1 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest,
        dir,
        memo,
        log: (line) => logs.push(line),
      })
      assert.equal(pass1.action, 'pending_open_cleanup_failed')
      assert.equal(pass1.requestId, RECOVERED_REQ)
      assert.equal(pass1.refusal?.code, 'pending_open_cleanup_failed')
      assert.equal(memo.synced, false, 'MUST NOT mark memo synced while pending-open cleanup failed')
      assert.equal(typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }), true)
      assert.equal(fs.existsSync(sidecar), true)
      assert.ok(logs.some((l) => /pending_open_cleanup_failed/i.test(l)))
      const midState = readRequestState(CONN, { dir })
      assert.equal(midState.open.has(RECOVERED_REQ), true)
      assert.equal(midState.current, RECOVERED_REQ)
      assert.equal(
        midState.seenTranscriptTurns.has(turnKey),
        false,
        'MUST NOT mark transcript_turn seen when removing .pending-opens.json fails',
      )
    } finally {
      fs.rmSync = origRmSync
    }

    // After disk recovers, the next pass MUST retry cleanup, remove .pending-opens.json, and complete sync!
    const pass2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest,
      dir,
      memo,
      log: (line) => logs.push(line),
    })
    assert.equal(pass2.action, 'opened', 'next pass must finish recovery rather than silently returning already_synced')
    assert.equal(pass2.requestId, RECOVERED_REQ)
    assert.equal(openCalls, 0, 'must NOT open a second request on DevSpec')
    assert.equal(fs.existsSync(sidecar), false, '.pending-opens.json must be removed on retry')
    assert.equal(memo.synced, true)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, RECOVERED_REQ)
    assert.equal(after.seenTranscriptTurns.get(turnKey), RECOVERED_REQ)
  })

  it('preserves terminal requester AND joins a single background completion when Cursor writes a summary row immediately afterward in a live turn (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111e5'

    appendRequestEvent(
      CONN,
      { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE, message_id: 'msg-alice-summary' },
      { dir },
    )
    appendRequestEvent(
      CONN,
      { op: 'launch', key: 'alice-bg-before-summary', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] },
      { dir },
    )

    const bobRow = typedRow('Bob live terminal prompt before single wake and summary')
    const aliceWake = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>alice-bg-before-summary</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    const summaryRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<available_subagent_types>summary</available_subagent_types>\n<dynamic_tool_catalog>tools</dynamic_tool_catalog>',
          },
        ],
      },
    })

    // First sync sees Bob's live terminal prompt; then single background completion + Cursor summary arrive together.
    fs.writeFileSync(transcriptPath, `${bobRow}\n`)
    const memo = {}
    const poll1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo,
    })
    assert.equal(poll1.action, 'opened')
    const TYPED_BOB = poll1.requestId

    fs.writeFileSync(transcriptPath, `${bobRow}\n${aliceWake}\n${summaryRow}\n`)
    const poll2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        throw new Error('must not reopen Bob request')
      },
      dir,
      memo,
    })
    assert.equal(poll2.action, 'restored_wake_request')
    assert.equal(poll2.midTurn, true)
    assert.equal(memo.synced, true)

    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, TYPED_BOB, 'summary row MUST NOT clear Bob’s live terminal requester')
    assert.equal(after.joined.has(CMD_ALICE), true, 'single background wake before summary MUST be joined, not skipped')
    assert.equal(after.launches.get('alice-bg-before-summary')?.notified, true)
    assert.equal(turnAmbiguity(after)?.length, 2, 'two-person ambiguity between Bob and Alice must be preserved')

    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'next write must require choosing between Bob and Alice instead of stamping neither')
    assert.match(stamped.deny, /--terminal/)
    assert.match(stamped.deny, /msg-alice-summary/)
  })

  it('ended-turn pending-open flush does NOT mark transcript_turn seen when removing .pending-opens.json fails, and completes cleanly on retry (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const RECOVERED_REQ = '55555555-5555-4555-8555-5555555555fa'

    fs.writeFileSync(transcriptPath, `${typedRow('Ended turn whose pending-open cleanup fails')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: RECOVERED_REQ, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )

    const origRmSync = fs.rmSync
    fs.rmSync = (targetPath, ...rest) => {
      if (String(targetPath) === sidecar) {
        throw Object.assign(new Error('EPERM removing pending-opens.json'), { code: 'EPERM' })
      }
      return origRmSync(targetPath, ...rest)
    }
    const memo = {}
    try {
      const pass1 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => { throw new Error('must not reopen') },
        dir,
        memo,
      })
      assert.equal(pass1.action, 'open_write_failed')
      assert.equal(memo.synced, false)
      assert.equal(
        readRequestState(CONN, { dir }).seenTranscriptTurns.has(turnKey),
        false,
        'flushPendingLocalOpenEntry MUST NOT mark transcript_turn seen when deleting .pending-opens.json fails',
      )
    } finally {
      fs.rmSync = origRmSync
    }

    const pass2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => { throw new Error('must not reopen') },
      dir,
      memo,
    })
    assert.equal(pass2.action, 'not_typed_live')
    assert.equal(fs.existsSync(sidecar), false)
    assert.equal(memo.synced, true)
    assert.equal(readRequestState(CONN, { dir }).seenTranscriptTurns.get(turnKey), RECOVERED_REQ)
  })

  it('clears an ended prior terminal prompt when an unrelated non-wake row followed by a summary row arrives after turn_ended (ce71a72b)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const bobRow = typedRow('Bob ended terminal prompt before unrelated wake and summary')
    const unrelatedOther = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'System notice: unrelated scheduled event with no launch record' }] },
    })
    const summaryRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<available_subagent_types>summary</available_subagent_types>\n<dynamic_tool_catalog>tools</dynamic_tool_catalog>',
          },
        ],
      },
    })

    fs.writeFileSync(transcriptPath, `${bobRow}\n`)
    const memo = {}
    const p1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo,
    })
    assert.equal(p1.action, 'opened')
    assert.equal(readRequestState(CONN, { dir }).current, p1.requestId)

    fs.writeFileSync(transcriptPath, `${bobRow}\n${turnEndedRow()}\n${unrelatedOther}\n${summaryRow}\n`)
    const p2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(p2.action, 'cleared_for_wake')
    assert.equal(readRequestState(CONN, { dir }).current, null, 'ended Bob prompt MUST NOT stay current across unrelated turn + summary')
  })

  it('finishIdleRequests fails closed with pending_open_cleanup_failed when reading .pending-opens.json hits a transient error while closing a matching candidate request (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const REQ_ID = '55555555-5555-4555-8555-5555555555fb'

    fs.writeFileSync(transcriptPath, `${typedRow('Idle sweep where pending-opens read fails transiently')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    appendRequestEvent(CONN, { op: 'open', id: REQ_ID, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ID }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ID }, { dir })

    const sidecar = path.join(dir, `${CONN}.pending-opens.json`)
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ [turnKey]: { requestId: REQ_ID, requestedBy: ALI, turnKey } }),
      { mode: 0o600 },
    )

    const origReadFileSync = fs.readFileSync
    fs.readFileSync = (filePath, ...rest) => {
      if (String(filePath) === sidecar) {
        throw Object.assign(new Error('transient EIO reading pending-opens.json'), { code: 'EIO' })
      }
      return origReadFileSync(filePath, ...rest)
    }
    const logs = []
    try {
      const idle1 = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: (line) => logs.push(line),
      })
      assert.deepEqual(idle1.closed, [], 'MUST NOT report request closed when reading .pending-opens.json failed')
      assert.equal(idle1.closeRefusal?.code, 'pending_open_cleanup_failed')
      assert.equal(fs.existsSync(sidecar), true, 'matching recovery entry remained on disk')
      assert.ok(logs.some((l) => /pending_open_cleanup_failed/i.test(l)))
    } finally {
      fs.readFileSync = origReadFileSync
    }

    // Once readable again, next idle sweep removes the recovery entry and completes cleanly!
    const idle2 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => ({ status: 'closed' }),
      dir,
      log: () => {},
    })
    assert.deepEqual(idle2.closed, [REQ_ID])
    assert.equal(idle2.closeRefusal, undefined)
    assert.equal(fs.existsSync(sidecar), false)
  })

  it('syncLiveTypedTurn NEVER overwrites a newer live room command that became current while awaiting DevSpec’s open reply for an older terminal prompt (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111fb'

    fs.writeFileSync(transcriptPath, `${typedRow('Bob older terminal prompt whose open reply arrives late')}\n`)

    const memo = {}
    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        // While awaiting DevSpec's reply opening Bob's older terminal prompt, Alice's newer
        // live room command arrives and becomes `current` in `.requests.jsonl`!
        appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
        appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
        return { request_id: args.request_id, status: 'open', requested_by_user_id: BOB }
      },
      dir,
      memo,
    })

    assert.equal(res.action, 'opened')
    assert.equal(res.superseded, true)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'older terminal open reply MUST NOT overwrite newer live room requester')
    assert.equal(after.joined.size, 0, 'superseded older terminal request must not pollute newer live room command')
    assert.equal(after.started.has(res.requestId), true, 'superseded older terminal request must still be marked started for idle cleanup')

    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.deny, undefined, 'next write must not fail or name Bob')
    assert.equal(stamped.args?.request_ref, CMD_ALICE, 'next write MUST name Alice’s live room request')
  })

  it('syncLiveTypedTurn fails closed without setting current or marking synced when post-open transcript re-read is unreadable, then restores the newer background wake once readable (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111fc'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(
      CONN,
      { op: 'launch', key: 'alice-bg-after-unreadable', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] },
      { dir },
    )

    const bobRow = typedRow('Bob terminal prompt that ends while open is in flight')
    const aliceWake = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>alice-bg-after-unreadable</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.writeFileSync(transcriptPath, `${bobRow}\n`)

    const memo = {}
    const logs = []
    let openCalls = 0
    const origOpenSync = fs.openSync
    let failTranscriptRead = false
    fs.openSync = (filePath, flags, ...rest) => {
      if (failTranscriptRead && String(filePath) === transcriptPath) {
        throw Object.assign(new Error('transient EACCES re-reading transcript'), { code: 'EACCES' })
      }
      return origOpenSync(filePath, flags, ...rest)
    }
    let res1 = null
    try {
      res1 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          openCalls += 1
          // While awaiting open_request, Bob's turn ends and Alice's background job wakes the agent,
          // AND re-reading the transcript hits a transient read error!
          fs.writeFileSync(transcriptPath, `${bobRow}\n${turnEndedRow()}\n${aliceWake}\n`)
          failTranscriptRead = true
          return { request_id: args.request_id, status: 'open', requested_by_user_id: BOB }
        },
        dir,
        memo,
        log: (line) => logs.push(line),
      })
      assert.equal(res1.action, 'unreadable', 'MUST report unreadable instead of advancing state')
      assert.equal(memo.synced, false, 'MUST NOT mark pass complete when post-open transcript check failed')
      assert.equal(typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }), true)
      assert.ok(logs.some((l) => /transcript unreadable after open_request/i.test(l)))
      const midState = readRequestState(CONN, { dir })
      assert.equal(midState.current, null, 'MUST NOT make ended Bob request current while transcript re-read failed')
      assert.equal(midState.seenTranscriptTurns.size, 0, 'MUST NOT mark turn seen on failed post-open transcript check')
      const midStamp = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
      assert.equal(midStamp.args?.request_ref, undefined, 'write stamper MUST NOT misattribute to ended Bob request')
    } finally {
      failTranscriptRead = false
      fs.openSync = origOpenSync
    }

    // Once the transcript is readable again, the next pass restores Alice's wake cleanly and binds Bob's ended turn historically without reopening!
    const res2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => {
        openCalls += 1
        throw new Error('must not reopen already-opened Bob request')
      },
      dir,
      memo,
    })
    assert.equal(res2.action, 'restored_wake_request')
    assert.equal(openCalls, 1)
    assert.equal(memo.synced, true)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'next readable pass MUST restore Alice’s background wake')
    assert.equal(after.started.has(res1.requestId), true, 'ended Bob request must be bound historically as started for idle close')
    const finalStamp = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(finalStamp.args?.request_ref, CMD_ALICE)
  })

  it('finishIdleRequests fails closed without closing locally or reporting success when post-close transcript verification fails (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const REQ_ID = '55555555-5555-4555-8555-5555555555fd'

    fs.writeFileSync(transcriptPath, `${typedRow('Turn whose post-close transcript verification fails')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    appendRequestEvent(CONN, { op: 'open', id: REQ_ID, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ID }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ID }, { dir })

    const origOpenSync = fs.openSync
    let failTranscriptRead = false
    fs.openSync = (filePath, flags, ...rest) => {
      if (failTranscriptRead && String(filePath) === transcriptPath) {
        throw Object.assign(new Error('transient EACCES re-reading transcript after close'), { code: 'EACCES' })
      }
      return origOpenSync(filePath, flags, ...rest)
    }
    const logs = []
    try {
      const idle1 = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => {
          // Server acknowledges close, then the post-close transcript read fails!
          failTranscriptRead = true
          return { status: 'closed' }
        },
        dir,
        log: (line) => logs.push(line),
      })
      assert.deepEqual(idle1.closed, [], 'MUST NOT report request closed when post-close transcript verification failed')
      assert.equal(idle1.closeRefusal?.code, 'transcript_unreadable')
      assert.equal(idle1.closeRefusal?.request_id, REQ_ID)
      assert.ok(logs.some((l) => /transcript_unreadable/i.test(l)))
      const midState = readRequestState(CONN, { dir })
      assert.equal(midState.open.has(REQ_ID), true, 'MUST NOT write local close event without verifying transcript')
      assert.equal(midState.closed?.has(REQ_ID) ?? false, false)
      assert.equal(midState.current, REQ_ID, 'MUST NOT clear foreground current while close verification failed')
    } finally {
      failTranscriptRead = false
      fs.openSync = origOpenSync
    }

    // Once the transcript is readable again, the next idle sweep verifies and closes cleanly.
    const idle2 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async () => ({ status: 'closed' }),
      dir,
      log: () => {},
    })
    assert.deepEqual(idle2.closed, [REQ_ID])
    assert.equal(idle2.closeRefusal, undefined)
    const afterState = readRequestState(CONN, { dir })
    assert.equal(afterState.open.has(REQ_ID), false)
    assert.equal(afterState.closed?.has(REQ_ID), true)
    assert.equal(afterState.current, null)
  })

  it('syncLiveTypedTurn NEVER overwrites a different person’s room command that becomes current while re-reading the transcript after open_request (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111fd'

    fs.writeFileSync(transcriptPath, `${typedRow('Bob terminal prompt racing Alice room command during transcript re-read')}\n`)

    const origOpenSync = fs.openSync
    let injectAliceOnNextTranscriptRead = false
    let injected = false
    fs.openSync = (filePath, flags, ...rest) => {
      if (injectAliceOnNextTranscriptRead && !injected && String(filePath) === transcriptPath) {
        injected = true
        // Alice's room command lands and becomes `current` DURING the post-open transcript re-read!
        appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
        appendRequestEvent(CONN, { op: 'current', ref: CMD_ALICE }, { dir })
      }
      return origOpenSync(filePath, flags, ...rest)
    }

    let res = null
    try {
      res = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => {
          injectAliceOnNextTranscriptRead = true
          return { request_id: args.request_id, status: 'open', requested_by_user_id: BOB }
        },
        dir,
        memo: {},
      })
    } finally {
      fs.openSync = origOpenSync
    }

    assert.equal(injected, true, 'test hook must have fired during post-open transcript re-read')
    assert.equal(res.action, 'opened')
    assert.equal(res.superseded, true)
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'older terminal open MUST NOT replace Alice’s room command that landed during transcript re-read')
    assert.equal(after.joined.size, 0, 'superseded terminal request must not pollute Alice’s room command')
    assert.equal(after.started.has(res.requestId), true, 'superseded terminal request must be marked started for idle cleanup')

    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.deny, undefined)
    assert.equal(stamped.args?.request_ref, CMD_ALICE, 'next write MUST stamp Alice’s live room request, not Bob’s older terminal prompt')
  })

  it('finishIdleRequests fails closed without clearing a newer local_turn attempt when reading the saved connection state file fails after report_complete (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const ATTEMPT_OLD = '99999999-9999-4999-8999-9999999999fe'
    const ATTEMPT_NEW = '88888888-8888-4888-8888-8888888888fe'
    const SESSION = '77777777-7777-4777-8777-7777777777fe'
    const stateFile = path.join(dir, `${CONN}.json`)

    fs.writeFileSync(transcriptPath, `${typedRow('Turn 1 finished before newer attempt read fails')}\n${turnEndedRow()}\n`)
    const state = {
      connection_id: CONN,
      session_id: SESSION,
      local_turn: { attempt_id: ATTEMPT_OLD, session_id: SESSION },
    }
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, local_turn: { attempt_id: ATTEMPT_NEW, session_id: SESSION } }), { mode: 0o600 })

    const origReadFileSync = fs.readFileSync
    let failStateRead = false
    fs.readFileSync = (filePath, ...rest) => {
      if (failStateRead && String(filePath) === stateFile) {
        throw Object.assign(new Error('transient EIO reading connection state'), { code: 'EIO' })
      }
      return origReadFileSync(filePath, ...rest)
    }
    let patchCalls = 0
    const logs = []
    try {
      const res = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        state,
        connectionCapability: 'cap-secret',
        callComplete: async () => {
          failStateRead = true
          return { phase: 'done', closed_as: 'completed' }
        },
        patchState: () => {
          patchCalls += 1
          return true
        },
        dir,
        log: (line) => logs.push(line),
      })
      assert.equal(res.localCompleted, false, 'MUST NOT report localCompleted when state file check failed')
      assert.equal(res.localCompleteRefusal?.code, 'state_unreadable')
      assert.equal(res.localCompleteRefusal?.cause_code, 'EIO')
      assert.equal(patchCalls, 0, 'MUST NOT erase local_turn when disk state could not be verified')
      assert.ok(logs.some((l) => /state_unreadable/i.test(l)))
    } finally {
      failStateRead = false
      fs.readFileSync = origReadFileSync
    }

    // Once readable again, finishIdleRequests sees ATTEMPT_NEW on disk and treats the old receipt
    // as superseded WITHOUT clearing ATTEMPT_NEW.
    const res2 = await finishIdleRequests({
      connectionId: CONN,
      transcriptPath,
      state,
      connectionCapability: 'cap-secret',
      callComplete: async () => ({ phase: 'done', closed_as: 'completed' }),
      patchState: () => {
        patchCalls += 1
        return true
      },
      dir,
      log: () => {},
    })
    assert.equal(res2.localCompleted, true)
    assert.equal(patchCalls, 0, 'newer attempt on disk MUST NOT be cleared by older completion receipt')
  })

  it('syncLiveTypedTurn preserves a different person’s room command that joined the running turn while open_request was in flight so the next write asks which request it serves (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111fe'

    fs.writeFileSync(transcriptPath, `${typedRow('Bob starts terminal turn while Alice room command joins mid-open')}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => {
        // While Bob's terminal open_request is in flight, Alice's room command JOINS the running turn!
        appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE }, { dir })
        appendRequestEvent(CONN, { op: 'joined', id: CMD_ALICE }, { dir })
        return { request_id: args.request_id, status: 'open', requested_by_user_id: BOB }
      },
      dir,
      memo: {},
    })

    assert.equal(res.action, 'opened')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, res.requestId, 'Bob’s terminal request becomes foreground current')
    assert.equal(after.joined.has(CMD_ALICE), true, 'Alice’s joined room command MUST NOT be erased by Bob’s current binding')
    assert.equal(turnAmbiguity(after)?.length, 2, 'turn MUST remain ambiguous across Bob and Alice')

    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'next write MUST ask which requester it serves instead of stamping Bob alone')
  })

  it('syncLiveTypedTurn does NOT inherit a room requester who joined the previous turn across an explicit turn_ended boundary (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const TURN1_BOB = '11111111-1111-4111-8111-1111111111a1'
    const CMD_ALICE_PREV = '22222222-2222-4222-8222-2222222222a1'

    // Turn 1 had Bob's typed prompt with Alice's room command joined mid-turn, then ended explicitly.
    const turn1Row = typedRow('Bob turn 1 where Alice joined mid-turn')
    const turn2Row = typedRow('Bob brand-new turn 2 after explicit turn_ended')
    fs.writeFileSync(transcriptPath, `${turn1Row}\n${turnEndedRow()}\n${turn2Row}\n`)

    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const keys = activeTranscriptTurn(transcriptPath).typedTurnKeys
    assert.equal(keys.length, 2)

    appendRequestEvent(CONN, { op: 'open', id: TURN1_BOB, kind: 'typed_prompt', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE_PREV, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: TURN1_BOB }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: keys[0], ref: TURN1_BOB }, { dir })
    appendRequestEvent(CONN, { op: 'joined', id: CMD_ALICE_PREV }, { dir })

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo: {},
    })

    assert.equal(res.action, 'opened')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, res.requestId)
    assert.equal(after.joined.has(CMD_ALICE_PREV), false, 'Turn 2 MUST NOT inherit Alice’s joined request from Turn 1 across turn_ended')
    assert.equal(turnAmbiguity(after), null, 'Turn 2 serves Bob alone with no false ambiguity')

    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.deny, undefined, 'write hook MUST NOT refuse Turn 2 terminal write')
    assert.equal(stamped.args?.request_ref, res.requestId)
  })

  it('finishIdleRequests does NOT close or lose requester attribution when a background launch is appended after its final read and right before saving close (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const REQ_ALICE = '55555555-5555-4555-8555-5555555555a2'

    fs.writeFileSync(transcriptPath, `${typedRow('Alice turn whose background launch races commitServerClose')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'typed_prompt', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ALICE }, { dir })

    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    const origAppendFileSync = fs.appendFileSync
    let injectedLaunch = false
    fs.appendFileSync = (filePath, data, ...rest) => {
      // Simulate a concurrent hook appending `{ op: 'launch' }` to `.requests.jsonl` AFTER
      // commitServerClose's final readRequestState and IMMEDIATELY BEFORE it appends `{ op: 'close' }`!
      if (!injectedLaunch && String(filePath) === reqLogPath && String(data).includes('"op":"close"')) {
        injectedLaunch = true
        origAppendFileSync(
          filePath,
          `${JSON.stringify({ op: 'launch', key: 'raced-bg-launch', kind: 'shell', notifies: true, request: REQ_ALICE, also: [] })}\n`,
          ...rest,
        )
      }
      return origAppendFileSync(filePath, data, ...rest)
    }

    let idleRes = null
    try {
      idleRes = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: () => {},
      })
    } finally {
      fs.appendFileSync = origAppendFileSync
    }

    assert.equal(injectedLaunch, true, 'test hook must have injected launch right before close write')
    assert.deepEqual(idleRes.closed, [], 'idle sweep MUST NOT report request closed when a launch landed before close')
    const afterIdle = readRequestState(CONN, { dir })
    assert.equal(afterIdle.open.has(REQ_ALICE), true, 'request MUST remain open for the raced background launch')
    assert.equal(afterIdle.closed?.has(REQ_ALICE) ?? false, false)

    // When the background launch's wake later arrives, it MUST still resolve to Alice's original request!
    const wakeRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>raced-bg-launch</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
    const wakeSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo: {},
    })
    assert.equal(wakeSync.action, 'restored_wake_request')
    assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.args?.request_ref, REQ_ALICE, 'wake write MUST still resolve to original requester')
  })

  it('finishIdleRequests aborts conditional close without erasing a request that joined a live turn after its final read and right before saving close (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const REQ_ALICE = '55555555-5555-4555-8555-5555555555a3'
    const REQ_BOB_LIVE = '66666666-6666-4666-8666-6666666666a3'

    fs.writeFileSync(transcriptPath, `${typedRow('Alice turn ended before Bob turn starts and joins Alice')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'typed_prompt', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ALICE }, { dir })

    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    const origAppendFileSync = fs.appendFileSync
    let injectedJoin = false
    fs.appendFileSync = (filePath, data, ...rest) => {
      // Right after commitServerClose's last readRequestState and IMMEDIATELY BEFORE it writes
      // `{ op: 'close', if_idle: true }`, a new live turn opens for Bob and joins REQ_ALICE!
      if (!injectedJoin && String(filePath) === reqLogPath && String(data).includes('"op":"close"')) {
        injectedJoin = true
        origAppendFileSync(
          filePath,
          `${JSON.stringify({ op: 'open', id: REQ_BOB_LIVE, kind: 'typed_prompt', requested_by: BOB })}\n` +
            `${JSON.stringify({ op: 'current', ref: REQ_BOB_LIVE })}\n` +
            `${JSON.stringify({ op: 'joined', id: REQ_ALICE })}\n`,
          ...rest,
        )
      }
      return origAppendFileSync(filePath, data, ...rest)
    }

    let idleRes = null
    try {
      idleRes = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: () => {},
      })
    } finally {
      fs.appendFileSync = origAppendFileSync
    }

    assert.equal(injectedJoin, true, 'test hook must have injected live turn + join right before close write')
    assert.deepEqual(idleRes.closed, [], 'idle sweep MUST NOT report closed when request joined a live turn before close')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.open.has(REQ_ALICE), true, 'joined request MUST stay open')
    assert.equal(after.current, REQ_BOB_LIVE, 'live turn current request MUST stay intact')
    assert.equal(after.joined.has(REQ_ALICE), true, 'joined requester MUST NOT be erased by conditional close')
    assert.equal(turnAmbiguity(after)?.length, 2)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'writes MUST ask which requester they serve')
  })

  it('syncLiveTypedTurn preserves a room command that joined a live terminal turn BEFORE registration ran, while dropping stale joins from an earlier answered turn (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE_LIVE = '11111111-1111-4111-8111-1111111111a4'
    const CMD_PREV_ANSWERED = '22222222-2222-4222-8222-2222222222a4'
    const CMD_STALE_JOIN = '33333333-3333-4333-8333-3333333333a4'

    // Part 1: Idle (`current === null`), Bob starts a live terminal turn, and Alice's room
    // command joins the live turn BEFORE the poller opens Bob's terminal request!
    fs.writeFileSync(transcriptPath, `${typedRow('Bob live terminal turn where Alice joined before poller opened it')}\n`)
    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE_LIVE, kind: 'command', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'joined', id: CMD_ALICE_LIVE }, { dir })

    const res1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir,
      memo: {},
    })
    assert.equal(res1.action, 'opened')
    const after1 = readRequestState(CONN, { dir })
    assert.equal(after1.current, res1.requestId)
    assert.equal(after1.joined.has(CMD_ALICE_LIVE), true, 'already-joined requester on this live turn MUST be preserved')
    assert.equal(turnAmbiguity(after1)?.length, 2)
    const stamp1 = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamp1.deny, 'next write MUST ask which requester it serves instead of stamping Bob alone')

    // Part 2: Earlier turn answered its current command while CMD_STALE_JOIN was joined
    // (leaving current === null and CMD_STALE_JOIN in priorTurnJoined), then turn_ended,
    // then Bob starts a fresh terminal turn -> CMD_STALE_JOIN MUST NOT be inherited!
    const { home: home2, dir: dir2, transcriptPath: tp2 } = makeEnv()
    fs.writeFileSync(tp2, `${typedRow('Earlier turn that answered')}\n${turnEndedRow()}\n${typedRow('Fresh Bob terminal turn')}\n`)
    appendRequestEvent(CONN, { op: 'open', id: CMD_PREV_ANSWERED, kind: 'command', requested_by: BOB }, { dir: dir2 })
    appendRequestEvent(CONN, { op: 'open', id: CMD_STALE_JOIN, kind: 'command', requested_by: ALICE }, { dir: dir2 })
    appendRequestEvent(CONN, { op: 'current', ref: CMD_PREV_ANSWERED }, { dir: dir2 })
    appendRequestEvent(CONN, { op: 'joined', id: CMD_STALE_JOIN }, { dir: dir2 })
    appendRequestEvent(CONN, { op: 'answered', id: CMD_PREV_ANSWERED }, { dir: dir2 })
    assert.equal(readRequestState(CONN, { dir: dir2 }).current, null)

    const res2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath: tp2,
      connectionCapability: 'cap-secret',
      callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
      dir: dir2,
      memo: {},
    })
    assert.equal(res2.action, 'opened')
    const after2 = readRequestState(CONN, { dir: dir2 })
    assert.equal(after2.current, res2.requestId)
    assert.equal(after2.joined.has(CMD_STALE_JOIN), false, 'stale join from earlier answered turn MUST NOT be inherited')
    const stamp2 = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home: home2 })
    assert.equal(stamp2.deny, undefined)
    assert.equal(stamp2.args?.request_ref, res2.requestId)
  })

  it('syncLiveTypedTurn preserves a room command that joins the live turn IMMEDIATELY BEFORE op:current is appended (after post-open readRequestState) (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE_RACING = '11111111-1111-4111-8111-1111111111a5'

    fs.writeFileSync(transcriptPath, `${typedRow('Bob live terminal turn raced right before op:current write')}\n`)
    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    const origAppendFileSync = fs.appendFileSync
    let injectedRightBeforeCurrent = false
    fs.appendFileSync = (filePath, data, ...rest) => {
      if (!injectedRightBeforeCurrent && String(filePath) === reqLogPath && String(data).includes('"op":"current"')) {
        injectedRightBeforeCurrent = true
        origAppendFileSync(
          filePath,
          `${JSON.stringify({ op: 'open', id: CMD_ALICE_RACING, kind: 'command', requested_by: ALICE })}\n` +
            `${JSON.stringify({ op: 'joined', id: CMD_ALICE_RACING })}\n`,
          ...rest,
        )
      }
      return origAppendFileSync(filePath, data, ...rest)
    }

    let res = null
    try {
      res = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
        dir,
        memo: {},
      })
    } finally {
      fs.appendFileSync = origAppendFileSync
    }

    assert.equal(injectedRightBeforeCurrent, true, 'test hook must have injected join right before op:current')
    assert.equal(res.action, 'opened')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, res.requestId)
    assert.equal(after.joined.has(CMD_ALICE_RACING), true, 'concurrent join right before op:current MUST stay carried')
    assert.equal(turnAmbiguity(after)?.length, 2)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'next write MUST ask which requester it serves instead of stamping Bob alone')
  })

  it('finishIdleRequests and rotateRequestLog NEVER archive unexamined launch or typed_turn_failed entries appended after rotation read and before rename (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const REQ_ALICE = '55555555-5555-4555-8555-5555555555a6'

    fs.writeFileSync(transcriptPath, `${typedRow('Alice turn triggering log rotation on idle close')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    // Pad the request log past ROTATE_BYTES (64 KiB) with closed historical entries so rotation triggers!
    fs.mkdirSync(dir, { recursive: true })
    const padLine = `${JSON.stringify({ op: 'transcript_turn', key: 'old-pad', ref: null, pad: 'p'.repeat(400) })}\n`
    fs.writeFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })

    appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'typed_prompt', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ALICE }, { dir })

    const origRenameSync = fs.renameSync
    let injectedDuringRotation = false
    fs.renameSync = (from, to) => {
      // Simulate a concurrent launch + typed_turn_failed arriving AFTER rotateRequestLog's
      // readFileSync and IMMEDIATELY BEFORE its atomic rename!
      if (!injectedDuringRotation && String(from) === reqLogPath) {
        injectedDuringRotation = true
        fs.appendFileSync(
          reqLogPath,
          `${JSON.stringify({ op: 'launch', key: 'raced-rot-launch', kind: 'shell', notifies: true, request: REQ_ALICE, also: [] })}\n` +
            `${JSON.stringify({ op: 'typed_turn_failed', key: 'raced-retry-turn' })}\n`,
          { mode: 0o600 },
        )
      }
      return origRenameSync(from, to)
    }

    let idleRes = null
    try {
      idleRes = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: () => {},
      })
    } finally {
      fs.renameSync = origRenameSync
    }

    assert.equal(injectedDuringRotation, true, 'test hook must have fired right before rotation rename')
    assert.deepEqual(idleRes.closed, [], 'idle cleanup MUST NOT report request closed when a launch arrived during rotation')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.failedTranscriptTurns.has('raced-retry-turn'), true, 'typed_turn_failed retry MUST stay queued in active log')
    assert.equal(after.launches.has('raced-rot-launch'), true, 'concurrent launch MUST stay in active log')
    assert.equal(after.open.has(REQ_ALICE), true, 'original request MUST stay open in active log for the launch wake')
    assert.equal(after.open.get(REQ_ALICE)?.requested_by, ALICE)

    // When the raced launch's wake arrives, it MUST still resolve to Alice's original request!
    const wakeRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>raced-rot-launch</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
    const wakeSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo: {},
    })
    assert.equal(wakeSync.action, 'restored_wake_request')
    assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.args?.request_ref, REQ_ALICE)
  })

  it('syncLiveTypedTurn NEVER replaces a different sender’s room command that became current IMMEDIATELY BEFORE op:current is written (after post-open readRequestState) (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE_LIVE = '11111111-1111-4111-8111-1111111111a7'

    fs.writeFileSync(transcriptPath, `${typedRow('Bob terminal turn raced by Alice becoming current right before op:current write')}\n`)
    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    const origAppendFileSync = fs.appendFileSync
    let injectedAliceCurrent = false
    fs.appendFileSync = (filePath, data, ...rest) => {
      if (!injectedAliceCurrent && String(filePath) === reqLogPath && String(data).includes('"op":"current"')) {
        injectedAliceCurrent = true
        origAppendFileSync(
          filePath,
          `${JSON.stringify({ op: 'open', id: CMD_ALICE_LIVE, kind: 'command', requested_by: ALICE })}\n` +
            `${JSON.stringify({ op: 'current', ref: CMD_ALICE_LIVE })}\n`,
          ...rest,
        )
      }
      return origAppendFileSync(filePath, data, ...rest)
    }

    let res = null
    try {
      res = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async (args) => ({ request_id: args.request_id, status: 'open', requested_by_user_id: BOB }),
        dir,
        memo: {},
      })
    } finally {
      fs.appendFileSync = origAppendFileSync
    }

    assert.equal(injectedAliceCurrent, true, 'test hook must have made Alice current right before Bob op:current')
    assert.equal(res.action, 'opened')
    assert.equal(res.superseded, true, 'Bob terminal binding must recognize CAS supersession')
    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE_LIVE, 'Alice’s live room command MUST stay current and NOT be replaced by Bob')
    assert.equal(after.joined.size, 0, 'superseded terminal binding must not pollute Alice’s room turn')
    assert.equal(after.started.has(res.requestId), true, 'superseded terminal request must still be marked started for idle cleanup')

    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.deny, undefined, 'next write must not fail or name Bob')
    assert.equal(stamped.args?.request_ref, CMD_ALICE_LIVE, 'next write MUST name Alice’s live room sender')
  })

  it('finishIdleRequests and readRequestState recover launch + typed_turn_failed appended to an already-open old-log fd AFTER rotation’s final read (both pre-archive and post-archive) (3ea2b201 / ce71a72b)', async () => {
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    // Part 1: Writer with an already-open fd appends AFTER `readFileSync(staged)` and right before `renameSync(staged, '.1')`!
    {
      const { home, dir, transcriptPath } = makeEnv()
      const REQ_ALICE = '55555555-5555-4555-8555-5555555555a8'
      fs.writeFileSync(transcriptPath, `${typedRow('Alice turn raced by open fd after rotation read')}\n${turnEndedRow()}\n`)
      const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
      assert.ok(turnKey)

      const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
      fs.mkdirSync(dir, { recursive: true })
      const padLine = `${JSON.stringify({ op: 'transcript_turn', key: 'old-pad', ref: null, pad: 'p'.repeat(400) })}\n`
      fs.writeFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })

      appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'typed_prompt', requested_by: ALICE }, { dir })
      appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
      appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ALICE }, { dir })

      // Open a separate fd to the original inode BEFORE rotation starts!
      const oldFd = fs.openSync(reqLogPath, 'a')
      const origRenameSync = fs.renameSync
      let wroteViaOldFd = false
      fs.renameSync = (from, to) => {
        // Fire on the SECOND rename (`staged -> .requests.jsonl.1`), which happens AFTER
        // `rotateRequestLog` has already read `staged`!
        if (!wroteViaOldFd && String(to) === `${reqLogPath}.1`) {
          wroteViaOldFd = true
          fs.writeSync(
            oldFd,
            `${JSON.stringify({ op: 'launch', key: 'open-fd-launch-1', kind: 'shell', notifies: true, request: REQ_ALICE, also: [] })}\n` +
              `${JSON.stringify({ op: 'typed_turn_failed', key: 'open-fd-retry-1' })}\n`,
          )
        }
        return origRenameSync(from, to)
      }

      let idleRes = null
      try {
        idleRes = await finishIdleRequests({
          connectionId: CONN,
          transcriptPath,
          connectionCapability: 'cap-secret',
          callRequest: async () => ({ status: 'closed' }),
          dir,
          log: () => {},
        })
      } finally {
        fs.renameSync = origRenameSync
        fs.closeSync(oldFd)
      }

      assert.equal(wroteViaOldFd, true, 'test hook must have written via already-open fd after rotation read')
      assert.deepEqual(idleRes.closed, [], 'idle cleanup MUST NOT report request closed when open fd appended launch during rotation')
      const after = readRequestState(CONN, { dir })
      assert.equal(after.failedTranscriptTurns.has('open-fd-retry-1'), true, 'typed_turn_failed retry MUST be recovered from open-fd append')
      assert.equal(after.launches.has('open-fd-launch-1'), true, 'launch MUST be recovered from open-fd append')
      assert.equal(after.open.has(REQ_ALICE), true, 'request MUST remain open for the launch')
      assert.equal(after.open.get(REQ_ALICE)?.requested_by, ALICE)

      const wakeRow = JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<task-notification><task-id>open-fd-launch-1</task-id><status>completed</status></task-notification>',
            },
          ],
        },
      })
      fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
      const wakeSync = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo: {},
      })
      assert.equal(wakeSync.action, 'restored_wake_request')
      assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE)
      assert.equal(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }).args?.request_ref, REQ_ALICE)
    }

    // Part 2: Writer holding an already-open fd flushes AFTER rotation and finishIdleRequests have ALREADY completed!
    {
      const { home, dir, transcriptPath } = makeEnv()
      const REQ_ALICE = '55555555-5555-4555-8555-5555555555a9'
      fs.writeFileSync(transcriptPath, `${typedRow('Alice turn whose open fd flushes after archive completes')}\n${turnEndedRow()}\n`)
      const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
      assert.ok(turnKey)

      const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
      fs.mkdirSync(dir, { recursive: true })
      const padLine = `${JSON.stringify({ op: 'transcript_turn', key: 'old-pad', ref: null, pad: 'p'.repeat(400) })}\n`
      fs.writeFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })

      appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'typed_prompt', requested_by: ALICE }, { dir })
      appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
      appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ALICE }, { dir })

      const oldFd = fs.openSync(reqLogPath, 'a')
      try {
        const idleRes = await finishIdleRequests({
          connectionId: CONN,
          transcriptPath,
          connectionCapability: 'cap-secret',
          callRequest: async () => ({ status: 'closed' }),
          dir,
          log: () => {},
        })
        assert.deepEqual(idleRes.closed, [REQ_ALICE])
        assert.equal(fs.existsSync(`${reqLogPath}.1`), true, 'rotation must have archived old log to .1')

        // Now the already-open fd flushes a launch + typed_turn_failed into the archived inode!
        fs.writeSync(
          oldFd,
          `${JSON.stringify({ op: 'launch', key: 'open-fd-launch-2', kind: 'shell', notifies: true, request: REQ_ALICE, also: [] })}\n` +
            `${JSON.stringify({ op: 'typed_turn_failed', key: 'open-fd-retry-2' })}\n`,
        )
      } finally {
        fs.closeSync(oldFd)
      }

      const recovered = readRequestState(CONN, { dir })
      assert.equal(recovered.failedTranscriptTurns.has('open-fd-retry-2'), true, 'active reader MUST NOT ignore post-archive typed_turn_failed')
      assert.equal(recovered.launches.has('open-fd-launch-2'), true, 'active reader MUST NOT ignore post-archive launch')
      assert.equal(recovered.open.has(REQ_ALICE), true, 'active reader MUST restore idle-closed request for post-archive launch')
      assert.equal(recovered.open.get(REQ_ALICE)?.requested_by, ALICE)

      const wakeRow = JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<task-notification><task-id>open-fd-launch-2</task-id><status>completed</status></task-notification>',
            },
          ],
        },
      })
      fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
      const wakeSync = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo: {},
      })
      assert.equal(wakeSync.action, 'restored_wake_request')
      assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE)
      assert.equal(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }).args?.request_ref, REQ_ALICE)
    }
  })

  it('finishIdleRequests fails closed with a diagnostic AND readRequestState keeps staged launch + typed_turn_failed visible when a transient read error strikes rotation after a parallel hook recreates the active log (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const REQ_ALICE = '55555555-5555-4555-8555-5555555555aa'
    const REQ_BOB_PARALLEL = '66666666-6666-4666-8666-6666666666aa'

    fs.writeFileSync(transcriptPath, `${typedRow('Alice turn whose rotation hits transient staged read error while parallel hook writes active log')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    fs.mkdirSync(dir, { recursive: true })
    const padLine = `${JSON.stringify({ op: 'transcript_turn', key: 'old-pad', ref: null, pad: 'p'.repeat(400) })}\n`
    fs.writeFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })

    appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'typed_prompt', requested_by: ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_ALICE }, { dir })

    const origRenameSync = fs.renameSync
    const origReadFileSync = fs.readFileSync
    let stagedPath = null
    let recreatedActiveLog = false
    let threwStagedReadErr = false

    fs.renameSync = (from, to) => {
      if (String(from) === reqLogPath && String(to).includes('.requests.jsonl.rotating-')) {
        // Concurrent launch + typed_turn_failed land in the original log right before rename -> staged.
        fs.appendFileSync(
          reqLogPath,
          `${JSON.stringify({ op: 'launch', key: 'staged-err-launch', kind: 'shell', notifies: true, request: REQ_ALICE, also: [] })}\n` +
            `${JSON.stringify({ op: 'typed_turn_failed', key: 'staged-err-retry' })}\n`,
          { mode: 0o600 },
        )
        stagedPath = String(to)
        const r = origRenameSync(from, to)
        // Immediately after rename, a parallel hook recreates the active log!
        recreatedActiveLog = true
        fs.appendFileSync(
          reqLogPath,
          `${JSON.stringify({ op: 'open', id: REQ_BOB_PARALLEL, kind: 'command', requested_by: BOB })}\n`,
          { mode: 0o600 },
        )
        return r
      }
      return origRenameSync(from, to)
    }

    fs.readFileSync = (filePath, ...rest) => {
      if (!threwStagedReadErr && stagedPath && String(filePath) === stagedPath) {
        threwStagedReadErr = true
        throw Object.assign(new Error('transient EIO reading staged request log'), { code: 'EIO' })
      }
      return origReadFileSync(filePath, ...rest)
    }

    const logs = []
    let idleRes = null
    try {
      idleRes = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: (line) => logs.push(line),
      })
    } finally {
      fs.renameSync = origRenameSync
      fs.readFileSync = origReadFileSync
    }

    assert.equal(recreatedActiveLog, true, 'parallel hook must have recreated active log')
    assert.equal(threwStagedReadErr, true, 'transient read error on staged log must have fired')
    assert.ok(stagedPath && fs.existsSync(stagedPath), 'staged file must remain intact on disk when active log exists')
    assert.deepEqual(idleRes.closed, [], 'idle cleanup MUST NOT report request closed when rotation read failed')
    assert.equal(idleRes.closeRefusal?.code, 'request_log_rotation_failed')
    assert.equal(idleRes.closeRefusal?.cause_code, 'EIO')
    assert.ok(logs.some((l) => /request_log_rotation_failed/i.test(l)), 'diagnostic MUST be logged')

    // Once reads recover, `readRequestState` MUST read the staged file ahead of the recreated active log!
    const recovered = readRequestState(CONN, { dir })
    assert.equal(recovered.failedTranscriptTurns.has('staged-err-retry'), true, 'typed_turn_failed in staged file MUST remain queued for next pass')
    assert.equal(recovered.launches.has('staged-err-launch'), true, 'launch in staged file MUST stay visible')
    assert.equal(recovered.open.has(REQ_ALICE), true, 'original request MUST remain open for the staged launch')
    assert.equal(recovered.open.get(REQ_ALICE)?.requested_by, ALICE)
    assert.equal(recovered.open.has(REQ_BOB_PARALLEL), true, 'parallel hook’s write to recreated active log MUST also be preserved')

    // When the staged launch’s completion wake arrives, it MUST resolve back to Alice’s original request!
    const wakeRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>staged-err-launch</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
    const wakeSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo: {},
    })
    assert.equal(wakeSync.action, 'restored_wake_request')
    assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.args?.request_ref, REQ_ALICE, 'completion wake MUST resolve to Alice’s original request')
  })

  it('a later rotation NEVER deletes an older staged log where a still-open fd appends a launch or typed_turn_failed retry (3ea2b201 / ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const REQ_ALICE_OLD = '55555555-5555-4555-8555-5555555555ab'
    const REQ_BOB_NEW = '66666666-6666-4666-8666-6666666666ab'

    fs.writeFileSync(transcriptPath, `${typedRow('Bob turn triggering a later rotation while an older staged log exists')}\n${turnEndedRow()}\n`)
    const turnKey = activeTranscriptTurn(transcriptPath).typedTurnKeys[0]
    assert.ok(turnKey)

    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    const oldStagedPath = `${reqLogPath}.rotating-99999-old12345`
    fs.mkdirSync(dir, { recursive: true })

    // Create an older staged log (already idle: REQ_ALICE_OLD was if_idle-closed) and hold an open fd to it!
    fs.writeFileSync(
      oldStagedPath,
      `${JSON.stringify({ op: 'open', id: REQ_ALICE_OLD, kind: 'typed_prompt', requested_by: ALICE })}\n` +
        `${JSON.stringify({ op: 'current', ref: REQ_ALICE_OLD })}\n` +
        `${JSON.stringify({ op: 'close', id: REQ_ALICE_OLD, if_idle: true, expected_current: REQ_ALICE_OLD, allow_joined: false })}\n`,
      { mode: 0o600 },
    )
    const oldStagedFd = fs.openSync(oldStagedPath, 'a')

    // Active log has >64 KiB + REQ_BOB_NEW ready for idle close and rotation.
    const padLine = `${JSON.stringify({ op: 'transcript_turn', key: 'old-pad-2', ref: null, pad: 'q'.repeat(400) })}\n`
    fs.writeFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })
    appendRequestEvent(CONN, { op: 'open', id: REQ_BOB_NEW, kind: 'typed_prompt', requested_by: BOB }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_BOB_NEW }, { dir })
    appendRequestEvent(CONN, { op: 'transcript_turn', key: turnKey, ref: REQ_BOB_NEW }, { dir })

    const origRenameSync = fs.renameSync
    let appendedToOldStagedDuringLaterRotation = false
    fs.renameSync = (from, to) => {
      // Right as the later rotation archives the new active log, the writer holding an open fd
      // to `oldStagedPath` appends a launch for REQ_ALICE_OLD AND a typed_turn_failed retry!
      if (!appendedToOldStagedDuringLaterRotation && String(to) === `${reqLogPath}.1`) {
        appendedToOldStagedDuringLaterRotation = true
        fs.writeSync(
          oldStagedFd,
          `${JSON.stringify({ op: 'launch', key: 'old-staged-fd-launch', kind: 'shell', notifies: true, request: REQ_ALICE_OLD, also: [] })}\n` +
            `${JSON.stringify({ op: 'typed_turn_failed', key: 'old-staged-fd-retry' })}\n`,
        )
      }
      return origRenameSync(from, to)
    }

    try {
      await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: () => {},
      })
    } finally {
      fs.renameSync = origRenameSync
      fs.closeSync(oldStagedFd)
    }

    assert.equal(appendedToOldStagedDuringLaterRotation, true)
    assert.equal(fs.existsSync(oldStagedPath), true, 'later rotation MUST NOT unlink older staged log')

    const after = readRequestState(CONN, { dir })
    assert.equal(after.failedTranscriptTurns.has('old-staged-fd-retry'), true, 'typed_turn_failed appended to older staged log MUST stay queued')
    assert.equal(after.launches.has('old-staged-fd-launch'), true, 'launch appended to older staged log MUST stay visible')
    assert.equal(after.open.has(REQ_ALICE_OLD), true, 'REQ_ALICE_OLD MUST be restored open for its launch')
    assert.equal(after.open.get(REQ_ALICE_OLD)?.requested_by, ALICE)

    // Completion wake for the launch MUST resolve back to Alice’s original request!
    const wakeRow = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>old-staged-fd-launch</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
    const wakeSync = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo: {},
    })
    assert.equal(wakeSync.action, 'restored_wake_request')
    assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE_OLD)
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.equal(stamped.args?.request_ref, REQ_ALICE_OLD, 'wake MUST still resolve to Alice after later rotation')
  })

  it('memo invalidation watches retained archive (.1) and staged (.rotating-*) logs so a launch appended after rotation triggers reconciliation even with cached memo (3ea2b201)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { finishIdleRequests, typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const { activeTranscriptTurn } = await import('./transcript-turn-end.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const REQ_ALICE = '55555555-5555-4555-8555-5555555555ac'

    fs.writeFileSync(transcriptPath, `${turnEndedRow()}\n`)

    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    fs.mkdirSync(dir, { recursive: true })
    const padLine = `${JSON.stringify({ op: 'transcript_turn', key: 'pad-retained', ref: null, pad: 'r'.repeat(400) })}\n`
    fs.writeFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })

    appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'command', requested_by: ALICE, message_id: 'msg-alice-retained' }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'answered', id: REQ_ALICE }, { dir })

    // Open fd BEFORE rotation, finish idle close + rotation so the old inode becomes `.requests.jsonl.1`.
    const oldFd = fs.openSync(reqLogPath, 'a')
    try {
      const idleRes = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: () => {},
      })
      assert.deepEqual(idleRes.closed, [REQ_ALICE])
      assert.equal(fs.existsSync(`${reqLogPath}.1`), true)

      // Completion arrives in transcript BEFORE the launch record lands -> first poll caches `memo.synced = true`!
      const wakeRow = JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<task-notification><task-id>retained-memo-launch</task-id><status>completed</status></task-notification>',
            },
          ],
        },
      })
      fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
      const memo = {}
      const poll1 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
      })
      assert.equal(poll1.action, 'not_typed_live')
      assert.equal(memo.synced, true)
      assert.equal(typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }), false)

      // Now the still-open fd appends the launch record into the retained `.requests.jsonl.1` log
      // WITHOUT touching the active `.requests.jsonl` file!
      fs.writeSync(
        oldFd,
        `${JSON.stringify({ op: 'launch', key: 'retained-memo-launch', kind: 'shell', notifies: true, request: REQ_ALICE, also: [] })}\n`,
      )

      // Poller MUST detect the change in `.requests.jsonl.1` using the SAME cached `memo`!
      assert.equal(
        typedTurnSyncPending({ transcriptPath, memo, connectionId: CONN, dir }),
        true,
        'typedTurnSyncPending MUST detect append to retained .1 log',
      )
      assert.equal(
        typedTurnSyncPending({ transcriptPath, memo }),
        true,
        'typedTurnSyncPending via memo alone MUST also detect append to retained .1 log',
      )
      const poll2 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
      })
      assert.equal(poll2.action, 'restored_wake_request', 'reconciliation with cached memo MUST process the launch')
      assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE)
      assert.equal(readRequestState(CONN, { dir }).launches.get('retained-memo-launch')?.notified, true)
      assert.equal(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }).args?.request_ref, REQ_ALICE)
    } finally {
      fs.closeSync(oldFd)
    }
  })

  it('same-turn second background notification whose launch is still arriving does NOT clear the first notification’s restored requester, and joins it once the second launch arrives (ce71a72b)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { turnAmbiguity } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111ad'
    const CMD_BOB = '22222222-2222-4222-8222-2222222222ad'

    appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE, message_id: 'msg-alice-wake1' }, { dir })
    appendRequestEvent(CONN, { op: 'open', id: CMD_BOB, kind: 'command', requested_by: BOB, message_id: 'msg-bob-wake2' }, { dir })
    // Only Alice's launch record has landed so far; Bob's launch record is still arriving!
    appendRequestEvent(CONN, { op: 'launch', key: 'alice-same-turn-1', kind: 'shell', notifies: true, request: CMD_ALICE, also: [] }, { dir })

    const wake1 = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>alice-same-turn-1</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })
    const wake2 = JSON.stringify({
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>bob-same-turn-2</task-id><status>completed</status></task-notification>',
          },
        ],
      },
    })

    const memo = {}
    // Poll 1: Alice's notification arrives and restores CMD_ALICE.
    fs.writeFileSync(transcriptPath, `${wake1}\n`)
    const p1 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(p1.action, 'restored_wake_request')
    assert.equal(readRequestState(CONN, { dir }).current, CMD_ALICE)

    // Poll 2: Bob's notification arrives in the SAME turn (no turn_ended) while Bob's launch record is still in flight!
    fs.appendFileSync(transcriptPath, `${wake2}\n`)
    const p2 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.notEqual(p2.action, 'cleared_for_wake', 'unmatched second same-turn notification MUST NOT clear Alice’s requester')
    assert.equal(readRequestState(CONN, { dir }).current, CMD_ALICE, 'Alice MUST remain current while Bob’s launch record arrives')

    // Poll 3: Bob's launch record lands in `.requests.jsonl`!
    appendRequestEvent(CONN, { op: 'launch', key: 'bob-same-turn-2', kind: 'shell', notifies: true, request: CMD_BOB, also: [] }, { dir })
    const p3 = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
      memo,
    })
    assert.equal(p3.action, 'restored_wake_request')
    assert.equal(p3.midTurn, true, 'Bob’s late-matched notification MUST join Alice’s live turn, not replace it')

    const after = readRequestState(CONN, { dir })
    assert.equal(after.current, CMD_ALICE, 'Alice’s request must stay current')
    assert.equal(after.joined.has(CMD_BOB), true, 'Bob’s request must be joined')
    assert.equal(turnAmbiguity(after)?.length, 2, 'both requesters must stay distinct and require a choice')
    const stamped = stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home })
    assert.ok(stamped.deny, 'next write MUST ask which requester it serves instead of stamping Bob alone')
    assert.match(stamped.deny, /msg-alice-wake1/)
    assert.match(stamped.deny, /msg-bob-wake2/)
  })

  it('a second successful rotation NEVER replaces/unlinks the first archive so a late launch written via an open fd from before the first rotation is still detected and reconciled (3ea2b201)', async () => {
    const { home, dir, transcriptPath } = makeEnv()
    const { typedTurnSyncPending } = await import('./typed-turn-sync.mjs')
    const { rotateRequestLog } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const REQ_ALICE = '11111111-1111-4111-8111-1111111111ae'
    const REQ_SECOND = '22222222-2222-4222-8222-2222222222ae'

    fs.writeFileSync(transcriptPath, `${turnEndedRow()}\n`)
    const reqLogPath = path.join(dir, `${CONN}.requests.jsonl`)
    fs.mkdirSync(dir, { recursive: true })
    const padLine = `${JSON.stringify({ op: 'transcript_turn', key: 'old-pad', ref: null, pad: 'p'.repeat(400) })}\n`
    fs.writeFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })

    appendRequestEvent(CONN, { op: 'open', id: REQ_ALICE, kind: 'command', requested_by: ALICE, message_id: 'msg-alice-2rot' }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: REQ_ALICE }, { dir })
    appendRequestEvent(CONN, { op: 'answered', id: REQ_ALICE }, { dir })

    // Open fd BEFORE Rotation #1!
    const firstFd = fs.openSync(reqLogPath, 'a')
    try {
      // Rotation #1 via finishIdleRequests -> moves original inode to `.requests.jsonl.1`.
      const idle1 = await finishIdleRequests({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        callRequest: async () => ({ status: 'closed' }),
        dir,
        log: () => {},
      })
      assert.deepEqual(idle1.closed, [REQ_ALICE])
      assert.equal(fs.existsSync(`${reqLogPath}.1`), true)
      const firstArchiveIno = fs.statSync(`${reqLogPath}.1`).ino

      // Now accumulate enough log lines and run a SECOND successful rotation!
      fs.appendFileSync(reqLogPath, padLine.repeat(180), { mode: 0o600 })
      appendRequestEvent(CONN, { op: 'open', id: REQ_SECOND, kind: 'typed_prompt', requested_by: ALICE }, { dir })
      appendRequestEvent(CONN, { op: 'current', ref: REQ_SECOND }, { dir })
      appendRequestEvent(CONN, { op: 'close', id: REQ_SECOND }, { dir })
      const rotated2 = rotateRequestLog(CONN, { dir })
      assert.equal(rotated2, true, 'second rotation must succeed')
      assert.equal(fs.statSync(`${reqLogPath}.1`).ino, firstArchiveIno, 'second rotation MUST NOT replace or unlink the first archive inode!')
      const archiveFiles = fs.readdirSync(dir).filter((name) => name.startsWith(`${CONN}.requests.jsonl.archive-`))
      assert.ok(archiveFiles.length >= 1, 'second rotation must write a distinct non-overwriting .archive-* file')

      // Completion arrives in transcript BEFORE the late launch lands -> first poll caches `memo.synced = true`.
      const wakeRow = JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<task-notification><task-id>two-rotations-late-launch</task-id><status>completed</status></task-notification>',
            },
          ],
        },
      })
      fs.appendFileSync(transcriptPath, `${wakeRow}\n`)
      const memo = {}
      const poll1 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
      })
      assert.equal(poll1.action, 'not_typed_live')
      assert.equal(memo.synced, true)
      assert.equal(typedTurnSyncPending({ transcriptPath, memo }), false)

      // Now the writer holding `firstFd` from BEFORE Rotation #1 appends the launch record!
      fs.writeSync(
        firstFd,
        `${JSON.stringify({ op: 'launch', key: 'two-rotations-late-launch', kind: 'shell', notifies: true, request: REQ_ALICE, also: [] })}\n`,
      )

      // Poller MUST detect the append to the first archive even after Rotation #2!
      assert.equal(
        typedTurnSyncPending({ transcriptPath, memo }),
        true,
        'typedTurnSyncPending MUST detect append to first archive even after a second rotation',
      )
      const poll2 = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
        memo,
      })
      assert.equal(poll2.action, 'restored_wake_request', 'reconciliation MUST recover late launch from first archive across two rotations')
      assert.equal(readRequestState(CONN, { dir }).current, REQ_ALICE)
      assert.equal(readRequestState(CONN, { dir }).launches.get('two-rotations-late-launch')?.notified, true)
      assert.equal(stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }).args?.request_ref, REQ_ALICE)
    } finally {
      fs.closeSync(firstFd)
    }
  })

  it('when a scheduled wake starts and ends between sync passes, a later unrelated timestamp-only wake does NOT inherit the finished wake’s requester (ce71a72b)', async () => {
    const { promptArrival } = await import('./requests.mjs')
    const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const CMD_ALICE = '11111111-1111-4111-8111-1111111111af'
    const PROV_ALICE = '99999999-9999-4999-8999-9999999999af'

    for (const scheduledRowText of [
      'check deploy status',
      '<timestamp>Wednesday, Nov 25, 2026, 6:20 PM (UTC)</timestamp>',
    ]) {
      const { home, dir, transcriptPath } = makeEnv()
      appendRequestEvent(CONN, { op: 'open', id: CMD_ALICE, kind: 'command', requested_by: ALICE, provenance_ref: PROV_ALICE }, { dir })
      appendRequestEvent(CONN, { op: 'schedule', id: 'sched-alice-end', prompt: 'check deploy status', request: CMD_ALICE, also: [] }, { dir })

      // Turn 1: scheduled wake fires via promptArrival (`from_wake: true`), runs, and ENDS (`turn_ended`) BEFORE any sync runs!
      const schedEvents = promptArrival({
        fromAPerson: false,
        origin: 'scheduled-trigger',
        text: 'check deploy status',
        midTurn: false,
        state: readRequestState(CONN, { dir }),
      }).events
      for (const ev of schedEvents) appendRequestEvent(CONN, ev, { dir })
      assert.equal(readRequestState(CONN, { dir }).current, CMD_ALICE)
      assert.equal(readRequestState(CONN, { dir }).currentFromWake, true)

      const scheduledRow = JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: scheduledRowText }] },
      })
      const laterUnrelatedTimestamp = JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 6:35 PM (UTC)</timestamp>' }] },
      })
      fs.writeFileSync(transcriptPath, `${scheduledRow}\n${turnEndedRow()}\n${laterUnrelatedTimestamp}\n`)

      // Now sync runs on Turn 2 (the unrelated timestamp-only wake)!
      const res = await syncTypedTurnFromTranscript({
        connectionId: CONN,
        transcriptPath,
        connectionCapability: 'cap-secret',
        dir,
      })
      assert.equal(res.action, 'cleared_for_wake', `unrelated timestamp wake after finished scheduled wake (${scheduledRowText}) MUST clear stale wake requester`)
      const after = readRequestState(CONN, { dir })
      assert.equal(after.current, null, 'finished scheduled wake requester MUST NOT stay current for later unrelated timestamp wake')
      assert.equal(after.open.has(CMD_ALICE), true, 'Alice’s request stays open for future real scheduled firings')
      assert.deepEqual(
        stampRequest('record_implementation', { task_id: 'x' }, CONN, null, { home }),
        { args: { task_id: 'x' } },
        'write during later unrelated timestamp wake MUST NOT be stamped with Alice’s finished scheduled wake request',
      )
    }
  })
})
