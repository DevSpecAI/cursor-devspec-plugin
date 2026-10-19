#!/usr/bin/env node
// The requests a connection carries (item 56ba1b79): which request a turn, a
// launch and a write serve, and when a write must say which.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  NO_REQUEST,
  UNSTATED,
  appendRequestEvent,
  absentLaunches,
  closeRequest,
  launchForRequest,
  openRequest,
  promptArrival,
  provenanceRefForWrite,
  recordDeliveredBatchRequests,
  rotateRequestLog,
  servableCarried,
  readRequestState,
  reduceRequestLog,
  requestForLaunch,
  requestForWake,
  requestRefForWrite,
  requestsWithWorkPending,
  requestFinished,
  selectableRequests,
  serveMain,
  setCurrentRequest,
  turnAmbiguity,
} from './requests.mjs'
import { PROVENANCE_REF_TOOLS, REQUEST_REF_TOOLS, stampRequest } from './request-ref.mjs'
import { launchGuard } from './launch-guard.mjs'
import { markCommandsAnswered } from './mark-explicit-reply.mjs'

const CONN = '11111111-1111-4111-8111-111111111111'
const ALI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BRANDON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const A = '0000000a-0000-4000-8000-00000000000a'
const B = '0000000b-0000-4000-8000-00000000000b'
const T = '0000000c-0000-4000-8000-00000000000c'
const MSG_A = '1000000a-0000-4000-8000-00000000000a'
const MSG_B = '1000000b-0000-4000-8000-00000000000b'
const DELIVERY_A = '2000000a-0000-4000-8000-00000000000a'
const DELIVERY_B = '2000000b-0000-4000-8000-00000000000b'

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-requests-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  return { home, dir }
}

function log(...events) {
  return events.map((event) => JSON.stringify(event)).join('\n')
}

const openA = { op: 'open', id: A, kind: 'command', message_id: MSG_A, provenance_ref: DELIVERY_A, requested_by: ALI }
const openB = { op: 'open', id: B, kind: 'command', message_id: MSG_B, provenance_ref: DELIVERY_B, requested_by: BRANDON }
const openT = { op: 'open', id: T, kind: 'typed_prompt', requested_by: ALI }

/** A listener wake, as the DevSpec monitor prints an owner_message. */
function wakeFor(...messageIds) {
  return messageIds.map((id) => `{"type":"owner_message","from":"Someone","message_id":"${id}","body":"..."}`).join('\n')
}

