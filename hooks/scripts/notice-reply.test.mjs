#!/usr/bin/env node
/**
 * The Cursor agent's answer to a DevSpec notice reaches the room as a reply to that
 * notice, never as an answer to a command (item 5f8fe76a; server item 8885423d).
 * Run: node --test hooks/scripts/notice-reply.test.mjs
 *
 * These run the real code over a real connection directory:
 * - the wake hands the model the exact call with the exact ids, for one notice and
 *   for a batch;
 * - the wait script and the prompt hook record what woke the turn;
 * - preToolUse stamps the turn's notices only when every wake of the turn was a
 *   notice, turns string-shaped ids into the array DevSpec takes, always names the
 *   connection, and never gives a notice reply local-turn flags;
 * - a notice reply never completes a turn or answers a command, even with complete_turn;
 * - Stop ends a notice-only turn with a notice reply, and such a turn posts no trail.
 * The hooks run as Cursor runs them: real processes against a stub DevSpec server.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  applyArmTurnSemantics,
  buildOwnerMessageEvents,
  formatSystemNoticeContent,
  parseWakeBatches,
} from './devspec-remote-wait.mjs'
import { appendWakeEvents } from './devspec-wake-file.mjs'
import { handleExplicitReply } from './mark-explicit-reply.mjs'
import { explicitReplyMarkerPath, turnMarkerPath, writeTurnMarker } from './mirror-turn.mjs'
import {
  currentTurnNoticeIds,
  lastAssistantText,
  noticeReplyCall,
  noticeReplyInstruction,
  normalizeNoticeIds,
  postNoticeTurnReply,
  readTurnWakes,
  recordNoticeReply,
  recordPromptWake,
  recordTurnWake,
  turnWakeFromEvents,
  turnWakeFromText,
  turnWakesPath,
} from './notice-reply.mjs'
import { projectInput } from './project-input.mjs'
import { selectProjectContext } from './project-context.mjs'
import { canonicalAcceptanceKey } from './remote-ingress-v1.mjs'
import { FIXTURE_ID, fixtureServerNotice, fixtureSystemNoticeEnvelope } from './remote-ingress-test-fixtures.mjs'
import { appendRequestEvent, readRequestState } from './requests.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONN = FIXTURE_ID.connection
const ROOM = '44444444-4444-4444-8444-444444444444'
const NOTICE_A = 'f7d6a637-bb5a-4bcc-98ee-354e5f309a6b'
const NOTICE_B = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const REQ = 'f1111111-1111-4111-8111-111111111111'
const TYPED = 'f2222222-2222-4222-8222-222222222222'
const PROV = 'c1111111-1111-4111-8111-111111111111'
const MSG = 'd1111111-1111-4111-8111-111111111111'
const ALI = 'a1111111-1111-4111-8111-111111111111'
const CONVERSATION = 'cursor-conversation-5f8fe76a'
const ENDPOINT = 'https://fixture.invalid/api/mcp?tool_namespace=devspec'
const PROJECT = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Fixture',
  organization: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Org' },
}

/** Fields a notice reply never carries: they belong to a turn, and DevSpec refuses them. */
const TURN_ONLY = ['work_trail', 'trail_events', 'command_turn_id', 'reply_to_message_id', 'session_id']

function noticeBatch(...ids) {
  const envelope = fixtureSystemNoticeEnvelope({
    wakeKind: 'system_notice',
    commands: [],
    systemNotices: ids.map((id, i) => fixtureServerNotice({ notice_id: id, summary: `Notice ${i + 1}` })),
  })
  return {
    type: 'canonical_system_notices',
    connection_id: CONN,
    session_id: ROOM,
    execute_notice_ids: ids,
    acceptance_key: canonicalAcceptanceKey(envelope),
    ingress: { canonical: true, envelope },
    messages: envelope.system_notices,
  }
}

const COMMAND_EVENTS = [
  { type: 'owner_message', message_id: MSG, body: 'Fix the flaky test', session_id: ROOM },
  { type: 'wake', reason: 'canonical_conversational_command', session_id: ROOM, count: 1 },
]

/** The lines the wake file holds, as Cursor's notification shows them to the model. */
function notificationText(events, home) {
  const file = path.join(home, `wake-${Math.random().toString(36).slice(2)}.jsonl`)
  appendWakeEvents(file, events)
  return `<task-notification>\nBackground shell output:\n${fs.readFileSync(file, 'utf8')}</task-notification>`
}

let home
let dir

