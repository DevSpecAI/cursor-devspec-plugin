#!/usr/bin/env node
/**
 * Unit and integration tests for hooks/scripts/local-turn.mjs and mirror-turn.mjs (item b59a201c):
 * terminal turn admission via report_pickup with local_activity_version: 1 and connection
 * capability, exact attempt completion on Stop, and ensuring room commands and background
 * wakes open no terminal turn.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachmentFromPoll, localTurnScope, localTurnToComplete, startLocalTurn } from './local-turn.mjs'
import { markCommandsAnswered } from './mark-explicit-reply.mjs'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const ROOM = '22222222-2222-4222-8222-222222222222'
const ATTACHMENT = '33333333-3333-4333-8333-333333333333'
const OLDER = '44444444-4444-4444-8444-444444444444'
const ATTACHED_AT = '2026-10-04T21:00:00.123+00:00'
const state = {
  connection_id: CONNECTION,
  session_id: ROOM,
  connection_capability: 'dvsc_hidden',
  speech_attachment_id: ATTACHMENT,
  attached_at: ATTACHED_AT,
}

describe('attachmentFromPoll', () => {
  it('records the attachment a poll names', () => {
    assert.deepEqual(attachmentFromPoll({ speech_attachment_id: ATTACHMENT, attached_at: ATTACHED_AT }), {
      speech_attachment_id: ATTACHMENT,
      attached_at: ATTACHED_AT,
    })
  })
  it('records nothing for a detached or malformed response, never half an attachment', () => {
    for (const res of [{}, { speech_attachment_id: ATTACHMENT }, { speech_attachment_id: 'nope', attached_at: ATTACHED_AT }, null]) {
      assert.deepEqual(attachmentFromPoll(res), { speech_attachment_id: null, attached_at: null })
    }
  })
})

describe('localTurnScope', () => {
  it('is the exact attachment the server will check', () => {
    assert.deepEqual(localTurnScope(state, ROOM), {
      connection_id: CONNECTION,
      expected_session_id: ROOM,
      expected_attachment_id: ATTACHMENT,
      expected_attached_at: ATTACHED_AT,
    })
  })
  it('cannot prove a turn without a room, the capability or a recorded attachment', () => {
    assert.equal(localTurnScope(state, null), null)
    assert.equal(localTurnScope({ ...state, connection_capability: null }, ROOM), null)
    assert.equal(localTurnScope({ ...state, speech_attachment_id: null }, ROOM), null)
    assert.equal(localTurnScope({ ...state, attached_at: 'not a time' }, ROOM), null)
  })
})

describe('startLocalTurn', () => {
  const scope = localTurnScope(state, ROOM)
  const receipt = (args, extra) => ({
    connection_id: args.connection_id,
    attempt_id: args.attempt_id,
    expected_session_id: args.expected_session_id,
    ...extra,
  })

  it('admits with the exact local identity and nothing else', async () => {
    const calls = []
    const admitted = await startLocalTurn({
      scope,
      attemptId: OLDER,
      call: async (args) => {
        calls.push(args)
        return receipt(args, { status: 'working', already_started: false })
      },
    })
    assert.deepEqual(admitted, { attempt_id: OLDER, session_id: ROOM })
    assert.deepEqual(calls, [
      { ...scope, local_activity_version: 1, local_turn: true, attempt_id: OLDER, previous_attempt_id: null },
    ])
  })

  it('adopts the newest attempt the server names, once', async () => {
    const calls = []
    const admitted = await startLocalTurn({
      scope,
      call: async (args) => {
        calls.push(args.previous_attempt_id)
        return calls.length === 1
          ? receipt(args, { status: 'predecessor_changed', previous_attempt_id: OLDER })
          : receipt(args, { status: 'working', already_started: false })
      },
    })
    assert.equal(admitted.session_id, ROOM)
    assert.deepEqual(calls, [null, OLDER])
  })

  it('admits nothing when the server keeps moving, another command owns the turn, or the call fails', async () => {
    const changing = async (args) => receipt(args, { status: 'predecessor_changed', previous_attempt_id: OLDER })
    assert.equal(await startLocalTurn({ scope, call: changing }), null)
    assert.equal(await startLocalTurn({ scope, call: async (args) => receipt(args, { status: 'foreground_owned' }) }), null)
    assert.equal(await startLocalTurn({ scope, call: async () => { throw new Error('offline') } }), null)
    assert.equal(
      await startLocalTurn({ scope, call: async (args) => ({ ...receipt(args, { status: 'working' }), connection_id: OLDER }) }),
      null,
    )
  })
})

describe('localTurnToComplete', () => {
  it('completes only a turn admitted in the room the connection is still in', () => {
    assert.equal(localTurnToComplete({ attempt_id: OLDER, session_id: ROOM }, ROOM), OLDER)
    assert.equal(localTurnToComplete({ attempt_id: OLDER, session_id: ROOM }, ATTACHMENT), null)
    assert.equal(localTurnToComplete(null, ROOM), null)
  })
})

// The hook as Cursor runs it: a real process, a real state file, a stub server.
describe('mirror-turn opens and closes the owner terminal turn (item b59a201c)', () => {
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mirror-turn.mjs')
  const CONVERSATION = 'conversation-b59a201c'
  const TYPED = { kind: 'composer' }
  const OWNER = '33333333-3333-4333-8333-333333333333'
  let server
  let url
  let calls = []
  let home
  let connections

  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const rpc = JSON.parse(body)
        const name = rpc.params?.name
        const args = rpc.params?.arguments ?? {}
        calls.push({ name, args, capability: req.headers['x-devspec-connection-capability'] ?? null })
        const result =
          name === 'report_pickup'
            ? {
                connection_id: args.connection_id,
                attempt_id: args.attempt_id,
                expected_session_id: args.expected_session_id,
                status: 'working',
                already_started: false,
              }
            : name === 'report_request'
              ? {
                  outcome: 'committed',
                  request_id: args.request_id,
                  status: args.action === 'open' ? 'open' : 'closed',
                  requested_by_user_id: OWNER,
                }
              : { ok: true }
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/api/mcp`
  })
  after(() => server.close())

  function seed(extra = {}) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-local-turn-'))
    connections = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connections, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(connections, `${CONNECTION}.json`),
      JSON.stringify({
        ...state,
        enabled: true,
        agent_name: 'Cursor',
        local_id: CONVERSATION,
        token: 'dvs_test',
        mcp_url: url,
        ...extra,
      }),
      { mode: 0o600 },
    )
    calls = []
  }
  const stored = () => JSON.parse(fs.readFileSync(path.join(connections, `${CONNECTION}.json`), 'utf8'))
  function run(mode, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK, mode], {
        env: { PATH: process.env.PATH, HOME: home, CURSOR_CONVERSATION_ID: CONVERSATION },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.on('error', reject)
      child.on('exit', (code) => resolve(code))
      child.stdin.end(JSON.stringify({ conversation_id: CONVERSATION, ...input }))
    })
  }

  it('a typed prompt admits the turn with the capability, before anything else, and Stop closes exactly it', async () => {
    seed()
    await run('user_prompt', { prompt: 'file an item for the flaky test' })
    const pickup = calls.find((call) => call.name === 'report_pickup')
    assert.ok(pickup, 'report_pickup was called')
    assert.equal(calls[0].name, 'report_pickup')
    assert.equal(pickup.capability, 'dvsc_hidden')
    assert.deepEqual(
      { ...pickup.args, attempt_id: undefined },
      {
        connection_id: CONNECTION,
        expected_session_id: ROOM,
        expected_attachment_id: ATTACHMENT,
        expected_attached_at: ATTACHED_AT,
        local_activity_version: 1,
        local_turn: true,
        attempt_id: undefined,
        previous_attempt_id: null,
      },
    )
    assert.deepEqual(stored().local_turn, { attempt_id: pickup.args.attempt_id, session_id: ROOM })
    const opened = calls.find((call) => call.name === 'report_request')
    assert.equal(opened.capability, 'dvsc_hidden')
    assert.deepEqual(
      { ...opened.args, request_id: undefined },
      { connection_id: CONNECTION, action: 'open', kind: 'typed_prompt', request_id: undefined },
    )

    calls = []
    await run('stop', { last_assistant_message: 'Filed.' })
    const complete = calls.find((call) => call.name === 'report_complete')
    assert.deepEqual(complete.args, {
      connection_id: CONNECTION,
      attempt_id: pickup.args.attempt_id,
      reason: 'turn_end',
    })
    assert.equal(stored().local_turn, null)
    const closed = calls.find((call) => call.name === 'report_request')
    assert.deepEqual(
      { ...closed.args, reason: undefined },
      { connection_id: CONNECTION, action: 'close', request_id: opened.args.request_id, reason: undefined },
    )
  })

  it('a job a typed prompt started keeps its request open, and its wake continues it', async () => {
    seed()
    await run('user_prompt', { prompt: 'run the slow suite and tell me', origin: TYPED })
    const request = calls.find((call) => call.name === 'report_request').args.request_id
    await run('background_launch', {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { backgroundTaskId: 'suite1' },
      tool_use_id: 'toolu_suite',
    })

    calls = []
    await run('stop', {
      last_assistant_message: 'Started it.',
      background_tasks: [{ id: 'suite1', status: 'running' }],
    })
    assert.equal(
      calls.some((call) => call.name === 'report_request'),
      false,
      'a request with work running stays open',
    )

    await run('user_prompt', {
      prompt: '<task-notification>\n<task-id>suite1</task-id>\n<status>completed</status>\n</task-notification>',
      origin: { kind: 'task-notification' },
    })
    const log = fs
      .readFileSync(path.join(connections, `${CONNECTION}.requests.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(log.filter((event) => event.op === 'current').at(-1).ref, request)
    assert.ok(log.some((event) => event.op === 'notified' && event.key === 'suite1'))

    calls = []
    await run('stop', { last_assistant_message: 'All green.', background_tasks: [] })
    assert.deepEqual(
      calls.filter((call) => call.name === 'report_request').map((call) => [call.args.action, call.args.request_id]),
      [['close', request]],
    )
  })

  it('a room command or a background wake opens no terminal turn', async () => {
    seed({ local_turn: { attempt_id: OLDER, session_id: ROOM } })
    await run('user_prompt', {
      prompt: '<task-notification>background job finished</task-notification>',
      origin: { kind: 'task-notification' },
    })
    assert.equal(calls.some((call) => call.name === 'report_pickup'), false)
    assert.deepEqual(stored().local_turn, { attempt_id: OLDER, session_id: ROOM })

    calls = []
    await run('user_prompt', {
      prompt: '{"type":"owner_message","message_id":"66666666-6666-4666-8666-666666666666","content":"check status"}',
    })
    assert.equal(calls.some((call) => call.name === 'report_pickup'), false)
    assert.deepEqual(stored().local_turn, { attempt_id: OLDER, session_id: ROOM })
  })

  it('a command delivered into a running turn joins it, and one not yet delivered outlives the turn Stop', async () => {
    seed()
    const brandon = '44444444-4444-4444-8444-444444444444'
    const delivered = '55555555-5555-4555-8555-555555555555'
    const message = '66666666-6666-4666-8666-666666666666'
    const waiting = '77777777-7777-4777-8777-777777777777'
    fs.writeFileSync(
      path.join(connections, `${CONNECTION}.requests.jsonl`),
      [
        { op: 'open', id: delivered, kind: 'command', message_id: message, provenance_ref: brandon, requested_by: brandon },
        { op: 'open', id: waiting, kind: 'command', message_id: brandon, provenance_ref: message, requested_by: brandon },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    )
    await run('user_prompt', { prompt: 'tidy the changelog', origin: TYPED })
    const typed = calls.find((call) => call.name === 'report_request').args.request_id
    await run('user_prompt', {
      prompt: `<task-notification><task-id>listener</task-id><event>{"type":"owner_message","message_id":"${message}"}</event></task-notification>`,
      origin: { kind: 'task-notification' },
      turn_id: 'turn-1',
    })
    const events = () =>
      fs
        .readFileSync(path.join(connections, `${CONNECTION}.requests.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    assert.deepEqual(
      events()
        .filter((event) => event.op === 'current')
        .map((event) => event.ref),
      [typed],
      'the turn still serves the typed prompt',
    )
    assert.ok(events().some((event) => event.op === 'joined' && event.id === delivered))

    calls = []
    await run('stop', { last_assistant_message: 'Done.', background_tasks: [] })
    let closed = calls
      .filter((call) => call.name === 'report_request')
      .map((call) => call.args.request_id)
      .sort()
    assert.deepEqual(closed, [typed], 'a command without its final answer stays open')
    assert.equal(closed.includes(waiting), false, 'a command whose wake has not come is not closed')

    await run('user_prompt', {
      prompt: `<task-notification><task-id>listener</task-id><event>{"type":"owner_message","message_id":"${message}"}</event></task-notification>`,
      origin: { kind: 'task-notification' },
    })
    assert.deepEqual(markCommandsAnswered(CONNECTION, { dir: connections }), [delivered])
    calls = []
    await run('stop', { last_assistant_message: 'Done.', background_tasks: [] })
    closed = calls.filter((call) => call.name === 'report_request').map((call) => call.args.request_id)
    assert.deepEqual(closed, [delivered])
  })

  it('a scheduled firing or unknown origin opens no terminal turn', async () => {
    seed()
    const loop = '/loop check CI and merge when green'
    await run('user_prompt', { prompt: loop, origin: { kind: 'scheduled-trigger' } })
    assert.equal(calls.some((call) => call.name === 'report_pickup'), false)
    assert.equal(stored().local_turn ?? null, null)

    calls = []
    await run('user_prompt', { prompt: loop, origin: TYPED })
    assert.equal(calls[0].name, 'report_pickup')
    assert.equal(calls[1].name, 'report_request')
    const localPost = calls.find(
      (call) => call.name === 'post_session_message' && call.args?.turn_kind === 'local_prompt',
    )
    assert.deepEqual(localPost.args, {
      message: loop,
      agent_name: 'Cursor',
      turn_kind: 'local_prompt',
      connection_id: CONNECTION,
    })
  })

  it('without a recorded attachment the turn is left as before, and Stop keeps the connection-scoped completion', async () => {
    seed({ speech_attachment_id: null, attached_at: null })
    await run('user_prompt', { prompt: 'file an item', origin: TYPED })
    assert.equal(calls.some((call) => call.name === 'report_pickup'), false)
    calls = []
    await run('stop', { last_assistant_message: 'Done.' })
    assert.deepEqual(calls.find((call) => call.name === 'report_complete').args, {
      connection_id: CONNECTION,
      reason: 'turn_end',
    })
  })
})
