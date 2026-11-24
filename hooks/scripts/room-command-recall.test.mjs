#!/usr/bin/env node
/**
 * A command sent from a DevSpec room gets DevSpec's project recall for that turn
 * (turn-recall.mjs): the real poller against a stub DevSpec, then the real wait that
 * hands the command to Cursor, all in a temporary home.
 *
 * - The poller negotiates the recall on every poll and sends what this conversation
 *   was already shown; the recall goes into the inbox with the command and into the
 *   wake right after it, and only then counts as shown.
 * - A recall too long for one wake is handed over whole in a note the wake points to,
 *   and its records count as shown only once the agent has read every part of it.
 * - An automation run gets the recall the same way; a check job never carries one,
 *   and when a delivery holds both a command and an automation run only the command
 *   carries it.
 * - A recall DevSpec could not finish, or a malformed one, or a seen store that
 *   cannot be read, leaves the command to arrive as before.
 * - A recall that takes DevSpec's whole shared time budget still arrives with its
 *   command: the poll's own deadline is far beyond it.
 *
 * No --owner-pid is passed, so the poller arms no wake-follow (that needs an owner),
 * and the test runs the wait itself, once per wake, as the backstop re-arm does.
 * Run: node --test hooks/scripts/room-command-recall.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPushStreamRequest, refusePushStream } from './fixtures/push-stream.mjs'
import {
  FIXTURE_ID,
  fixtureAutomationDispatch,
  fixtureCommand,
  fixtureEnvelope,
  fixtureOrder,
  fixtureUuid,
} from './remote-ingress-test-fixtures.mjs'
import { resolveSpaceFreeWakeFile, splitWakes, wakeLines, wakesWaitingEvent } from './devspec-wake-file.mjs'
import { NOTHING_UNREAD, readerHeader } from './devspec-wake-tail.mjs'
import { fitsShellOutput, readNoteText } from './hook-context-budget.mjs'
import { RECALL_IN_NEXT_WAKE, RECALL_UNSAVED_NOTE, seenRecallKeys, seenStoreFile } from './turn-recall.mjs'
import { withoutEndedConnectionWakes } from './step-delivery.mjs'
import { catCall, noteFiles } from '../../tests/helpers/note-reads.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const POLL_SCRIPT = path.join(HERE, 'devspec-remote-poll.mjs')
const WAIT_SCRIPT = path.join(HERE, 'devspec-remote-wait.mjs')
const TAIL_SCRIPT = path.join(HERE, 'devspec-wake-tail.mjs')
const CONNECTION = FIXTURE_ID.connection
const CHAT = 'cursor-chat-recall-test'

/**
 * How long every DevSpec plugin waits for a turn's recall (DevSpecV2
 * packages/core/src/recall/budget.ts HOST_RECALL_WAIT_MS): DevSpec gives up before it.
 */
const SHARED_RECALL_BUDGET_MS = 4_800

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the agent runs when a wake's notification arrives: the wake reader, once; its whole output. */
function readWakesAsTheAgentDoes(home, wakeFile) {
  const run = spawnSync(process.execPath, [TAIL_SCRIPT, 'read', '--file', wakeFile], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30_000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stderr, '', 'nothing beside the wakes in the output')
  return run.stdout
}

const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(25)
  return condition()
}

const key = (n) => `memory:00000000-0000-4000-8000-${String(n).padStart(12, '0')}:v1`

function recall(n, title = `Decision ${n}`) {
  return {
    version: 1,
    cards: [{ seenKey: key(n), dedupe_key: key(n) }],
    formatted_block: `== PROACTIVE PROJECT RECALL ==\nProject records surfaced automatically for this turn.\n- [MEMORY · decision] **${title}** (get_memory({ id: "${key(n)}" }))`,
    seen_keys: [key(n)],
    latency_ms: 812,
  }
}

function command(sequence, body) {
  const messageId = fixtureUuid(700 + sequence)
  const turnId = fixtureUuid(800 + sequence)
  const provenance = fixtureUuid(900 + sequence)
  const base = fixtureCommand(body)
  return {
    ...base,
    message_id: messageId,
    order: fixtureOrder(sequence, messageId),
    delivery: { ...base.delivery, turn_id: turnId, provenance_ref: provenance, primary_provenance_ref: provenance },
  }
}

const commandPoll = (sequence, body, over = {}) => ({
  status: 'live',
  session_id: null,
  changed: true,
  cursor: fixtureUuid(700 + sequence),
  cursor_v2: `after:command-${sequence}`,
  dispatch_cursor: 'dispatch-0',
  ingress: fixtureEnvelope({ envelopeId: fixtureUuid(500 + sequence), commands: [command(sequence, body)] }),
  dispatches: [],
  ...over,
})

const dispatchPoll = (dispatches, over = {}) => ({
  status: 'live',
  session_id: null,
  changed: true,
  cursor: null,
  cursor_v2: 'after:dispatch-1',
  dispatch_cursor: '2026-11-20T12:00:00.000Z',
  ingress: fixtureEnvelope({ envelopeId: fixtureUuid(600), wakeKind: 'advisory_update', commands: [] }),
  dispatches,
  ...over,
})