function bond(extra = {}) {
  fs.writeFileSync(
    path.join(dir, `${CONN}.json`),
    JSON.stringify({ connection_id: CONN, enabled: true, agent_name: 'Cursor', local_id: CONVERSATION, session_id: ROOM, ...extra }),
    { mode: 0o600 },
  )
}

function scratchHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-notice-reply-'))
  dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { devspec: { url: ENDPOINT } } }))
  selectProjectContext(CONVERSATION, ENDPOINT, PROJECT, 'explicit', home)
  bond()
}

/** preToolUse on a DevSpec post, the way Cursor runs it. Returns the call as it goes out. */
function prePost(args) {
  const out = projectInput(
    'pre',
    { conversation_id: CONVERSATION, cwd: home, tool_name: 'MCP:devspec__post_session_message', tool_input: args },
    { home },
  )
  assert.notEqual(out?.permission, 'deny', out?.agent_message)
  return { ...args, ...(out?.updated_input ?? {}) }
}

/** A turn started by Cursor's notification of a notice wake, as the prompt hook records it. */
function noticeTurn(...ids) {
  const text = notificationText(buildOwnerMessageEvents(noticeBatch(...ids)), home)
  appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })
  recordPromptWake(CONN, { text, dir })
}

/** A room command being worked: opened as a request and current, its wake recorded. */
function commandTurn() {
  appendRequestEvent(CONN, { op: 'open', id: REQ, kind: 'command', message_id: MSG, provenance_ref: PROV, requested_by: ALI }, { dir })
  appendRequestEvent(CONN, { op: 'current', ref: REQ }, { dir })
  recordPromptWake(CONN, { text: notificationText(COMMAND_EVENTS, home), dir })
}

describe('the wake hands the model the exact call with the exact ids', () => {
  it('ends each notice with the reply naming its own id, and the wake with one reply for the batch', () => {
    const [parsed] = parseWakeBatches([JSON.stringify(noticeBatch(NOTICE_A, NOTICE_B))], { canonicalOnly: true, connectionId: CONN })
    assert.ok(parsed, 'the batch is a valid notice wake')
    const events = buildOwnerMessageEvents(parsed)
    const [first, second, wake] = events

    const callA = `post_session_message({ connection_id: "${CONN}", message, system_notice_ids: ["${NOTICE_A}"] })`
    assert.equal(first.notice_reply, callA)
    assert.equal(noticeReplyCall([NOTICE_A], { connectionId: CONN }), callA)
    assert.ok(first.content.includes(noticeReplyInstruction([NOTICE_A], { connectionId: CONN })))
    assert.ok(!first.content.includes(NOTICE_B), 'a notice names only its own id')
    assert.ok(second.notice_reply.includes(`["${NOTICE_B}"]`))

    // Short previews still show it: the call comes before the notice's records.
    const line = JSON.stringify(first)
    assert.ok(line.indexOf('"notice_reply"') < line.indexOf('"records"'))

    assert.equal(wake.type, 'wake')
    assert.ok(wake.notice_reply.includes(`system_notice_ids: ["${NOTICE_A}","${NOTICE_B}"]`))
    assert.match(wake.notice_reply, /One reply can answer all of these notices; name only the notices it answers/)
  })

  it('says what a notice reply is, where the rules are, and what to do with no room', () => {
    const content = buildOwnerMessageEvents(noticeBatch(NOTICE_A))[0].content
    assert.match(content, /never as an answer to a command/)
    assert.match(content, /complete_turn has no effect on it, and a command you are working on still needs its own answer/)
    assert.match(content, /when you are attached to no room, tell the person here in the terminal instead/)
    assert.match(content, /semantics\.notice_reply in devspec:\/\/product\/remote-ingress-contract/)
    assert.doesNotMatch(content, /complete_turn:\s*true/)
  })

  it('gives a notice of a kind this plugin cannot read the same reply', () => {
    const content = formatSystemNoticeContent(
      { version: 1, kind: 'future_notice_kind', notice_id: NOTICE_A, contract_uri: 'devspec://product/remote-ingress-contract' },
      { connectionId: CONN },
    )
    assert.ok(content.includes(`system_notice_ids: ["${NOTICE_A}"]`))
  })
})

