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
import { resolveSpaceFreeWakeFile, wakeLines } from './devspec-wake-file.mjs'
import { fitsShellOutput, readNoteText } from './hook-context-budget.mjs'
import { seenRecallKeys, seenStoreFile } from './turn-recall.mjs'
import { catCall, noteFiles } from '../../tests/helpers/note-reads.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const POLL_SCRIPT = path.join(HERE, 'devspec-remote-poll.mjs')
const WAIT_SCRIPT = path.join(HERE, 'devspec-remote-wait.mjs')
const CONNECTION = FIXTURE_ID.connection
const CHAT = 'cursor-chat-recall-test'

/**
 * How long every DevSpec plugin waits for a turn's recall (DevSpecV2
 * packages/core/src/recall/budget.ts HOST_RECALL_WAIT_MS): DevSpec gives up before it.
 */
const SHARED_RECALL_BUDGET_MS = 4_800

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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

/** The plugin's postToolUse hook for recall notes, run as hooks.json has Cursor run it: what it answered, or null. */
function runAfterTool(home, input) {
  const run = spawnSync('sh', ['-c', AFTER_TOOL_RECALL.command], {
    input: JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: path.resolve(HERE, '..', '..') },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout ? JSON.parse(run.stdout).additional_context : null
}

const toolCall = (command = 'git status') => ({ conversation_id: CHAT, tool_name: 'Shell', tool_input: { command }, tool_output: JSON.stringify({ output: '', exitCode: 0 }) })

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
      assert.equal(carried.block, recall(1).formatted_block)
      assert.equal(carried.read, undefined)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(1)])

      // The next poll leaves out what the conversation has been shown.
      const after = run.stub.polls.length
      assert.ok(await until(() => run.stub.polls.slice(after).some((p) => p.seen_recall_versions?.includes(key(1)))), 'the shown version goes with the next poll')

      // The next command's recall is handed over too, and joins what was shown.
      run.stub.serve(commandPoll(2, 'And make the redirect keep the return path', { turn_recall: recall(2) }))
      assert.ok(await until(() => run.records().filter((r) => r.type === 'owner_messages').length === 2))
      const second = await run.nextWake()
      assert.equal(second.find((e) => e.type === 'turn_recall').block, recall(2).formatted_block)
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
      assert.equal(events[1].block, recall(4).formatted_block)
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

  it('near Cursor\'s limit (19,990 characters with the command alone): the command arrives byte for byte, the recall\'s pointer arrives at the first tool call, and its records count as shown once the note is read', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      const tight = bodyFor(19_990)
      run.stub.serve(commandPoll(2, tight, { turn_recall: mediumRecall(9) }))
      assert.ok(await until(() => run.records().length === 2), `no command kept; stderr:\n${run.stderr()}`)
      const tightWake = await run.nextWake()
      assert.ok(wakeLines(tightWake).length <= 19_991 && wakeLines(tightWake).length > 19_900, String(wakeLines(tightWake).length))
      assert.equal(tightWake.some((e) => e.type === 'turn_recall'), false, 'not even the short pointer fits beside it')
      const command = tightWake.find((e) => e.type === 'owner_message')
      assert.equal(command.body, tight)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [])

      // The agent's first tool call in the turn: the pointer, naming the command.
      const context = runAfterTool(run.home, toolCall())
      assert.ok(context.includes(`room command ${command.message_id}`), context)
      const id = /cat ~\/\.devspec\/notes\/([0-9a-f]{16})\.md/.exec(context)[1]
      assert.equal(readNoteText(id, { home: run.home }), mediumRecall(9).formatted_block)
      assert.equal(runAfterTool(run.home, toolCall('ls')), null, 'handed over once')
      for (const file of noteFiles(run.home, id)) runAfterTool(run.home, catCall(run.home, file, { conversation: CHAT }))
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(9)])

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
      assert.equal(runAfterTool(run.home, toolCall()), null, 'a pointer the wake carried is not given again')
    } finally {
      await run.cleanup()
    }
  })

  it('near the limit with no tool call in the turn: the records stay unshown and come back with the next command', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      const bodyFor = await measuredBodies(run)
      run.stub.serve(commandPoll(2, bodyFor(19_990), { turn_recall: mediumRecall(11) }))
      assert.ok(await until(() => run.records().length === 2), `no command kept; stderr:\n${run.stderr()}`)
      assert.equal((await run.nextWake()).some((e) => e.type === 'turn_recall'), false)
      // The turn ends without a tool call. The next poll still asks for that record.
      const before = run.stub.polls.length
      assert.ok(await until(() => run.stub.polls.length > before + 1))
      assert.equal(run.stub.polls.at(-1).seen_recall_versions, undefined)
      // The next command offers it again, with room this time.
      run.stub.serve(commandPoll(3, 'And keep the return path when it redirects', { turn_recall: recall(11) }))
      assert.ok(await until(() => run.records().length === 3), `no command kept; stderr:\n${run.stderr()}`)
      const next = await run.nextWake()
      assert.equal(next.find((e) => e.type === 'turn_recall').block, recall(11).formatted_block)
      assert.deepEqual(seenRecallKeys(CHAT, { home: run.home }), [key(11)])
      assert.equal(runAfterTool(run.home, toolCall()), null, 'the earlier pointer is not handed over late')
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
      assert.equal(events.find((e) => e.type === 'turn_recall').block, recall(6).formatted_block)
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