function notification(taskId) {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`
}

describe('the request log', () => {
  it('keeps open requests with who asked, and forgets closed ones', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'close', id: A }))
    assert.deepEqual([...state.open.keys()], [B])
    assert.equal(state.open.get(B).requested_by, BRANDON)
  })

  it('starts each turn from the request that woke it', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'joined', id: B }, { op: 'current', ref: A }))
    assert.equal(state.current, A)
    assert.equal(state.joined.size, 0)
  })

  it('skips a torn line', () => {
    const state = reduceRequestLog(`${JSON.stringify(openA)}\n{"op":"open","id":`)
    assert.deepEqual([...state.open.keys()], [A])
  })
})

describe('what a wake continues', () => {
  const state = reduceRequestLog(log(
    openA, openB, openT,
    { op: 'launch', key: 'task1', alias: 'toolu_1', kind: 'shell', notifies: true, request: T, also: [] },
    { op: 'launch', key: 'gone', kind: 'shell', notifies: true, request: '0000000d-0000-4000-8000-00000000000d', also: [] },
    { op: 'launch', key: 'own', kind: 'shell', notifies: true, request: NO_REQUEST, also: [] },
    { op: 'launch', key: 'unknown', kind: 'shell', notifies: true, request: UNSTATED, also: [] },
    { op: 'schedule', prompt: 'check the deploy', id: 'cron1', request: A, also: [] },
    { op: 'schedule', prompt: 'tidy up', id: 'cron2', request: NO_REQUEST, also: [] },
  ))

  it('a DevSpec command is its own request, and the others in one wake join it', () => {
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: wakeFor(MSG_A), state }), { ref: A, also: [] })
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: wakeFor(MSG_A, MSG_B), state }), { ref: B, also: [A] })
  })

  it('reads the listener wake as delivered, a body cut mid-string included', () => {
    const delivered = `<task-notification>\n<task-id>b2hh67xwv</task-id>\n<summary>Monitor event: "DevSpec: messages sent to this agent"</summary>\n` +
      `<event>{"type":"owner_message","from":"Ali Price","authority":"owner","style":true,"message_id":"${MSG_A}","unread":27,"body_chars":681,"body":"Please, can you get caught up and get grou</event>\n</task-notification>`
    assert.deepEqual(requestForWake({ origin: { kind: 'task-notification' }, text: delivered, state }), { ref: A, also: [] })
  })

  it('an automation run DevSpec dispatched is nobody\'s request, so DevSpec credits the run', () => {
    const run = `<task-notification>\n<task-id>b2hh67xwv</task-id>\n<event>{"type":"automation_run","session_id":null,"authoritative":true,"executable":true,"channel":"explicit_automation_dispatch"}</event>\n</task-notification>`
    assert.deepEqual(requestForWake({ origin: { kind: 'task-notification' }, text: run, state }), { ref: NO_REQUEST, also: [] })
  })

  it('a command this plugin could not open leaves the write for DevSpec to resolve', () => {
    const unknown = '1000000f-0000-4000-8000-00000000000f'
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: wakeFor(unknown), state }), { ref: UNSTATED, also: [] })
  })

  it('a background job continues the request that launched it, by job id or tool call id', () => {
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: notification('task1'), state }), { ref: T, also: [] })
    const byAlias = '<task-notification><tool-use-id>toolu_1</tool-use-id></task-notification>'
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: byAlias, state }), { ref: T, also: [] })
  })

  it('is nobody\'s request only when the job was launched for nobody\'s', () => {
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: notification('own'), state }), { ref: NO_REQUEST, also: [] })
    assert.deepEqual(requestForWake({ origin: 'scheduled-trigger', text: 'tidy up', state }), { ref: NO_REQUEST, also: [] })
  })

  it('never infers nobody\'s request from a missing signal: a finished, unknown or unrecorded launch is unstated', () => {
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: notification('gone'), state }), { ref: UNSTATED, also: [] })
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: notification('unknown'), state }), { ref: UNSTATED, also: [] })
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: notification('stranger'), state }), { ref: UNSTATED, also: [] })
    assert.deepEqual(requestForWake({ origin: 'scheduled-trigger', text: 'something else', state }), { ref: UNSTATED, also: [] })
  })

  it('a scheduled firing continues the request that scheduled that prompt', () => {
    assert.deepEqual(requestForWake({ origin: 'scheduled-trigger', text: ' check the deploy ', state }), { ref: A, also: [] })
  })

  it('any other prompt (a channel, a peer, another plugin, no stamp) is not known, never the last request', () => {
    for (const origin of ['channel', 'peer', 'plugin', 'unclassified', null]) {
      assert.deepEqual(requestForWake({ origin, text: 'hello', state }), { ref: UNSTATED, also: [] }, String(origin))
    }
  })

  it('reads a recorded job by its id before anything its output quotes', () => {
    const quoting = `<task-notification><task-id>task1</task-id><event>{"type":"owner_message","message_id":"${MSG_A}"}</event>` +
      '{"type":"automation_run"}</task-notification>'
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: quoting, state }), { ref: T, also: [] })
  })

  it('carries every request that scheduled the same prompt (two people\'s /loop)', () => {
    const twoLoops = reduceRequestLog(log(openA, openB,
      { op: 'schedule', prompt: '<<autonomous-loop-dynamic>>', request: A, also: [] },
      { op: 'schedule', prompt: '<<autonomous-loop-dynamic>>', request: B, also: [] }))
    assert.deepEqual(requestForWake({ origin: 'scheduled-trigger', text: '<<autonomous-loop-dynamic>>', state: twoLoops }), { ref: B, also: [A] })
  })
})

