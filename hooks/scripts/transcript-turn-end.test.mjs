#!/usr/bin/env node
/**
 * Item cdf020cc: Cursor runs the plugin's end-of-turn (stop) hook only when the person
 * has a hooks file of their own, so the poller notices a turn's end in Cursor's
 * transcript and reports it the way the stop hook would: the commands the turn
 * finished, an error or a stop in Cursor's own words, and Working cleared. When the
 * stop hook does run, each turn end is reported once, whichever sees it first. A line
 * the plugin does not recognise, or the end of a turn that was already running when the
 * tracked one started, is never reported.
 *
 * The end-to-end tests run the real poller and the real stop hook against a stub
 * DevSpec that refuses its push stream, so the poller holds short polls.
 * Run: node --test hooks/scripts/transcript-turn-end.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPushStreamRequest, refusePushStream } from './fixtures/push-stream.mjs'
import { FIXTURE_ID, fixtureCommand, fixtureEnvelope, fixtureOrder, fixtureUuid } from './remote-ingress-test-fixtures.mjs'
import { resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'
import { trailWatchPidPath } from './cli-trail-watch.mjs'
import { lastTurnError } from './turn-failure.mjs'
import {
  claimTurnEnd,
  lastTurnEnd,
  readTranscriptTurns,
  readTurnBaseline,
  recordTurnBaseline,
  releaseTurnEnd,
  transcriptTurnEnd,
  turnEndClaimed,
  turnEndIdentity,
  turnEndPending,
} from './transcript-turn-end.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONNECTION = FIXTURE_ID.connection
const CONVERSATION = 'c0ffee00-cdf0-4020-8c00-000000000001'
const SESSION = fixtureUuid(900)
const REQUEST = fixtureUuid(901)
const COMMAND = { turnId: FIXTURE_ID.turn, messageId: FIXTURE_ID.message }

// What Cursor CLI wrote for an account at its usage limit (CLI 2026.10.19, 2026-10-31).
const LIMIT = "You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more."

// Rows as Cursor's CLI writes them (2026.11.05 bundle; transcripts on the measuring machine).
const user = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })
const answer = (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
const tool = (name, input) => ({ role: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
const ended = (status, error) => ({ type: 'turn_ended', status, ...(error ? { error } : {}) })
// A turn Cursor starts when a background task's output arrives, as the wake for a room command does.
const WAKE = user('<timestamp>Friday, Nov 20, 2026, 7:00 PM (UTC)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>')
// How a turn end names the user row that started its turn.
const rowDigest = (row) => crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16)
const identity = (turns, row) => `${CONVERSATION}#${turns}#${rowDigest(row)}`
// Cursor's error text when it is longer than the 64 KiB the transcript used to be read
// back by, and still well inside the room's 100,000-character message.
const LONG_ERROR = `Provider returned an error: ${'request context too large; '.repeat(2_700)}end of error.`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(25)
  return condition()
}

/** Write a transcript whole, as Cursor rewrites it. Strings are written as given. */
function writeTranscript(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n')
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-turn-end-'))
  return { dir, transcript: path.join(dir, 'projects', 'app', 'agent-transcripts', CONVERSATION, `${CONVERSATION}.jsonl`) }
}