function checkJob() {
  const id = fixtureUuid(400)
  return {
    id,
    kind: 'check_job',
    check_job_id: id,
    check_kind: 'conflict',
    record: { type: 'task', id: fixtureUuid(401), title: 'Fix the login redirect' },
    entries: 1,
    yours: false,
    offered_at: '2026-11-20T12:00:00.000Z',
    delivery_connection_id: CONNECTION,
  }
}

/** A stub DevSpec that serves queued poll responses, one per poll, and records every poll's arguments. */
async function stubDevSpec() {
  const polls = []
  const calls = []
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
      calls.push({ name, args })
      let result = {}
      if (name === 'poll_connection') {
        polls.push(args)
        const next = queue.shift()
        if (next) {
          const { delayMs = 0, ...payload } = next
          if (delayMs) await sleep(delayMs)
          idleCursor = { cursor: payload.cursor, cursor_v2: payload.cursor_v2, dispatch_cursor: payload.dispatch_cursor }
          result = payload
        } else {
          await sleep(100)
          result = { status: 'live', session_id: null, changed: false, ...idleCursor }
        }
      } else if (name === 'report_pickup') {
        result = { outcome: 'picked_up' }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    polls,
    named: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
    serve: (payload) => queue.push(payload),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

async function startPoller({ beforeStart } = {}) {
  const stub = await stubDevSpec()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-room-recall-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true,
    connection_id: CONNECTION,
    session_id: null,
    local_id: CHAT,
    agent_name: 'Cursor',
    token: 'dvs_test_token',
    mcp_url: stub.url,
    ingress_version: 1,
  }), { mode: 0o600 })
  beforeStart?.(home)
  const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], { env: { ...process.env, HOME: home } })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const inbox = path.join(dir, `${CONNECTION}.inbox.jsonl`)
  const records = () => {
    try {
      return fs.readFileSync(inbox, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  return {
    home,
    stub,
    stderr: () => stderr,
    records,
    /** The wait, started on the inbox and left running: what it printed so far, and its exit. */
    startWait() {
      const wait = spawn(process.execPath, [WAIT_SCRIPT, '--connection-id', CONNECTION, '--pending', '--poll-ms', '20'], {
        env: { ...process.env, HOME: home },
      })
      let out = ''
      let err = ''
      wait.stdout.on('data', (chunk) => { out += chunk })
      wait.stderr.on('data', (chunk) => { err += chunk })
      const exited = new Promise((resolve) => wait.once('close', resolve))
      return {
        stdout: () => out,
        stderr: () => err,
        events: () => out.split('\n').filter(Boolean).map((line) => JSON.parse(line)),
        exited,
        kill: () => wait.kill('SIGKILL'),
      }
    },
    /** The connection's state file, as the wait reads it. */
    state: () => JSON.parse(fs.readFileSync(path.join(dir, `${CONNECTION}.json`), 'utf8')),
    patchState: (patch) => {
      const file = path.join(dir, `${CONNECTION}.json`)
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }), { mode: 0o600 })
      fs.renameSync(tmp, file)
    },
    /** What the wait hands Cursor for the next wake in the inbox, as the events it writes. */
    async nextWake() {
      const wait = spawn(process.execPath, [WAIT_SCRIPT, '--connection-id', CONNECTION, '--pending', '--poll-ms', '20'], {
        env: { ...process.env, HOME: home },
      })
      let out = ''
      let err = ''
      wait.stdout.on('data', (chunk) => { out += chunk })
      wait.stderr.on('data', (chunk) => { err += chunk })
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => wait.kill('SIGKILL'), 10_000)
        wait.once('close', (exit) => { clearTimeout(timer); resolve(exit) })
      })
      assert.equal(code, 0, `the wait did not wake; stderr:\n${err}`)
      return out.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
    async cleanup() {
      child.kill('SIGKILL')
      await stub.close()
      try { fs.rmSync(resolveSpaceFreeWakeFile(CONNECTION), { force: true }) } catch { /* nothing to clean */ }
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const AFTER_TOOL_RECALL = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'hooks.json'), 'utf8')).hooks.postToolUse
  .find((entry) => entry.command.includes('turn-recall.mjs'))

/** The plugin's postToolUse hook that counts recall-note reads, run as hooks.json has Cursor run it. It only observes. */
function runAfterTool(home, input) {
  const run = spawnSync('sh', ['-c', AFTER_TOOL_RECALL.command], {
    input: JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: path.resolve(HERE, '..', '..') },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, '{}', 'it adds nothing, and still answers Cursor (item 6ddde907)')
}

/** The agent reads a recall's note whole, part by part, as the postToolUse hook sees it. */
function readNote(home, read) {
  const id = /notes\/([0-9a-f]{16})\.md$/.exec(read)[1]
  for (const file of noteFiles(home, id)) runAfterTool(home, catCall(home, file, { conversation: CHAT }))
  return id
}