describe('what a finished tool call left running', () => {
  it('reads each launch shape Cursor / Claude Code returns', () => {
    assert.deepEqual(launchForRequest('Bash', {}, { backgroundTaskId: 'b1' }, 'toolu_9'), { key: 'b1', alias: 'toolu_9', kind: 'shell', notifies: true })
    assert.deepEqual(launchForRequest('Shell', {}, { backgroundTaskId: 's1' }, 'call_1'), { key: 's1', alias: 'call_1', kind: 'shell', notifies: true })
    assert.equal(launchForRequest('Bash', {}, { stdout: 'done' }), null)
    assert.equal(launchForRequest('Agent', {}, { status: 'async_launched', agentId: 'ag1' }).key, 'ag1')
    assert.equal(launchForRequest('Task', {}, { status: 'async_launched', agentId: 'ag2' }).key, 'ag2')
    assert.equal(launchForRequest('Agent', {}, { status: 'remote_launched', taskId: 'r1' }).key, 'r1')
    assert.equal(launchForRequest('Agent', {}, { status: 'completed', agentId: 'ag1' }), null)
    assert.equal(launchForRequest('Workflow', {}, { taskId: 'w1' }).kind, 'workflow')
    assert.deepEqual(launchForRequest('Monitor', { command: 'tail -f x' }, { taskId: 'm1' }), { key: 'm1', alias: null, kind: 'monitor', notifies: false })
    assert.deepEqual(launchForRequest('ScheduleWakeup', { prompt: ' again ' }, {}), { schedule: true, prompt: 'again', id: null })
    assert.equal(launchForRequest('ScheduleWakeup', { prompt: 'again' }, { stopped: true }), null)
    assert.deepEqual(launchForRequest('CronCreate', { prompt: 'nightly' }, { id: 'c1' }), { schedule: true, prompt: 'nightly', id: 'c1' })
    assert.equal(launchForRequest('Read', {}, { taskId: 'x' }), null)
  })

  it('never treats the DevSpec listener as one request\'s work: it carries all of them', () => {
    const listener = { command: 'node "/plugin/hooks/scripts/devspec-remote-wait.mjs" --connection-id x --stream' }
    assert.equal(launchForRequest('Monitor', listener, { taskId: 'm2' }), null)
  })

  it('belongs to the current request, or to the subagent\'s that launched it', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'current', ref: A },
      { op: 'launch', key: 'agentB', kind: 'subagent', notifies: true, request: B, also: [] }))
    assert.deepEqual(requestForLaunch(state), { request: A, also: [] })
    assert.deepEqual(requestForLaunch(state, 'agentB'), { request: B, also: [] })
  })

  it('records every launch: for nobody\'s request when the turn was, and as not known otherwise', () => {
    assert.deepEqual(requestForLaunch(reduceRequestLog(log(openA, { op: 'current', ref: NO_REQUEST }))), { request: NO_REQUEST, also: [] })
    assert.deepEqual(requestForLaunch(reduceRequestLog(log(openA))), { request: UNSTATED, also: [] })
    assert.deepEqual(requestForLaunch(reduceRequestLog(log(openA, { op: 'current', ref: A }, { op: 'close', id: A }))), { request: UNSTATED, also: [] })
  })

  it('launched while a turn carries two people\'s requests, its wake carries both again', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B }))
    assert.deepEqual(requestForLaunch(state), { request: A, also: [B] })
    const later = reduceRequestLog(log(openA, openB,
      { op: 'launch', key: 'job', kind: 'shell', notifies: true, request: A, also: [B] }))
    assert.deepEqual(requestForWake({ origin: 'task-notification', text: notification('job'), state: later }), { ref: A, also: [B] })
  })
})

describe('which requests a Stop leaves open', () => {
  const state = reduceRequestLog(log(
    openA, openB, openT,
    { op: 'launch', key: 'run', kind: 'shell', notifies: true, request: A, also: [] },
    { op: 'launch', key: 'mon', kind: 'monitor', notifies: false, request: B, also: [] },
    { op: 'schedule', prompt: 'loop', id: null, request: T, also: [] },
  ))

  it('keeps a request while its job runs, or has ended with its wake still to come', () => {
    assert.ok(requestsWithWorkPending(state, { backgroundTasks: [{ id: 'run', status: 'running' }] }).has(A))
    assert.ok(requestsWithWorkPending(state, { backgroundTasks: [{ id: 'run', status: 'completed' }] }).has(A))
    const seen = reduceRequestLog(log(openA, { op: 'launch', key: 'run', kind: 'shell', notifies: true, request: A, also: [] }, { op: 'notified', key: 'run' }))
    assert.equal(requestsWithWorkPending(seen, { backgroundTasks: [{ id: 'run', status: 'completed' }] }).has(A), false)
  })

  it('keeps a monitor\'s request only while it is listed, and a schedule\'s while its cron is', () => {
    assert.ok(requestsWithWorkPending(state, { backgroundTasks: [{ id: 'mon', status: 'running' }] }).has(B))
    assert.equal(requestsWithWorkPending(state, { backgroundTasks: [] }).has(B), false)
    assert.ok(requestsWithWorkPending(state, { sessionCrons: [{ prompt: 'loop' }] }).has(T))
    assert.equal(requestsWithWorkPending(state, { sessionCrons: [] }).has(T), false)
  })

  it('keeps every request an undecided launch carried', () => {
    const both = reduceRequestLog(log(openA, openB, { op: 'launch', key: 'job', kind: 'shell', notifies: true, request: A, also: [B] }))
    assert.deepEqual([...requestsWithWorkPending(both, { backgroundTasks: [{ id: 'job', status: 'running' }] })].sort(), [A, B].sort())
  })
})

