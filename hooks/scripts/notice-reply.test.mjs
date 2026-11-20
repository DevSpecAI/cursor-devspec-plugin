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
 * - Stop never posts the final message of a turn only notices and check jobs woke as a
 *   reply (item 140a7f68), and such a turn posts no trail; it posts that message, as an
 *   ordinary message, only when a write in the turn carried DevSpec's tell_person mark
 *   and the model told nobody itself;
 * - a notice DevSpec labels for the record (system_notice_version 3, item a868f41f)
 *   gets no reply from any of these.
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
  NOTICE_HANDLING,
  parseWakeBatches,
} from './devspec-remote-wait.mjs'
import { appendWakeEvents } from './devspec-wake-file.mjs'
import { handleExplicitReply } from './mark-explicit-reply.mjs'
import { explicitReplyMarkerPath, turnMarkerPath, writeTurnMarker } from './mirror-turn.mjs'
import { CursorMcpRefusal } from './mcp-call.mjs'
import { persistConnectionCapability } from './manage-plan-bridge.mjs'
import {
  currentTurnNoticeIds,
  currentTurnOwnsNoCommand,
  FOR_THE_RECORD_HANDLING,
  FOR_THE_RECORD_WAKE,
  lastAssistantText,
  leaveTellPersonNote,
  noticeReplyCall,
  noticeReplyInstruction,
  normalizeNoticeIds,
  postTellPersonAtStop,
  readTurnWakes,
  recordNoticeReply,
  recordPromptWake,
  recordTellPerson,
  recordTurnWake,
  resultCarriesTellPerson,
  takeTellPersonNotes,
  tellPersonNotePath,
  tellPersonNoteText,
  tellPersonPost,
  turnWakeFromEvents,
  turnWakeFromText,
  turnWakesPath,
} from './notice-reply.mjs'
import { projectInput } from './project-input.mjs'
import { selectProjectContext } from './project-context.mjs'
import { canonicalAcceptanceKey } from './remote-ingress-v1.mjs'
import {
  FIXTURE_ID,
  fixtureServerNotice,
  fixtureSystemNoticeEnvelope,
  fixtureUnlinkedCommitNotice,
} from './remote-ingress-test-fixtures.mjs'
import { appendRequestEvent, readRequestState } from './requests.mjs'
import { CURSOR_HOOK_CONTEXT_MAX_CHARS, POST_TOOL_CONTEXT_SHARE, readNoteText } from './hook-context-budget.mjs'
import { catCall, noteFiles, noteIdIn, readCall } from '../../tests/helpers/note-reads.mjs'

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

const OTHER_TASK = 'b2222222-2222-4222-8222-222222222222'
const STORED = 'e3333333-3333-4333-8333-333333333333'
/** The connection's own capability, as the state file holds it. */
const CAPABILITY = 'dvsc_fixture_capability'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** DevSpec's receipt for a post its speech lane stored. */
const storedSpeech = (args) => ({
  connection_id: args.connection_id,
  session_id: ROOM,
  message_id: STORED,
  phase: 'answer',
  assistant_source_id: args.assistant_source_id,
  delivery: { status: 'stored', message_id: STORED },
})

/**
 * A DevSpec write's result as Cursor hands it to afterMCPExecution (`result_json`):
 * the write's own answer, then DevSpec's tell_person mark appended as its own block.
 */
function markedResult({ why = 'changed_someone_elses_record', isError = false } = {}) {
  return JSON.stringify({
    content: [
      { type: 'text', text: JSON.stringify({ success: true, task: { id: OTHER_TASK, lifecycle: 'dismissed' } }) },
      {
        type: 'text',
        text: JSON.stringify({
          tell_person: {
            why,
            record: { type: 'task', id: OTHER_TASK },
            owner: 'someone_else',
            instruction: 'This changed a record that is not the requester\'s own, so tell the person you are working for what you changed.',
          },
        }),
      },
    ],
    ...(isError ? { isError: true } : {}),
  })
}

function noticeBatch(...ids) {
  return labelledBatch(ids.map((id) => [id]))
}

