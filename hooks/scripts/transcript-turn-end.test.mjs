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
  REPORT_ATTEMPTS,
  REPORT_RETRY_MS,
  claimTurnEnd,
  lastTurnEnd,
  nextReportTry,
  noteTurnEndCompleted,
  noteTurnEndTold,
  observeRunningTurnEnd,
  readTranscriptTurns,
  readTurnBaseline,
  recordTurnBaseline,
  settleTurnEnd,
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
// What Cursor's server adds inside a turn when it resumes one (10 seen in real transcripts).
const RESUMED = user('Your previous response was interrupted. Continue from where you left off.')
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
      const read = readTranscriptTurns(transcript)
      assert.deepEqual({ turns: read.turns, lastUser: read.lastUser, end: read.end }, { turns: 2, lastUser: rowDigest(WAKE), end: { status: 'error', error: LIMIT } })
      assert.match(read.stamp, /^\d+:\d+(\.\d+)?$/)
      assert.equal(turnEndIdentity(transcript), identity(2, WAKE))

      writeTranscript(transcript, [user('fix the test'), answer('Working on it.')])
      assert.equal(readTranscriptTurns(transcript).end, null, 'a turn still running has no end')
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
  const track = (dir, transcript) =>
    recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
  const connected = [user('/devspec-remote'), answer('Connected.'), ended('success')]

  it('A2: a room command\'s turn, started by its wake, that ends in an error', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, connected)
      assert.equal(track(dir, transcript), true)
      const baseline = readTurnBaseline(CONNECTION, marker.startedAt, { dir })
      assert.deepEqual({ ...baseline, stamp: typeof baseline.stamp }, { turn: marker.startedAt, conversation: CONVERSATION, between: true, stamp: 'string' })
      assert.equal(decide(dir, transcript), null, 'the turn before it is not its end')

      writeTranscript(transcript, [user('/devspec-remote'), answer('Connected.'), WAKE, answer('Reading the command.')])
      assert.equal(decide(dir, transcript), null, 'still running')

      writeTranscript(transcript, [user('/devspec-remote'), answer('Connected.'), WAKE, ended('error', LIMIT)])
      assert.deepEqual(decide(dir, transcript), { identity: identity(2, WAKE), status: 'error', error: LIMIT, failure: { status: 'error', text: LIMIT } })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A2/A9: a turn a person started by typing, and one stopped', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, connected)
      track(dir, transcript)
      const typed = user('<timestamp>Friday, Nov 20, 2026, 7:59 PM (UTC)</timestamp>\n<user_query>\nfix the test\n</user_query>')
      writeTranscript(transcript, [...connected.slice(0, 2), typed, answer('Done.'), ended('success')])
      assert.deepEqual(decide(dir, transcript), { identity: identity(2, typed), status: 'success', error: null, failure: null })
      writeTranscript(transcript, [...connected.slice(0, 2), typed, ended('aborted', 'User aborted/interrupted manually.')])
      assert.deepEqual(decide(dir, transcript).failure, { status: 'aborted', text: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A3: a turn that fails at its very start, writing no user row of its own', () => {
    const { dir, transcript } = scratch()
    try {
      // The previous turn ran; the command's turn is refused before Cursor writes its
      // prompt, so the file is rewritten with the same rows and a new turn end.
      const ran = [user('/devspec-remote'), answer('Connected.'), WAKE, answer('Done.')]
      writeTranscript(transcript, [...ran, ended('success')])
      track(dir, transcript)
      writeTranscript(transcript, [...ran, ended('error', LIMIT)])
      assert.deepEqual(decide(dir, transcript), { identity: identity(2, WAKE), status: 'error', error: LIMIT, failure: { status: 'error', text: LIMIT } })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A8: two room-command turns in the same minute, whose user rows are the same', () => {
    const { dir, transcript } = scratch()
    try {
      const first = [user('/devspec-remote'), answer('Connected.'), WAKE, answer('Done.')]
      writeTranscript(transcript, [...first, ended('success')])
      track(dir, transcript)
      writeTranscript(transcript, [...first, WAKE, ended('error', LIMIT)])
      assert.equal(decide(dir, transcript)?.identity, identity(3, WAKE))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B1/B5: the end of a turn already running when tracking started, resumed or not, is not reported when it ran or was stopped', () => {
    for (const end of [ended('success'), ended('aborted', 'User aborted/interrupted manually.')]) {
      const { dir, transcript } = scratch()
      try {
        // A prompt typed at the terminal (or the turn that connected) is running when the
        // room command arrives. Cursor's server resumes it once, adding a user row.
        const running = [user('typed at the terminal'), answer('Looking.')]
        writeTranscript(transcript, running)
        track(dir, transcript)
        assert.equal(readTurnBaseline(CONNECTION, marker.startedAt, { dir }).between, false)
        writeTranscript(transcript, [...running, RESUMED, answer('Here it is.'), end])
        assert.equal(decide(dir, transcript), null, `the running turn's own end: ${end.status}`)
        assert.equal(readTurnBaseline(CONNECTION, marker.startedAt, { dir }).between, true, 'from now on, between turns')

        writeTranscript(transcript, [...running, RESUMED, answer('Here it is.'), WAKE, answer('Done.'), ended('success')])
        assert.equal(decide(dir, transcript)?.identity, identity(3, WAKE), 'the command\'s turn after it')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('B2/B3: an error that ends the running turn, or a later turn that overwrote its end unseen, is reported as Cursor errors were before', () => {
    const { dir, transcript } = scratch()
    try {
      const running = [user('typed at the terminal'), answer('Looking.')]
      writeTranscript(transcript, running)
      track(dir, transcript)
      // The running turn's end ("success") was overwritten before any look by the
      // command's turn, refused at its start: the same rows, and Cursor's error.
      writeTranscript(transcript, [...running, answer('Here it is.'), ended('error', LIMIT)])
      assert.deepEqual(decide(dir, transcript), {
        identity: identity(1, user('typed at the terminal')),
        status: 'error',
        error: LIMIT,
        failure: { status: 'error', text: LIMIT },
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B2: an error written before tracking started is not reported', () => {
    const { dir, transcript } = scratch()
    try {
      // Tracking starts in a turn; the transcript then ends in an error dated before it.
      const late = { startedAt: Date.now() + 60_000 }
      writeTranscript(transcript, [user('typed at the terminal'), answer('Looking.')])
      recordTurnBaseline(CONNECTION, { turn: late.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
      writeTranscript(transcript, [user('typed at the terminal'), answer('Looking.'), ended('error', LIMIT)])
      assert.equal(transcriptTurnEnd({ connectionId: CONNECTION, marker: late, transcriptPath: transcript, dir }), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B4: a running turn\'s end overwritten unseen by a later turn that ran is not reported: as before, never false', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, [user('typed at the terminal'), answer('Looking.')])
      track(dir, transcript)
      writeTranscript(transcript, [user('typed at the terminal'), answer('Here it is.'), WAKE, ended('success')])
      assert.equal(decide(dir, transcript), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B1: the watch notes the running turn\'s end as Cursor writes it, so the error that overwrites it next is the later turn\'s', () => {
    const { dir, transcript } = scratch()
    try {
      const running = [user('typed at the terminal'), answer('Looking.')]
      writeTranscript(transcript, running)
      track(dir, transcript)
      assert.equal(observeRunningTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: transcript, dir }), false, 'not ended yet')
      writeTranscript(transcript, [...running, ended('success')])
      assert.equal(observeRunningTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: transcript, dir }), true)
      writeTranscript(transcript, [...running, ended('aborted', 'User aborted/interrupted manually.')])
      assert.ok(decide(dir, transcript), 'a later turn, stopped at its start: reported')
      // An error is left to the look, which reports it.
      const other = scratch()
      writeTranscript(other.transcript, running)
      recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: other.transcript, dir: other.dir })
      writeTranscript(other.transcript, [...running, ended('error', LIMIT)])
      assert.equal(observeRunningTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: other.transcript, dir: other.dir }), false)
      fs.rmSync(other.dir, { recursive: true, force: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A4: the tracked turn\'s end overwritten by the next turn before any look: the next turn end is reported, once', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, connected)
      track(dir, transcript)
      // Missed: [..., WAKE, ended('success')] was written and then rewritten by the next turn.
      writeTranscript(transcript, [...connected.slice(0, 2), WAKE, answer('Done.'), user('typed next'), answer('Working.')])
      assert.equal(decide(dir, transcript), null, 'no turn end to see')
      writeTranscript(transcript, [...connected.slice(0, 2), WAKE, answer('Done.'), user('typed next'), ended('success')])
      assert.equal(decide(dir, transcript)?.identity, identity(3, user('typed next')))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A6: never takes a stopped turn\'s end, written twice as tracking starts, for a later turn\'s', async () => {
    const { dir, transcript } = scratch()
    try {
      // Cursor writes a stopped turn's end twice, 3 ms apart (CLI 2026.11.19). Rewrite it
      // every few milliseconds while tracking starts: the baseline is only taken from a
      // file that has kept still, so it is the file as it ends up.
      const stopped = [user('typed at the terminal'), answer('Looking.'), ended('aborted', 'User aborted/interrupted manually.')]
      writeTranscript(transcript, stopped)
      const writer = spawn(process.execPath, ['-e', `
        const fs = require('node:fs'); const end = Date.now() + 120
        const text = fs.readFileSync(process.argv[1]); const tick = () => { fs.writeFileSync(process.argv[1], text); if (Date.now() < end) setTimeout(tick, 3) }; tick()
      `, transcript])
      await sleep(10)
      assert.equal(track(dir, transcript), true)
      await new Promise((resolve) => writer.on('exit', resolve))
      assert.equal(decide(dir, transcript), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A7: reports nothing for a line it does not recognise, a turn end that is not last, or a turn with no baseline', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, [user('connect'), ended('success')])
      track(dir, transcript)
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

  it('A10: counts a conversation with no transcript yet as between turns', () => {
    const { dir, transcript } = scratch()
    try {
      assert.equal(recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: null, dir }), true)
      writeTranscript(transcript, [WAKE, answer('Done.'), ended('success')])
      assert.equal(decide(dir, transcript)?.identity, identity(1, WAKE))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A5: reports the turn after Cursor summarises the conversation, though its user rows stayed level or fell', () => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, [user('one'), answer('1'), user('two'), answer('2'), user('three'), answer('3'), ended('success')])
      track(dir, transcript)
      // Rewritten shorter during the command's turn: two user rows where there were three.
      writeTranscript(transcript, [user('three'), answer('Summary of the conversation so far.'), WAKE, ended('error', LIMIT)])
      assert.equal(decide(dir, transcript)?.identity, identity(2, WAKE))
      // The same number of user rows as before.
      writeTranscript(transcript, [user('two'), user('three'), answer('Summary.'), WAKE, ended('error', LIMIT)])
      assert.equal(decide(dir, transcript)?.identity, identity(3, WAKE))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A11: reads a turn end longer than 64 KiB whole, so Cursor\'s words are never lost', () => {
    const { dir, transcript } = scratch()
    try {
      assert.ok(Buffer.byteLength(LONG_ERROR) > 64 * 1024)
      writeTranscript(transcript, [user('connect'), ended('success')])
      track(dir, transcript)
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
  it('one caller claims it; the other finds it being reported, then reported; a newer turn end replaces it', () => {
    const { dir } = scratch()
    try {
      const first = identity(2, WAKE)
      assert.deepEqual(claimTurnEnd(CONNECTION, first, { by: 'stop', dir }), { outcome: 'claimed', told: false, completed: false })
      assert.deepEqual(claimTurnEnd(CONNECTION, first, { by: 'poller', dir }), { outcome: 'reporting', told: false, completed: false }, 'its owner (this process) is alive')
      assert.equal(noteTurnEndTold(CONNECTION, first, { dir }), true)
      assert.equal(settleTurnEnd(CONNECTION, first, { reported: true, dir }), true)
      assert.equal(claimTurnEnd(CONNECTION, first, { by: 'poller', dir }).outcome, 'reported')

      assert.equal(claimTurnEnd(CONNECTION, identity(3, user('next')), { by: 'poller', dir }).outcome, 'claimed')
      assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.turn-end.')).length, 1, 'only the newest claim is kept')
      assert.equal(claimTurnEnd(CONNECTION, 'not an identity', { dir }).outcome, 'failed')
      assert.equal(claimTurnEnd(CONNECTION, `${CONVERSATION}#2`, { dir }).outcome, 'failed', 'an identity without its turn')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('C5/C6/C9: a claim given back after a failed step is taken over, with what was already told', () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      claimTurnEnd(CONNECTION, same, { by: 'poller', dir })
      noteTurnEndTold(CONNECTION, same, { dir })
      settleTurnEnd(CONNECTION, same, { reported: false, dir })
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'stop', dir }), { outcome: 'claimed', told: true, completed: false }, 'the room is not told twice')
      noteTurnEndCompleted(CONNECTION, same, { dir })
      settleTurnEnd(CONNECTION, same, { reported: false, dir })
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', dir }), { outcome: 'claimed', told: true, completed: true }, 'nor the turn reported finished twice')
      assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.turn-end.')).length, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('C8: a claim whose owner process has gone is taken over', async () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      // A stop hook Cursor killed at its timeout, mid-report.
      const gone = spawn(process.execPath, ['-e', ''])
      await new Promise((resolve) => gone.on('exit', resolve))
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'stop', dir, pid: gone.pid }).outcome, 'claimed')
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', dir }), { outcome: 'claimed', told: false, completed: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A3: a turn that wrote no user row of its own is claimable though the turn before it had the same identity', () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      const earlier = Date.now() - 60_000
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'poller', dir, now: earlier }).outcome, 'claimed')
      settleTurnEnd(CONNECTION, same, { reported: true, dir })
      const trackedFrom = Date.now() - 1_000
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', after: trackedFrom, dir }), { outcome: 'claimed', told: false, completed: false }, 'the earlier claim was an earlier turn')
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'stop', after: trackedFrom, dir }).outcome, 'reporting', 'and this one is being reported')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a claim of an older shape (an earlier plugin version) is set aside', () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      claimTurnEnd(CONNECTION, same, { by: 'poller', dir })
      const file = fs.readdirSync(dir).find((name) => name.endsWith('.claim'))
      fs.writeFileSync(path.join(dir, file), JSON.stringify({ v: 1, turn: same, by: 'stop', at: new Date().toISOString() }))
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'poller', dir }).outcome, 'claimed')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a turn\'s end counts as reported, for the backstop, only once reported or while its owner reports it', () => {
    const { dir } = scratch()
    try {
      const started = Date.now() - 1_000
      const same = identity(2, WAKE)
      claimTurnEnd(CONNECTION, same, { by: 'stop', dir })
      const baseline = { turn: started, conversation: CONVERSATION, between: true, stamp: '1:1' }
      assert.equal(turnEndClaimed(CONNECTION, baseline, { dir }), true, 'being reported by a live owner')
      settleTurnEnd(CONNECTION, same, { reported: false, dir })
      assert.equal(turnEndClaimed(CONNECTION, baseline, { dir }), false, 'given back: the backstop still reports it')
      claimTurnEnd(CONNECTION, same, { by: 'stop', dir })
      settleTurnEnd(CONNECTION, same, { reported: true, dir })
      assert.equal(turnEndClaimed(CONNECTION, baseline, { dir }), true)
      assert.equal(turnEndClaimed(CONNECTION, { ...baseline, turn: Date.now() + 60_000 }, { dir }), false, 'claimed before the turn started')
      assert.equal(turnEndClaimed(CONNECTION, { ...baseline, conversation: 'another' }, { dir }), false)
      assert.equal(turnEndClaimed(CONNECTION, null, { dir }), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('D2: the poller tries a report that did not land again, REPORT_RETRY_MS apart, REPORT_ATTEMPTS times in all', () => {
    assert.equal(nextReportTry(1, 1_000), 1_000 + REPORT_RETRY_MS)
    assert.equal(nextReportTry(REPORT_ATTEMPTS - 1, 1_000), 1_000 + REPORT_RETRY_MS)
    assert.equal(nextReportTry(REPORT_ATTEMPTS, 1_000), null, 'then as before: Working until the next command or the backstop')
  })
})

// ---------------------------------------------------------------------------------
// The real poller and the real stop hook.

const SECOND_COMMAND = { turnId: fixtureUuid(702), messageId: fixtureUuid(802) }

function commandPoll(body, sessionId, command = COMMAND, sequence = 1) {
  const base = fixtureCommand(body)
  return {
    status: 'live',
    session_id: sessionId,
    changed: true,
    cursor: command.messageId,
    cursor_v2: `after:command-${sequence}`,
    dispatch_cursor: 'dispatch-0',
    ingress: fixtureEnvelope({
      envelopeId: fixtureUuid(500 + sequence),
      commands: [{
        ...base,
        message_id: command.messageId,
        order: fixtureOrder(sequence, command.messageId),
        delivery: { ...base.delivery, turn_id: command.turnId, provenance_ref: fixtureUuid(600 + sequence), primary_provenance_ref: fixtureUuid(600 + sequence) },
      }],
    }),
    dispatches: [],
  }
}

async function stubDevSpec(sessionId) {
  const calls = []
  const polls = []
  const queue = []
  // Calls to fail (DevSpec refusing them) or hold, by tool name, consumed in order.
  const failures = new Map()
  const delays = new Map()
  let idleCursor = { cursor: null, cursor_v2: null, dispatch_cursor: null }
  const server = http.createServer((request, response) => {
    if (isPushStreamRequest(request)) return refusePushStream(response)
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      const name = parsed.params?.name
      const args = parsed.params?.arguments ?? {}
      const call = { name, args, at: Date.now(), ok: true }
      calls.push(call)
      const delay = delays.get(name)
      if (delay) {
        delays.delete(name)
        await sleep(delay)
      }
      if ((failures.get(name) ?? 0) > 0 && !(name === 'report_request' && args.action !== 'close')) {
        failures.set(name, failures.get(name) - 1)
        call.ok = false
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32000, message: 'DevSpec is unavailable' } }))
        return
      }
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
    landed: (name) => calls.filter((call) => call.name === name && call.ok).map((call) => call.args),
    fail: (name, times = 1) => failures.set(name, times),
    hold: (name, ms) => delays.set(name, ms),
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
    completions: () => stub.landed('report_complete'),
    failurePosts: () => stub.landed('post_session_message').filter((args) => args.complete_turn === true),
    /** Every failure reply DevSpec was sent, whether or not it landed. */
    failurePostsSent: () => stub.named('post_session_message').filter((args) => args.complete_turn === true),
    /** Room messages telling why a turn ended, posted by session alone so they answer nothing. */
    roomNotices: () => stub.landed('post_session_message').filter((args) => !args.connection_id && args.session_id),
    requestCloses: () => stub.landed('report_request').filter((args) => args.action === 'close'),
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
    async deliver(body = 'ship the release notes', command = COMMAND, sequence = 1) {
      assert.ok(await until(() => stub.polls.length >= 1), `no poll; stderr:\n${stderr}`)
      const pickups = stub.named('report_pickup').length
      stub.serve(commandPoll(body, sessionId, command, sequence))
      assert.ok(await until(() => stub.named('report_pickup').length > pickups && fs.existsSync(marker)), `no pickup; stderr:\n${stderr}`)
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

const finished = (reason = 'turn_end', command = COMMAND) => ({ connection_id: CONNECTION, command_turn_id: command.turnId, command_message_id: command.messageId, reason })

describe('the poller reports a turn end from the transcript when no stop hook runs', () => {
  it('A1: a turn that ran: the command it started is finished within seconds and Working clears', async () => {
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

  it('B1/A7: a turn already running when the command arrived, and lines it does not recognise, are never reported', async () => {
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
    it(`C3: ${status}: the poller first, then Cursor runs the stop hook`, async () => {
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

  it('A5/C3: error after Cursor summarised the conversation: reported once, though its user rows fell', async () => {
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

  it('A11: an error longer than 64 KiB is quoted whole in the room', async () => {
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
    it(`A2/${order === 'the stop hook first' ? 'C2' : 'C3'}: error on a turn carrying no tracked command: the room is told once, in a message of its own (${order})`, async () => {
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
        assert.deepEqual(Object.keys(run.roomNotices()[0]).sort(), ['agent_name', 'message', 'phase', 'session_id', 'turn_kind'], 'tied to no turn')
        assert.deepEqual(run.failurePosts(), [], 'not posted as an answer to anything')
        assert.deepEqual(run.completions(), [finished()])
      } finally {
        await run.cleanup()
      }
    })
  }

  it('A3/C3: a second command whose turn fails at its very start, with no user row of its own: reported once', async () => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      const ran = [...run.connected.slice(0, 2), WAKE, answer('Done.')]
      writeTranscript(run.transcript, [...ran, ended('success')])
      assert.ok(await until(() => run.completions().length >= 1), `no first completion; stderr:\n${run.stderr()}`)

      await run.deliver('and the changelog', SECOND_COMMAND, 2)
      // Cursor refuses the command's turn before writing its prompt: the same rows, a new end.
      writeTranscript(run.transcript, [...ran, ended('error', LIMIT)])
      assert.ok(await until(() => run.completions().length >= 2), `no second completion; stderr:\n${run.stderr()}`)
      await run.stop('error')
      await run.laps()
      assert.deepEqual(run.completions(), [finished(), finished('turn_end', SECOND_COMMAND)])
      assert.equal(run.roomNotices().length, 1, 'told once, in a message of its own')
      assert.ok(run.roomNotices()[0].message.includes(LIMIT))
    } finally {
      await run.cleanup()
    }
  })

  it('C2: error: Cursor runs the stop hook first, and the poller adds nothing', async () => {
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
  it('C1: the stop hook reports it before Cursor writes the turn end, and the poller adds nothing', async () => {
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

describe('the stop hook and the poller around a report that is in flight, fails or is refused', () => {
  it('C4: the stop hook runs while the poller\'s post is in flight: it adds nothing, and the room is told once', async () => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      run.stub.hold('post_session_message', 1_500)
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
      assert.ok(await until(() => run.failurePostsSent().length >= 1), `no post; stderr:\n${run.stderr()}`)
      await run.stop('error')
      assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.failurePostsSent().length, 1, 'the stop hook did not post while the poller was')
      assert.equal(run.failurePosts().length, 1)
      assert.deepEqual(run.completions(), [finished()])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('C5: the poller\'s post is refused, then Cursor runs the stop hook: the stop hook tells the room, once', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      run.stub.fail('post_session_message')
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
      assert.ok(await until(() => run.failurePostsSent().length >= 1), `no post; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.turnOpen(), true, 'the turn stays open: its end has not been reported')
      assert.deepEqual(run.requestCloses(), [], 'nor its request closed')
      await run.stop('error')
      await run.laps()
      assert.equal(run.failurePosts().length, 1, 'told once')
      assert.equal(run.failurePostsSent().length, 2, 'the refused post and the stop hook\'s')
      assert.deepEqual(run.completions(), [finished()])
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('C6: the stop hook\'s own post is refused: it gives the turn end back, and the poller tells the room, once', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      // Keep the poller inside one long poll, so the stop hook claims the turn end first.
      const pollCalls = () => run.stub.calls.filter((call) => call.name === 'poll_connection').length
      run.stub.hold('poll_connection', 4_000)
      const polled = pollCalls()
      // The poll that is held: received (calls), not yet answered (polls).
      assert.ok(await until(() => pollCalls() > polled), 'the held poll began')
      run.stub.fail('post_session_message')
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
      await run.stop('error')
      assert.equal(run.failurePostsSent().length, 1, 'the stop hook tried')
      assert.equal(run.failurePosts().length, 0)
      assert.equal(run.turnOpen(), true, 'kept for the poller')
      assert.ok(await until(() => run.failurePosts().length >= 1), `the poller did not tell the room; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.failurePosts().length, 1, 'told once')
      assert.equal(run.completions().length, 1, 'reported finished once')
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('C9/D3: the poller\'s post lands but its request close is refused: the stop hook finishes it without telling the room again', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      run.stub.fail('report_request')
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
      assert.ok(await until(() => run.failurePosts().length >= 1), `no post; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.turnOpen(), true)
      await run.stop('error')
      await run.laps()
      assert.equal(run.failurePostsSent().length, 1, 'the room is told once')
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('C7: on a turn that ran, the stop hook\'s completion is refused: the poller completes it from the transcript', async () => {
    const run = await startPoller()
    try {
      await run.deliver()
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Done.')])
      run.stub.fail('report_complete')
      await run.stop('completed')
      assert.equal(run.turnOpen(), true, 'kept for the poller')
      writeTranscript(run.transcript, [...run.connected, WAKE, answer('Done.'), ended('success')])
      assert.ok(await until(() => run.completions().length >= 1), `no completion; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.deepEqual(run.completions(), [finished()])
      assert.equal(run.stub.named('report_complete').length, 2, 'the refused one and the poller\'s')
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it(`C4/D1: the stop hook runs while the poller's post is in flight, then that post fails: the poller tries again ${REPORT_RETRY_MS / 1000} s later, and the room is told once`, async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      run.stub.hold('post_session_message', 1_500)
      run.stub.fail('post_session_message')
      writeTranscript(run.transcript, [...run.connected, WAKE, ended('error', LIMIT)])
      assert.ok(await until(() => run.failurePostsSent().length >= 1), `no post; stderr:\n${run.stderr()}`)
      await run.stop('error')
      await run.laps()
      assert.equal(run.turnOpen(), true, 'the turn stays open: its end has not been reported')
      assert.equal(run.failurePostsSent().length, 1, 'not again before its time')
      assert.ok(await until(() => run.failurePosts().length >= 1, REPORT_RETRY_MS + 10_000), `no retry; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.failurePostsSent().length, 2, 'the failed post and its retry, none from the stop hook')
      assert.equal(run.failurePosts().length, 1)
      assert.deepEqual(run.completions(), [finished()])
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })
})