describe('when a write must say whose request it serves', () => {
  it('one person\'s two commands have one answer', () => {
    const second = { ...openB, requested_by: ALI }
    assert.equal(turnAmbiguity(reduceRequestLog(log(openA, second, { op: 'current', ref: A }, { op: 'joined', id: B }))), null)
  })

  it('two people\'s requests in one turn do not, until the agent names one', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B }))
    assert.deepEqual(turnAmbiguity(state).map((entry) => entry.id), [A, B])
    const named = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B }, { op: 'serve', ref: B }))
    assert.equal(turnAmbiguity(named), null)
    assert.equal(requestRefForWrite(named), B)
    assert.equal(provenanceRefForWrite(named), DELIVERY_B)
  })

  it('a person at the terminal and the same person in a room are recorded differently', () => {
    const state = reduceRequestLog(log(openT, openA, { op: 'current', ref: T }, { op: 'joined', id: A }))
    assert.deepEqual(turnAmbiguity(state).map((entry) => entry.kind), ['typed_prompt', 'command'])
  })

  it('a turn woken for nobody\'s request that a command then reaches carries both', () => {
    const state = reduceRequestLog(log(openB, { op: 'current', ref: NO_REQUEST }, { op: 'joined', id: B }))
    assert.deepEqual(turnAmbiguity(state).map((entry) => entry.id), [NO_REQUEST, B])
  })

  it('a subagent\'s write is settled by its launch', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B },
      { op: 'launch', key: 'agentB', kind: 'subagent', notifies: true, request: B, also: [] }))
    assert.equal(turnAmbiguity(state, 'agentB'), null)
    assert.equal(requestRefForWrite(state, 'agentB'), B)
    assert.equal(provenanceRefForWrite(state, 'agentB'), DELIVERY_B)
  })

  it('a new arrival undoes a choice, and a new turn clears what joined the last one', () => {
    const state = reduceRequestLog(log(openA, openB, openT, { op: 'current', ref: A }, { op: 'joined', id: B },
      { op: 'serve', ref: A }, { op: 'joined', id: T }))
    assert.ok(turnAmbiguity(state))
    assert.equal(turnAmbiguity(reduceRequestLog(log(openA, openB, { op: 'joined', id: B }, { op: 'current', ref: B }))), null)
  })
})