describe('what woke the turn', () => {
  beforeEach(scratchHome)

  it('reads notice ids from wake events, and anything else as another wake', () => {
    assert.deepEqual(turnWakeFromEvents(buildOwnerMessageEvents(noticeBatch(NOTICE_A, NOTICE_B))), { noticeIds: [NOTICE_A, NOTICE_B] })
    assert.deepEqual(turnWakeFromEvents(COMMAND_EVENTS), { otherWake: true })
    assert.deepEqual(turnWakeFromEvents([{ type: 'question_answer', question_id: MSG }]), { otherWake: true })
    assert.equal(turnWakeFromEvents([{ type: 'room_unread', unread: 2 }]), null)
  })

  it('reads the lines Cursor shows the model, even cut short', () => {
    const events = buildOwnerMessageEvents(noticeBatch(NOTICE_A, NOTICE_B))
    const text = notificationText(events, home)
    assert.deepEqual(turnWakeFromText(text), { noticeIds: [NOTICE_A, NOTICE_B] })
    const cut = text.split('\n').map((line) => line.slice(0, 160)).join('\n')
    assert.deepEqual(turnWakeFromText(cut), { noticeIds: [NOTICE_A, NOTICE_B] })
    assert.deepEqual(turnWakeFromText(notificationText(COMMAND_EVENTS, home)), { otherWake: true })
    assert.equal(turnWakeFromText('Please tidy the README'), null)
  })

  it('starts a turn from its wake, folds in what arrives mid-turn, and keeps a delivery a bare notification points at', () => {
    recordPromptWake(CONN, { text: notificationText(buildOwnerMessageEvents(noticeBatch(NOTICE_A)), home), dir })
    assert.deepEqual(readTurnWakes(CONN, { dir }).noticeIds, [NOTICE_A])

    recordPromptWake(CONN, { text: 'Background shell finished.', midTurn: true, dir })
    assert.equal(readTurnWakes(CONN, { dir }).otherWake, true, 'a mid-turn prompt that is not a notice')

    recordPromptWake(CONN, { fromAPerson: true, text: 'what about the README?', dir })
    const typed = readTurnWakes(CONN, { dir })
    assert.deepEqual([typed.noticeIds, typed.otherWake], [[], true], 'a person\'s prompt starts a turn that is no notice turn')

    // The wait script recorded a notice it delivered; Cursor's notification only points at it.
    recordTurnWake(CONN, { noticeIds: [NOTICE_B] }, { dir, newTurn: true })
    recordPromptWake(CONN, { text: 'Background shell produced output.', dir })
    assert.deepEqual(readTurnWakes(CONN, { dir }).noticeIds, [NOTICE_B])
  })

  it('the wait script records each delivery, and an arm that ends the turn forgets the last turn', async () => {
    const waitDir = path.join(home, 'wait-connections')
    fs.mkdirSync(waitDir, { recursive: true })
    recordTurnWake(CONN, { otherWake: true }, { dir: waitDir })
    fs.writeFileSync(path.join(waitDir, `${CONN}.inbox.jsonl`), `${JSON.stringify(noticeBatch(NOTICE_A))}\n`)
    const { code, stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(HERE, 'devspec-remote-wait.mjs'), '--connection-id', CONN, '--pending', '--after-reply', '--poll-ms', '20'],
        { env: { PATH: process.env.PATH, HOME: home, DEVSPEC_REMOTE_CONNECTIONS_DIR: waitDir }, cwd: home },
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      const timer = setTimeout(() => { child.kill(); reject(new Error(`wait timed out: ${err}`)) }, 20_000)
      child.on('close', (exit) => { clearTimeout(timer); resolve({ code: exit, stdout: out, stderr: err }) })
    })
    assert.equal(code, 0, stderr)
    assert.match(stdout, new RegExp(`"notice_reply":"post_session_message\\(\\{ connection_id: \\\\"${CONN}\\\\"`))
    const record = readTurnWakes(CONN, { dir: waitDir })
    assert.deepEqual(record.noticeIds, [NOTICE_A])
    assert.equal(record.otherWake, false, 'the ended turn\'s command no longer counts')

    assert.equal(applyArmTurnSemantics(CONN, { fromEnd: true }, waitDir), true)
    assert.equal(fs.existsSync(turnWakesPath(CONN, waitDir)), false)
  })
})