describe('a command sent from a DevSpec room gets its project recall', () => {
  it('asks for it on every poll, hands it over right after the command, and leaves out what the conversation was shown', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      assert.equal(run.stub.polls[0].turn_recall_version, 1)
      assert.equal(run.stub.polls[0].seen_recall_versions, undefined, 'nothing shown yet')

      run.stub.serve(commandPoll(1, 'Why does the settings page redirect to login?', { turn_recall: recall(1) }))
      assert.ok(await until(() => run.records().some((r) => r.type === 'owner_messages')), `no command kept; stderr:\n${run.stderr()}`)
      const kept = run.records().find((r) => r.type === 'owner_messages')
      assert.deepEqual(kept.turn_recall, { version: 1, formatted_block: recall(1).formatted_block, seen_keys: [key(1)] })
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [], 'not shown until the wake hands it over')

      const events = await run.nextWake()
      assert.deepEqual(events.map((e) => e.type), ['owner_message', 'turn_recall', 'wake'])
      const carried = events.find((e) => e.type === 'turn_recall')
      assert.equal(carried.block, undefined, 'the recall is always in a note')
      assert.equal(readNoteText(/notes\/([0-9a-f]{16})\.md$/.exec(carried.read)[1], { home: run.home }), recall(1).formatted_block)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [], 'printed is not read')
      readNote(run.home, carried.read)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(1)])

      // The next poll leaves out what the conversation has been shown.
      const after = run.stub.polls.length
      assert.ok(await until(() => run.stub.polls.slice(after).some((p) => p.seen_recall_versions?.includes(key(1)))), 'the shown version goes with the next poll')

      // The next command's recall is handed over too, and joins what was shown.
      run.stub.serve(commandPoll(2, 'And make the redirect keep the return path', { turn_recall: recall(2) }))
      assert.ok(await until(() => run.records().filter((r) => r.type === 'owner_messages').length === 2))
      const second = await run.nextWake()
      readNote(run.home, second.find((e) => e.type === 'turn_recall').read)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(1), key(2)])
    } finally {
      await run.cleanup()
    }
  })

  it('gives an automation run its recall the same way, and never a check job', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.stub.serve(dispatchPoll([checkJob()], { turn_recall: recall(3) }))
      assert.ok(await until(() => run.records().some((r) => r.type === 'check_job_dispatches')), `no check job kept; stderr:\n${run.stderr()}`)
      assert.equal(run.records().find((r) => r.type === 'check_job_dispatches').turn_recall, undefined)
      const job = await run.nextWake()
      assert.equal(job.some((e) => e.type === 'turn_recall'), false)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])

      run.stub.serve(dispatchPoll([fixtureAutomationDispatch()], { turn_recall: recall(4), dispatch_cursor: '2026-11-20T12:01:00.000Z' }))
      assert.ok(await until(() => run.records().some((r) => r.type === 'automation_dispatches')), `no run kept; stderr:\n${run.stderr()}`)
      const events = await run.nextWake()
      assert.deepEqual(events.map((e) => e.type), ['automation_dispatch', 'turn_recall', 'wake'])
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])
      readNote(run.home, events[1].read)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(4)])
    } finally {
      await run.cleanup()
    }
  })

  it('hands over a recall too long for one wake whole, in a note the wake points to', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      // Every requirement that qualifies is shown, uncapped, so a recall can outgrow one output.
      const lines = Array.from({ length: 400 }, (_, n) => `- [REQUIREMENT] **Requirement ${n}** — ${'governs this change; '.repeat(4)}(get_requirement({ id: "${n}" }))`)
      const big = { ...recall(8), formatted_block: `== PROACTIVE PROJECT RECALL ==\n${lines.join('\n')}` }
      run.stub.serve(commandPoll(1, 'Which requirements govern the settings page?', { turn_recall: big }))
      assert.ok(await until(() => run.records().some((r) => r.type === 'owner_messages')), `no command kept; stderr:\n${run.stderr()}`)
      const events = await run.nextWake()
      assert.deepEqual(events.map((e) => e.type), ['owner_message', 'turn_recall', 'wake'])
      const carried = events[1]
      assert.equal(carried.block, undefined)
      assert.ok(noteFiles(run.home, /notes\/([0-9a-f]{16})\.md/.exec(carried.read)[1]).length > 1)
      const id = /^cat ~\/\.devspec\/notes\/([0-9a-f]{16})\.md$/.exec(carried.read)[1]
      assert.equal(readNoteText(id, { home: run.home }), big.formatted_block, 'the note holds the whole recall')
      assert.ok(fitsShellOutput(wakeLines(events)), 'and the wake that points to it reaches the agent whole')

      // Pointed at is not shown: until the agent reads the note, its records stay unshown
      // and the next poll does not leave them out.
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])
      const before = run.stub.polls.length
      assert.ok(await until(() => run.stub.polls.length > before + 1))
      assert.equal(run.stub.polls.at(-1).seen_recall_versions, undefined)

      // The agent reads every part, and the plugin's postToolUse hook sees each read.
      for (const file of noteFiles(run.home, id)) runAfterTool(run.home, catCall(run.home, file, { conversation: CHAT }))
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(8)])
      assert.ok(await until(() => run.stub.polls.at(-1)?.seen_recall_versions?.includes(key(8))), 'now the next poll leaves them out')
    } finally {
      await run.cleanup()
    }
  })

  /** Command bodies that make the real wake a given length, measured on a first command with no recall. */
  async function measuredBodies(run) {
    // The wake carries the body twice (the command's text, and the message it came in).
    run.stub.serve(commandPoll(1, 'a'.repeat(100)))
    assert.ok(await until(() => run.records().length === 1), `no command kept; stderr:\n${run.stderr()}`)
    const around = wakeLines(await run.nextWake()).length - 2 * 100
    return (chars) => 'a'.repeat(Math.floor((chars - around - 2) / 2)) // body_chars gains up to two digits
  }
  const mediumRecall = (n) => ({ ...recall(n), formatted_block: `== PROACTIVE PROJECT RECALL ==\n${Array.from({ length: 16 }, (_, i) => `- [MEMORY · decision] **Decision ${i}** — the settings page keeps its redirect (get_memory({ id: "${i}" }))`).join('\n')}` })

  it('near Cursor\'s limit (19,870 characters with the command alone): the command goes inline in its own wake, byte for byte, and a pointer-only wake naming it follows; the reader prints both whole, in order', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      const tight = bodyFor(19_870)
      run.stub.serve(commandPoll(2, tight, { turn_recall: mediumRecall(9) }))
      assert.ok(await until(() => run.records().length === 2), `no command kept; stderr:\n${run.stderr()}`)

      // The host's follow writes the wake file the reader prints.
      const wakeFile = path.join(run.home, 'wake.jsonl')
      const follow = spawn(process.execPath, [WAIT_SCRIPT, '--connection-id', CONNECTION, '--pending', '--follow', '--wake-file', wakeFile, '--owner-pid', String(process.pid), '--poll-ms', '20'], {
        env: { ...process.env, HOME: run.home },
      })
      let followLog = ''
      follow.stderr.on('data', (chunk) => { followLog += chunk })
      try {
        assert.ok(await until(() => fs.existsSync(wakeFile) && fs.readFileSync(wakeFile, 'utf8').includes('turn_recall')), 'no wake written')
        // Stopped only once it has finished the delivery (its recall waits to be read), not
        // between writing the wake and recording the recall.
        assert.ok(await until(() => /wake \(1 msg\) — follow/.test(followLog)), `the follow did not finish the delivery:\n${followLog}`)
      } finally {
        follow.kill('SIGKILL')
      }
      const file = fs.readFileSync(wakeFile, 'utf8')
      // The reader, run as its header says: the command's wake, then its recall's.
      const first = readWakesAsTheAgentDoes(run.home, wakeFile)
      const second = readWakesAsTheAgentDoes(run.home, wakeFile)
      assert.ok(fitsShellOutput(first) && fitsShellOutput(second))
      assert.ok(first.startsWith(readerHeader(1, 1)), first.slice(0, 120))
      assert.ok(second.startsWith(readerHeader(1, 0)), second.slice(0, 120))
      assert.equal(first.slice(readerHeader(1, 1).length) + second.slice(readerHeader(1, 0).length), file, 'two whole wakes, nothing else')
      const commandWake = first.slice(readerHeader(1, 1).length).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const recallWake = second.slice(readerHeader(1, 0).length).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      assert.deepEqual(commandWake.map((e) => e.type), ['owner_message', 'wake', 'recall_in_next_wake'], 'the command\'s own print says its recall is next')
      assert.equal(commandWake[0].body, tight, 'the command inline, byte for byte')
      assert.deepEqual(recallWake.map((e) => e.type), ['turn_recall'])
      assert.equal(recallWake[0].for, commandWake[0].message_id, 'naming the command it belongs to')
      assert.equal(recallWake[0].block, undefined, 'a pointer only')
      assert.equal(readNoteText(/notes\/([0-9a-f]{16})\.md$/.exec(recallWake[0].read)[1], { home: run.home }), mediumRecall(9).formatted_block)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [], 'printed is not read')
      readNote(run.home, recallWake[0].read)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(9)], 'shown once its note is read')

      // 19,000 characters alone: the recall does not fit inline, its short pointer does.
      const roomy = bodyFor(19_000)
      run.stub.serve(commandPoll(3, roomy, { turn_recall: mediumRecall(10) }))
      assert.ok(await until(() => run.records().length === 3), `no command kept; stderr:\n${run.stderr()}`)
      const roomyWake = await run.nextWake()
      const carried = roomyWake.find((e) => e.type === 'turn_recall')
      assert.equal(carried.block, undefined)
      assert.match(carried.read, /^cat ~\/\.devspec\/notes\/[0-9a-f]{16}\.md$/)
      assert.ok(fitsShellOutput(wakeLines(roomyWake)))
      assert.equal(roomyWake.find((e) => e.type === 'owner_message').body, roomy)
    } finally {
      await run.cleanup()
    }
  })

  it('a command too long to fit on its own (25,300 characters): the one case it goes whole into a note, with its recall, behind one short line', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      const body = bodyFor(25_300)
      run.stub.serve(commandPoll(2, body, { turn_recall: mediumRecall(11) }))
      assert.ok(await until(() => run.records().length === 2), `no command kept; stderr:\n${run.stderr()}`)
      const wakeOut = await run.nextWake()
      assert.equal(wakeOut.length, 1)
      assert.equal(wakeOut[0].type, 'wake_in_note')
      assert.deepEqual(wakeOut[0].carries, ['owner_message', 'turn_recall', 'wake'])
      const id = /^cat ~\/\.devspec\/notes\/([0-9a-f]{16})\.md$/.exec(wakeOut[0].read)[1]
      const inNote = readNoteText(id, { home: run.home }).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      assert.equal(inNote[0].body, body, 'the command, byte for byte')
      assert.equal(inNote[1].block, mediumRecall(11).formatted_block, 'and its recall')
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [], 'not shown until the note is read')
      for (const file of noteFiles(run.home, id)) runAfterTool(run.home, catCall(run.home, file, { conversation: CHAT }))
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(11)])
    } finally {
      await run.cleanup()
    }
  })

  it('the one-shot wait sizes its whole result: a command and its pointer wake that do not fit together come out in two results, each within the limit, the cursor moving only past what was printed, nothing lost', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      // A command wake that fits on its own but not with the pointer beside it, with room for the waiting line.
      const body = bodyFor(19_870)
      run.stub.serve(commandPoll(2, body, { turn_recall: mediumRecall(12) }))
      assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)
      const before = run.state().inbox_byte_offset

      const first = run.startWait()
      assert.equal(await Promise.race([first.exited, sleep(10_000).then(() => 'timeout')]), 0, first.stderr())
      assert.ok(fitsShellOutput(first.stdout()), `${first.stdout().length} characters in one result`)
      const one = first.events()
      assert.deepEqual(one.map((e) => e.type).slice(0, 3), ['owner_message', 'wake', 'recall_in_next_wake'])
      assert.ok(one.length === 3 || one[3].type === 'wakes_waiting')
      assert.equal(one[0].body, body, 'the command, whole')
      assert.equal(run.state().inbox_byte_offset, before, 'the cursor stays at this delivery: part of it is still to print')

      const second = run.startWait()
      assert.equal(await Promise.race([second.exited, sleep(10_000).then(() => 'timeout')]), 0, second.stderr())
      assert.ok(fitsShellOutput(second.stdout()))
      const two = second.events()
      assert.deepEqual(two.map((e) => e.type), ['turn_recall'])
      assert.equal(two[0].for, one[0].message_id)
      assert.equal(readNoteText(/notes\/([0-9a-f]{16})\.md$/.exec(two[0].read)[1], { home: run.home }), mediumRecall(12).formatted_block, 'nothing lost')
      assert.ok(run.state().inbox_byte_offset > before, 'and now past it')
      assert.equal(run.state().wake_batch_progress, null)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])
      readNote(run.home, two[0].read)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(12)])
    } finally {
      await run.cleanup()
    }
  })

  it('the one-shot wait at 19,950 characters: the result ends with the line that says the recall is next (no room for the waiting line), the cursor stays, and the re-arm prints the pointer wake', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      const body = bodyFor(19_950)
      run.stub.serve(commandPoll(2, body, { turn_recall: mediumRecall(13) }))
      assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)
      const before = run.state().inbox_byte_offset

      const first = run.startWait()
      assert.equal(await Promise.race([first.exited, sleep(10_000).then(() => 'timeout')]), 0, first.stderr())
      assert.ok(fitsShellOutput(first.stdout()), `${first.stdout().length} characters in one result`)
      const one = first.events()
      assert.deepEqual(one.map((e) => e.type), ['owner_message', 'wake', RECALL_IN_NEXT_WAKE.type], 'the marker closes the result; the waiting line has no room')
      assert.ok(!fitsShellOutput(first.stdout() + wakeLines([wakesWaitingEvent(1)])), 'the waiting line really would not fit')
      assert.equal(one[0].body, body, 'the command, whole')
      assert.equal(run.state().inbox_byte_offset, before, 'the cursor stays at this delivery')
      assert.ok(run.state().wake_batch_progress, 'and the rest is kept for the re-arm')

      // The re-arm the skill asks for on that line: --pending, straight away.
      const second = run.startWait()
      assert.equal(await Promise.race([second.exited, sleep(10_000).then(() => 'timeout')]), 0, second.stderr())
      const two = second.events()
      assert.deepEqual(two.map((e) => e.type), ['turn_recall'])
      assert.equal(two[0].for, one[0].message_id)
      assert.equal(readNoteText(/notes\/([0-9a-f]{16})\.md$/.exec(two[0].read)[1], { home: run.home }), mediumRecall(13).formatted_block, 'nothing lost')
      assert.ok(run.state().inbox_byte_offset > before, 'and now past it')
      assert.equal(run.state().wake_batch_progress, null)
    } finally {
      await run.cleanup()
    }
  })

  /** The host's follow, run until its wake file is `ready`, then stopped: the wake file's text. */
  async function followOnce(run, wakeFile, ready) {
    const follow = spawn(process.execPath, [WAIT_SCRIPT, '--connection-id', CONNECTION, '--pending', '--follow', '--wake-file', wakeFile, '--owner-pid', String(process.pid), '--poll-ms', '20'], {
      env: { ...process.env, HOME: run.home },
    })
    try {
      assert.ok(await until(() => fs.existsSync(wakeFile) && ready(fs.readFileSync(wakeFile, 'utf8'))), 'the follow wrote nothing')
      await sleep(300)
    } finally {
      follow.kill('SIGKILL')
    }
    return fs.readFileSync(wakeFile, 'utf8')
  }

  it('a frozen wake for a connection that ended is skipped, never printed: the wait checks the connection under the steps lock every end takes', async () => {
    const run = await startPoller()
    const dir = path.join(run.home, '.devspec', 'remote-control', 'connections')
    const lock = path.join(dir, `${CONNECTION}.steps.lock`)
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      run.stub.serve(commandPoll(2, bodyFor(19_950), { turn_recall: mediumRecall(14) }))
      assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)
      const first = run.startWait()
      assert.equal(await Promise.race([first.exited, sleep(10_000).then(() => 'timeout')]), 0, first.stderr())
      assert.equal(first.events().at(-1).type, RECALL_IN_NEXT_WAKE.type)
      assert.ok(run.state().wake_batch_progress, 'the pointer wake is frozen for the re-arm')

      // The connection is live when the re-arm starts; an end lands while it waits for the lock.
      fs.writeFileSync(lock, String(process.pid))
      const second = run.startWait()
      assert.ok(await until(() => fs.readdirSync(dir).some((name) => name.startsWith(`${CONNECTION}.steps.lock.`))), 'the re-arm never reached the lock')
      run.patchState({ enabled: false, end_reason: 'local_stop' })
      fs.rmSync(lock)
      assert.equal(await Promise.race([second.exited, sleep(10_000).then(() => 'timeout')]), 1, second.stderr())
      assert.equal(second.stdout(), '', 'nothing printed')
      assert.match(second.stderr(), /skipped 1 waiting wake\(s\): the connection has ended; never printed/)
    } finally {
      fs.rmSync(lock, { force: true })
      await run.cleanup()
    }
  })

  it('the wake reader skips a recall\'s own wake once its connection has ended; the command\'s wake still prints', async () => {
    const run = await startPoller()
    const dir = path.join(run.home, '.devspec', 'remote-control', 'connections')
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      run.stub.serve(commandPoll(2, bodyFor(19_870), { turn_recall: mediumRecall(15) }))
      assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)
      const wakeFile = path.join(run.home, 'wake.jsonl')
      const file = await followOnce(run, wakeFile, (text) => text.includes('"for"'))
      const [first, second] = splitWakes(file).wakes
      const own = JSON.parse(second.split('\n')[0])
      assert.equal(own.type, 'turn_recall')
      assert.equal(own.connection_id, CONNECTION, 'the recall\'s own wake names its connection')
      assert.equal(withoutEndedConnectionWakes(file, { dir, write: () => assert.fail('nothing skipped while live') }), file)

      run.patchState({ enabled: false, end_reason: 'local_stop' })
      const skipped = []
      assert.equal(withoutEndedConnectionWakes(file, { dir, write: (line) => skipped.push(line) }), first)
      assert.equal(skipped.length, 1)
      assert.match(skipped[0], new RegExp(`skipped a turn_recall wake for connection ${CONNECTION}, which has ended \\(recall for ${own.for}\\); never printed`))
      // The agent's reader: the command's wake, never the ended connection's recall wake, and then nothing.
      assert.equal(readWakesAsTheAgentDoes(run.home, wakeFile), readerHeader(1, 0) + first)
      assert.equal(readWakesAsTheAgentDoes(run.home, wakeFile), readerHeader(0, 0, NOTHING_UNREAD))
    } finally {
      await run.cleanup()
    }
  })

  it('one continuation for both printers: the manual wait prints the command, then the background listener prints only the pointer wake, never the command again', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      const body = bodyFor(19_870)
      run.stub.serve(commandPoll(2, body, { turn_recall: mediumRecall(13) }))
      assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)

      const manual = run.startWait()
      assert.equal(await Promise.race([manual.exited, sleep(10_000).then(() => 'timeout')]), 0, manual.stderr())
      const printed = manual.events()
      assert.equal(printed[0].body, body)
      assert.equal(printed.some((e) => e.type === 'turn_recall'), false)

      const wakeFile = path.join(run.home, 'wake-after-manual.jsonl')
      const text = await followOnce(run, wakeFile, (t) => t.includes('turn_recall') && run.state().wake_batch_progress === null)
      const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
      assert.deepEqual(lines.map((e) => e.type), ['turn_recall'], 'only the remaining pointer wake')
      assert.equal(lines[0].for, printed[0].message_id)
      assert.equal(run.state().wake_batch_progress, null)
    } finally {
      await run.cleanup()
    }
  })

  it('one continuation for both printers, the other way: the background listener hands on the whole delivery, and a manual wait after it prints none of it again', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      const body = bodyFor(19_870)
      run.stub.serve(commandPoll(2, body, { turn_recall: mediumRecall(14) }))
      assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)

      const wakeFile = path.join(run.home, 'wake-first.jsonl')
      const text = await followOnce(run, wakeFile, (t) => t.includes('turn_recall') && (run.state().inbox_byte_offset ?? 0) > 0)
      const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
      assert.deepEqual(lines.map((e) => e.type), ['owner_message', 'wake', 'recall_in_next_wake', 'turn_recall'])

      const manual = run.startWait()
      await sleep(1_000)
      assert.equal(manual.stdout(), '', 'the manual wait prints nothing the listener already handed on')
      manual.kill()
    } finally {
      await run.cleanup()
    }
  })

  it('puts the recall with the command when one delivery holds a command and an automation run', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.stub.serve(commandPoll(1, 'Ship the release notes for this week', {
        dispatches: [fixtureAutomationDispatch()],
        dispatch_cursor: '2026-11-20T12:00:00.000Z',
        turn_recall: recall(5),
      }))
      assert.ok(await until(() => run.records().some((r) => r.type === 'automation_dispatches')), `not kept; stderr:\n${run.stderr()}`)
      assert.equal(run.records().find((r) => r.type === 'owner_messages').turn_recall.formatted_block, recall(5).formatted_block)
      assert.equal(run.records().find((r) => r.type === 'automation_dispatches').turn_recall, undefined)
    } finally {
      await run.cleanup()
    }
  })
})