describe('opening and naming requests', () => {
  it('records who asked, and reuses an open command, without joining any turn until it is delivered', async () => {
    const { dir } = tempHome()
    const calls = []
    const call = async (args) => { calls.push(args); return { request_id: args.request_id, status: 'open', requested_by_user_id: BRANDON } }
    const id = await openRequest({ connectionId: CONN, kind: 'command', provenanceRef: DELIVERY_B, messageId: MSG_B, call, dir })
    assert.equal(calls[0].kind, 'command')
    assert.equal(calls[0].provenance_ref, DELIVERY_B)
    const state = readRequestState(CONN, { dir })
    assert.equal(state.open.get(id).requested_by, BRANDON)
    assert.equal(state.joined.has(id), false)
    assert.equal(state.started.has(id), false, 'not started: a Stop before its wake must not close it')
    assert.equal(await openRequest({ connectionId: CONN, kind: 'command', provenanceRef: DELIVERY_B, call, dir }), id)
    assert.equal(calls.length, 1)
  })

  it('records delivered batches in the request ledger and joins an already-open turn', () => {
    const { dir } = tempHome()
    appendRequestEvent(CONN, openA, { dir })
    appendRequestEvent(CONN, openB, { dir })
    const first = recordDeliveredBatchRequests(CONN, {
      type: 'owner_messages',
      messages: [{ message_id: MSG_A }],
    }, { dir })
    assert.deepEqual(first, [{ op: 'current', ref: A }])
    assert.equal(readRequestState(CONN, { dir }).current, A)

    const second = recordDeliveredBatchRequests(CONN, {
      type: 'owner_messages',
      messages: [{ message_id: MSG_B }],
    }, { dir })
    assert.deepEqual(second, [{ op: 'joined', id: B }])
    assert.deepEqual(turnAmbiguity(readRequestState(CONN, { dir })).map((entry) => entry.id), [A, B])
  })

  it('records nothing when DevSpec refuses or cannot be reached', async () => {
    const { dir } = tempHome()
    assert.equal(await openRequest({ connectionId: CONN, kind: 'typed_prompt', call: async () => { throw new Error('offline') }, dir }), null)
    assert.equal(await openRequest({ connectionId: CONN, kind: 'command', provenanceRef: DELIVERY_A, call: async () => ({ request_id: A, status: 'closed' }), dir }), null)
    assert.equal(await openRequest({ connectionId: CONN, kind: 'command', provenanceRef: 'not-a-uuid', call: async () => ({}), dir }), null)
    assert.equal(readRequestState(CONN, { dir }).open.size, 0)
  })

  it('serve names only a request the undecided turn carries, and prints no request id', () => {
    const { dir } = tempHome()
    for (const event of [openA, { ...openT, requested_by: ALI }, openB, { op: 'current', ref: A }, { op: 'joined', id: T }]) appendRequestEvent(CONN, event, { dir })
    const named = serveMain(['--connection-id', CONN, '--terminal'], { dir })
    assert.equal(named.ok, true)
    assert.doesNotMatch(named.serving, new RegExp(T))
    assert.equal(readRequestState(CONN, { dir }).current, T)
    assert.equal(turnAmbiguity(readRequestState(CONN, { dir })), null, 'decided: writes go through')
    assert.match(serveMain(['--connection-id', CONN, '--message-id', MSG_B], { dir }).error, /not one of the requests/)
    assert.match(serveMain(['--connection-id', CONN, '--none'], { dir }).error, /not one of the requests/)
    assert.equal(serveMain(['--connection-id', CONN, '--terminal', '--none'], { dir }).ok, false)
    assert.equal(serveMain(['--message-id', MSG_A], { dir }).ok, false)
  })

  it('a choice never locks the turn: the agent can switch to another request it carries', () => {
    const { dir } = tempHome()
    for (const event of [openA, openT, { op: 'current', ref: T }, { op: 'joined', id: UNSTATED }, { op: 'joined', id: A }]) appendRequestEvent(CONN, event, { dir })
    assert.equal(serveMain(['--connection-id', CONN, '--unstated'], { dir }).ok, true)
    assert.equal(requestRefForWrite(readRequestState(CONN, { dir })), null)
    assert.equal(serveMain(['--connection-id', CONN, '--message-id', MSG_A], { dir }).ok, true)
    assert.equal(requestRefForWrite(readRequestState(CONN, { dir })), A)
    assert.equal(serveMain(['--connection-id', CONN, '--terminal'], { dir }).ok, true)
    assert.equal(requestRefForWrite(readRequestState(CONN, { dir })), T)
    assert.equal(turnAmbiguity(readRequestState(CONN, { dir })), null)
  })

  it('a room command not yet answered stays open and can be named in a later turn something else woke', () => {
    const { dir } = tempHome()
    for (const event of [openT, openA, { op: 'current', ref: A }]) appendRequestEvent(CONN, event, { dir })
    let state = readRequestState(CONN, { dir })
    assert.equal(requestFinished(state, A, new Set()), false, 'unanswered: kept open at Stop')
    assert.equal(requestFinished(state, T, new Set()), false, 'the prompt never reached this turn')
    for (const event of [{ op: 'current', ref: T }, { op: 'joined', id: UNSTATED }]) appendRequestEvent(CONN, event, { dir })
    state = readRequestState(CONN, { dir })
    assert.deepEqual(selectableRequests(state).map((entry) => entry.id), [T, UNSTATED, A])
    assert.equal(serveMain(['--connection-id', CONN, '--message-id', MSG_A], { dir }).ok, true)
    assert.equal(requestRefForWrite(readRequestState(CONN, { dir })), A)
    assert.deepEqual(markCommandsAnswered(CONN, { dir }), [A])
    state = readRequestState(CONN, { dir })
    assert.equal(requestFinished(state, A, new Set()), true)
    assert.equal(requestFinished(state, A, new Set([A])), false, 'not while its work still runs')
    assert.deepEqual(markCommandsAnswered(CONN, { dir }), [], 'answered once')
    assert.equal(selectableRequests(state).some((entry) => entry.id === A), true, 'still carried this turn')
  })

  it('an unknown turn clears the current request instead of keeping the last one', () => {
    const { dir } = tempHome()
    appendRequestEvent(CONN, openA, { dir })
    setCurrentRequest(CONN, A, { dir })
    setCurrentRequest(CONN, UNSTATED, { dir })
    assert.equal(requestRefForWrite(readRequestState(CONN, { dir })), null)
  })
})

