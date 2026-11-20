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
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPushStreamRequest, refusePushStream } from './fixtures/push-stream.mjs'
import { FIXTURE_ID, fixtureCommand, fixtureEnvelope, fixtureOrder, fixtureUuid } from './remote-ingress-test-fixtures.mjs'
import { resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'
import { trailWatchPidPath } from './cli-trail-watch.mjs'
import {
  claimTurnEnd,
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
      assert.deepEqual(readTranscriptTurns(transcript), { turns: 2, end: { status: 'error', error: LIMIT } })
      assert.equal(turnEndIdentity(transcript), `${CONVERSATION}#2`)

      writeTranscript(transcript, [user('fix the test'), answer('Working on it.')])
      assert.deepEqual(readTranscriptTurns(transcript), { turns: 1, end: null }, 'a turn still running has no end')
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
      assert.deepEqual(readTurnBaseline(CONNECTION, marker.startedAt, { dir }), { conversation: CONVERSATION, turns: 1 })
      assert.equal(decide(dir, transcript), null, 'the turn before it is not its end')

      writeTranscript(transcript, [user('connect'), answer('Connected.'), WAKE, answer('Reading the command.')])
      assert.equal(decide(dir, transcript), null, 'still running')

      writeTranscript(transcript, [user('connect'), answer('Connected.'), WAKE, answer('Done.'), ended('success')])
      assert.deepEqual(decide(dir, transcript), { identity: `${CONVERSATION}#2`, status: 'success', error: null, failure: null })

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
      assert.equal(decide(dir, transcript)?.identity, `${CONVERSATION}#2`)
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
      assert.equal(decide(dir, transcript)?.identity, `${CONVERSATION}#1`)
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
      const first = `${CONVERSATION}#2`
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'stop', dir }), 'claimed')
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'poller', dir }), 'taken')
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'stop', dir }), 'taken')
      releaseTurnEnd(CONNECTION, first, { dir })
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'poller', dir }), 'claimed')

      assert.equal(turnEndClaimed(CONNECTION, { conversation: CONVERSATION, turns: 1 }, { dir }), true)
      assert.equal(turnEndClaimed(CONNECTION, { conversation: CONVERSATION, turns: 2 }, { dir }), false, 'not a later turn end')
      assert.equal(turnEndClaimed(CONNECTION, { conversation: 'another', turns: 1 }, { dir }), false)
      assert.equal(turnEndClaimed(CONNECTION, null, { dir }), false)

      assert.equal(claimTurnEnd(CONNECTION, `${CONVERSATION}#3`, { by: 'poller', dir }), 'claimed')
      const claims = fs.readdirSync(dir).filter((name) => name.endsWith('.claim'))
      assert.equal(claims.length, 1, 'an older claim goes when a newer turn end is claimed')
      assert.equal(claimTurnEnd(CONNECTION, 'not an identity', { dir }), 'failed')
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

async function startPoller({ attached = false } = {}) {
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