/** A notice wake as DevSpec sends it at system_notice_version 3: `[id, audience]` pairs. */
function labelledBatch(pairs) {
  const ids = pairs.map(([id]) => id)
  const envelope = fixtureSystemNoticeEnvelope({
    wakeKind: 'system_notice',
    commands: [],
    systemNotices: pairs.map(([id, audience], i) =>
      fixtureServerNotice({ notice_id: id, summary: `Notice ${i + 1}`, ...(audience ? { audience } : {}) })),
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

  it('is never posted as a reply, and goes out as the agent\'s own message only for a tell_person write the model told nobody about', async () => {
    const file = transcript([user('wake'), say('Closed the duplicate task Brandon filed.'), { type: 'turn_ended', status: 'completed' }])
    const posts = []
    const stop = (input = {}, extra = {}) => postTellPersonAtStop({
      raw: JSON.stringify({ status: 'completed', transcript_path: file, ...input }),
      connectionId: CONN,
      sessionId: ROOM,
      connectionCapability: CAPABILITY,
      agentName: 'Cursor',
      dir,
      post: async (args, options) => {
        posts.push({ args, options })
        return storedSpeech(args)
      },
      ...extra,
    })

    // Settled quietly: no write asked the agent to tell anyone.
    noticeTurn(NOTICE_A)
    assert.equal(await stop(), null, 'a notice the model left unanswered is not answered for it')
    assert.equal(posts.length, 0)

    recordTellPerson(CONN, { dir })
    assert.equal(await stop({}, { sessionId: null }), null, 'no room: the person already has it in the terminal')
    assert.equal(await stop({ status: 'aborted' }), null, 'a stopped turn\'s last words are not an answer')
    assert.equal(await stop({}, { told: true }), null, 'the model already told the room itself')
    assert.equal(posts.length, 0)

    assert.equal(await stop(), 'posted')
    const [told, ...more] = posts
    assert.equal(more.length, 0)
    assert.deepEqual(told.options, { connectionCapability: CAPABILITY })
    assert.match(told.args.assistant_source_id, UUID_V4)
    assert.deepEqual(told.args, tellPersonPost({
      connectionId: CONN,
      text: 'Closed the duplicate task Brandon filed.',
      agentName: 'Cursor',
      sourceId: told.args.assistant_source_id,
    }))
    for (const key of [...TURN_ONLY, 'system_notice_ids', 'local_turn', 'command_turn_unbound', 'command_message_id']) {
      assert.equal(told.args[key], undefined, key)
    }

    // The model replied to the notice itself: nothing more from Stop.
    scratchHome()
    posts.length = 0
    noticeTurn(NOTICE_A)
    recordTellPerson(CONN, { dir })
    recordNoticeReply(CONN, { dir })
    assert.equal(await stop(), null)

    // A command's turn tells the person in its own answer.
    scratchHome()
    commandTurn()
    recordTellPerson(CONN, { dir })
    assert.equal(await stop(), null)
    assert.equal(posts.length, 0)
  })

  it('a turn only a check job woke tells the person about a tell_person write, too', async () => {
    const file = transcript([user('wake'), say('Ruling the check closed another person\'s task.'), { type: 'turn_ended', status: 'completed' }])
    const posts = []
    recordTurnWake(CONN, { checkJobIds: [NOTICE_B] }, { dir, newTurn: true })
    appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })
    const stop = () => postTellPersonAtStop({
      raw: JSON.stringify({ status: 'completed', transcript_path: file }),
      connectionId: CONN,
      sessionId: ROOM,
      connectionCapability: CAPABILITY,
      dir,
      post: async (args) => {
        posts.push(args)
        return storedSpeech(args)
      },
    })
    assert.equal(await stop(), null)
    recordTellPerson(CONN, { dir })
    assert.equal(await stop(), 'posted')
    assert.equal(posts[0].message, 'Ruling the check closed another person\'s task.')
    assert.equal(posts[0].ingest_version, 2)
    assert.equal(posts[0].system_notice_ids, undefined)
  })

  it('a message that cannot be posted is logged and left for the next turn, whatever stopped it', async () => {
    const file = transcript([user('wake'), say('Closed the duplicate task Brandon filed.'), { type: 'turn_ended', status: 'completed' }])
    const logged = []
    let calls = 0
    const stop = (extra) => postTellPersonAtStop({
      raw: JSON.stringify({ status: 'completed', transcript_path: file }),
      connectionId: CONN,
      sessionId: ROOM,
      connectionCapability: CAPABILITY,
      agentName: 'Cursor',
      dir,
      log: (event) => logged.push(event),
      ...extra,
    })
    const turn = () => {
      noticeTurn(NOTICE_A)
      recordTellPerson(CONN, { dir })
    }

    // DevSpec refuses it, with a structured answer.
    turn()
    const receipt = { delivery: { status: 'rejected', reason: 'not_attached', retryable: false }, error: 'Your connection is not attached to a room.' }
    const refusal = new CursorMcpRefusal(JSON.stringify(receipt), receipt)
    assert.equal(await stop({ post: async () => { calls++; throw refusal } }), 'left_for_next_turn')
    // DevSpec answers without storing it.
    turn()
    assert.equal(await stop({ post: async () => { calls++; return { delivery: { status: 'skipped', reason: 'no_unanswered_dispatch', retryable: false } } } }), 'left_for_next_turn')
    // No capability on this computer: nothing is sent at all.
    turn()
    assert.equal(await stop({ connectionCapability: null, post: async () => { calls++ } }), 'left_for_next_turn')
    assert.equal(calls, 2, 'each post tried once, and none without the capability it needs')

    assert.deepEqual(logged.map((event) => [event.phase, event.outcome, event.reason, event.connectionId]), [
      ['mirror_post', 'failed', 'tell_person_not_posted', CONN],
      ['mirror_post', 'failed', 'tell_person_not_posted', CONN],
      ['mirror_post', 'failed', 'tell_person_not_posted', CONN],
    ])
    assert.ok(logged.every((event) => !JSON.stringify(event).includes('Closed the duplicate')), 'no message body in the log')
    // DevSpec's structured answer is kept as it gave it, never flattened into a sentence.
    assert.deepEqual(logged.map((event) => event.data.refusal.details), [
      receipt,
      { delivery: { status: 'skipped', reason: 'no_unanswered_dispatch', retryable: false } },
      { reason: 'no_connection_capability' },
    ])

    // Every one is kept, with its refusal, and handed over once.
    const notes = takeTellPersonNotes(CONN, { dir })
    assert.deepEqual(notes.map((note) => note.text), Array(3).fill('Closed the duplicate task Brandon filed.'))
    assert.deepEqual(notes.map((note) => note.refusal), logged.map((event) => event.data.refusal))
    assert.deepEqual(takeTellPersonNotes(CONN, { dir }), [])
    const text = tellPersonNoteText(notes)
    assert.match(text, /tell-person command/)
    assert.equal(text.split('Closed the duplicate task Brandon filed.').length - 1, 3)
    assert.ok(text.includes(JSON.stringify(notes[0].refusal, null, 2)), 'the structured answer, as data')
    assert.match(text, /"reason": "not_attached"/)
    assert.equal(tellPersonNoteText([]), null)
  })

  it('hands the message over whole in a note, offered after every step until the agent reads it', async () => {
    // The hook as Cursor runs it, in this conversation's home.
    const postToolUse = (call = { tool_name: 'Shell', tool_input: { command: 'ls' } }) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, 'mark-explicit-reply.mjs'), 'postToolUse'], {
        env: { PATH: process.env.PATH, HOME: home, CURSOR_CONVERSATION_ID: CONVERSATION },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.on('error', reject)
      child.on('close', () => resolve(stdout))
      child.stdin.end(JSON.stringify({ ...call, conversation_id: CONVERSATION }))
    })
    // Longer than this hook's share of Cursor's ceiling, which other hooks on the same
    // step share: a note Cursor dropped would leave no trace.
    const long = `Closed these duplicates: ${'a task Brandon filed; '.repeat(150)}done.`
    assert.ok(long.length > POST_TOOL_CONTEXT_SHARE && long.length < CURSOR_HOOK_CONTEXT_MAX_CHARS)
    leaveTellPersonNote(CONN, { text: long, refusal: { message: null, details: { delivery: { status: 'skipped', reason: 'not_attached' } } }, dir })
    const out = JSON.parse(await postToolUse())
    assert.ok(out.additional_context.length <= POST_TOOL_CONTEXT_SHARE, 'a pointer, not the message')
    const id = noteIdIn(out.additional_context)
    const file = path.join(home, '.devspec', 'notes', `${id}.md`)
    assert.ok(readNoteText(id, { home }).includes(long), 'the whole message is in the note')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)

    // Printed but not seen read: offered again, since Cursor may have dropped it.
    assert.equal(JSON.parse(await postToolUse()).additional_context, out.additional_context)
    // A second message while the first is unread joins it in one note.
    leaveTellPersonNote(CONN, { text: 'Also reopened the task Brandon closed.', dir })
    const joined = noteIdIn(JSON.parse(await postToolUse()).additional_context)
    const both = readNoteText(joined, { home })
    assert.ok(both.includes(long) && both.includes('Also reopened the task Brandon closed.'))
    // Only mentioning the note is not reading it.
    assert.ok(await postToolUse({ tool_name: 'Shell', tool_input: { command: `test -e ~/.devspec/notes/${joined}.md` }, tool_output: JSON.stringify({ output: '', exitCode: 0 }) }))
    // Read whole, by Cursor's Read tool: no more pointers.
    assert.equal(await postToolUse(readCall(noteFiles(home, joined)[0])), '')
    assert.equal(await postToolUse(), '')
  })
})