describe('preToolUse in a turn woken only by notices', () => {
  beforeEach(scratchHome)

  it('stamps every notice of the wake on a plain post, with the connection and no turn fields', () => {
    noticeTurn(NOTICE_A, NOTICE_B)
    assert.deepEqual(currentTurnNoticeIds(CONN, { dir }), [NOTICE_A, NOTICE_B])
    const sent = prePost({ message: 'Merged; it is on staging.', complete_turn: true })
    assert.deepEqual(sent.system_notice_ids, [NOTICE_A, NOTICE_B])
    assert.equal(sent.connection_id, CONN)
    assert.equal(sent.local_turn, undefined)
    assert.equal(sent.command_turn_unbound, undefined)
    for (const key of TURN_ONLY) assert.equal(sent[key], undefined, `${key} must not ride on a notice reply`)
    assert.equal(typeof readTurnWakes(CONN, { dir }).noticeReplyAt, 'number', 'Stop will not post a second reply')
  })

  it('leaves a post aimed at a room message alone', () => {
    noticeTurn(NOTICE_A)
    const sent = prePost({ message: 'Answering you.', reply_to_message_id: MSG })
    assert.equal(sent.system_notice_ids, undefined)
  })

  it('stamps nothing once a person or a command has joined the turn', () => {
    noticeTurn(NOTICE_A)
    recordPromptWake(CONN, { fromAPerson: true, text: 'and fix the README', midTurn: true, dir })
    assert.equal(prePost({ message: 'Done.' }).system_notice_ids, undefined)

    noticeTurn(NOTICE_A)
    appendRequestEvent(CONN, { op: 'open', id: REQ, kind: 'command', message_id: MSG, provenance_ref: PROV, requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'joined', id: REQ }, { dir })
    assert.equal(currentTurnNoticeIds(CONN, { dir }), null)
  })
})

describe('a notice that arrives while a command is being worked', () => {
  beforeEach(scratchHome)

  it('never stamps the command answer; the model replies to the notice with the ids it was shown', () => {
    commandTurn()
    recordTurnWake(CONN, turnWakeFromEvents(buildOwnerMessageEvents(noticeBatch(NOTICE_A))), { dir })
    assert.equal(currentTurnNoticeIds(CONN, { dir }), null)

    const answer = prePost({ message: 'Your request is done.', complete_turn: true })
    assert.equal(answer.system_notice_ids, undefined, 'the command answer is never a notice reply')

    // A chat whose tool list predates system_notice_ids sends the array as text, and
    // names its room rather than its connection.
    const reply = prePost({ message: 'Heads up: a finding on your work.', session_id: ROOM, system_notice_ids: `["${NOTICE_A}"]` })
    assert.deepEqual(reply.system_notice_ids, [NOTICE_A])
    assert.equal(reply.connection_id, CONN, 'a notice reply always names the connection')
    assert.equal(reply.local_turn, undefined)
  })

  it('a notice reply, even with complete_turn, leaves the command open and Working', async () => {
    const connDir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
    const conn = 'e5f8fe76-0000-4000-8000-000000000001'
    const cleanup = () => {
      for (const file of [turnMarkerPath(conn), explicitReplyMarkerPath(conn), path.join(connDir, `${conn}.requests.jsonl`), turnWakesPath(conn, connDir)]) {
        fs.rmSync(file, { force: true })
      }
    }
    cleanup()
    try {
      appendRequestEvent(conn, { op: 'open', id: REQ, kind: 'command', message_id: MSG, provenance_ref: PROV, requested_by: ALI }, { dir: connDir })
      appendRequestEvent(conn, { op: 'current', ref: REQ }, { dir: connDir })
      writeTurnMarker(conn)

      const noticeReply = { connection_id: conn, message: 'A finding on your work.', system_notice_ids: [NOTICE_A], complete_turn: true }
      assert.equal(await handleExplicitReply({ tool_name: 'devspec__post_session_message', tool_input: noticeReply }, {}, { dir: connDir }), false)
      assert.equal(fs.existsSync(turnMarkerPath(conn)), true, 'the command still shows Working')
      assert.equal(fs.existsSync(explicitReplyMarkerPath(conn)), false, 'it is not the turn\'s reply')
      assert.equal(readRequestState(conn, { dir: connDir }).open.get(REQ).answered, undefined, 'the command is not answered')

      const answer = { connection_id: conn, message: 'Your request is done.', complete_turn: true }
      assert.equal(await handleExplicitReply({ tool_name: 'devspec__post_session_message', tool_input: answer }, {}, { dir: connDir }), true)
      assert.equal(fs.existsSync(turnMarkerPath(conn)), false)
      assert.equal(readRequestState(conn, { dir: connDir }).open.get(REQ).answered, true)
    } finally {
      cleanup()
    }
  })

  it('in a turn typed at the terminal, a notice reply carries none of its local-turn flags', () => {
    bond({ local_turn: { attempt_id: TYPED, session_id: ROOM } })
    appendRequestEvent(CONN, { op: 'open', id: TYPED, kind: 'typed_prompt', requested_by: ALI }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: TYPED }, { dir })
    recordPromptWake(CONN, { fromAPerson: true, text: 'Tidy the README please', dir })

    const answer = prePost({ message: 'README tidied.' })
    assert.equal(answer.local_turn, true, 'the typed turn\'s own answer keeps its flags')
    assert.equal(answer.command_turn_unbound, true)

    // The rules for a typed turn say to pass these on every post; DevSpec refuses them here.
    const reply = prePost({ message: 'About that notice.', system_notice_ids: [NOTICE_A], local_turn: true, command_turn_unbound: true })
    assert.deepEqual(reply.system_notice_ids, [NOTICE_A])
    assert.equal(reply.local_turn, false)
    assert.equal(reply.command_turn_unbound, false)
  })

  it('a conversation with no connection still sends string ids as the list DevSpec takes', () => {
    fs.rmSync(path.join(dir, `${CONN}.json`))
    const out = projectInput(
      'pre',
      { conversation_id: CONVERSATION, cwd: home, tool_name: 'MCP:devspec__post_session_message', tool_input: { message: 'm', system_notice_ids: `${NOTICE_A}, ${NOTICE_B}` } },
      { home },
    )
    assert.deepEqual(out.updated_input.system_notice_ids, [NOTICE_A, NOTICE_B])
  })
})