describe('when notes cannot be written (a disk problem in the home folder)', () => {
  const ROOM = fixtureUuid(990)
  /** Make ~/.devspec/notes unwritable: a file where the folder should be. Returns the undo. */
  function breakNotes(home) {
    const notes = path.join(home, '.devspec', 'notes')
    fs.rmSync(notes, { recursive: true, force: true })
    fs.writeFileSync(notes, 'a file where the folder should be')
    return () => fs.rmSync(notes, { force: true })
  }
  const big = (n) => ({ ...recall(n), formatted_block: `== PROACTIVE PROJECT RECALL ==\n${Array.from({ length: 300 }, (_, i) => `- [REQUIREMENT] **Requirement ${n}.${i}** governs the settings page redirect`).join('\n')}` })

  for (const [label, target, turnRecall] of [
    ['25,300 characters with its recall', 25_300, (n) => recall(n)],
    ['25,300 characters with no recall', 25_300, () => undefined],
    ['19,990 characters with its recall (no room for the waiting line)', 19_990, (n) => recall(n)],
  ]) {
    it(`holds a command of ${label}: nothing is sent, the cursor stays, the room is told once, and it goes out whole once notes can be written`, async () => {
      const run = await startPoller()
      try {
        assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
        run.stub.serve(commandPoll(1, 'a'.repeat(100)))
        assert.ok(await until(() => run.records().length === 1))
        const around = wakeLines(await run.nextWake()).length - 2 * 100
        const body = 'a'.repeat(Math.floor((target - around - 2) / 2))
        const offsetBefore = run.state().inbox_byte_offset
        run.patchState({ session_id: ROOM })
        const restore = breakNotes(run.home)
        const n = turnRecall(1) ? 20 : 21
        run.stub.serve(commandPoll(2, body, turnRecall(n) ? { turn_recall: turnRecall(n) } : {}))
        assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)

        const wait = run.startWait()
        assert.ok(await until(() => (wait.stderr().match(/holding a wake/g) ?? []).length >= 5), `not held; stderr:\n${wait.stderr()}`)
        assert.equal(wait.stdout(), '', 'nothing is sent')
        assert.equal(run.state().inbox_byte_offset, offsetBefore, 'the inbox cursor stays where it was')
        assert.equal(run.stub.named('post_session_message').length, 1, 'the room is told once, not every try')
        const told = run.stub.named('post_session_message')[0]
        assert.equal(told.session_id, ROOM)
        assert.match(told.message, /hasn't received a message from this room yet/)
        assert.match(told.message, /keeps trying/)
        // The system's error names private paths on that computer: it goes to the local
        // log, never to the people in the room.
        const logged = /holding a wake: [^(]*\((.+)\); trying again/.exec(wait.stderr())
        assert.ok(logged, `the error is in the local log; stderr:\n${wait.stderr()}`)
        assert.ok(!told.message.includes(logged[1]), 'the room notice carries no system error')
        assert.ok(!told.message.includes(run.home), 'the room notice names no path on that computer')
        assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])

        restore()
        const code = await Promise.race([wait.exited, sleep(10_000).then(() => 'timeout')])
        assert.equal(code, 0, `not sent once notes could be written; stderr:\n${wait.stderr()}`)
        const [line, ...rest] = wait.events()
        assert.deepEqual(rest, [])
        assert.equal(line.type, 'wake_in_note')
        const inNote = readNoteText(/notes\/([0-9a-f]{16})\.md$/.exec(line.read)[1], { home: run.home }).split('\n').filter(Boolean).map((l) => JSON.parse(l))
        assert.equal(inNote.find((e) => e.type === 'owner_message').body, body, 'the command, byte for byte')
        if (turnRecall(n)) assert.equal(inNote.find((e) => e.type === 'turn_recall').block, recall(n).formatted_block)
        assert.equal(run.stub.named('post_session_message').length, 1)
      } finally {
        await run.cleanup()
      }
    })
  }

  it('never holds a 19,870-character command: it fits on its own with room for the waiting line, so it goes inline, with a line saying its recall could not be saved', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.stub.serve(commandPoll(1, 'a'.repeat(100)))
      assert.ok(await until(() => run.records().length === 1))
      const around = wakeLines(await run.nextWake()).length - 2 * 100
      run.patchState({ session_id: ROOM })
      breakNotes(run.home)
      const tight = 'a'.repeat(Math.floor((19_870 - around - 2) / 2))
      run.stub.serve(commandPoll(2, tight, { turn_recall: recall(23) }))
      assert.ok(await until(() => run.records().length === 2), `not kept; stderr:\n${run.stderr()}`)
      // Its recall's note cannot be saved: the line saying so goes beside it, and nothing waits.
      const events = await run.nextWake()
      assert.deepEqual(events.map((e) => e.type), ['owner_message', 'turn_recall', 'wake'])
      assert.equal(events[0].body, tight)
      assert.deepEqual(events[1], { type: 'turn_recall', note: RECALL_UNSAVED_NOTE })
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])
      assert.equal(run.stub.named('post_session_message').length, 0, 'nothing held')
    } finally {
      await run.cleanup()
    }
  })

  it('sends a small command whose recall needed a note at once, with a line saying its recall could not be saved, and counts nothing as shown', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.patchState({ session_id: ROOM })
      breakNotes(run.home)
      run.stub.serve(commandPoll(1, 'Which requirements govern the settings page?', { turn_recall: big(22) }))
      assert.ok(await until(() => run.records().length === 1), `not kept; stderr:\n${run.stderr()}`)
      const events = await run.nextWake()
      assert.deepEqual(events.map((e) => e.type), ['owner_message', 'turn_recall', 'wake'])
      assert.equal(events[0].body, 'Which requirements govern the settings page?')
      assert.equal(events[1].note, RECALL_UNSAVED_NOTE)
      assert.equal(events[1].block, undefined)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [], 'its records come with the next command')
      assert.equal(run.stub.named('post_session_message').length, 0, 'nothing held, nothing to tell')
    } finally {
      await run.cleanup()
    }
  })

  it('sends a command that fits with no recall as usual: it needs no note', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      breakNotes(run.home)
      run.stub.serve(commandPoll(1, 'Why does the settings page redirect to login?'))
      assert.ok(await until(() => run.records().length === 1), `not kept; stderr:\n${run.stderr()}`)
      const events = await run.nextWake()
      assert.deepEqual(events.map((e) => e.type), ['owner_message', 'wake'])
      assert.equal(events[0].body, 'Why does the settings page redirect to login?')
    } finally {
      await run.cleanup()
    }
  })
})

