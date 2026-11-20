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
  SETTLE_MS,
  claimTurnEnd,
  completeTurnBaseline,
  lastTurnEnd,
  nextReportTry,
  noteTurnEndAttemptEnded,
  noteTurnEndCompleted,
  noteTurnEndNoticed,
  noteTurnEndTold,
  readLastTurnEnd,
  readTranscriptTurns,
  readTurnBaseline,
  recordTurnBaseline,
  reportHoldingClaim,
  readSettle,
  settleStep,
  settleTurnEnd,
  startSettle,
  transcriptTurnEnd,
  turnEndClaimed,
  turnEndIdentity,
  turnEndPending,
  writeTurnBaseline,
} from './transcript-turn-end.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONNECTION = FIXTURE_ID.connection
const CONVERSATION = 'c0ffee00-cdf0-4020-8c00-000000000001'
const SESSION = fixtureUuid(900)
const REQUEST = fixtureUuid(901)
const SECOND_REQUEST = fixtureUuid(902)
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
// What a claim says already reached DevSpec (claimTurnEnd).
const progress = (done = {}) => ({ told: false, noticed: false, completed: false, ended: false, ...done })
// Real transcripts from CLI 2026.11.19 (2026-11-20, a throwaway conversation): two typed
// turns, then `/summarize`, then a third typed turn, each copied as Cursor left it.
const SUMMARY_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor-summarize-2026.11.19')
const summaryFixture = (name) => fs.readFileSync(path.join(SUMMARY_FIXTURES, name))
// The user row Cursor added when it summarised that conversation (its tool catalog).
const SUMMARY_ROW = (() => {
  const kept = (bytes) => bytes.subarray(0, bytes.lastIndexOf(0x0a, bytes.length - 2) + 1)
  const before = kept(summaryFixture('1-before-summary.jsonl'))
  return JSON.parse(kept(summaryFixture('2-summary-turn-ended.jsonl')).subarray(before.length).toString())
})()

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

/**
 * Make a file unreadable to this process, as a read that fails: false where permissions
 * do not stop this process reading (root), and the file is put back as it was.
 * Changing a file's permissions leaves its size and modification time as they were.
 */
