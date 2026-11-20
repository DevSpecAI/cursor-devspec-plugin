#!/usr/bin/env node
/**
 * Item f8672ca0: when Cursor stops the agent for a usage limit, DevSpec is told until
 * when (the served contract's `semantics.check_job.usage_refusal`), the next turn that
 * runs clears it, and a stop the plugin cannot recognise as a usage limit is never
 * reported as one. Read from the transcript's turn_ended line by the poller, whether or
 * not Cursor runs the stop hook, and by the stop hook when it does.
 * Run: node --test hooks/scripts/usage-refusal.test.mjs
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPushStreamRequest, refusePushStream } from './fixtures/push-stream.mjs'
import { FIXTURE_ID } from './remote-ingress-test-fixtures.mjs'
import { resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'
import {
  USAGE_REFUSAL_COOL_OFF_MS,
  USAGE_REFUSAL_MAX_AHEAD_MS,
  isUsageRefusalText,
  lastTurnEnd,
  noteUsageRefusalSent,
  observeTurnEnd,
  refusalLiftsAt,
  usageRefusalArgument,
} from './usage-refusal.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONN = FIXTURE_ID.connection
const CONVERSATION = 'cursor-conversation-f8672ca0'

// What Cursor CLI 2026.10.19 wrote for an account at its usage limit (2026-10-31), and
// what this machine's transcripts hold up to CLI 2026.11.05.
const LIMIT = "You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more."
// Errors Cursor wrote to real transcripts that are not usage stops.
const NOT_USAGE = [
  'WritableIterable is closed',
  'Model unavailable on Free Free includes Grok 4.7, Grok 4.6, and Auto with fixed settings. Switch to an included model to continue.',
  'Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.',
  "This turn's step limit (50) needs an in-process agent loop; the network client cannot send it.",
  "You've used 92% of your usage limit.",
  "You've reached 100% of your included usage.",
]

const user = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })
const answer = (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
const ended = (status, error) => ({ type: 'turn_ended', status, ...(error ? { error } : {}) })

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-usage-refusal-'))
}

/** A time in whole seconds, which a file's modification time holds exactly. */
const second = (ms = Date.now()) => Math.floor(ms / 1000) * 1000

/** Write a transcript (rewritten whole, as Cursor does) and date it `atMs`. */
function writeTranscript(file, rows, atMs = second()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  fs.utimesSync(file, atMs / 1000, atMs / 1000)
}

describe('what counts as a usage stop', () => {
  it("recognises Cursor's usage-limit text and the usage and rate-limit phrasings", () => {
    for (const text of [
      LIMIT,
      "You've reached your monthly usage limit.",
      "You've hit your free requests limit.",
      'Rate limit exceeded. Please try again later.',
      'You are being rate limited.',
      '429 Too Many Requests',
      'You exceeded your current quota, please check your plan and billing details.',
      'RESOURCE_EXHAUSTED: quota exceeded for this model',
    ]) {
      assert.equal(isUsageRefusalText(text), true, text)
    }
  })

  it('never takes another error, a usage percentage or no text for one', () => {
    for (const text of [...NOT_USAGE, '', null, undefined]) assert.equal(isUsageRefusalText(text), false, String(text))
  })

  it('reads the time a stop says it lifts, only when it reads without a guess', () => {
    const at = Date.parse('2026-11-20T12:00:00.000Z')
    assert.equal(refusalLiftsAt('Usage limit reached. Try again in 2 hours.', at), at + 2 * 3_600_000)
    assert.equal(refusalLiftsAt('Rate limit exceeded, resets in 3h 20m', at), at + 3 * 3_600_000 + 20 * 60_000)
    assert.equal(refusalLiftsAt('Too many requests. Retry after 90 seconds', at), at + 90_000)
    assert.equal(refusalLiftsAt('429 Too Many Requests; retry-after: 30', at), at + 30_000)
    assert.equal(
      refusalLiftsAt('Usage limit reached; resets at 2026-11-21T09:00:00Z', at),
      Date.parse('2026-11-21T09:00:00Z'),
    )
    for (const vague of [LIMIT, 'Usage limit reached, resets 3pm', 'Usage limit reached until Dec 1', 'try again later']) {
      assert.equal(refusalLiftsAt(vague, at), null, vague)
    }
  })
})