describe('reading the transcript', () => {
  it('counts the user rows, a background-task wake among them, and reads the final turn end', () => {
    const { dir, transcript } = scratch()
    try {
      // A tool input holding a user-role object is the assistant's row, not a user row.
      writeTranscript(transcript, [user('fix the test'), tool('Write', { messages: [{ role: 'user', text: 'x' }] }), WAKE, answer('Done.'), ended('error', LIMIT)])
      assert.deepEqual(readTranscriptTurns(transcript), { turns: 2, lastUser: rowDigest(WAKE), end: { status: 'error', error: LIMIT } })
      assert.equal(turnEndIdentity(transcript), identity(2, WAKE))

      writeTranscript(transcript, [user('fix the test'), answer('Working on it.')])
      assert.deepEqual(readTranscriptTurns(transcript), { turns: 1, lastUser: rowDigest(user('fix the test')), end: null }, 'a turn still running has no end')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never reads a half-written or empty transcript, and says when there is none yet', () => {
    const { dir, transcript } = scratch()
    try {
      fs.mkdirSync(path.dirname(transcript), { recursive: true })
      fs.writeFileSync(transcript, `${JSON.stringify(user('hi'))}\n{"type":"turn_ended","sta`)
      assert.equal(readTranscriptTurns(transcript, { attempts: 1 }), null)
      fs.writeFileSync(transcript, '')
      assert.equal(readTranscriptTurns(transcript, { attempts: 1 }), null, 'Cursor caught between truncating and writing')
      assert.deepEqual(readTranscriptTurns(path.join(dir, 'none.jsonl')), { missing: true })
      assert.equal(turnEndIdentity(path.join(dir, 'none.jsonl')), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('which turn a turn end belongs to', () => {
  const marker = { startedAt: 1_000 }
  const decide = (dir, transcript) => transcriptTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: transcript, dir })

  it('reports the end of the turn that started after the baseline: a run, an error, a stop', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, [user('connect'), answer('Connected.'), ended('success')])
      assert.equal(recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir }), true)
      assert.deepEqual(readTurnBaseline(CONNECTION, marker.startedAt, { dir }), {
        turn: marker.startedAt,
        conversation: CONVERSATION,
        turns: 1,
        lastUser: rowDigest(user('connect')),
      })
      assert.equal(decide(dir, transcript), null, 'the turn before it is not its end')

      writeTranscript(transcript, [user('connect'), answer('Connected.'), WAKE, answer('Reading the command.')])
      assert.equal(decide(dir, transcript), null, 'still running')

      writeTranscript(transcript, [user('connect'), answer('Connected.'), WAKE, answer('Done.'), ended('success')])
      assert.deepEqual(decide(dir, transcript), { identity: identity(2, WAKE), status: 'success', error: null, failure: null })

      writeTranscript(transcript, [user('connect'), answer('Connected.'), WAKE, ended('error', LIMIT)])
      assert.deepEqual(decide(dir, transcript).failure, { status: 'error', text: LIMIT }, "Cursor's own words")

      writeTranscript(transcript, [user('connect'), answer('Connected.'), WAKE, ended('aborted', 'User aborted request.')])
      assert.deepEqual(decide(dir, transcript).failure, { status: 'aborted', text: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never takes the end of a turn already running when the tracked turn started for its end', () => {
    const { dir, transcript } = scratch()
    try {
      // A prompt typed at the terminal (or the turn that connected) is running when the
      // room command arrives; Cursor writes that turn's end afterwards.
      writeTranscript(transcript, [user('typed at the terminal'), answer('Looking.')])
      recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
      writeTranscript(transcript, [user('typed at the terminal'), answer('Looking.'), answer('Here it is.'), ended('success')])
      assert.equal(decide(dir, transcript), null)

      writeTranscript(transcript, [user('typed at the terminal'), answer('Looking.'), answer('Here it is.'), WAKE, answer('Done.'), ended('success')])
      assert.equal(decide(dir, transcript)?.identity, identity(2, WAKE))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports nothing for a line it does not recognise, a turn end that is not last, or a turn with no baseline', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, [user('connect'), ended('success')])
      recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
      const head = [user('connect'), WAKE, answer('Done.')]
      for (const last of [
        ended('completed'), // the stop hook's word, never the transcript's
        ended('cancelled'),
        { type: 'turn_end', status: 'success' }, // a changed format
        { event: 'turn_ended', status: 'success' },
        'Turn ended: success.', // Cursor's text transcript, not its JSONL
      ]) {
        writeTranscript(transcript, [...head, last])
        assert.equal(decide(dir, transcript), null, JSON.stringify(last))
      }
      writeTranscript(transcript, [...head, ended('success'), user('one more thing')])
      assert.equal(decide(dir, transcript), null, 'a prompt written below it')

      writeTranscript(transcript, [...head, ended('success')])
      const otherTurn = { startedAt: 2_000 }
      assert.equal(transcriptTurnEnd({ connectionId: CONNECTION, marker: otherTurn, transcriptPath: transcript, dir }), null, 'no baseline for this turn')
      const elsewhere = path.join(path.dirname(path.dirname(transcript)), 'other', 'other.jsonl')
      writeTranscript(elsewhere, [...head, ended('success')])
      assert.equal(transcriptTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: elsewhere, dir }), null, 'another conversation')
      assert.equal(recordTurnBaseline(CONNECTION, { turn: 3_000, conversationId: null, transcriptPath: null, dir }), false, 'no conversation, no baseline')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts a conversation with no transcript yet as having no turns', () => {
    const { dir, transcript } = scratch()
    try {
      assert.equal(recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: null, dir }), true)
      writeTranscript(transcript, [WAKE, answer('Done.'), ended('success')])
      assert.equal(decide(dir, transcript)?.identity, identity(1, WAKE))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the turn after Cursor summarises the conversation, though its user rows stayed level or fell', () => {
    const { dir, transcript } = scratch()
    try {
      const before = [user('one'), answer('1'), user('two'), answer('2'), user('three'), answer('3'), ended('success')]
      writeTranscript(transcript, before)
      recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
      // Rewritten shorter during the command's turn: two user rows where there were three.
      writeTranscript(transcript, [user('three'), answer('Summary of the conversation so far.'), WAKE, ended('error', LIMIT)])
      assert.deepEqual(decide(dir, transcript), {
        identity: identity(2, WAKE),
        status: 'error',
        error: LIMIT,
        failure: { status: 'error', text: LIMIT },
      })
      // The same number of user rows as before.
      writeTranscript(transcript, [user('two'), user('three'), answer('Summary.'), WAKE, ended('error', LIMIT)])
      assert.equal(decide(dir, transcript)?.identity, identity(3, WAKE))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never takes an ended turn written again, after tracking started, for a new turn end', () => {
    const { dir, transcript } = scratch()
    try {
      // A person stopped a turn typed at the terminal; Cursor writes its end again after
      // a room command has been handed over.
      const stopped = [user('typed at the terminal'), answer('Looking.'), ended('aborted', 'User aborted/interrupted manually.')]
      writeTranscript(transcript, stopped)
      recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
      const later = Date.now() / 1000 + 5
      writeTranscript(transcript, stopped)
      fs.utimesSync(transcript, later, later)
      assert.equal(decide(dir, transcript), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a turn end longer than 64 KiB whole, so Cursor\'s words are never lost', () => {
    const { dir, transcript } = scratch()
    try {
      assert.ok(Buffer.byteLength(LONG_ERROR) > 64 * 1024)
      writeTranscript(transcript, [user('connect'), ended('success')])
      recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
      writeTranscript(transcript, [user('connect'), answer('x'.repeat(200 * 1024)), WAKE, ended('error', LONG_ERROR)])
      assert.equal(lastTurnEnd(transcript).error, LONG_ERROR)
      assert.equal(lastTurnError(transcript), LONG_ERROR, 'the stop hook reads it whole too')
      assert.deepEqual(decide(dir, transcript).failure, { status: 'error', text: LONG_ERROR })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the once-a-second check fires once for each new turn end, and not for a turn still running', () => {
    const { dir, transcript } = scratch()
    try {
      const memo = {}
      writeTranscript(transcript, [WAKE, answer('Working.')])
      assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo }), false)
      writeTranscript(transcript, [WAKE, answer('Done.'), ended('success')])
      assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo }), true)
      assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo }), false, 'once')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('claiming a turn end', () => {
  it('lets exactly one caller report it, gives it back when that report failed, and keeps only the newest', () => {
    const { dir } = scratch()
    try {
      const first = identity(2, WAKE)
      const started = Date.now() - 1_000
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'stop', dir }), 'claimed')
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'poller', dir }), 'taken')
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'stop', dir }), 'taken')
      releaseTurnEnd(CONNECTION, first, { dir })
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'poller', dir }), 'claimed')

      const baseline = { turn: started, conversation: CONVERSATION, turns: 1, lastUser: rowDigest(user('connect')) }
      assert.equal(turnEndClaimed(CONNECTION, baseline, { dir }), true)
      assert.equal(turnEndClaimed(CONNECTION, { ...baseline, lastUser: rowDigest(WAKE) }, { dir }), false, 'the turn the baseline was taken in')
      assert.equal(turnEndClaimed(CONNECTION, { ...baseline, turn: Date.now() + 60_000 }, { dir }), false, 'claimed before the turn started')
      assert.equal(turnEndClaimed(CONNECTION, { ...baseline, conversation: 'another' }, { dir }), false)
      assert.equal(turnEndClaimed(CONNECTION, null, { dir }), false)

      assert.equal(claimTurnEnd(CONNECTION, identity(3, user('next')), { by: 'poller', dir }), 'claimed')
      const claims = fs.readdirSync(dir).filter((name) => name.endsWith('.claim'))
      assert.equal(claims.length, 1, 'an older claim goes when a newer turn end is claimed')
      assert.equal(claimTurnEnd(CONNECTION, 'not an identity', { dir }), 'failed')
      assert.equal(claimTurnEnd(CONNECTION, `${CONVERSATION}#2`, { dir }), 'failed', 'an identity without its turn')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------------