describe('stamping a DevSpec write', () => {
  function homeWith(...events) {
    const { home, dir } = tempHome()
    for (const event of events) appendRequestEvent(CONN, event, { dir })
    return home
  }

  it('stamps the request and provenance the turn serves, and nothing when nothing is known', () => {
    const home = homeWith(openA, { op: 'current', ref: A })
    assert.deepEqual(stampRequest('record_memory', { title: 'x' }, CONN, null, { home }), {
      args: { title: 'x', request_ref: A },
    })
    assert.deepEqual(stampRequest('create_task', { title: 'x' }, CONN, null, { home, includeProvenance: true }), {
      args: { title: 'x', provenance_ref: DELIVERY_A, request_ref: A },
    })
    assert.deepEqual(stampRequest('record_memory', { title: 'x' }, CONN, null, { home: homeWith() }), {
      args: { title: 'x' },
    })
  })

  it('stamps nobody\'s request as none, so DevSpec records the agent\'s own initiative', () => {
    const home = homeWith({ op: 'current', ref: NO_REQUEST })
    assert.equal(stampRequest('update_task', {}, CONN, null, { home }).args.request_ref, NO_REQUEST)
  })

  it('never lets the model state attribution: a request_ref it wrote is replaced by the host\'s, or dropped', () => {
    const home = homeWith(openA, openB, { op: 'current', ref: A })
    assert.deepEqual(stampRequest('record_memory', { request_ref: B }, CONN, null, { home }), {
      args: { request_ref: A },
    })
    assert.deepEqual(stampRequest('record_memory', { request_ref: NO_REQUEST }, CONN, null, { home: homeWith() }), { args: {} })
    const undecided = homeWith(openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B })
    assert.ok(stampRequest('record_memory', { request_ref: NO_REQUEST }, CONN, null, { home: undecided }).deny)
    assert.deepEqual(stampRequest('heartbeat_connection', {}, CONN, null, { home }), { args: {} })
    assert.deepEqual(stampRequest('report_request', {}, CONN, null, { home }), { args: {} })
  })

  it('refuses a write that could serve two people\'s requests, with the command that names one', () => {
    const home = homeWith(openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B })
    const refused = stampRequest('record_implementation', {}, CONN, null, { home })
    assert.match(refused.deny, /more than one request, and they would be recorded differently/)
    assert.match(refused.deny, new RegExp(`requests\\.mjs" serve --connection-id ${CONN}`))
    assert.match(refused.deny, new RegExp(`--message-id ${MSG_A}`))
    assert.match(refused.deny, new RegExp(`--message-id ${MSG_B}`))
  })

  it('never refuses a read, or a write that already cites its work or command', () => {
    const home = homeWith(openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B })
    assert.ok(stampRequest('get_task', {}, CONN, null, { home }).args)
    assert.ok(stampRequest('record_implementation', { work_claim_ref: 'x' }, CONN, null, { home }).args)
    assert.ok(stampRequest('update_task', { provenance_ref: DELIVERY_B }, CONN, null, { home }).args)
  })

  it('covers the DevSpec tools that take a request or provenance', () => {
    assert.equal(REQUEST_REF_TOOLS.size, 35)
    assert.equal(PROVENANCE_REF_TOOLS.has('reserve_work_items'), true)
    assert.equal(PROVENANCE_REF_TOOLS.has('claim_work_item'), true)
    for (const name of ['post_session_message', 'reserve_work_items', 'claim_work_item', 'report_request']) {
      assert.equal(REQUEST_REF_TOOLS.has(name), false, name)
    }
  })
})