describe("DevSpec's tell_person mark on a write", () => {
  beforeEach(scratchHome)

  it('is read only from the block DevSpec appends to an applied write', () => {
    assert.equal(resultCarriesTellPerson(markedResult()), true)
    assert.equal(resultCarriesTellPerson(JSON.parse(markedResult({ why: 'task_blocked' }))), true, 'the parsed result too')
    assert.equal(resultCarriesTellPerson(markedResult({ isError: true })), false, 'a refused write changed nothing')
    // A record whose own text mentions the word is not the mark.
    const mention = { content: [{ type: 'text', text: JSON.stringify({ success: true, description: 'Read "tell_person" on a write result.' }) }] }
    assert.equal(resultCarriesTellPerson(mention), false)
    assert.equal(resultCarriesTellPerson({ content: [{ type: 'text', text: '{"tell_person":"yes"}' }] }), false)
    assert.equal(resultCarriesTellPerson(''), false, 'Cursor withholds a large result as empty text')
    assert.equal(resultCarriesTellPerson(undefined), false)
  })

  it('is noted on the turn only when a turn something woke is open', () => {
    assert.equal(recordTellPerson(CONN, { dir }), false, 'no turn record: nothing to note it on')
    noticeTurn(NOTICE_A)
    assert.equal(recordTellPerson(CONN, { dir }), true)
    const first = readTurnWakes(CONN, { dir }).tellPersonAt
    assert.equal(typeof first, 'number')
    recordTurnWake(CONN, { noticeIds: [NOTICE_B] }, { dir })
    assert.equal(readTurnWakes(CONN, { dir }).tellPersonAt, first, 'a notice folded in mid-turn keeps it')
    recordPromptWake(CONN, { fromAPerson: true, text: 'next thing', dir })
    assert.equal(readTurnWakes(CONN, { dir }).tellPersonAt, undefined, 'a new turn starts without it')
  })
})