// The real poller and the real stop hook.

function commandPoll(body, sessionId) {
  const base = fixtureCommand(body)
  return {
    status: 'live',
    session_id: sessionId,
    changed: true,
    cursor: COMMAND.messageId,
    cursor_v2: 'after:command-1',
    dispatch_cursor: 'dispatch-0',
    ingress: fixtureEnvelope({
      envelopeId: fixtureUuid(501),
      commands: [{ ...base, message_id: COMMAND.messageId, order: fixtureOrder(1, COMMAND.messageId), delivery: { ...base.delivery, turn_id: COMMAND.turnId } }],
    }),
    dispatches: [],
  }
}

async function stubDevSpec(sessionId) {
  const calls = []
  const polls = []
  const queue = []
  let idleCursor = { cursor: null, cursor_v2: null, dispatch_cursor: null }
  const server = http.createServer((request, response) => {
    if (isPushStreamRequest(request)) return refusePushStream(response)
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      const name = parsed.params?.name
      const args = parsed.params?.arguments ?? {}
      calls.push({ name, args, at: Date.now() })
      let result = {}
      if (name === 'poll_connection') {
        polls.push(args)
        const next = queue.shift()
        if (next) {
          idleCursor = { cursor: next.cursor, cursor_v2: next.cursor_v2, dispatch_cursor: next.dispatch_cursor }
          result = next
        } else {
          await sleep(100)
          result = { status: 'live', session_id: sessionId, changed: false, ...idleCursor }
        }
      } else if (name === 'report_pickup') {
        result = { outcome: 'picked_up' }
      } else if (name === 'report_complete') {
        result = { closed_as: 'done' }
      } else if (name === 'report_request' && args.action === 'close') {
        result = { request_id: args.request_id, status: 'closed' }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    polls,
    serve: (payload) => queue.push(payload),
    named: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

async function startPoller({ attached = false, capability = false } = {}) {
  const sessionId = attached ? SESSION : null
  const stub = await stubDevSpec(sessionId)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-turn-end-home-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true,
    connection_id: CONNECTION,
    session_id: sessionId,
    agent_name: 'Cursor',
    local_id: CONVERSATION,
    token: 'dvs_test_token',
    mcp_url: stub.url,
    ingress_version: 1,
  }), { mode: 0o600 })
  if (capability) {
    // The connection capability register leaves beside the state; request bookkeeping needs it.
    fs.writeFileSync(path.join(dir, `${CONNECTION}.capability.json`), JSON.stringify({
      version: 1,
      connection_id: CONNECTION,
      capability: 'dvsc_test_capability',
    }), { mode: 0o600 })
  }
  // Where Cursor keeps the conversation's transcript; the turn that connected has ended.
  const transcript = path.join(home, '.cursor', 'projects', 'home-dev-app', 'agent-transcripts', CONVERSATION, `${CONVERSATION}.jsonl`)
  const connected = [user('/devspec-remote'), answer('Connected.'), ended('success')]
  writeTranscript(transcript, connected)
  const env = { PATH: process.env.PATH, HOME: home }
  const child = spawn(process.execPath, [path.join(HERE, 'devspec-remote-poll.mjs'), '--connection-id', CONNECTION], { env })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const marker = path.join(dir, `${CONNECTION}.turn`)
  return {
    stub,
    dir,
    transcript,
    connected,
    stderr: () => stderr,
    turnOpen: () => fs.existsSync(marker),
    completions: () => stub.named('report_complete'),
    failurePosts: () => stub.named('post_session_message').filter((args) => args.complete_turn === true),
    /** Plain room messages telling why a turn ended, not answering any command. */
    roomNotices: () => stub.named('post_session_message').filter((args) => args.complete_turn !== true && args.phase === 'answer'),
    requestCloses: () => stub.named('report_request').filter((args) => args.action === 'close'),
    /** The requests the connection still has open, as its request log says. */
    openRequests() {
      const events = fs.readFileSync(path.join(dir, `${CONNECTION}.requests.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      const open = new Set()
      for (const event of events) {
        if (event.op === 'open') open.add(event.id)
        if (event.op === 'close') open.delete(event.id)
      }
      return [...open]
    },
    /** The agent posting its final answer to the command (mark-explicit-reply.mjs records it). */
    recordAnswered() {
      fs.appendFileSync(path.join(dir, `${CONNECTION}.requests.jsonl`), `${JSON.stringify({ op: 'answered', id: REQUEST })}\n`)
    },
    /** Hand the agent a room command and wait for the poller to start it. */
    async deliver(body = 'ship the release notes') {
      assert.ok(await until(() => stub.polls.length >= 1), `no poll; stderr:\n${stderr}`)
      stub.serve(commandPoll(body, sessionId))
      assert.ok(await until(() => stub.named('report_pickup').length >= 1 && fs.existsSync(marker)), `no pickup; stderr:\n${stderr}`)
      const polled = stub.polls.length
      assert.ok(await until(() => stub.polls.slice(polled).some((poll) => poll.busy === true)), 'the turn reports busy')
    },
    /** What the wait records as it hands the command to the model (requests.mjs). */
    recordCommandRequest() {
      fs.appendFileSync(path.join(dir, `${CONNECTION}.requests.jsonl`), [
        { op: 'open', id: REQUEST, kind: 'command', message_id: COMMAND.messageId },
        { op: 'current', ref: REQUEST },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n')
    },
    /** Cursor running the plugin's stop hook, as it does when the person has a hooks file of their own. */
    stop(status) {
      return new Promise((resolve, reject) => {
        const hook = spawn(process.execPath, [path.join(HERE, 'mirror-turn.mjs'), 'stop'], {
          env: { ...env, CURSOR_CONVERSATION_ID: CONVERSATION },
          stdio: ['pipe', 'ignore', 'ignore'],
        })
        hook.on('error', reject)
        hook.on('exit', resolve)
        hook.stdin.end(JSON.stringify({ hook_event_name: 'stop', conversation_id: CONVERSATION, status, loop_count: 0, transcript_path: transcript }))
      })
    },
    /** A few more laps of the poller, to show nothing else happens. */
    async laps(count = 6) {
      const from = stub.polls.length
      assert.ok(await until(() => stub.polls.length >= from + count), `the poller stopped; stderr:\n${stderr}`)
    },
    async cleanup() {
      child.kill('SIGKILL')
      try {
        const watcher = Number(fs.readFileSync(trailWatchPidPath(CONNECTION, dir), 'utf8').trim())
        if (watcher) process.kill(watcher, 'SIGKILL')
      } catch { /* no trail watcher was started */ }
      await stub.close()
      try { fs.rmSync(resolveSpaceFreeWakeFile(CONNECTION), { force: true }) } catch { /* nothing to clean */ }
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const finished = (reason = 'turn_end') => ({ connection_id: CONNECTION, command_turn_id: COMMAND.turnId, command_message_id: COMMAND.messageId, reason })

describe('the poller reports a turn end from the transcript when no stop hook runs', () => {
  it('a turn that ran: the command it started is finished within seconds and Working clears', async () => {
    const run = await startPoller()
    try {
      await run.deliver()
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Reading the command.')])
      await run.laps()
      assert.deepEqual(run.completions(), [], 'nothing is reported while the turn runs')
      assert.equal(run.turnOpen(), true)

      const endedAt = Date.now()
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Done.'), ended('success')])
      assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
      const completedAt = run.stub.calls.find((call) => call.name === 'report_complete').at
      assert.ok(completedAt - endedAt < 5_000, `reported ${completedAt - endedAt} ms after the turn ended`)
      assert.deepEqual(run.completions(), [finished()])
      assert.equal(run.turnOpen(), false, 'Working is no longer asserted')
      const after = run.stub.polls.length
      assert.ok(await until(() => run.stub.polls.slice(after - 1).some((poll) => poll.busy === false)), 'busy:false reaches DevSpec')
      await run.laps()
      assert.deepEqual(run.completions(), [finished()], 'reported once')
      assert.deepEqual(run.failurePosts(), [], 'a turn that ran posts nothing for the agent')
    } finally {
      await run.cleanup()
    }
  })

  it('a turn already running when the command arrived, and lines it does not recognise, are never reported', async () => {
    const run = await startPoller()
    try {
      // A prompt typed at the terminal is running when the command arrives.
      writeTranscript(run.transcript, [...run.connected, user('typed at the terminal'), answer('Looking.')])
      await run.deliver()
      writeTranscript(run.transcript, [...run.connected, user('typed at the terminal'), answer('Here it is.'), ended('success')])
      await run.laps()
      assert.deepEqual(run.completions(), [], "the typed turn's end is not the command's")

      const running = [...run.connected, user('typed at the terminal'), answer('Here it is.'), WAKE, answer('Done.')]
      for (const last of [ended('completed'), { type: 'turn_end', status: 'success' }, '{"type":"turn_ended","sta']) {
        writeTranscript(run.transcript, [...running, last])
        await run.laps()
        assert.deepEqual(run.completions(), [], JSON.stringify(last))
        assert.equal(run.turnOpen(), true, 'Working stays, as before')
      }

      writeTranscript(run.transcript, [...running, ended('success')])
      assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
      assert.deepEqual(run.completions(), [finished()])
    } finally {
      await run.cleanup()
    }
  })
})

describe('an error or a stop is told to the room in Cursor\'s words, once, whoever sees it first', () => {
  for (const [status, words] of [['error', LIMIT], ['aborted', 'was stopped before it finished']]) {
    it(`${status}: the poller first, then Cursor runs the stop hook`, async () => {
      const run = await startPoller({ attached: true })
      try {
        await run.deliver()
        run.recordCommandRequest()
        writeTranscript(run.transcript, [...run.connected, WAKE, ended(status, status === 'error' ? LIMIT : 'User aborted request.')])
        assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
        assert.equal(run.failurePosts().length, 1, 'the room is told')
        assert.ok(run.failurePosts()[0].message.includes(words), run.failurePosts()[0].message)
        assert.deepEqual(run.completions(), [finished()])

        await run.stop(status)
        await run.laps()
        assert.equal(run.failurePosts().length, 1, 'the stop hook does not tell the room again')
        assert.deepEqual(run.completions(), [finished()], 'nor report the turn end again')
        assert.equal(run.stub.named('heartbeat_connection').at(-1)?.busy, false, 'the stop hook still ends Working')
      } finally {
        await run.cleanup()
      }
    })
  }

  it('error after Cursor summarised the conversation: reported once, though its user rows fell', async () => {
    const run = await startPoller({ attached: true })
    try {
      writeTranscript(run.transcript, [user('one'), answer('1'), user('two'), answer('2'), ...run.connected])
      await run.deliver()
      run.recordCommandRequest()
      writeTranscript(run.transcript, [answer('Summary of the conversation so far.'), WAKE, ended('error', LIMIT)])
      assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
      assert.equal(run.failurePosts().length, 1)
      assert.ok(run.failurePosts()[0].message.includes(LIMIT))
      await run.stop('error')
      await run.laps()
      assert.equal(run.failurePosts().length, 1, 'once')
      assert.deepEqual(run.completions(), [finished()])
    } finally {
      await run.cleanup()
    }
  })

  it('an error longer than 64 KiB is quoted whole in the room', async () => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LONG_ERROR)])
      assert.ok(await until(() => run.failurePosts().length >= 1), `no room message; stderr:\n${run.stderr()}`)
      const message = run.failurePosts()[0].message
      assert.ok(message.includes(LONG_ERROR.slice(0, 200)) && message.includes('end of error.'), 'the whole of Cursor\'s text')
      assert.ok(!message.includes('its terminal shows what went wrong'), 'not the reply for an error with no text')
      assert.ok(message.length <= 100_000)
    } finally {
      await run.cleanup()
    }
  })

  for (const order of ['the poller first, then the stop hook', 'the stop hook first']) {
    it(`error on a turn carrying no tracked command: the room is told once, as a plain message (${order})`, async () => {
      const run = await startPoller({ attached: true })
      try {
        await run.deliver()
        // No request is tracked for the command: nothing tells the plugin who asked.
        writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
        if (order === 'the stop hook first') await run.stop('error')
        assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
        if (order !== 'the stop hook first') await run.stop('error')
        await run.laps()
        assert.equal(run.roomNotices().length, 1, 'told once')
        assert.ok(run.roomNotices()[0].message.includes(LIMIT), "in Cursor's words")
        assert.deepEqual(run.failurePosts(), [], 'not posted as an answer to anything')
        assert.deepEqual(run.completions(), [finished()])
      } finally {
        await run.cleanup()
      }
    })
  }

  it('error: Cursor runs the stop hook first, and the poller adds nothing', async () => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      // Cursor writes an error's turn end, then runs the stop hook straight away.
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
      await run.stop('error')
      await run.laps()
      assert.equal(run.failurePosts().length, 1)
      assert.ok(run.failurePosts()[0].message.includes(LIMIT))
      assert.deepEqual(run.completions(), [finished()])
    } finally {
      await run.cleanup()
    }
  })
})

describe('when Cursor does run the stop hook on a turn that ran', () => {
  it('the stop hook reports it before Cursor writes the turn end, and the poller adds nothing', async () => {
    const run = await startPoller()
    try {
      await run.deliver()
      // On a turn that ran, Cursor runs the stop hook and only then writes turn_ended.
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Done.')])
      await run.stop('completed')
      assert.deepEqual(run.completions(), [finished()])
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Done.'), ended('success')])
      await run.laps(10)
      assert.deepEqual(run.completions(), [finished()], 'reported once')
    } finally {
      await run.cleanup()
    }
  })
})

describe('the request a turn served is closed at its end with no stop hook', () => {
  it('a command answered by its failure reply', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
      assert.ok(await until(() => run.requestCloses().length >= 1), `no close; stderr:\n${run.stderr()}`)
      assert.equal(run.failurePosts().length, 1)
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.deepEqual(run.openRequests(), [], 'recorded closed')
      // Cursor runs the stop hook as well (a person with a hooks file of their own).
      await run.stop('error')
      await run.laps()
      assert.equal(run.requestCloses().length, 1, 'closed once')
      assert.equal(run.failurePosts().length, 1)
    } finally {
      await run.cleanup()
    }
  })

  it('a command the agent answered itself, in a turn that ran', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      run.recordAnswered()
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Done.'), ended('success')])
      assert.ok(await until(() => run.requestCloses().length >= 1), `no close; stderr:\n${run.stderr()}`)
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.deepEqual(run.openRequests(), [])
      assert.deepEqual(run.completions(), [finished()])
    } finally {
      await run.cleanup()
    }
  })

  it('a command not answered yet stays open', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Still working on it.'), ended('success')])
      assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.deepEqual(run.requestCloses(), [])
      assert.deepEqual(run.openRequests(), [REQUEST])
    } finally {
      await run.cleanup()
    }
  })
})