describe('reading the turn end from the transcript', () => {
  it('finds the last turn_ended line, says whether it is final, and dates it by the file', () => {
    const dir = scratch()
    try {
      const file = path.join(dir, 't.jsonl')
      const at = Date.parse('2026-11-20T12:00:00.000Z')
      writeTranscript(file, [user('hi'), ended('error', LIMIT)], at)
      const end = lastTurnEnd(file)
      assert.equal(end.status, 'error')
      assert.equal(end.error, LIMIT)
      assert.equal(end.final, true)
      assert.equal(end.atMs, at)

      writeTranscript(file, [user('hi'), ended('error', LIMIT), user('again')], at)
      assert.equal(lastTurnEnd(file).final, false, 'a prompt written below it')
      assert.equal(lastTurnEnd(path.join(dir, 'missing.jsonl')), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never reads the partial first line of a long transcript as a turn end', () => {
    const dir = scratch()
    try {
      const file = path.join(dir, 't.jsonl')
      // One row larger than the tail that is read, so the tail starts inside it.
      writeTranscript(file, [ended('error', LIMIT), answer('x'.repeat(200 * 1024))])
      assert.equal(lastTurnEnd(file), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('what is reported, turn end by turn end', () => {
  let dir
  let file
  beforeEach(() => {
    dir = scratch()
    file = path.join(dir, 'transcript.jsonl')
  })
  const observe = (nowMs) => observeTurnEnd(CONN, file, { dir, nowMs })
  const argument = (nowMs) => usageRefusalArgument(CONN, { dir, nowMs })

  it('a usage stop with no time is reported for the cool-off from when it happened', () => {
    const at = second(Date.now() - 60_000)
    writeTranscript(file, [user('fix the test'), ended('error', LIMIT)], at)
    observe(Date.now())
    assert.deepEqual(argument(Date.now()), { usage_refused_until: new Date(at + USAGE_REFUSAL_COOL_OFF_MS).toISOString() })
    // Seen again on later laps, it is the same stop: its time does not slide forward.
    observe(Date.now() + 5_000)
    assert.deepEqual(argument(Date.now()), { usage_refused_until: new Date(at + USAGE_REFUSAL_COOL_OFF_MS).toISOString() })
    // Once its time has passed it is no longer sent: DevSpec has cleared it too.
    assert.deepEqual(argument(at + USAGE_REFUSAL_COOL_OFF_MS + 1), {})
  })

  it('a usage stop that says when it lifts is reported until then, held to seven days', () => {
    const at = second()
    writeTranscript(file, [user('fix the test'), ended('error', 'Usage limit reached. Try again in 2 hours.')], at)
    observe(at)
    assert.deepEqual(argument(at), { usage_refused_until: new Date(at + 2 * 3_600_000).toISOString() })

    writeTranscript(file, [user('again'), ended('error', 'Usage limit reached. Try again in 30 days.')], at)
    observe(at)
    assert.deepEqual(argument(at), { usage_refused_until: new Date(at + USAGE_REFUSAL_MAX_AHEAD_MS).toISOString() })
  })

  it('a turn that runs clears it: null until a status update carrying it is delivered, then nothing', () => {
    const at = second()
    writeTranscript(file, [user('fix the test'), ended('error', LIMIT)], at)
    observe(at)
    assert.equal(typeof argument(at).usage_refused_until, 'string')

    writeTranscript(file, [user('fix the test'), user('try again'), answer('Fixed.'), ended('success')], at + 1_000)
    observe(at + 1_000)
    assert.deepEqual(argument(at + 1_000), { usage_refused_until: null })
    assert.deepEqual(argument(at + 2_000), { usage_refused_until: null }, 'repeated until delivered')
    noteUsageRefusalSent(CONN, { usage_refused_until: null }, { dir })
    assert.deepEqual(argument(at + 3_000), {})
  })

  it('a turn that runs with nothing standing sends nothing', () => {
    writeTranscript(file, [user('hi'), answer('Hello.'), ended('success')])
    observe(Date.now())
    assert.deepEqual(argument(Date.now()), {})
  })

  it('an error that is not a usage stop is not reported, and leaves a standing one as it was', () => {
    const at = second()
    for (const error of NOT_USAGE) {
      writeTranscript(file, [user('hi'), ended('error', error)], at)
      observe(at)
      assert.deepEqual(argument(at), {}, error)
    }
    writeTranscript(file, [user('hi'), ended('error', LIMIT)], at)
    observe(at)
    const standing = argument(at)
    writeTranscript(file, [user('hi'), user('again'), ended('error', 'WritableIterable is closed')], at + 1_000)
    observe(at + 1_000)
    assert.deepEqual(argument(at + 1_000), standing)
  })

  it('a person stopping the turn is not a usage stop, whatever its text', () => {
    writeTranscript(file, [user('hi'), ended('aborted', LIMIT)])
    observe(Date.now())
    assert.deepEqual(argument(Date.now()), {})
  })

  it('a usage stop that cannot be dated or has already lifted is not reported', () => {
    writeTranscript(file, [user('hi'), ended('error', LIMIT), user('again')])
    observe(Date.now())
    assert.deepEqual(argument(Date.now()), {}, 'a prompt already written below it')

    writeTranscript(file, [user('hi'), ended('error', LIMIT)], Date.now() - USAGE_REFUSAL_COOL_OFF_MS - 60_000)
    observe(Date.now())
    assert.deepEqual(argument(Date.now()), {}, 'its cool-off ended before it was seen')
  })

  it('a clear delivered after a newer stop was recorded never erases the stop', () => {
    const at = second()
    writeTranscript(file, [user('hi'), ended('error', LIMIT)], at)
    observe(at)
    writeTranscript(file, [user('hi'), answer('Done.'), ended('success')], at + 1_000)
    observe(at + 1_000)
    const clear = argument(at + 1_000)
    writeTranscript(file, [user('hi'), answer('Done.'), user('more'), ended('error', LIMIT)], at + 2_000)
    observe(at + 2_000)
    noteUsageRefusalSent(CONN, clear, { dir })
    assert.equal(typeof argument(at + 2_000).usage_refused_until, 'string')
  })
})

/** A stub DevSpec that answers every call and records it; polls return idle quickly. */
async function stubDevSpec() {
  const calls = []
  const server = http.createServer((request, response) => {
    if (isPushStreamRequest(request)) return refusePushStream(response)
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      const name = parsed.params?.name
      calls.push({ name, args: parsed.params?.arguments ?? {} })
      if (name === 'poll_connection') await new Promise((resolve) => setTimeout(resolve, 50))
      const result = name === 'poll_connection'
        ? { status: 'live', session_id: null, changed: false, cursor: null, cursor_v2: null, dispatch_cursor: null }
        : { ok: true }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/api/mcp`,
    calls,
    named: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

function scratchHome(mcpUrl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-usage-refusal-home-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, `${CONN}.json`), JSON.stringify({
    enabled: true,
    connection_id: CONN,
    session_id: null,
    agent_name: 'Cursor',
    local_id: CONVERSATION,
    token: 'dvs_test_token',
    mcp_url: mcpUrl,
    ingress_version: 1,
  }), { mode: 0o600 })
  // Where Cursor keeps the conversation's agent transcript.
  const transcript = path.join(home, '.cursor', 'projects', 'home-dev-app', 'agent-transcripts', CONVERSATION, `${CONVERSATION}.jsonl`)
  return { home, dir, transcript }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(25)
  return condition()
}

describe('the poller reports it on every poll, with no stop hook running', () => {
  it('reports a usage stop, repeats it, clears it after a turn that runs, and ignores another error', async () => {
    const stub = await stubDevSpec()
    const { home, transcript } = scratchHome(stub.url)
    writeTranscript(transcript, [user('hi'), answer('Hello.'), ended('success')])
    const child = spawn(process.execPath, [path.join(HERE, 'devspec-remote-poll.mjs'), '--connection-id', CONN], {
      env: { ...process.env, HOME: home },
    })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const polls = () => stub.named('poll_connection')
    const carrying = (from) => polls().slice(from).filter((args) => Object.hasOwn(args, 'usage_refused_until'))
    try {
      assert.ok(await until(() => polls().length >= 2), `no polls; stderr:\n${stderr}`)
      assert.deepEqual(carrying(0), [], 'nothing is reported before any usage stop')

      const stoppedAt = second()
      writeTranscript(transcript, [user('hi'), answer('Hello.'), user('fix the test'), ended('error', LIMIT)], stoppedAt)
      const expected = new Date(stoppedAt + USAGE_REFUSAL_COOL_OFF_MS).toISOString()
      assert.ok(await until(() => carrying(0).length >= 3), `the stop is not repeated; stderr:\n${stderr}`)
      assert.deepEqual(carrying(0).map((args) => args.usage_refused_until).slice(0, 3), [expected, expected, expected])

      const beforeRun = polls().length
      writeTranscript(transcript, [user('fix the test'), user('try again'), answer('Fixed.'), ended('success')])
      assert.ok(await until(() => carrying(beforeRun).some((args) => args.usage_refused_until === null)), `no clear; stderr:\n${stderr}`)
      const cleared = polls().length
      assert.ok(await until(() => polls().length >= cleared + 3))
      assert.deepEqual(carrying(cleared), [], 'the clear is sent until delivered, then nothing')

      const beforeOther = polls().length
      writeTranscript(transcript, [user('fix the test'), user('one more'), ended('error', 'WritableIterable is closed')])
      assert.ok(await until(() => polls().length >= beforeOther + 4))
      assert.deepEqual(carrying(beforeOther), [], 'an error that is not a usage stop is never reported as one')
    } finally {
      child.kill('SIGKILL')
      await stub.close()
      try { fs.rmSync(resolveSpaceFreeWakeFile(CONN), { force: true }) } catch { /* nothing to clean */ }
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the stop hook reports it on its own heartbeat when Cursor runs it', () => {
  let stub
  let scratchDirs
  before(async () => { stub = await stubDevSpec() })
  after(() => stub.close())
  beforeEach(() => {
    scratchDirs = scratchHome(stub.url)
    stub.calls.length = 0
  })

  function stop(input) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, 'mirror-turn.mjs'), 'stop'], {
        env: { PATH: process.env.PATH, HOME: scratchDirs.home, CURSOR_CONVERSATION_ID: CONVERSATION },
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      child.on('error', reject)
      child.on('exit', resolve)
      child.stdin.end(JSON.stringify({ hook_event_name: 'stop', conversation_id: CONVERSATION, ...input }))
    })
  }
  const heartbeat = () => stub.named('heartbeat_connection').at(-1)

  it('a usage stop rides the heartbeat, and the next turn that runs sends null once', async () => {
    const { transcript, home } = scratchDirs
    try {
      const stoppedAt = second()
      writeTranscript(transcript, [user('fix the test'), ended('error', LIMIT)], stoppedAt)
      await stop({ status: 'error', transcript_path: transcript })
      assert.equal(heartbeat().usage_refused_until, new Date(stoppedAt + USAGE_REFUSAL_COOL_OFF_MS).toISOString())

      writeTranscript(transcript, [user('fix the test'), user('again'), answer('Fixed.'), ended('success')])
      await stop({ status: 'completed', transcript_path: transcript })
      assert.equal(heartbeat().usage_refused_until, null)

      await stop({ status: 'completed', transcript_path: transcript })
      assert.equal(Object.hasOwn(heartbeat(), 'usage_refused_until'), false, 'cleared once, then nothing')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('an error that is not a usage stop sends nothing', async () => {
    const { transcript, home } = scratchDirs
    try {
      writeTranscript(transcript, [user('fix the test'), ended('error', 'WritableIterable is closed')])
      await stop({ status: 'error', transcript_path: transcript })
      assert.ok(heartbeat(), 'the stop hook sent its heartbeat')
      assert.equal(Object.hasOwn(heartbeat(), 'usage_refused_until'), false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