function makeUnreadable(file) {
  fs.chmodSync(file, 0o000)
  try {
    fs.closeSync(fs.openSync(file, 'r'))
  } catch {
    return true
  }
  fs.chmodSync(file, 0o600)
  return false
}
const ROOT_READS = 'permissions do not stop this process reading files (root)'
const stampOf = (file) => {
  const { size, mtimeMs } = fs.statSync(file)
  return `${size}:${mtimeMs}`
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
      assert.match(turnEndIdentity(transcript), new RegExp(`^${identity(2, WAKE)}#[0-9a-f]{16}@\\d+$`), 'an error names its line')

      writeTranscript(transcript, [user('fix the test'), answer('Working on it.')])
      assert.equal(turnEndIdentity(transcript), identity(1, user('fix the test')), 'a turn still running: its rows alone')
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
  // What the lap decides, without where the end sits (`position`, for a settle).
  const decide = (dir, transcript, m = marker) => {
    const ended = transcriptTurnEnd({ connectionId: CONNECTION, marker: m, transcriptPath: transcript, dir })
    if (!ended) return ended
    const { position, ...decision } = ended
    assert.equal(typeof position?.kept, 'number', 'every decided end says where it sits')
    return decision
  }
  const track = (dir, transcript, m = marker) =>
    recordTurnBaseline(CONNECTION, { turn: m.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
  // The turn that connected, ended: Cursor keeps its rows and drops its end line when
  // the next turn starts.
  const connectedRows = [user('/devspec-remote'), answer('Connected.')]
  const connected = [...connectedRows, ended('success')]
  const typed = user('<timestamp>Friday, Nov 20, 2026, 8:58 PM (UTC)</timestamp>\n<user_query>\nfix the test\n</user_query>')
  const inScratch = (fn) => {
    const { dir, transcript } = scratch()
    try {
      return fn(dir, transcript)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('A1/A2: the room command\'s turn, started by its wake: a run, an error and a stop are the command\'s', () => inScratch((dir, transcript) => {
    writeTranscript(transcript, connected)
    assert.equal(track(dir, transcript), true)
    assert.equal(readTurnBaseline(CONNECTION, marker.startedAt, { dir }).between, true)
    assert.equal(decide(dir, transcript), null, 'the turn before it is not its end')

    writeTranscript(transcript, [...connectedRows, WAKE, answer('Reading the command.')])
    assert.equal(decide(dir, transcript), null, 'still running')

    writeTranscript(transcript, [...connectedRows, WAKE, answer('Done.'), ended('success')])
    assert.deepEqual(decide(dir, transcript), { identity: identity(2, WAKE), status: 'success', error: null, failure: null, attributed: true })

    writeTranscript(transcript, [...connectedRows, WAKE, ended('error', LIMIT)])
    const errored = decide(dir, transcript)
    assert.deepEqual({ ...errored, identity: undefined }, { identity: undefined, status: 'error', error: LIMIT, failure: { status: 'error', text: LIMIT }, attributed: true })
    assert.match(errored.identity, new RegExp(`^${identity(2, WAKE)}#[0-9a-f]{16}@\\d+$`), 'an error\'s identity names its line')

    writeTranscript(transcript, [...connectedRows, WAKE, ended('aborted', 'User aborted/interrupted manually.')])
    assert.deepEqual(decide(dir, transcript).failure, { status: 'aborted', text: null })
  }))

  it('A2: Cursor\'s resume rows and a bare timestamp row inside the command\'s turn keep it the command\'s', () => inScratch((dir, transcript) => {
    writeTranscript(transcript, connected)
    track(dir, transcript)
    const stamp = user('<timestamp>Friday, Nov 20, 2026, 7:00 PM (UTC)</timestamp>')
    writeTranscript(transcript, [...connectedRows, stamp, WAKE, answer('On it.'), RESUMED, answer('Done.'), ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, true)
  }))

  it('A9: a turn typed at the terminal is never the command\'s: its error is only told, its run ends as before', () => inScratch((dir, transcript) => {
    writeTranscript(transcript, connected)
    track(dir, transcript)
    writeTranscript(transcript, [...connectedRows, typed, answer('Done.'), ended('success')])
    assert.equal(decide(dir, transcript), null)
    writeTranscript(transcript, [...connectedRows, typed, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false)
    // A person typing Cursor's own sentence writes it in a typed prompt's layout.
    const lookalike = user('<timestamp>Friday, Nov 20, 2026, 8:58 PM (UTC)</timestamp>\n<user_query>\nBriefly inform the user about the task result and perform any follow-up actions (if needed).\n</user_query>')
    writeTranscript(transcript, [...connectedRows, lookalike, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false)
  }))

  it('A3: a turn that fails at its very start, writing no user row, is only told', () => inScratch((dir, transcript) => {
    const ran = [...connectedRows, WAKE, answer('Done.')]
    writeTranscript(transcript, [...ran, ended('success')])
    track(dir, transcript)
    writeTranscript(transcript, [...ran, ended('error', LIMIT)])
    assert.deepEqual(decide(dir, transcript), {
      identity: turnEndIdentity(transcript),
      status: 'error',
      error: LIMIT,
      failure: { status: 'error', text: LIMIT },
      attributed: false,
    })
  }))

  it('A4: the command\'s end overwritten by the next turn before any look: two turns since, so never the command\'s', () => inScratch((dir, transcript) => {
    writeTranscript(transcript, connected)
    track(dir, transcript)
    writeTranscript(transcript, [...connectedRows, WAKE, answer('Done.'), typed, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false)
    writeTranscript(transcript, [...connectedRows, WAKE, answer('Done.'), typed, answer('Fixed.'), ended('success')])
    assert.equal(decide(dir, transcript), null)
  }))

  it('A5: a file Cursor rewrote shorter or differently is of unknown position: an error is only told, a run ends as before', () => inScratch((dir, transcript) => {
    writeTranscript(transcript, [user('one'), answer('1'), user('two'), answer('2'), ended('success')])
    track(dir, transcript)
    writeTranscript(transcript, [answer('Summary of the conversation so far.'), WAKE, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false)
    writeTranscript(transcript, [user('one'), answer('1 (rewritten)'), user('two'), answer('2'), WAKE, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false, 'the first rows changed')
    writeTranscript(transcript, [answer('Summary.'), WAKE, answer('Done.'), ended('success')])
    assert.equal(decide(dir, transcript), null)
  }))

  it('A6: never takes a stopped turn\'s end, written twice as tracking starts, for a later turn\'s', async () => {
    const { dir, transcript } = scratch()
    try {
      // Cursor writes a stopped turn's end twice, 3 ms apart (CLI 2026.11.19). Rewrite it
      // every few milliseconds while tracking starts: the baseline is only taken from a
      // file that has kept still, so it is the file as it ends up.
      const stopped = [typed, answer('Looking.'), ended('aborted', 'User aborted/interrupted manually.')]
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

  it('A7/T11/T8: reports nothing for a line it does not recognise or a turn end that is not last; with no baseline, an error is only noticed', () => inScratch((dir, transcript) => {
    writeTranscript(transcript, connected)
    track(dir, transcript)
    const head = [...connectedRows, WAKE, answer('Done.')]
    for (const last of [
      ended('completed'), // the stop hook's word, never the transcript's
      ended('cancelled'),
      { type: 'turn_end', status: 'error', error: LIMIT }, // a changed format
      { event: 'turn_ended', status: 'error' },
      'Turn ended: error.', // Cursor's text transcript, not its JSONL
    ]) {
      writeTranscript(transcript, [...head, last])
      assert.equal(decide(dir, transcript), null, JSON.stringify(last))
    }
    writeTranscript(transcript, [...head, ended('error', LIMIT), user('one more thing')])
    assert.equal(decide(dir, transcript), null, 'a prompt written below it')

    writeTranscript(transcript, [...head, ended('error', LIMIT)])
    // T8: no snapshot for this turn: an error written since is still noticed (never the
    // command's), as the reader before this one did; a turn that ran ends as before.
    assert.deepEqual(decide(dir, transcript, { startedAt: 2_000 })?.attributed, false, 'no baseline for this turn: noticed')
    writeTranscript(transcript, [...head, ended('success')])
    assert.equal(decide(dir, transcript, { startedAt: 2_000 }), null, 'no baseline, a turn that ran')
    const elsewhere = path.join(path.dirname(path.dirname(transcript)), 'other', 'other.jsonl')
    writeTranscript(elsewhere, [...head, ended('error', LIMIT)])
    assert.equal(transcriptTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: elsewhere, dir }), null, 'another conversation')
    assert.equal(recordTurnBaseline(CONNECTION, { turn: 3_000, conversationId: null, transcriptPath: null, dir }), false, 'no conversation, no baseline')
  }))

  it('A8: two command turns in one minute, whose user rows are the same: the second is its own', () => inScratch((dir, transcript) => {
    const first = [...connectedRows, WAKE, answer('Done.')]
    writeTranscript(transcript, [...first, ended('success')])
    track(dir, transcript)
    writeTranscript(transcript, [...first, WAKE, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, true)
  }))

  it('A10: a conversation with no transcript yet is between turns, and every row is new', () => inScratch((dir, transcript) => {
    assert.equal(recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: null, dir }), true)
    writeTranscript(transcript, [WAKE, answer('Done.'), ended('success')])
    assert.deepEqual(decide(dir, transcript), { identity: identity(1, WAKE), status: 'success', error: null, failure: null, attributed: true })
  }))

  it('A11: reads a turn end longer than 64 KiB whole, so Cursor\'s words are never lost', () => inScratch((dir, transcript) => {
    assert.ok(Buffer.byteLength(LONG_ERROR) > 64 * 1024)
    writeTranscript(transcript, [user('connect'), answer('x'.repeat(200 * 1024)), ended('success')])
    track(dir, transcript)
    writeTranscript(transcript, [user('connect'), answer('x'.repeat(200 * 1024)), WAKE, ended('error', LONG_ERROR)])
    assert.equal(lastTurnEnd(transcript).error, LONG_ERROR)
    assert.equal(lastTurnError(transcript), LONG_ERROR, 'the stop hook reads it whole too')
    assert.deepEqual(decide(dir, transcript).failure, { status: 'error', text: LONG_ERROR })
  }))

  it('A12 (DevSpec\'s fixture): an older error transcript put back with its old modification time never counts', () => inScratch((dir, transcript) => {
    const now = { startedAt: Date.now() }
    const older = [...connectedRows, WAKE, ended('error', LIMIT)]
    writeTranscript(transcript, older)
    const oldTime = (now.startedAt - 3_600_000) / 1000
    fs.utimesSync(transcript, oldTime, oldTime)
    const restoredFrom = fs.readFileSync(transcript)
    writeTranscript(transcript, connected)
    track(dir, transcript, now)
    // Restored as it was, its time and all.
    fs.writeFileSync(transcript, restoredFrom)
    fs.utimesSync(transcript, oldTime, oldTime)
    assert.equal(decide(dir, transcript, now), null)
  }))

  it('A13: a start row Cursor words differently is not taken for a room command\'s: its error is only told', () => inScratch((dir, transcript) => {
    writeTranscript(transcript, connected)
    track(dir, transcript)
    const reworded = user('<timestamp>Friday, Nov 20, 2026, 7:00 PM (UTC)</timestamp>\n\n<user_query>Tell the user what the background task returned.</user_query>')
    writeTranscript(transcript, [...connectedRows, reworded, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false)
    writeTranscript(transcript, [...connectedRows, reworded, answer('Done.'), ended('success')])
    assert.equal(decide(dir, transcript), null)
  }))

  it('A14 (real transcripts, CLI 2026.11.19 /summarize): a summary keeps the rows noted at handover first, so the position holds; a turn holding the row Cursor adds is only told', () => inScratch((dir, transcript) => {
    const before = summaryFixture('1-before-summary.jsonl')
    const summarised = summaryFixture('2-summary-turn-ended.jsonl')
    const next = summaryFixture('3-next-turn-ended.jsonl')
    // All but the final turn_ended line: the rows Cursor keeps when the next turn starts.
    const keptOf = (bytes) => bytes.subarray(0, bytes.lastIndexOf(0x0a, bytes.length - 2) + 1)
    assert.match(before.subarray(keptOf(before).length).toString(), /"turn_ended"/)
    // Cursor rewrote nothing it had written: each file starts with the one before's rows.
    assert.ok(summarised.subarray(0, keptOf(before).length).equals(keptOf(before)), 'the summary kept the rows before it')
    assert.ok(next.subarray(0, keptOf(summarised).length).equals(keptOf(summarised)), 'the turn after it kept them too')
    // The one row the summary added: Cursor's own, its tool catalog, no prompt of anyone's.
    const summaryRow = keptOf(summarised).subarray(keptOf(before).length)
    assert.match(summaryRow.toString(), /^\{"role":"user".*<available_subagent_types>.*<\/dynamic_tool_catalog>"\}\]\}\}\n$/s)
    const write = (...parts) => fs.writeFileSync(transcript, Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(`${JSON.stringify(part)}\n`)))))

    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    write(before)
    track(dir, transcript)
    write(summarised)
    assert.equal(decide(dir, transcript), null, 'the summary\'s own turn ran, and it was nobody\'s command')
    // The command's turn after a summary, or a summary inside the command's turn: the
    // position holds, but the turn holds a row that is neither the command's sentence nor
    // Cursor's resume row, and a summary inside the command's turn cannot be told from a
    // summary turn that ran after it (A4). Only told.
    write(keptOf(summarised), WAKE, ended('error', LIMIT))
    assert.equal(decide(dir, transcript)?.attributed, false, 'a summary between handover and the command\'s turn')
    write(keptOf(before), WAKE, answer('Looking.'), summaryRow, ended('error', LIMIT))
    assert.equal(decide(dir, transcript)?.attributed, false, 'a summary inside the command\'s turn')
    write(keptOf(before), WAKE, ended('error', LIMIT))
    assert.equal(decide(dir, transcript)?.attributed, true, 'the same turn with no summary row in it is the command\'s')

    // A command handed over after a summary: its turn is the command's as any other.
    const after = { startedAt: 2_000 }
    write(summarised)
    track(dir, transcript, after)
    write(keptOf(summarised), WAKE, ended('error', LIMIT))
    assert.equal(decide(dir, transcript, after)?.attributed, true)
  }))

  it('A16/T6 (requirement 3ea2b201): a read that fails marks nothing as checked: the same file, unchanged, read again reports its end', (t) => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, connected)
      track(dir, transcript)
      writeTranscript(transcript, [...connectedRows, WAKE, ended('error', LIMIT)])
      const before = stampOf(transcript)
      const memo = {}
      const probe = {}
      const look = () => transcriptTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: transcript, dir, memo })
      if (!makeUnreadable(transcript)) return t.skip(ROOT_READS)
      try {
        assert.deepEqual(readLastTurnEnd(transcript), { read: false, end: null })
        assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo: probe }), false)
        assert.equal(look(), null)
        assert.equal(look(), null)
      } finally {
        fs.chmodSync(transcript, 0o600)
      }
      assert.equal(stampOf(transcript), before, 'the same size and time')
      assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo: probe }), true, 'the once-a-second check reads it again')
      assert.equal(look()?.attributed, true, 'the lap reads it again')
      assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo: probe }), false, 'and then it is checked')

      // A final line that does not parse yet is not a read either.
      fs.writeFileSync(transcript, `${JSON.stringify(WAKE)}\n{"type":"turn_ended","sta\n`)
      assert.deepEqual(readLastTurnEnd(transcript), { read: false, end: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A17: a snapshot handover could not read is taken later from the same, unchanged file, and never once the file has changed', (t) => {
    const { dir, transcript } = scratch()
    try {
      writeTranscript(transcript, connected)
      if (!makeUnreadable(transcript)) return t.skip(ROOT_READS)
      try {
        assert.equal(track(dir, transcript), false, 'no snapshot yet, only a pending one')
        assert.equal(readTurnBaseline(CONNECTION, marker.startedAt, { dir }), null)
        assert.equal(completeTurnBaseline(CONNECTION, marker.startedAt, { dir }), 'pending', 'still unreadable')
      } finally {
        fs.chmodSync(transcript, 0o600)
      }
      assert.equal(completeTurnBaseline(CONNECTION, marker.startedAt, { dir }), 'complete')
      assert.equal(readTurnBaseline(CONNECTION, marker.startedAt, { dir }).between, true)
      writeTranscript(transcript, [...connectedRows, WAKE, ended('error', LIMIT)])
      assert.equal(decide(dir, transcript)?.attributed, true, 'its turn end is reported as any other')

      const later = { startedAt: 5_000 }
      writeTranscript(transcript, connected)
      makeUnreadable(transcript)
      try {
        assert.equal(track(dir, transcript, later), false)
      } finally {
        fs.chmodSync(transcript, 0o600)
      }
      writeTranscript(transcript, [...connectedRows, WAKE, answer('Working.')])
      assert.equal(completeTurnBaseline(CONNECTION, later.startedAt, { dir }), 'none', 'the file changed first: never taken')
      writeTranscript(transcript, [...connectedRows, WAKE, ended('error', LIMIT)])
      assert.equal(decide(dir, transcript, later)?.attributed, false, 'with no snapshot, its error is still noticed (T8)')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B1/B2 (DevSpec\'s fixture): tracking started while a typed turn ran: its error is only told, never the command\'s answer; a run ends as before', () => inScratch((dir, transcript) => {
    const running = [...connectedRows, typed, answer('Looking.')]
    writeTranscript(transcript, running)
    track(dir, transcript)
    assert.equal(readTurnBaseline(CONNECTION, marker.startedAt, { dir }).between, false)
    writeTranscript(transcript, [...running, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false)
    // Nor the command's own turn after it: tracking did not start between turns.
    writeTranscript(transcript, [...running, WAKE, ended('error', LIMIT)])
    assert.equal(decide(dir, transcript)?.attributed, false)
    writeTranscript(transcript, [...running, WAKE, answer('Done.'), ended('success')])
    assert.equal(decide(dir, transcript), null)
  }))

  it('B3: an error dated before tracking started is not reported', () => inScratch((dir, transcript) => {
    const late = { startedAt: Date.now() + 60_000 }
    writeTranscript(transcript, [typed, answer('Looking.')])
    track(dir, transcript, late)
    writeTranscript(transcript, [typed, answer('Looking.'), ended('error', LIMIT)])
    assert.equal(decide(dir, transcript, late), null)
  }))

  it('the once-a-second check fires once for each new turn end, and not for a turn still running', () => inScratch((dir, transcript) => {
    const memo = {}
    writeTranscript(transcript, [WAKE, answer('Working.')])
    assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo }), false)
    writeTranscript(transcript, [WAKE, answer('Done.'), ended('success')])
    assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo }), true)
    assert.equal(turnEndPending({ marker, transcriptPath: transcript, memo }), false, 'once')
  }))
})