describe('what reaches a running turn joins it', () => {
  const fixedId = () => T

  it('a second person\'s command delivered mid-turn joins it, and writes are refused until the agent names one', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }))
    const { events } = promptArrival({ origin: 'task-notification', text: wakeFor(MSG_B), midTurn: true, state })
    assert.deepEqual(events, [{ op: 'joined', id: B }])
    const after = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }, ...events))
    assert.equal(after.current, A, 'the turn still serves Ali\'s command')
    assert.deepEqual(turnAmbiguity(after).map((entry) => entry.id), [A, B])
  })

  it('the same delivered as a new turn starts from it', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }))
    assert.deepEqual(promptArrival({ origin: 'task-notification', text: wakeFor(MSG_B), midTurn: false, state }).events, [{ op: 'current', ref: B }])
  })

  it('a prompt typed over a running turn joins it as the owner\'s typed request', () => {
    const state = reduceRequestLog(log(openB, { op: 'current', ref: B }))
    assert.deepEqual(promptArrival({ fromAPerson: true, midTurn: true, state, newId: fixedId }), { events: [{ op: 'joined', id: T }], typedId: T })
    assert.deepEqual(promptArrival({ fromAPerson: true, midTurn: false, state, newId: fixedId }), { events: [{ op: 'current', ref: T }], typedId: T })
  })

  it('an automation run, or something not known, delivered mid-turn makes the turn undecided', () => {
    const state = reduceRequestLog(log(openA, { op: 'current', ref: A }))
    const run = promptArrival({ origin: 'task-notification', text: '<event>{"type":"automation_run"}</event>', midTurn: true, state })
    assert.deepEqual(run.events, [{ op: 'joined', id: NO_REQUEST }])
    assert.deepEqual(turnAmbiguity(reduceRequestLog(log(openA, { op: 'current', ref: A }, ...run.events))).map((entry) => entry.kind), ['command', 'none'])
    const peer = promptArrival({ origin: 'peer', text: 'hi', midTurn: true, state })
    assert.deepEqual(peer.events, [{ op: 'joined', id: UNSTATED }])
  })

  it('a new turn from a prompt nothing here knows starts unstated, never as the last turn\'s request', () => {
    const state = reduceRequestLog(log(openB, { op: 'current', ref: B }))
    const { events } = promptArrival({ origin: 'channel', text: 'from telegram', midTurn: false, state })
    assert.deepEqual(events, [{ op: 'current', ref: null }])
    assert.equal(requestRefForWrite(reduceRequestLog(log(openB, { op: 'current', ref: B }, ...events))), null)
  })

  it('marks the jobs a wake reports as notified', () => {
    const state = reduceRequestLog(log(openT, { op: 'launch', key: 'job', kind: 'shell', notifies: true, request: T, also: [] }))
    assert.deepEqual(promptArrival({ origin: 'task-notification', text: notification('job'), midTurn: false, state }).events,
      [{ op: 'current', ref: T }, { op: 'notified', key: 'job' }])
  })
})

describe('closing requests at a Stop', () => {
  it('never counts a command the poller opened ahead of its wake as started', () => {
    const state = reduceRequestLog(log(openA, openB, { op: 'current', ref: A }))
    assert.deepEqual([...state.started], [A])
  })

  it('records a close only once DevSpec has it, or has no such request', async () => {
    const { dir } = tempHome()
    appendRequestEvent(CONN, openA, { dir })
    assert.equal(await closeRequest({ connectionId: CONN, requestId: A, call: async () => { throw new Error('timeout') }, dir }), false)
    assert.ok(readRequestState(CONN, { dir }).open.has(A), 'retried at the next Stop')
    assert.ok(await closeRequest({ connectionId: CONN, requestId: A, call: async () => { throw new Error('Request refused: unknown request for this connection') }, dir }))
    assert.equal(readRequestState(CONN, { dir }).open.has(A), false)
  })

  it('lets a job that never notifies go once the host has left it off its list at two Stops', () => {
    const launched = [openA, { op: 'launch', key: 'stopped', kind: 'shell', notifies: true, request: A, also: [] }]
    const first = reduceRequestLog(log(...launched))
    assert.ok(requestsWithWorkPending(first, { backgroundTasks: [] }).has(A), 'its notification may still be on its way')
    assert.deepEqual(absentLaunches(first, []), ['stopped'])
    const second = reduceRequestLog(log(...launched, { op: 'absent', key: 'stopped' }))
    assert.equal(requestsWithWorkPending(second, { backgroundTasks: [] }).has(A), false)
    assert.ok(requestsWithWorkPending(second, { backgroundTasks: null }).has(A), 'a host that sends no list never closes it')
  })

  it('finds a cron by its id, and a long prompt by what the host kept of it', () => {
    const long = 'x'.repeat(1500)
    const state = reduceRequestLog(log(openA, openB,
      { op: 'schedule', prompt: 'renamed', id: 'cron1', request: A, also: [] },
      { op: 'schedule', prompt: long, id: null, request: B, also: [] }))
    const pending = requestsWithWorkPending(state, { sessionCrons: [{ id: 'cron1', prompt: 'something else' }, { prompt: long.slice(0, 1000) }] })
    assert.deepEqual([...pending].sort(), [A, B].sort())
  })

  it('starts the log afresh when it has grown and nothing is open, keeping nobody\'s launches', () => {
    const { dir } = tempHome()
    appendRequestEvent(CONN, { op: 'launch', key: 'own', kind: 'shell', notifies: true, request: NO_REQUEST, also: [] }, { dir })
    appendRequestEvent(CONN, openA, { dir })
    assert.equal(rotateRequestLog(CONN, { dir, minBytes: 1 }), false, 'not while a request is open')
    appendRequestEvent(CONN, { op: 'close', id: A }, { dir })
    assert.equal(rotateRequestLog(CONN, { dir, minBytes: 1 }), true)
    const state = readRequestState(CONN, { dir })
    assert.equal(state.launches.get('own').request, NO_REQUEST)
    assert.equal(state.open.size, 0)
  })
})