// The hooks as Cursor runs them: real processes, a real state file, a stub server.
describe('Stop and the trail in a notice-only turn, end to end', () => {
  let server
  let url
  let calls = []

  const OK = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, turn_effect: 'none' }) }] })
  /** How the stub answers each call: every call succeeds unless a test says otherwise. */
  let respond = OK
  const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true })

  /**
   * DevSpec's answers to a post from an attached connection with no turn open, which
   * is what a wake of notices or check jobs leaves (post_session_message as served):
   * an ordinary connection post joins the open turn, so it is refused; a notice reply
   * naming only for-the-record notices is refused; the speech lane (assistant_source_id
   * with ingest_version 2 and the connection's capability) lands outside any turn.
   */
  const noOpenTurn = (call) => {
    const { name, args, capability } = call
    if (name !== 'post_session_message') return OK()
    if (args.system_notice_ids !== undefined) {
      return refuse(JSON.stringify({ delivery: { status: 'rejected', reason: 'for_the_record', retryable: false } }))
    }
    if (args.assistant_source_id !== undefined) {
      if (args.ingest_version !== 2 || capability !== CAPABILITY || args.connection_id !== CONN) {
        return refuse('Assistant speech delivery rejected; original source was not relabelled.')
      }
      return { content: [{ type: 'text', text: JSON.stringify(storedSpeech(args)) }] }
    }
    if (args.connection_id) return refuse('Connection-native answer/error requires an exact open activity attempt.')
    return OK()
  }

  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const rpc = JSON.parse(body)
        const call = { name: rpc.params?.name, args: rpc.params?.arguments ?? {}, capability: req.headers['x-devspec-connection-capability'] ?? null }
        calls.push(call)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: respond(call) }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/api/mcp`
  })
  after(() => server.close())

  beforeEach(() => {
    scratchHome()
    bond({ token: 'dvs_test', mcp_url: url, connection_capability: CAPABILITY })
    calls = []
    respond = OK
  })

  /** A hook run as Cursor runs it; resolves with what it printed. */
  function run(script, mode, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, script), mode], {
        env: { PATH: process.env.PATH, HOME: home, CURSOR_CONVERSATION_ID: CONVERSATION },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify({ conversation_id: CONVERSATION, ...input }))
    })
  }
  const posts = () => calls.filter((call) => call.name === 'post_session_message')

  /** The agent transcript Stop reads the turn's final message from. */
  function transcriptOf(prompt, finalText) {
    const file = path.join(home, 'agent-transcript.jsonl')
    fs.writeFileSync(file, [
      { role: 'user', message: { content: [{ type: 'text', text: prompt }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Checking the finding.' }, { type: 'tool_use', name: 'Shell', input: {} }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: finalText }] } },
      { type: 'turn_ended', status: 'completed' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    return file
  }

  /** A DevSpec write the model makes, as afterMCPExecution hands it to the hook. */
  const afterWrite = (result_json) => run('mark-explicit-reply.mjs', 'afterMCPExecution', {
    hook_event_name: 'afterMCPExecution',
    mcp_server_name: 'devspec',
    tool_name: 'devspec__resolve_duplicate',
    tool_input: JSON.stringify({ action: 'resolve', duplicate: { type: 'task', id: OTHER_TASK } }),
    result_json,
  })

  it('Stop posts nothing for a notice turn the model settled without posting: never its terminal notes', async () => {
    const prompt = notificationText(buildOwnerMessageEvents(noticeBatch(NOTICE_A, NOTICE_B)), home)
    await run('mirror-turn.mjs', 'user_prompt', { prompt })
    assert.deepEqual(readTurnWakes(CONN, { dir }).noticeIds, [NOTICE_A, NOTICE_B])
    // A DevSpec read that carries no mark changes nothing.
    await afterWrite(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ success: true }) }] }))

    const file = transcriptOf(prompt, 'Settled in place from what was agreed; finishing quietly per the notice rules (f7d6a637).')
    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: file })

    assert.deepEqual(posts(), [], 'the terminal notes of a quiet notice turn never reach the room')
    assert.equal(fs.existsSync(turnWakesPath(CONN, dir)), false, 'the turn is forgotten once it ends')
  })

  it('Stop posts no second copy after the model replied to a notice itself, nor anything for a command turn', async () => {
    const prompt = notificationText(buildOwnerMessageEvents(noticeBatch(NOTICE_A)), home)
    await run('mirror-turn.mjs', 'user_prompt', { prompt })
    const reply = prePost({ message: 'This clashes with the release decision: keep it, or change the decision?' })
    assert.deepEqual(reply.system_notice_ids, [NOTICE_A], 'the model\'s own post is the notice reply')
    await afterWrite(markedResult())
    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: transcriptOf(prompt, 'Posted the reply.') })
    assert.equal(posts().length, 0)

    await run('mirror-turn.mjs', 'user_prompt', { prompt: notificationText(COMMAND_EVENTS, home) })
    await afterWrite(markedResult())
    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: transcriptOf('Fix the flaky test', 'Fixed.') })
    assert.equal(posts().length, 0, 'a command\'s turn tells the person in its own answer')
  })

  it('as a backstop, Stop posts the final message as the agent\'s own message when a write carried tell_person and the agent told nobody', async () => {
    respond = noOpenTurn
    const prompt = notificationText(buildOwnerMessageEvents(labelledBatch([[NOTICE_B, 'for_the_record']])), home)
    await run('mirror-turn.mjs', 'user_prompt', { prompt })
    await afterWrite(markedResult())
    assert.equal(typeof readTurnWakes(CONN, { dir }).tellPersonAt, 'number', 'the hook noted the mark on the turn')

    const stop = await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: transcriptOf(prompt, 'I closed Brandon\'s duplicate of my task.') })
    const [told, ...more] = posts()
    assert.ok(told, 'Stop told the room')
    assert.equal(more.length, 0, 'one post, and no fallback to a shape DevSpec refuses')
    assert.equal(told.capability, CAPABILITY, 'sent with the connection\'s own capability')
    const { assistant_source_id: sourceId, ...rest } = told.args
    assert.match(sourceId, UUID_V4)
    assert.deepEqual(rest, {
      connection_id: CONN,
      ingest_version: 2,
      message: 'I closed Brandon\'s duplicate of my task.',
      phase: 'answer',
      complete_turn: false,
      agent_name: 'Cursor',
    })
    assert.doesNotMatch(stop.stderr, /tell_person_not_posted/, 'nothing failed')
    assert.equal(fs.existsSync(tellPersonNotePath(CONN, dir)), false, 'nothing left over')

    // The model told the person itself, in an ordinary post: Stop adds nothing.
    calls = []
    await run('mirror-turn.mjs', 'user_prompt', { prompt })
    await afterWrite(markedResult())
    const own = { connection_id: CONN, message: 'I closed Brandon\'s duplicate of my task.' }
    assert.equal(prePost(own).system_notice_ids, undefined, 'a for-the-record turn stamps nothing')
    await run('mark-explicit-reply.mjs', 'afterMCPExecution', { mcp_server_name: 'devspec', tool_name: 'devspec__post_session_message', tool_input: own })
    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: transcriptOf(prompt, 'Told them.') })
    assert.equal(posts().length, 0)
  })

  it('the agent tells its person itself with tell-person, though no turn is open, and the backstop posts no second copy', async () => {
    respond = noOpenTurn
    // The bond and capability the plugin writes on connect, which the command reads.
    const remoteRoot = path.join(home, '.devspec', 'remote-control')
    fs.mkdirSync(path.join(remoteRoot, 'local', 'cursor'), { recursive: true })
    fs.writeFileSync(path.join(remoteRoot, 'local', 'cursor', `${CONVERSATION}.json`), JSON.stringify({
      connection_id: CONN, local_id: CONVERSATION, agent_name: 'Cursor', session_id: ROOM, status: 'live',
    }))
    persistConnectionCapability({ connectionId: CONN, localId: CONVERSATION, capability: CAPABILITY }, { root: remoteRoot })

    const prompt = notificationText(buildOwnerMessageEvents(labelledBatch([[NOTICE_B, 'for_the_record']])), home)
    await run('mirror-turn.mjs', 'user_prompt', { prompt })
    await afterWrite(markedResult())

    // The agent's own post, the way the skill has it run the command.
    const message = 'I closed Brandon\'s duplicate of my task.'
    const told = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, 'remote-control-state.mjs'), 'tell-person'], {
        env: { PATH: process.env.PATH, HOME: home, CURSOR_CONVERSATION_ID: CONVERSATION },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout }))
      child.stdin.end(JSON.stringify({ message }))
    })
    assert.equal(told.code, 0, told.stdout)
    assert.equal(JSON.parse(told.stdout).result.delivery.status, 'stored')
    assert.equal(posts().length, 1)
    assert.equal(posts()[0].capability, CAPABILITY)
    assert.equal(posts()[0].args.ingest_version, 2)
    assert.equal(posts()[0].args.message, message)

    await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: transcriptOf(prompt, 'Told them.') })
    assert.equal(posts().length, 1, 'the backstop saw the person was told')
    assert.equal(fs.existsSync(tellPersonNotePath(CONN, dir)), false)
  })

  it('a refused post is logged and handed to the agent at its next tool call, never dropped', async () => {
    respond = (call) => (call.name === 'post_session_message'
      ? refuse('Assistant speech delivery rejected; original source was not relabelled.')
      : OK())
    const prompt = notificationText(buildOwnerMessageEvents(labelledBatch([[NOTICE_B, 'for_the_record']])), home)
    await run('mirror-turn.mjs', 'user_prompt', { prompt })
    await afterWrite(markedResult())
    const finalText = 'I closed Brandon\'s duplicate of my task.'
    const stop = await run('mirror-turn.mjs', 'stop', { status: 'completed', transcript_path: transcriptOf(prompt, finalText) })
    assert.equal(posts().length, 1, 'tried once, and never in a shape DevSpec refuses outright')

    // Logged, with DevSpec's reason and never the message itself.
    const story = stop.stderr.split('\n').filter((line) => line.startsWith('story ')).map((line) => JSON.parse(line.slice(6)))
    const failed = story.find((event) => event.reason === 'tell_person_not_posted')
    assert.ok(failed, stop.stderr)
    assert.equal(failed.phase, 'mirror_post')
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.connectionId, CONN)
    assert.match(failed.refusal.message, /Assistant speech delivery rejected/)
    assert.ok(!stop.stderr.includes(finalText), 'no message body in the log')

    // Kept for the next turn: not on an afterMCPExecution, nor for a subagent's call...
    const toolCall = { tool_name: 'Shell', tool_input: { command: 'git status' }, tool_output: 'clean' }
    assert.equal((await run('mark-explicit-reply.mjs', 'afterMCPExecution', { mcp_server_name: 'devspec', tool_name: 'devspec__get_task', result_json: '{}' })).stdout, '')
    assert.equal((await run('mark-explicit-reply.mjs', 'postToolUse', { ...toolCall, agent_id: 'sub-1' })).stdout, '')
    assert.equal(fs.existsSync(tellPersonNotePath(CONN, dir)), true)

    // ...and handed over at the conversation's next tool call, as a note it is offered until it reads.
    const next = await run('mark-explicit-reply.mjs', 'postToolUse', toolCall)
    const out = JSON.parse(next.stdout)
    assert.equal(out.hookSpecificOutput.additionalContext, out.additional_context)
    const id = noteIdIn(out.additional_context)
    const note = readNoteText(id, { home })
    assert.ok(note.includes(finalText), 'the message the person has not heard')
    assert.match(note, /Assistant speech delivery rejected/, 'and why it was not posted')
    assert.match(note, /semantics\.notice_audience\.telling_anyway/)
    assert.equal(JSON.parse((await run('mark-explicit-reply.mjs', 'postToolUse', toolCall)).stdout).additional_context, out.additional_context, 'offered again until read')
    const { conversation_id: _, ...cat } = catCall(home, noteFiles(home, id)[0])
    assert.equal((await run('mark-explicit-reply.mjs', 'postToolUse', cat)).stdout, '', 'read whole by `cat`, so done')
    assert.equal((await run('mark-explicit-reply.mjs', 'postToolUse', toolCall)).stdout, '')
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

// DevSpec labels every notice at system_notice_version 3 (item a868f41f): only the
// ones that need a person are given a reply, and the model posts it.
describe('notices DevSpec labels for the record', () => {
  /** A turn started by Cursor's notification of a labelled wake, as the prompt hook records it. */
  function labelledTurn(pairs) {
    const text = notificationText(buildOwnerMessageEvents(labelledBatch(pairs)), home)
    appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })
    recordPromptWake(CONN, { text, dir })
    return text
  }

  beforeEach(scratchHome)

  it('a notice that needs a person ends with its reply; one for the record ends with no reply and points at the rules', () => {
    const [needs, quiet, wake] = buildOwnerMessageEvents(labelledBatch([[NOTICE_A, 'needs_person'], [NOTICE_B, 'for_the_record']]))
    assert.equal(needs.audience, 'needs_person')
    assert.ok(needs.notice_reply.includes(`["${NOTICE_A}"]`))
    assert.ok(needs.content.includes(NOTICE_HANDLING))
    assert.ok(needs.content.includes(noticeReplyInstruction([NOTICE_A], { connectionId: CONN })))

    assert.equal(quiet.audience, 'for_the_record')
    assert.equal(quiet.notice_reply, undefined, 'nothing to copy into a post')
    assert.ok(quiet.content.includes(FOR_THE_RECORD_HANDLING))
    assert.ok(!quiet.content.includes(NOTICE_HANDLING), 'none of the telling-the-person handling')
    assert.ok(!quiet.content.includes('system_notice_ids'), 'no reply call')
    assert.match(FOR_THE_RECORD_HANDLING, /semantics\.notice_audience in devspec:\/\/product\/remote-ingress-contract/)
    assert.match(FOR_THE_RECORD_HANDLING, /tell_person/)
    // A cut-short preview still shows the label.
    const line = JSON.stringify(quiet)
    assert.ok(line.indexOf('"audience"') < 160)

    assert.deepEqual(wake.system_notice_ids, [NOTICE_A, NOTICE_B])
    assert.deepEqual(wake.for_the_record_notice_ids, [NOTICE_B])
    assert.ok(wake.notice_reply.includes(`system_notice_ids: ["${NOTICE_A}"] })`), 'the batch reply names only the notice that needs a person')
    assert.ok(!wake.notice_reply.includes(NOTICE_B))

    const [, onlyWake] = buildOwnerMessageEvents(labelledBatch([[NOTICE_B, 'for_the_record']]))
    assert.equal(onlyWake.notice_reply, FOR_THE_RECORD_WAKE)
    assert.deepEqual(onlyWake.for_the_record_notice_ids, [NOTICE_B])
  })

  it('an unlinked-commit review and an unreadable kind labelled for the record get no reply either', () => {
    const unlinked = formatSystemNoticeContent(fixtureUnlinkedCommitNotice({ notice_id: NOTICE_B, audience: 'for_the_record' }), { connectionId: CONN })
    assert.ok(unlinked.includes(FOR_THE_RECORD_HANDLING))
    assert.ok(!unlinked.includes('system_notice_ids'))
    assert.ok(!unlinked.includes(NOTICE_HANDLING))
    const unreadable = formatSystemNoticeContent(
      { version: 1, kind: 'future_notice_kind', notice_id: NOTICE_B, contract_uri: 'devspec://product/remote-ingress-contract', audience: 'for_the_record' },
      { connectionId: CONN },
    )
    assert.ok(unreadable.includes(FOR_THE_RECORD_HANDLING))
    assert.doesNotMatch(unreadable, /Tell the person/)
    assert.ok(!unreadable.includes('system_notice_ids'))
  })

  it('the turn record keeps which notices are for the record, from events, from the lines Cursor shows, even cut short', () => {
    const events = buildOwnerMessageEvents(labelledBatch([[NOTICE_A, 'needs_person'], [NOTICE_B, 'for_the_record']]))
    const expected = { noticeIds: [NOTICE_A, NOTICE_B], forTheRecordIds: [NOTICE_B] }
    assert.deepEqual(turnWakeFromEvents(events), expected)
    const text = notificationText(events, home)
    assert.deepEqual(turnWakeFromText(text), expected)
    const cut = text.split('\n').map((line) => line.slice(0, 160)).join('\n')
    assert.deepEqual(turnWakeFromText(cut), expected)
    // A label never names a notice the wake did not deliver.
    assert.deepEqual(
      turnWakeFromEvents([{ type: 'wake', reason: 'exact_connection_system_notice', system_notice_ids: [NOTICE_A], for_the_record_notice_ids: [NOTICE_B] }]),
      { noticeIds: [NOTICE_A] },
    )
  })

  it('a prompt that lost a label keeps the one the wait script recorded on delivery', () => {
    recordTurnWake(CONN, { noticeIds: [NOTICE_B], forTheRecordIds: [NOTICE_B] }, { dir, newTurn: true })
    // The notification shows the notice without its label (an older line shape, or cut short).
    recordPromptWake(CONN, { text: `{"type":"system_notice","notice_id":"${NOTICE_B}"}`, dir })
    assert.deepEqual(readTurnWakes(CONN, { dir }).forTheRecordIds, [NOTICE_B])
    // A different notice in the next turn is not labelled by the old record.
    recordPromptWake(CONN, { text: `{"type":"system_notice","notice_id":"${NOTICE_A}"}`, dir })
    assert.equal(readTurnWakes(CONN, { dir }).forTheRecordIds, undefined)
  })

  it('a turn only for-the-record notices woke stamps nothing on a post, yet still owns no command', () => {
    labelledTurn([[NOTICE_B, 'for_the_record']])
    assert.equal(currentTurnNoticeIds(CONN, { dir }), null)
    assert.equal(currentTurnOwnsNoCommand(CONN, { dir }), true, 'its work is still kept out of the room\'s trail')
    // Telling the person what changed in someone else's record (tell_person) is an
    // ordinary message, which DevSpec would refuse if it named the notice.
    const sent = prePost({ message: 'I closed Brandon\'s duplicate task while tidying mine.' })
    assert.equal(sent.system_notice_ids, undefined)
    assert.equal(readTurnWakes(CONN, { dir }).noticeReplyAt, undefined)
  })

  it('a turn with both stamps only the notice that needs a person', () => {
    labelledTurn([[NOTICE_A, 'needs_person'], [NOTICE_B, 'for_the_record']])
    assert.deepEqual(currentTurnNoticeIds(CONN, { dir }), [NOTICE_A])
    assert.deepEqual(prePost({ message: 'This clashes with the release decision.' }).system_notice_ids, [NOTICE_A])
  })

  it('Stop replies to none of them, in a for-the-record turn or a mixed one', async () => {
    const file = path.join(home, 'agent-transcript.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Linked the commit.' }] } })}\n`)
    const posts = []
    const stop = () => postTellPersonAtStop({
      raw: JSON.stringify({ status: 'completed', transcript_path: file }),
      connectionId: CONN,
      sessionId: ROOM,
      dir,
      post: async (args) => posts.push(args),
    })
    labelledTurn([[NOTICE_B, 'for_the_record']])
    assert.equal(await stop(), null)

    scratchHome()
    labelledTurn([[NOTICE_A, 'needs_person'], [NOTICE_B, 'for_the_record']])
    assert.equal(await stop(), null, 'the notice that needs a person is the model\'s to answer')
    assert.equal(posts.length, 0)
  })
})