describe('settling a turn end the poller could only notice', () => {
  const marker = { startedAt: 1_000 }
  const connectedRows = [user('/devspec-remote'), answer('Connected.')]
  const typed = (text) => user(`<timestamp>Friday, Nov 20, 2026, 9:30 PM (UTC)</timestamp>\n<user_query>\n${text}\n</user_query>`)
  const begin = (dir, transcript, rows) => {
    writeTranscript(transcript, [...connectedRows, ended('success')])
    recordTurnBaseline(CONNECTION, { turn: marker.startedAt, conversationId: CONVERSATION, transcriptPath: transcript, dir })
    writeTranscript(transcript, rows)
    const ended_ = transcriptTurnEnd({ connectionId: CONNECTION, marker, transcriptPath: transcript, dir })
    assert.equal(ended_?.attributed, false)
    assert.equal(startSettle(CONNECTION, { ended: ended_, conversation: CONVERSATION, turn: marker.startedAt, requests: [REQUEST], now: 10_000, dir }), true)
    return readSettle(CONNECTION, { dir })
  }

  it('T2/T3: waits while Cursor is idle, resolves after SETTLE_MS, restarts on the same end written again, and never decides on a failed read', (t) => {
    const { dir, transcript } = scratch()
    try {
      const stopped = [...connectedRows, typed('run the build'), answer('Running.'), ended('aborted', 'User aborted/interrupted manually.')]
      const settle = begin(dir, transcript, stopped)
      assert.deepEqual(settle.requests, [REQUEST])
      assert.deepEqual(settleStep(settle, { transcriptPath: transcript, now: 10_000 + SETTLE_MS - 1 }), { action: 'wait' })
      assert.deepEqual(settleStep(settle, { transcriptPath: transcript, now: 10_000 + SETTLE_MS }), { action: 'resolve' })
      assert.deepEqual(settleStep({ ...settle, resolved: true }, { transcriptPath: transcript, now: 10_000 + SETTLE_MS }), { action: 'wait' }, 'answered once')
      // Ctrl+C writes the stopped end again: the same end, a new write.
      const later = Date.now() / 1000 + 5
      fs.utimesSync(transcript, later, later)
      assert.equal(settleStep(settle, { transcriptPath: transcript, now: 10_000 + SETTLE_MS }).action, 'restart')
      if (!makeUnreadable(transcript)) return t.skip(ROOT_READS)
      try {
        assert.deepEqual(settleStep(settle, { transcriptPath: transcript, now: 10_000 + SETTLE_MS }), { action: 'wait' }, 'a failed read decides nothing')
      } finally {
        fs.chmodSync(transcript, 0o600)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('T3 (measured): a typed turn after the end is waited for and watched from; the held wake turn after it is tracked from just before it', () => {
    const { dir, transcript } = scratch()
    try {
      const head = [...connectedRows, typed('run the build'), answer('Running.')]
      const settle = begin(dir, transcript, [...head, ended('aborted', 'User aborted/interrupted manually.')])
      // The person types: Cursor drops the stopped end and runs their turn.
      writeTranscript(transcript, [...head, typed('ok, go on'), answer('Going on.')])
      assert.deepEqual(settleStep(settle, { transcriptPath: transcript }), { action: 'wait' }, 'a typed turn is running')
      writeTranscript(transcript, [...head, typed('ok, go on'), answer('Going on.'), ended('success')])
      const rebase = settleStep(settle, { transcriptPath: transcript, now: 20_000 })
      assert.equal(rebase.action, 'rebase')
      assert.equal(rebase.idle.since, 20_000, 'the idle clock starts again')
      const watched = { ...settle, kept: rebase.kept, keptDigest: rebase.keptDigest, idle: rebase.idle }
      // Then Cursor runs the command it held: tracked as the command's turn.
      writeTranscript(transcript, [...head, typed('ok, go on'), answer('Going on.'), WAKE, answer('On it.')])
      const track = settleStep(watched, { transcriptPath: transcript })
      assert.equal(track.action, 'track')
      assert.equal(track.baseline.between, true)
      assert.equal(writeTurnBaseline(CONNECTION, { turn: 9_000, conversation: CONVERSATION, baseline: track.baseline }, { dir }), true)
      writeTranscript(transcript, [...head, typed('ok, go on'), answer('Going on.'), WAKE, answer('Done.'), ended('error', LIMIT)])
      assert.equal(transcriptTurnEnd({ connectionId: CONNECTION, marker: { startedAt: 9_000 }, transcriptPath: transcript, dir })?.attributed, true, 'and its end is the command\'s')
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
      assert.deepEqual(claimTurnEnd(CONNECTION, first, { by: 'stop', dir }), { outcome: 'claimed', ...progress() })
      assert.deepEqual(claimTurnEnd(CONNECTION, first, { by: 'poller', dir }), { outcome: 'reporting', ...progress() }, 'its owner (this process) is alive')
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
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'stop', dir }), { outcome: 'claimed', ...progress({ told: true }) }, 'the room is not told twice')
      noteTurnEndCompleted(CONNECTION, same, { dir })
      settleTurnEnd(CONNECTION, same, { reported: false, dir })
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', dir }), { outcome: 'claimed', ...progress({ told: true, completed: true }) }, 'nor the turn reported finished twice')
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
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', dir }), { outcome: 'claimed', ...progress() })
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
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', after: trackedFrom, dir }), { outcome: 'claimed', ...progress() }, 'the earlier claim was an earlier turn')
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
      for (const older of [
        { v: 1, turn: same, by: 'stop', at: new Date().toISOString() },
        { v: 2, turn: same, by: 'stop', pid: process.pid, at: new Date().toISOString(), state: 'reporting', told: false, completed: false },
      ]) {
        fs.writeFileSync(path.join(dir, file), JSON.stringify(older))
        assert.equal(claimTurnEnd(CONNECTION, same, { by: 'poller', dir }).outcome, 'claimed', `v${older.v}`)
      }
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
      claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir })
      settleTurnEnd(CONNECTION, same, { noticed: true, dir })
      assert.equal(turnEndClaimed(CONNECTION, baseline, { dir }), true, 'noticed: its working attempt was ended')
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

  it('C10: a notice, then the stop hook\'s report takes it over (the upgrade) without a second notice', () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir }), { outcome: 'claimed', ...progress() })
      noteTurnEndNoticed(CONNECTION, same, { dir })
      noteTurnEndAttemptEnded(CONNECTION, same, { dir })
      settleTurnEnd(CONNECTION, same, { noticed: true, dir })
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir }), { outcome: 'noticed', ...progress({ noticed: true, ended: true }) }, 'nothing left at the notice level')
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'stop', goal: 'report', dir }), { outcome: 'claimed', ...progress({ noticed: true, ended: true }) }, 'the stop hook answers and closes; the notice is not repeated')
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir }).outcome, 'reporting', 'while it does')
      noteTurnEndTold(CONNECTION, same, { dir })
      settleTurnEnd(CONNECTION, same, { reported: true, dir })
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir }).outcome, 'reported')
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'stop', goal: 'report', dir }).outcome, 'reported')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('C11: a notice being posted by a live process: the stop hook answers alongside it; the notice level waits for a report being made', () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir })
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'stop', goal: 'report', dir }).outcome, 'noticing')
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir }).outcome, 'reporting')
      const other = identity(3, user('next'))
      claimTurnEnd(CONNECTION, other, { by: 'stop', goal: 'report', dir })
      assert.equal(claimTurnEnd(CONNECTION, other, { by: 'poller', goal: 'notice', dir }).outcome, 'reporting', 'the stop hook\'s report tells the room itself')
      assert.equal(claimTurnEnd(CONNECTION, other, { by: 'poller', goal: 'report', dir }).outcome, 'reporting')
      assert.equal(claimTurnEnd(CONNECTION, other, { by: 'poller', goal: 'whatever', dir }).outcome, 'failed')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('C12: a report given back after telling the room: the notice level only ends what is left', () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      claimTurnEnd(CONNECTION, same, { by: 'stop', goal: 'report', dir })
      noteTurnEndTold(CONNECTION, same, { dir })
      settleTurnEnd(CONNECTION, same, { reported: false, dir })
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir }), { outcome: 'claimed', ...progress({ told: true }) }, 'no notice: the room was told')
      noteTurnEndAttemptEnded(CONNECTION, same, { dir })
      settleTurnEnd(CONNECTION, same, { noticed: false, dir })
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'poller', goal: 'notice', dir }), { outcome: 'claimed', ...progress({ told: true, ended: true }) }, 'nor the attempt ended twice')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('D5: a report that throws part-way gives the claim back with what landed; a claim that cannot be read is never set aside', async () => {
    const { dir } = scratch()
    try {
      const same = identity(2, WAKE)
      claimTurnEnd(CONNECTION, same, { by: 'poller', dir })
      noteTurnEndTold(CONNECTION, same, { dir })
      const heard = []
      const outcome = await reportHoldingClaim(CONNECTION, same, async () => {
        throw new Error('part-way')
      }, { dir, onError: (error) => heard.push(error.message) })
      assert.equal(outcome, 'retry')
      assert.deepEqual(heard, ['part-way'])
      assert.deepEqual(claimTurnEnd(CONNECTION, same, { by: 'stop', dir }), { outcome: 'claimed', ...progress({ told: true }) }, 'given back, the room not told twice')
      assert.equal(await reportHoldingClaim(CONNECTION, same, async () => 'reported', { dir }), 'reported')

      const file = path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith('.claim')))
      fs.writeFileSync(file, '{"v":3,"turn":')
      assert.equal(claimTurnEnd(CONNECTION, same, { by: 'poller', dir }).outcome, 'failed', 'its progress is unknown')
      assert.equal(fs.readFileSync(file, 'utf8'), '{"v":3,"turn":', 'left where it was')
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
    /** Every such message DevSpec was sent, whether or not it has landed yet. */
    noticesSent: () => stub.named('post_session_message').filter((args) => !args.connection_id && args.session_id),
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
    recordCommandRequest({ id = REQUEST, command = COMMAND, joined = false } = {}) {
      fs.appendFileSync(path.join(dir, `${CONNECTION}.requests.jsonl`), [
        { op: 'open', id, kind: 'command', message_id: command.messageId },
        joined ? { op: 'joined', id } : { op: 'current', ref: id },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n')
    },
    /** The settle point's replies: what is certain, never that the command failed (uncertainTurnFailureMessage). */
    uncertainReplies: () => stub.landed('post_session_message').filter((args) => args.complete_turn === true && args.message.includes('before it answered this')),
    /** Whether the poller has asked DevSpec to show Working since `from` (a poll index). */
    busySince: (from) => stub.polls.slice(from).some((poll) => poll.busy === true),
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
// The working attempt ended without saying which command finished (turn-commands.mjs attemptEndArguments).
const attemptEnded = { connection_id: CONNECTION, reason: 'turn_end' }

describe('the poller reports a turn end from the transcript when no stop hook runs', () => {
  it('A1/T1: a turn that ran: the command it started is finished within seconds and Working clears', async () => {
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
      assert.ok(await until(() => !run.turnOpen()), 'Working is no longer asserted')
      const after = run.stub.polls.length
      assert.ok(await until(() => run.stub.polls.slice(after - 1).some((poll) => poll.busy === false)), 'busy:false reaches DevSpec')
      await run.laps()
      assert.deepEqual(run.completions(), [finished()], 'reported once')
      assert.deepEqual(run.failurePosts(), [], 'a turn that ran posts nothing for the agent')
    } finally {
      await run.cleanup()
    }
  })

  it('B1/B2/A7/T2 (DevSpec\'s fixture): a typed turn already running at handover: its error is told at once and Working cleared; once Cursor has been idle SETTLE_MS, the command is answered with what is certain and its request closed', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      // A prompt typed at the terminal is running when the command arrives.
      const running = [...run.connected, user('typed at the terminal'), answer('Looking.')]
      writeTranscript(run.transcript, running)
      await run.deliver()
      run.recordCommandRequest()
      for (const last of [ended('completed'), { type: 'turn_end', status: 'error' }, '{"type":"turn_ended","sta']) {
        writeTranscript(run.transcript, [...running, last])
        await run.laps()
        assert.equal(run.turnOpen(), true, `unrecognised, nothing done: ${JSON.stringify(last)}`)
      }
      writeTranscript(run.transcript, [...running, answer('Here it is.'), ended('success')])
      await run.laps()
      assert.deepEqual(run.completions(), [], 'a turn that ran ends as before')
      assert.equal(run.turnOpen(), true)

      writeTranscript(run.transcript, [...running, answer('Here it is.'), ended('error', LIMIT)])
      assert.ok(await until(() => run.roomNotices().length >= 1), `the room was not told; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.ok(run.roomNotices()[0].message.includes(LIMIT), "in Cursor's words")
      assert.deepEqual(run.failurePostsSent(), [], 'never an answer to the command')
      assert.deepEqual(run.completions(), [attemptEnded], 'the working attempt ended at once, naming no command')
      assert.deepEqual(run.requestCloses(), [], 'nor its request closed')
      assert.deepEqual(run.openRequests(), [REQUEST])
      assert.ok(!fs.readFileSync(path.join(run.dir, `${CONNECTION}.requests.jsonl`), 'utf8').includes('"answered"'), 'nor marked answered')
      assert.equal(run.turnOpen(), false, 'Working clears')

      // Cursor stays idle: at the settle point the command is answered, uncertainly.
      const noticedAt = run.stub.calls.find((call) => call.name === 'post_session_message' && !call.args.connection_id).at
      assert.ok(await until(() => run.requestCloses().length >= 1, SETTLE_MS + 10_000), `not settled; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.failurePostsSent().length, 1, 'answered once')
      const reply = run.uncertainReplies()[0]
      assert.ok(reply, 'with what is certain')
      assert.ok(run.stub.calls.find((call) => call.args === reply).at - noticedAt >= SETTLE_MS - 1_000, 'only after the settle window')
      assert.ok(reply.message.includes('Cursor ended a turn with an error before it answered this') && reply.message.includes(LIMIT))
      assert.ok(reply.message.includes('If Cursor runs it later, its answer will appear here.'))
      assert.ok(!/couldn't finish this|send your message again/i.test(reply.message), 'never that the command itself failed')
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.deepEqual(run.openRequests(), [])
      assert.equal(run.roomNotices().length, 1, 'the notice is not repeated')
    } finally {
      await run.cleanup()
    }
  })
})

describe('an error or a stop is told to the room in Cursor\'s words, once, whoever sees it first', () => {
  for (const [status, words] of [['error', LIMIT], ['aborted', 'was stopped before it finished']]) {
    it(`C3/${status === 'error' ? 'T2' : 'T3'}: ${status}: the poller first, then Cursor runs the stop hook: the definite reply`, async () => {
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

  for (const [code, what, rows] of [
    ['A14/C10/T5/T9 (DevSpec\'s finding)', 'Cursor summarised the conversation during the command', (connected) => [...connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)]],
    ['A5/C10/T7/T9', 'Cursor rewrote the conversation shorter', () => [answer('Summary of the conversation so far.'), WAKE, ended('error', LIMIT)]],
  ]) {
    it(`${code}: an error after ${what}: a notice and the working attempt ended at once; the stop hook then answers the command and closes its request, without a second notice`, async () => {
      const run = await startPoller({ attached: true, capability: true })
      try {
        await run.deliver()
        run.recordCommandRequest()
        writeTranscript(run.transcript, rows(run.connected))
        assert.ok(await until(() => run.completions().length >= 1), `the attempt was not ended; stderr:\n${run.stderr()}`)
        assert.equal(run.roomNotices().length, 1, 'the room is told')
        assert.ok(run.roomNotices()[0].message.includes(LIMIT), "in Cursor's words")
        assert.deepEqual(run.completions(), [attemptEnded], 'the attempt ended, naming no command')
        assert.deepEqual(run.failurePostsSent(), [], 'not certain: never the command\'s answer')
        assert.deepEqual(run.requestCloses(), [], 'nor its request closed')
        // The end is seen by DevSpec before the poller has its answer and clears the marker.
        assert.ok(await until(() => !run.turnOpen()), 'Working clears')

        // Cursor runs the stop hook (a person with a hooks file of their own): it knows its turn.
        await run.stop('error')
        await run.laps()
        assert.equal(run.roomNotices().length, 1, 'the notice is not repeated')
        assert.equal(run.failurePostsSent().length, 1, 'the command answered once')
        assert.ok(run.failurePosts()[0].message.includes(LIMIT))
        assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST], 'its request closed once')
        assert.deepEqual(run.openRequests(), [])
        assert.deepEqual(run.completions(), [attemptEnded, finished()])
        if (code.startsWith('A14')) {
          // T9: the stop hook's definite reply settled it; the settle point adds nothing.
          await sleep(SETTLE_MS + 2_000)
          await run.laps()
          assert.deepEqual(run.uncertainReplies(), [])
          assert.equal(run.failurePostsSent().length, 1)
        }
      } finally {
        await run.cleanup()
      }
    })
  }

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

  it('A1/A3/C10: a second command whose turn fails at its very start, with no user row: told once and its attempt ended; the stop hook after it adds no message', async () => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      const ran = [...run.connected.slice(0, 2), WAKE, answer('Done.')]
      writeTranscript(run.transcript, [...ran, ended('success')])
      assert.ok(await until(() => run.completions().length >= 1), `no first completion; stderr:\n${run.stderr()}`)

      await run.deliver('and the changelog', SECOND_COMMAND, 2)
      // Cursor refuses the command's turn before writing its prompt: the same rows, a new end.
      writeTranscript(run.transcript, [...ran, ended('error', LIMIT)])
      assert.ok(await until(() => run.completions().length >= 2), `the attempt was not ended; stderr:\n${run.stderr()}`)
      assert.deepEqual(run.completions(), [finished(), attemptEnded], 'the first command by name, whose turn was its own; then the attempt, naming nothing')
      await run.stop('error')
      await run.laps()
      // The stop hook knows the turn it ended was the second command's, and finishes it by name.
      assert.deepEqual(run.completions(), [finished(), attemptEnded, finished('turn_end', SECOND_COMMAND)])
      assert.deepEqual(run.failurePostsSent(), [], 'no request tracked: nothing to answer')
      assert.equal(run.roomNotices().length, 1, 'told once, in a message of its own')
      assert.ok(run.roomNotices()[0].message.includes(LIMIT))
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('A12 (DevSpec\'s fixture): an older error transcript put back with its old time: nothing told, nothing reported', async () => {
    const run = await startPoller({ attached: true })
    try {
      const older = [...run.connected.slice(0, 2), WAKE, ended('error', LIMIT)]
      await run.deliver()
      writeTranscript(run.transcript, older)
      const longAgo = Date.now() / 1000 - 3_600
      fs.utimesSync(run.transcript, longAgo, longAgo)
      await run.laps(10)
      assert.deepEqual(run.roomNotices(), [])
      assert.deepEqual(run.failurePostsSent(), [])
      assert.deepEqual(run.completions(), [])
      assert.equal(run.turnOpen(), true, 'Working stays, as before')
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

  for (const tracked of [true, false]) {
    it(`C11: the stop hook runs while the poller's notice is in flight: ${tracked ? 'it answers the command and closes its request alongside; one notice, one answer' : 'with no command to answer, it posts no notice of its own; one notice'}`, async () => {
      const run = await startPoller({ attached: true, capability: true })
      try {
        await run.deliver()
        if (tracked) run.recordCommandRequest()
        run.stub.hold('post_session_message', 2_500)
        writeTranscript(run.transcript, [...run.connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)])
        assert.ok(await until(() => run.noticesSent().length >= 1), `no notice; stderr:\n${run.stderr()}`)
        await run.stop('error')
        assert.equal(run.turnOpen(), true, 'the stop hook leaves the turn to the poller posting its notice')
        assert.ok(await until(() => run.completions().some((args) => !args.command_turn_id)), `the attempt was not ended; stderr:\n${run.stderr()}`)
        await run.laps()
        assert.equal(run.noticesSent().length, 1, 'one notice, the poller\'s')
        assert.equal(run.failurePostsSent().length, tracked ? 1 : 0, 'the stop hook answers what it can')
        assert.deepEqual(run.requestCloses().map((args) => args.request_id), tracked ? [REQUEST] : [])
        assert.deepEqual(run.completions(), [finished(), attemptEnded])
        assert.equal(run.turnOpen(), false)
      } finally {
        await run.cleanup()
      }
    })
  }

  it('C2: on a turn end the poller cannot attribute, the stop hook first: it answers and closes, and the poller adds no notice', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      // Keep the poller inside one long poll, so the stop hook claims the turn end first.
      const pollCalls = () => run.stub.calls.filter((call) => call.name === 'poll_connection').length
      run.stub.hold('poll_connection', 4_000)
      const polled = pollCalls()
      assert.ok(await until(() => pollCalls() > polled), 'the held poll began')
      writeTranscript(run.transcript, [...run.connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)])
      await run.stop('error')
      assert.equal(run.failurePosts().length, 1, 'the stop hook answered')
      await sleep(4_000)
      await run.laps()
      assert.deepEqual(run.noticesSent(), [], 'the stop hook\'s answer told the room')
      assert.equal(run.failurePostsSent().length, 1)
      assert.deepEqual(run.completions(), [finished()])
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it(`D4: the notice lands but ending the working attempt is refused: tried again ${REPORT_RETRY_MS / 1000} s later, and the room is told once`, async () => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      run.stub.fail('report_complete')
      writeTranscript(run.transcript, [...run.connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)])
      assert.ok(await until(() => run.stub.named('report_complete').length >= 1), `no attempt end; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.roomNotices().length, 1)
      assert.equal(run.turnOpen(), true, 'kept until the attempt is ended')
      assert.ok(await until(() => run.completions().length >= 1, REPORT_RETRY_MS + 10_000), `no retry; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.roomNotices().length, 1, 'told once')
      assert.deepEqual(run.stub.named('report_complete'), [attemptEnded, attemptEnded], 'the refused end and its retry')
      assert.deepEqual(run.completions(), [attemptEnded])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('A15: a turn Cursor started after the error owns Working: the notice ends no attempt', async () => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      // The notice's post is held; by the time it lands, Cursor has started the next turn.
      run.stub.hold('post_session_message', 1_500)
      const errored = [...run.connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)]
      writeTranscript(run.transcript, errored)
      assert.ok(await until(() => run.noticesSent().length >= 1), `no notice; stderr:\n${run.stderr()}`)
      writeTranscript(run.transcript, [...errored.slice(0, -1), user('<timestamp>Friday, Nov 20, 2026, 9:30 PM (UTC)</timestamp>\n<user_query>\ntry again\n</user_query>')])
      await sleep(2_000)
      await run.laps()
      assert.equal(run.roomNotices().length, 1, 'the room is told')
      assert.deepEqual(run.stub.named('report_complete'), [], 'no attempt ended under the new turn')
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('A16/T6 (requirement 3ea2b201): the transcript cannot be read when its turn end is written, then can, unchanged: the error is answered once', async (t) => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      // Put in place already unreadable, so no read can succeed before it is readable.
      const staged = `${run.transcript}.staged`
      writeTranscript(staged, [...run.connected.slice(0, 2), WAKE, ended('error', LIMIT)])
      if (!makeUnreadable(staged)) return t.skip(ROOT_READS)
      fs.renameSync(staged, run.transcript)
      const before = stampOf(run.transcript)
      await sleep(2_500)
      await run.laps()
      assert.deepEqual(run.failurePostsSent(), [], 'nothing told while it cannot be read')
      assert.equal(run.turnOpen(), true)
      fs.chmodSync(run.transcript, 0o600)
      assert.equal(stampOf(run.transcript), before, 'the same file, unchanged')
      assert.ok(await until(() => run.failurePosts().length >= 1), `not reported once readable; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.failurePostsSent().length, 1, 'told once')
      assert.ok(run.failurePosts()[0].message.includes(LIMIT))
      assert.deepEqual(run.completions(), [finished()])
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      try { fs.chmodSync(run.transcript, 0o600) } catch { /* already readable */ }
      await run.cleanup()
    }
  })

  it('A17: the snapshot at handover cannot be read, then can, unchanged: the command\'s error is answered as any other', async (t) => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      if (!makeUnreadable(run.transcript)) return t.skip(ROOT_READS)
      await run.deliver()
      run.recordCommandRequest()
      const baseline = () => JSON.parse(fs.readFileSync(path.join(run.dir, `${CONNECTION}.turn-baseline.json`), 'utf8'))
      assert.equal(baseline().pending, true, 'handover could not read it')
      fs.chmodSync(run.transcript, 0o600)
      assert.ok(await until(() => !baseline().pending), `the snapshot was not taken; stderr:\n${run.stderr()}`)
      assert.equal(baseline().between, true)
      writeTranscript(run.transcript, [...run.connected.slice(0, 2), WAKE, ended('error', LIMIT)])
      assert.ok(await until(() => run.failurePosts().length >= 1), `not reported; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.failurePostsSent().length, 1, 'answered once')
      assert.deepEqual(run.completions(), [finished()])
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      try { fs.chmodSync(run.transcript, 0o600) } catch { /* already readable */ }
      await run.cleanup()
    }
  })

  it('A15/A16: the transcript cannot be read just before the notice\'s attempt end: tried again later, never taken for a newer turn', async (t) => {
    const run = await startPoller({ attached: true })
    try {
      await run.deliver()
      run.stub.hold('post_session_message', 1_500)
      writeTranscript(run.transcript, [...run.connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)])
      assert.ok(await until(() => run.noticesSent().length >= 1), `no notice; stderr:\n${run.stderr()}`)
      // While the notice is in flight, the transcript becomes unreadable, unchanged.
      if (!makeUnreadable(run.transcript)) return t.skip(ROOT_READS)
      await sleep(2_500)
      assert.deepEqual(run.stub.named('report_complete'), [], 'not ended while it cannot be read')
      assert.equal(run.turnOpen(), true, 'kept for the next try')
      fs.chmodSync(run.transcript, 0o600)
      assert.ok(await until(() => run.completions().length >= 1, REPORT_RETRY_MS + 10_000), `never ended; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.deepEqual(run.completions(), [attemptEnded])
      assert.equal(run.noticesSent().length, 1, 'told once')
      assert.equal(run.turnOpen(), false)
    } finally {
      try { fs.chmodSync(run.transcript, 0o600) } catch { /* already readable */ }
      await run.cleanup()
    }
  })
})

describe('the settle point: an end the poller could only notice is answered with what is certain', () => {
  const typedRow = (text, at = '9:30') => user(`<timestamp>Friday, Nov 20, 2026, ${at} PM (UTC)</timestamp>\n<user_query>\n${text}\n</user_query>`)
  const STOPPED = 'User aborted/interrupted manually.'

  it('T3/T4 (measured, CLI 2026.11.19): a typed turn stopped with Ctrl+C while the command waits in Cursor; told at once, answered with what is certain after the settle window; when the person types, the held turn runs, shows Working and is reported', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      const running = [...run.connected.slice(0, 2), typedRow('run the long build'), answer('Running it.')]
      writeTranscript(run.transcript, running)
      await run.deliver()
      run.recordCommandRequest()
      // Ctrl+C: Cursor writes the stopped turn's end twice, 3 ms apart (measured).
      const stopped = [...running, ended('aborted', STOPPED)]
      writeTranscript(run.transcript, stopped)
      await sleep(3)
      writeTranscript(run.transcript, stopped)
      assert.ok(await until(() => run.roomNotices().length >= 1), `the room was not told; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.roomNotices()[0].message, 'Cursor was stopped at its terminal.', 'only what is certain')
      assert.deepEqual(run.completions(), [attemptEnded])
      assert.equal(run.turnOpen(), false, 'Working clears at once')
      // Cursor holds the command (measured: no turn in 25 s or 45 s after Ctrl+C). Ctrl+C's
      // end written again restarts the idle clock.
      await sleep(4_000)
      const rewrittenAt = Date.now()
      writeTranscript(run.transcript, stopped)
      assert.ok(await until(() => run.uncertainReplies().length >= 1, SETTLE_MS + 10_000), `not settled; stderr:\n${run.stderr()}`)
      const reply = run.uncertainReplies()[0]
      assert.ok(run.stub.calls.find((call) => call.args === reply).at - rewrittenAt >= SETTLE_MS - 1_000, 'counted from the last write of that end')
      assert.equal(reply.message, 'Cursor was stopped at its terminal before it answered this. If Cursor runs it later, its answer will appear here.')
      assert.ok(await until(() => run.requestCloses().length >= 1), 'its request closed')
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])

      // The person types; their turn runs. Then Cursor runs the held command (measured: 1.6 s after).
      const afterTyped = [...running, typedRow('ok, go on', '9:31'), answer('Going on.')]
      writeTranscript(run.transcript, [...afterTyped, ended('success')])
      await run.laps()
      assert.equal(run.turnOpen(), false, 'a typed turn is not the command\'s')
      const polled = run.stub.polls.length
      writeTranscript(run.transcript, [...afterTyped, WAKE, answer('Writing the release notes.')])
      assert.ok(await until(() => run.turnOpen() && run.busySince(polled)), `Working does not show for the held turn; stderr:\n${run.stderr()}`)
      writeTranscript(run.transcript, [...afterTyped, WAKE, answer('Here are the release notes.'), ended('success')])
      assert.ok(await until(() => !run.turnOpen()), 'and clears when it ends')
      await run.laps()
      assert.deepEqual(run.completions(), [attemptEnded, finished()], 'its end reported as the command\'s turn')
      assert.equal(run.failurePostsSent().length, 1, 'nothing more from the plugin: the agent\'s own answer reaches the room')
      assert.equal(run.roomNotices().length, 1)
    } finally {
      await run.cleanup()
    }
  })

  for (const outcome of ['success', 'error']) {
    it(`T2 (A9): a typed turn errors before the command's turn, and Cursor starts the held command within the window (measured: 1.46 s after a normal end): it is tracked and its end, ${outcome === 'success' ? 'a turn that ran' : 'an error'}, decides; no settle reply`, async () => {
      const run = await startPoller({ attached: true, capability: true })
      try {
        await run.deliver()
        run.recordCommandRequest()
        const errored = [...run.connected.slice(0, 2), typedRow('fix the test'), ended('error', LIMIT)]
        writeTranscript(run.transcript, errored)
        assert.ok(await until(() => run.roomNotices().length >= 1), `the room was not told; stderr:\n${run.stderr()}`)
        await sleep(1_500)
        const polled = run.stub.polls.length
        const head = [...errored.slice(0, -1), WAKE]
        writeTranscript(run.transcript, [...head, answer('On it.')])
        assert.ok(await until(() => run.turnOpen() && run.busySince(polled)), `not tracked; stderr:\n${run.stderr()}`)
        if (outcome === 'success') {
          run.recordAnswered()
          writeTranscript(run.transcript, [...head, answer('Done.'), ended('success')])
          assert.ok(await until(() => !run.turnOpen()), 'Working clears at its end')
          assert.deepEqual(run.completions(), [attemptEnded, finished()])
          assert.ok(await until(() => run.requestCloses().length >= 1), 'the answered request closes')
          await sleep(SETTLE_MS + 2_000)
          await run.laps()
          assert.deepEqual(run.uncertainReplies(), [], 'no settle reply: its own turn decided')
          assert.deepEqual(run.failurePostsSent(), [])
        } else {
          writeTranscript(run.transcript, [...head, ended('error', LIMIT)])
          assert.ok(await until(() => run.failurePosts().length >= 1), `not answered; stderr:\n${run.stderr()}`)
          await run.laps()
          assert.equal(run.failurePostsSent().length, 1)
          assert.ok(run.failurePosts()[0].message.startsWith("Cursor couldn't finish this."), 'its own turn: the definite reply')
          assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
        }
        assert.equal(run.roomNotices().length, 1)
      } finally {
        await run.cleanup()
      }
    })
  }

  it('T8 (gap 1): the snapshot at handover cannot be read and Cursor writes the command\'s error before it can be: told once and Working cleared at once, then answered with what is certain', async (t) => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      if (!makeUnreadable(run.transcript)) return t.skip(ROOT_READS)
      await run.deliver()
      run.recordCommandRequest()
      const baselineFile = path.join(run.dir, `${CONNECTION}.turn-baseline.json`)
      assert.equal(JSON.parse(fs.readFileSync(baselineFile, 'utf8')).pending, true)
      // The file changes (Cursor's own rewrite) before the snapshot can be taken.
      const staged = `${run.transcript}.staged`
      writeTranscript(staged, [...run.connected.slice(0, 2), WAKE, answer('Looking.'), ended('error', LIMIT)])
      fs.renameSync(staged, run.transcript)
      assert.ok(await until(() => run.roomNotices().length >= 1), `the error was not reported; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.roomNotices().length, 1, 'told once')
      assert.ok(run.roomNotices()[0].message.includes(LIMIT))
      assert.deepEqual(run.completions(), [attemptEnded])
      assert.equal(run.turnOpen(), false, 'Working cleared')
      assert.ok(await until(() => run.requestCloses().length >= 1, SETTLE_MS + 10_000), `not settled; stderr:\n${run.stderr()}`)
      assert.equal(run.uncertainReplies().length, 1)
      assert.ok(run.uncertainReplies()[0].message.includes(LIMIT))
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
    } finally {
      try { fs.chmodSync(run.transcript, 0o600) } catch { /* already readable */ }
      await run.cleanup()
    }
  })

  it('T5/T10: two commands picked up before an end the poller could only notice (a summary row in it): one reply answers both, and both requests close', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      run.recordCommandRequest({ id: SECOND_REQUEST, command: SECOND_COMMAND, joined: true })
      writeTranscript(run.transcript, [...run.connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)])
      assert.ok(await until(() => run.requestCloses().length >= 2, SETTLE_MS + 10_000), `not settled; stderr:\n${run.stderr()}`)
      await run.laps()
      assert.equal(run.uncertainReplies().length, 1, 'one reply')
      assert.equal(run.failurePostsSent().length, 1)
      assert.deepEqual(run.requestCloses().map((args) => args.request_id).sort(), [REQUEST, SECOND_REQUEST].sort())
      assert.deepEqual(run.openRequests(), [])
    } finally {
      await run.cleanup()
    }
  })

  it('T7: the first rows changed and no stop hook runs: noticed at once, then answered with what is certain', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      writeTranscript(run.transcript, [user('one'), answer('1'), user('two'), answer('2'), ...run.connected])
      await run.deliver()
      run.recordCommandRequest()
      writeTranscript(run.transcript, [answer('Summary of the conversation so far.'), WAKE, ended('aborted', STOPPED)])
      assert.ok(await until(() => run.roomNotices().length >= 1), `the room was not told; stderr:\n${run.stderr()}`)
      assert.equal(run.roomNotices()[0].message, 'Cursor was stopped at its terminal.')
      assert.ok(await until(() => run.requestCloses().length >= 1, SETTLE_MS + 10_000), `not settled; stderr:\n${run.stderr()}`)
      assert.equal(run.uncertainReplies().length, 1)
      assert.equal(run.uncertainReplies()[0].message, 'Cursor was stopped at its terminal before it answered this. If Cursor runs it later, its answer will appear here.')
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), false)
    } finally {
      await run.cleanup()
    }
  })

  it('T10: a command handed over while an end settles: the commands picked up before that end are answered at once, with what is certain', async () => {
    const run = await startPoller({ attached: true, capability: true })
    try {
      await run.deliver()
      run.recordCommandRequest()
      writeTranscript(run.transcript, [...run.connected.slice(0, 2), WAKE, answer('Looking.'), SUMMARY_ROW, ended('error', LIMIT)])
      assert.ok(await until(() => run.roomNotices().length >= 1), `the room was not told; stderr:\n${run.stderr()}`)
      const noticedAt = Date.now()
      await run.deliver('and the changelog', SECOND_COMMAND, 2)
      assert.ok(await until(() => run.uncertainReplies().length >= 1), `not answered; stderr:\n${run.stderr()}`)
      assert.ok(Date.now() - noticedAt < SETTLE_MS, 'at once, not after the window')
      assert.ok(await until(() => run.requestCloses().length >= 1))
      assert.deepEqual(run.requestCloses().map((args) => args.request_id), [REQUEST])
      assert.equal(run.turnOpen(), true, 'the new command\'s turn is tracked')
    } finally {
      await run.cleanup()
    }
  })
})