describe('starting background work in an undecided turn', () => {
  function sessionHome(...events) {
    const { home, dir } = tempHome()
    for (const event of events) appendRequestEvent(CONN, event, { dir })
    fs.writeFileSync(path.join(dir, `${CONN}.json`), JSON.stringify({ connection_id: CONN, local_id: 'conv-1', enabled: true, agent_name: 'Cursor' }), { mode: 0o600 })
    return home
  }
  const undecided = [openA, openB, { op: 'current', ref: A }, { op: 'joined', id: B }]

  it('is refused until the agent names the request it is for, so nothing is launched under a guess', () => {
    const home = sessionHome(...undecided)
    const env = { CURSOR_CONVERSATION_ID: 'conv-1' }
    const refused = launchGuard({ conversation_id: 'conv-1', tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }, { home, env })
    assert.equal(refused.permission, 'deny')
    assert.equal(refused.hookSpecificOutput?.permissionDecision, 'deny')
    assert.match(refused.user_message, /--message-id/)
    for (const call of [{ tool_name: 'Workflow', tool_input: {} }, { tool_name: 'CronCreate', tool_input: { prompt: 'p' } }]) {
      assert.equal(launchGuard({ conversation_id: 'conv-1', ...call }, { home, env }).permission, 'deny', call.tool_name)
    }
  })

  it('lets everything else through: a foreground command, the DevSpec listener, or a decided turn', () => {
    const env = { CURSOR_CONVERSATION_ID: 'conv-1' }
    const home = sessionHome(...undecided)
    assert.deepEqual(launchGuard({ conversation_id: 'conv-1', tool_name: 'Bash', tool_input: { command: 'ls' } }, { home, env }), {})
    assert.deepEqual(launchGuard({ conversation_id: 'conv-1', tool_name: 'Monitor', tool_input: { command: 'node /x/devspec-remote-wait.mjs --stream' } }, { home, env }), {})
    const decided = sessionHome(...undecided, { op: 'serve', ref: B })
    assert.deepEqual(launchGuard({ conversation_id: 'conv-1', tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }, { home: decided, env }), {})
  })
})

describe('offering nobody\'s request', () => {
  it('is offered only when no teammate\'s request is open; otherwise "could not identify" stands in for it', () => {
    const own = reduceRequestLog(log(openT, { op: 'current', ref: T }, { op: 'joined', id: NO_REQUEST }))
    assert.ok(turnAmbiguity(own) === null || turnAmbiguity(own).some((entry) => entry.kind === 'none'))
    const withTeammate = reduceRequestLog(log(openT, openB, { op: 'current', ref: B }, { op: 'joined', id: NO_REQUEST }))
    const offered = servableCarried(withTeammate, turnAmbiguity(withTeammate))
    assert.deepEqual(offered.map((entry) => entry.kind), ['command', 'unstated'])
    const { dir } = tempHome()
    for (const event of [openT, openB, { op: 'current', ref: B }, { op: 'joined', id: NO_REQUEST }]) appendRequestEvent(CONN, event, { dir })
    assert.match(serveMain(['--connection-id', CONN, '--none'], { dir }).error, /not one of the requests/)
    assert.equal(serveMain(['--connection-id', CONN, '--unstated'], { dir }).ok, true)
    assert.equal(requestRefForWrite(readRequestState(CONN, { dir })), null)
  })
})