describe('normalizeNoticeIds changes shape only', () => {
  it('reads the string forms a stale tool list produces and leaves anything else for DevSpec to refuse', () => {
    assert.deepEqual(normalizeNoticeIds(`["${NOTICE_A}","${NOTICE_B}"]`), [NOTICE_A, NOTICE_B])
    assert.deepEqual(normalizeNoticeIds(NOTICE_A), [NOTICE_A])
    assert.deepEqual(normalizeNoticeIds(`${NOTICE_A}, ${NOTICE_B}`), [NOTICE_A, NOTICE_B])
    assert.deepEqual(normalizeNoticeIds(`[${NOTICE_A}]`), [NOTICE_A])
    assert.deepEqual(normalizeNoticeIds([NOTICE_A, NOTICE_A]), [NOTICE_A], 'DevSpec refuses a repeated id')
    assert.equal(normalizeNoticeIds('the last one'), 'the last one')
    assert.deepEqual(normalizeNoticeIds([NOTICE_A, 'nope']), [NOTICE_A, 'nope'])
    assert.equal(normalizeNoticeIds(7), 7)
  })
})

describe('the final message of a notice-only turn', () => {
  beforeEach(scratchHome)

  function transcript(rows) {
    const file = path.join(home, 'agent-transcript.jsonl')
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    return file
  }
  const say = (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
  const tool = (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Shell', input: {} }] } })
  const user = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })

  it('is the last words of this turn, never a tool call and never an earlier turn', () => {
    assert.equal(
      lastAssistantText(transcript([user('earlier'), say('Earlier answer.'), { type: 'turn_ended', status: 'completed' }, user('wake'), tool('Checking.'), say('Merged; it is on staging.'), { type: 'turn_ended', status: 'completed' }])),
      'Merged; it is on staging.',
    )
    assert.equal(lastAssistantText(transcript([say('Earlier answer.'), { type: 'turn_ended', status: 'completed' }, tool('Checking.'), { type: 'turn_ended', status: 'completed' }])), null)
    assert.equal(lastAssistantText(transcript([say('Earlier answer.'), user('wake'), { type: 'turn_ended', status: 'completed' }])), null)
    assert.equal(lastAssistantText(path.join(home, 'missing.jsonl')), null)
  })

  it('is posted only for a completed notice-only turn in a room, and only once', async () => {
    const file = transcript([user('wake'), say('Merged; it is on staging.'), { type: 'turn_ended', status: 'completed' }])
    const posts = []
    const stop = (input, extra = {}) => postNoticeTurnReply({
      raw: JSON.stringify({ status: 'completed', transcript_path: file, ...input }),
      connectionId: CONN,
      sessionId: ROOM,
      agentName: 'Cursor',
      dir,
      post: async (args) => posts.push(args),
      ...extra,
    })

    noticeTurn(NOTICE_A)
    assert.equal(await stop({}, { sessionId: null }), null, 'no room: the person already has it in the terminal')
    assert.equal(await stop({ status: 'aborted' }), null, 'a stopped turn\'s last words are not an answer')
    commandTurn()
    assert.equal(await stop({}), null, 'a command turn ends with its own answer')
    assert.equal(posts.length, 0)

    scratchHome()
    noticeTurn(NOTICE_A)
    recordNoticeReply(CONN, { dir })
    assert.equal(await stop({}), null, 'the model already replied')
  })
})