describe('a recall that is slow, missing or broken never holds the command back', () => {
  for (const [what, turnRecall] of [
    ['DevSpec ran out of time for it', { version: 1, cards: [], formatted_block: '', seen_keys: [], degraded_timeout: true, degraded_reason: 'timeout' }],
    ['DevSpec found nothing that bears on it', { version: 1, cards: [], formatted_block: '', seen_keys: [] }],
    ['the recall is malformed', '== PROACTIVE PROJECT RECALL =='],
    ['DevSpec sent no recall at all', undefined],
  ]) {
    it(`delivers the command with no recall when ${what}`, async () => {
      const run = await startPoller()
      try {
        assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
        run.stub.serve(commandPoll(1, 'Why does the settings page redirect to login?', turnRecall === undefined ? {} : { turn_recall: turnRecall }))
        assert.ok(await until(() => run.records().some((r) => r.type === 'owner_messages')), `no command kept; stderr:\n${run.stderr()}`)
        assert.equal(run.records()[0].turn_recall, undefined)
        const events = await run.nextWake()
        assert.equal(events.find((e) => e.type === 'owner_message').body, 'Why does the settings page redirect to login?')
        assert.equal(events.some((e) => e.type === 'turn_recall'), false)
        assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])
      } finally {
        await run.cleanup()
      }
    })
  }

  it('still polls, and delivers the command with its recall, when the seen store cannot be read', async () => {
    const run = await startPoller({
      beforeStart: (home) => {
        const file = seenStoreFile(CHAT, home)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, '{torn')
      },
    })
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      assert.equal(run.stub.polls[0].turn_recall_version, 1)
      assert.equal(run.stub.polls[0].seen_recall_versions, undefined)
      run.stub.serve(commandPoll(1, 'Why does the settings page redirect to login?', { turn_recall: recall(6) }))
      assert.ok(await until(() => run.records().some((r) => r.type === 'owner_messages')), `no command kept; stderr:\n${run.stderr()}`)
      const events = await run.nextWake()
      readNote(run.home, events.find((e) => e.type === 'turn_recall').read)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(6)], 'the torn store is replaced by what was shown')
    } finally {
      await run.cleanup()
    }
  })

  it('waits out a recall that takes DevSpec\'s whole shared time budget, and the command arrives with it', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.stub.serve({ ...commandPoll(1, 'Why does the settings page redirect to login?', { turn_recall: recall(7) }), delayMs: SHARED_RECALL_BUDGET_MS })
      assert.ok(await until(() => run.records().some((r) => r.type === 'owner_messages'), SHARED_RECALL_BUDGET_MS + 10_000), `no command kept; stderr:\n${run.stderr()}`)
      assert.equal(run.records()[0].turn_recall.formatted_block, recall(7).formatted_block)
      assert.doesNotMatch(run.stderr(), /abort|timed out|timeout/i)
    } finally {
      await run.cleanup()
    }
  })
})

describe('the instructions the agent reads for the lines that say more follows', () => {
  // Loaded as scripts/authority-prose.test.mjs loads them: the file, split into sentences.
  // The two lines are the ones the printers really emit, so a renamed line fails here too.
  const lines = [RECALL_IN_NEXT_WAKE.type, wakesWaitingEvent(1).type]
  const sentences = (file) => fs.readFileSync(path.join(HERE, '..', '..', file), 'utf8').split(/(?<=[.!?|])\s+/)

  it('teach both lines as one rule: whatever names one names the other, and says how a one-shot wait gets the rest', () => {
    const rules = []
    for (const file of ['skills/devspec-remote/SKILL.md', 'rules/devspec.mdc']) {
      for (const sentence of sentences(file).filter((text) => lines.some((line) => text.includes(`\`${line}\``)))) {
        for (const line of lines) assert.ok(sentence.includes(`\`${line}\``), `${file} teaches one line without the other: ${sentence.slice(0, 200)}`)
        rules.push(sentence)
      }
    }
    assert.equal(rules.length, 1, 'one rule, not parallel ones')
    assert.match(rules[0], /`--pending`/, 'a one-shot wait is re-armed with --pending')
  })
})
