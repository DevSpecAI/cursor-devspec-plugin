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
      patchState: (patch) => { patched = patch },
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
        return { ok: true }
      },
      patchState: (patch) => { patched = patch },
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
      patchState: (patch) => { patched = patch },
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

  it('preserves a typed_prompt that has a recorded scheduled wake continuation on a non-typed wake (ce71a72b / 2fcd26bd)', async () => {
    const { dir, transcriptPath } = makeEnv()
    appendRequestEvent(CONN, { op: 'open', id: HOOK_TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'schedule', id: 'cron-1', prompt: 'Check deploy', request: HOOK_TYPED, also: [] }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: HOOK_TYPED }, { dir })
    const timestampOnly = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Nov 25, 2026, 6:10 PM (UTC)</timestamp>' }] },
    })
    fs.writeFileSync(transcriptPath, `${typedRow('Schedule deploy check')}\n${timestampOnly}\n`)

    const res = await syncTypedTurnFromTranscript({
      connectionId: CONN,
      transcriptPath,
      connectionCapability: 'cap-secret',
      dir,
    })
    assert.equal(res.action, 'not_typed_live')
    assert.equal(readRequestState(CONN, { dir }).current, HOOK_TYPED, 'scheduled-wake continuation must keep typed_prompt attribution')
  })

  it('leaves turn unsynced when patchState fails to persist admitted local_turn (3ea2b201)', async () => {
    const { dir, transcriptPath } = makeEnv()
    fs.writeFileSync(transcriptPath, `${typedRow('Persist state check')}\n`)
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
      patchState: () => false,
      dir,
      memo,
      log: () => {},
    })
    assert.equal(res.action, 'state_write_failed')
    assert.equal(memo.synced, false)
    assert.equal(readRequestState(CONN, { dir }).seenTranscriptTurns.size, 0)
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
})