// The hooks as Cursor runs them: real processes, a real state file, a stub server.
describe('Stop and the trail in a notice-only turn, end to end', () => {
  let server
  let url
  let calls = []

  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const rpc = JSON.parse(body)
        calls.push({ name: rpc.params?.name, args: rpc.params?.arguments ?? {} })
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, turn_effect: 'none' }) }] } }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/api/mcp`
  })
  after(() => server.close())

  beforeEach(() => {
    scratchHome()
    bond({ token: 'dvs_test', mcp_url: url })
    calls = []
  })

  function run(script, mode, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, script), mode], {
        env: { PATH: process.env.PATH, HOME: home, CURSOR_CONVERSATION_ID: CONVERSATION },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.on('error', reject)
      child.on('exit', resolve)
      child.stdin.end(JSON.stringify({ conversation_id: CONVERSATION, ...input }))
    })
  }
  const posts = () => calls.filter((call) => call.name === 'post_session_message')

  it('Stop posts the final message as one reply to every notice of the wake, bound to no turn', async () => {
    const prompt = notificationText(buildOwnerMessageEvents(noticeBatch(NOTICE_A, NOTICE_B)), home)
    await run('mirror-turn.mjs', 'user_prompt', { prompt })
    assert.deepEqual(readTurnWakes(CONN, { dir }).noticeIds, [NOTICE_A, NOTICE_B])

    const file = path.join(home, 'agent-transcript.jsonl')
    fs.writeFileSync(file, [
      { role: 'user', message: { content: [{ type: 'text', text: prompt }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Merging.' }, { type: 'tool_use', name: 'Shell', input: {} }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Merged; the work is on staging.' }] } },
      { type: 'turn_ended', status: 'completed' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: file })

    const [reply, ...more] = posts()
    assert.ok(reply, 'Stop posted the final message')
    assert.equal(more.length, 0)
    assert.deepEqual(reply.args.system_notice_ids, [NOTICE_A, NOTICE_B])
    assert.equal(reply.args.connection_id, CONN)
    assert.equal(reply.args.message, 'Merged; the work is on staging.')
    for (const key of [...TURN_ONLY, 'complete_turn', 'local_turn', 'command_turn_unbound', 'phase']) {
      assert.equal(reply.args[key], undefined, key)
    }
    assert.equal(fs.existsSync(turnWakesPath(CONN, dir)), false, 'the turn is forgotten once it ends')
  })

  it('Stop posts nothing more after the model replied, and nothing for a command turn', async () => {
    await run('mirror-turn.mjs', 'user_prompt', { prompt: notificationText(buildOwnerMessageEvents(noticeBatch(NOTICE_A)), home) })
    prePost({ message: 'Merged.' })
    const file = path.join(home, 'agent-transcript.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Posted the reply.' }] } })}\n`)
    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: file })
    assert.equal(posts().length, 0)

    await run('mirror-turn.mjs', 'user_prompt', { prompt: notificationText(COMMAND_EVENTS, home) })
    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: file })
    assert.equal(posts().length, 0)
  })

  it('a notice-only turn posts no trail, which DevSpec would file under someone\'s command', async () => {
    // A command's turn held open for its background work is still marked running.
    fs.writeFileSync(path.join(dir, `${CONN}.turn`), JSON.stringify({ startedAt: Date.now(), held: true }))
    const toolCall = { tool_name: 'Shell', tool_input: { command: 'git merge' }, tool_output: 'merged' }

    await run('mirror-turn.mjs', 'user_prompt', { prompt: notificationText(buildOwnerMessageEvents(noticeBatch(NOTICE_A)), home) })
    await run('trail-turn.mjs', 'postToolUse', toolCall)
    assert.equal(posts().length, 0)

    // The same tool call in a command's turn grows its trail.
    await run('mirror-turn.mjs', 'user_prompt', { prompt: notificationText(COMMAND_EVENTS, home) })
    await run('trail-turn.mjs', 'postToolUse', toolCall)
    assert.equal(posts()[0]?.args.phase, 'trail')
  })
})
