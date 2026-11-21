#!/usr/bin/env node
/**
 * Check jobs and notices reach a working Cursor agent at its next step (DevSpec task
 * 8f940862, step-delivery.mjs).
 *
 * What could break: an item that arrives mid-turn could still wait for the turn's end,
 * or go to the wake file as well and be delivered twice; items waiting together could
 * be handed over one per step; an item the agent read at a step could come back in the
 * idle wake; one it never read (Cursor dropped the step's context, or the turn ended
 * first) could be lost; a check job DevSpec already settled could still be handed
 * over; a helper agent's tool calls could receive the parent's items; the hook's
 * context could pass its share of Cursor's ceiling and take every other hook's context
 * down with it; and a hook killed mid-hand-over could leave its items stranded.
 * Run: node --test hooks/scripts/step-delivery.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildOwnerMessageEvents } from './devspec-remote-wait.mjs'
import { POST_TOOL_CONTEXT_SHARE, readNoteText } from './hook-context-budget.mjs'
import { readTurnWakes } from './notice-reply.mjs'
import { canonicalAcceptanceKey } from './remote-ingress-v1.mjs'
import { checkJobAcceptanceKey } from './remote-poll-acceptance.mjs'
import { FIXTURE_ID, fixtureServerNotice, fixtureSystemNoticeEnvelope } from './remote-ingress-test-fixtures.mjs'
import {
  CHECK_JOB_RULES,
  NOTICE_RULES,
  adoptParked,
  holdForNextStep,
  parkedDir,
  parkSteps,
  reclaimAbandoned,
  releaseAtIdle,
  stepDeliveryHook,
  stepsDir,
} from './step-delivery.mjs'
import { fitsShellOutput } from './hook-context-budget.mjs'
import { REMOTE_WAKE_NOTIFY_PATTERN, printedThrough, recordPrinted } from './devspec-wake-file.mjs'
import { nextOutput } from './devspec-wake-tail.mjs'
import { randomUUID } from 'node:crypto'
import { catCall, noteFiles, noteIdIn } from '../../tests/helpers/note-reads.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const AFTER_TOOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.postToolUse
const STEP_HOOK = AFTER_TOOL.find((entry) => entry.command.includes('step-delivery.mjs'))
const WAIT_SCRIPT = path.join(ROOT, 'hooks', 'scripts', 'devspec-remote-wait.mjs')
const POLL_SCRIPT = path.join(ROOT, 'hooks', 'scripts', 'devspec-remote-poll.mjs')
const STATE_SCRIPT = path.join(ROOT, 'hooks', 'scripts', 'remote-control-state.mjs')
const TAIL_SCRIPT = path.join(ROOT, 'hooks', 'scripts', 'devspec-wake-tail.mjs')

const CONN = FIXTURE_ID.connection
const ROOM = '44444444-4444-4444-8444-444444444444'
const CONVERSATION = 'c5ad9955-d354-4a1e-9b1f-0d3c2a1b0e9f'
const HELPER = 'a69bf1a0-77cc-4d2e-8f3a-6b5c4d3e2f10'
const JOB_A = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c'
const JOB_B = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d'
const RECORD = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e'
const NOTICE_A = 'f7d6a637-bb5a-4bcc-98ee-354e5f309a6b'
const NOTICE_B = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const UNROUTABLE = 'http://127.0.0.1:9/api/mcp'

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function checkJob(id = JOB_A, title = 'Fix the login redirect') {
  return {
    id,
    kind: 'check_job',
    check_job_id: id,
    check_kind: 'conflict',
    record: { type: 'task', id: RECORD, title },
    entries: 3,
    yours: true,
    offered_at: '2026-11-20T03:00:00.000Z',
    delivery_connection_id: CONN,
  }
}

/** A check job as the poller keeps it in the inbox. */
function checkJobBatch(job = checkJob()) {
  return {
    type: 'check_job_dispatches',
    connection_id: CONN,
    session_id: ROOM,
    received_at: '2026-11-20T03:00:01.000Z',
    count: 1,
    next_after_message_id: null,
    messages: [job],
    acceptance_key: checkJobAcceptanceKey(job),
  }
}

/** Notices as the poller keeps them in the inbox: `[id, audience, summary, prompt, records]`. */
function noticeBatch(notices, envelopeId = '22222222-2222-4222-8222-2222222222a1') {
  const envelope = fixtureSystemNoticeEnvelope({
    envelopeId,
    wakeKind: 'system_notice',
    commands: [],
    systemNotices: notices.map(([id, audience, summary, prompt, records]) =>
      fixtureServerNotice({
        notice_id: id,
        summary: summary ?? `Notice ${id.slice(0, 4)}`,
        ...(prompt ? { prompt } : {}),
        ...(records ? { records } : {}),
        ...(audience ? { audience } : {}),
      })),
  })
  return {
    type: 'canonical_system_notices',
    connection_id: CONN,
    session_id: ROOM,
    received_at: '2026-11-20T03:00:02.000Z',
    count: notices.length,
    next_after_message_id: null,
    execute_notice_ids: notices.map(([id]) => id),
    acceptance_key: canonicalAcceptanceKey(envelope),
    ingress: { canonical: true, envelope },
    messages: envelope.system_notices,
  }
}

const eventsOf = (batch) => buildOwnerMessageEvents(batch, { inboxFile: '/inbox.jsonl' })

/** A home with this conversation connected to DevSpec, Cursor in a turn of it. */
function connectedHome({ state = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-step-delivery-'))
  roots.push(home)
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${CONN}.json`),
    JSON.stringify({ connection_id: CONN, enabled: true, agent_name: 'Cursor', local_id: CONVERSATION, session_id: ROOM, inbox_byte_offset: 0, ...state }),
    { mode: 0o600 },
  )
  const transcript = path.join(home, '.cursor', 'projects', 'work', 'agent-transcripts', CONVERSATION, `${CONVERSATION}.jsonl`)
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  const world = {
    home,
    dir,
    transcript,
    wakeFile: path.join(home, 'wake.jsonl'),
    /** Cursor starts a turn: the transcript ends in the turn's rows. */
    inTurn() {
      fs.writeFileSync(
        transcript,
        [
          { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nFix the flaky test\n</user_query>' }] } },
          { role: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the test now.' }] } },
        ].map((row) => JSON.stringify(row)).join('\n') + '\n',
      )
    },
    /** Cursor ends the turn: its final line is the turn end. */
    endTurn() {
      fs.appendFileSync(transcript, JSON.stringify({ type: 'turn_ended', status: 'success' }) + '\n')
    },
    wakeText() {
      return fs.existsSync(world.wakeFile) ? fs.readFileSync(world.wakeFile, 'utf8') : ''
    },
    held() {
      try {
        return fs.readdirSync(stepsDir(CONN, dir)).filter((name) => /^w-.*\.json$/.test(name))
      } catch {
        return []
      }
    },
    /** Items written whole in an idle wake that the reader has not printed yet. */
    inFlight() {
      try {
        return fs.readdirSync(stepsDir(CONN, dir)).filter((name) => /^printing-.*\.json$/.test(name))
      } catch {
        return []
      }
    },
  }
  world.inTurn()
  return world
}

/** A tool call of the conversation, as Cursor hands it to postToolUse. */
function toolCall(over = {}) {
  return {
    conversation_id: CONVERSATION,
    generation_id: 'g-1',
    tool_name: 'Shell',
    tool_input: { command: 'npm test' },
    tool_output: JSON.stringify({ output: 'ok', exitCode: 0 }),
    ...over,
  }
}

/** The step-delivery hook from hooks.json, run as Cursor runs it; its context, or null. */
function runStepHook(world, input, env = {}) {
  const run = spawnSync('sh', ['-c', STEP_HOOK.command], {
    input: JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: world.home, CLAUDE_PLUGIN_ROOT: ROOT, DEVSPEC_MCP_URL: UNROUTABLE, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.error && run.error.code !== 'EPIPE') throw run.error
  assert.equal(run.status, 0, run.stderr)
  const out = run.stdout.trim()
  if (!out) return null
  const parsed = JSON.parse(out)
  assert.equal(parsed.additional_context, parsed.hookSpecificOutput?.additionalContext)
  return parsed.additional_context
}

/** `runStepHook` without blocking this process, for a DevSpec stand-in served from it. */
async function runStepHookAsync(world, input, env = {}) {
  const child = spawn('sh', ['-c', STEP_HOOK.command], {
    env: { PATH: process.env.PATH, HOME: world.home, CLAUDE_PLUGIN_ROOT: ROOT, DEVSPEC_MCP_URL: UNROUTABLE, ...env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify(input))
  const status = await new Promise((resolve) => child.once('close', resolve))
  assert.equal(status, 0, stderr)
  const out = stdout.trim()
  return out ? JSON.parse(out).additional_context : null
}

/** Read every part of the note a pointer names, as the agent would, one tool call each. */
function readNote(world, context, run = (input) => runStepHook(world, input)) {
  const id = noteIdIn(context)
  assert.ok(id, `a pointer to a note: ${context}`)
  let last
  for (const file of noteFiles(world.home, id)) last = run(catCall(world.home, file, { conversation: CONVERSATION }))
  return last
}

async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/** The host follow for this connection, as the plugin starts it. */
function startFollow(world) {
  const inbox = path.join(world.dir, `${CONN}.inbox.jsonl`)
  fs.writeFileSync(inbox, '', { mode: 0o600 })
  const env = { ...process.env, HOME: world.home, DEVSPEC_REMOTE_CONNECTIONS_DIR: world.dir, DEVSPEC_MCP_URL: UNROUTABLE }
  delete env.DEVSPEC_MCP_TOKEN
  const child = spawn(
    process.execPath,
    [WAIT_SCRIPT, '--connection-id', CONN, '--pending', '--follow', '--wake-file', world.wakeFile, '--owner-pid', String(process.pid), '--poll-ms', '20'],
    { env, cwd: world.home, windowsHide: true },
  )
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const closed = new Promise((resolve) => child.once('close', resolve))
  return {
    /** The poller keeps a batch in the inbox. */
    deliver(batch) {
      fs.appendFileSync(inbox, JSON.stringify(batch) + '\n')
    },
    consumed() {
      try {
        return JSON.parse(fs.readFileSync(path.join(world.dir, `${CONN}.json`), 'utf8')).inbox_byte_offset === fs.statSync(inbox).size
      } catch {
        return false
      }
    },
    stderr: () => stderr,
    async stop() {
      child.kill('SIGTERM')
      await closed
    },
  }
}

describe('a check job and a notice that arrive while the agent works', () => {
  it('are held by the follow, never written to the wake file, and handed over together after the next tool call', async () => {
    const world = connectedHome()
    const follow = startFollow(world)
    try {
      follow.deliver(checkJobBatch())
      follow.deliver(noticeBatch([[NOTICE_A, 'needs_person', 'Your change clashes with the release decision']]))
      assert.ok(await until(() => world.held().length === 2 && follow.consumed()), follow.stderr())
      assert.equal(world.wakeText(), '', 'nothing for Cursor to hold until the turn ends')

      const context = runStepHook(world, toolCall())
      assert.ok(context.length <= POST_TOOL_CONTEXT_SHARE, `${context.length} characters`)
      assert.match(context, /1 check job and 1 notice/)
      assert.match(context, /one pause, then carry on with your task/)
      const note = readNoteText(noteIdIn(context), { home: world.home })
      // Both, in one note, as the idle wake would have carried them.
      assert.match(note, new RegExp(`## Check job ${JOB_A}`))
      assert.match(note, /A check is waiting on "Fix the login redirect": before you take it, read semantics\.check_job\.helpers/)
      assert.match(note, new RegExp(`Your connection id \\(its delivery_connection_id\\): ${CONN}`))
      assert.match(note, new RegExp(`## Notice ${NOTICE_A}`))
      assert.match(note, /Your change clashes with the release decision/)
      assert.match(note, new RegExp(`system_notice_ids: \\["${NOTICE_A}"\\]`))
      // DevSpec's rules, by id.
      assert.ok(note.includes(CHECK_JOB_RULES))
      assert.ok(note.includes(NOTICE_RULES))
      assert.deepEqual(world.held(), [], 'taken from the queue')
      // The turn now holds what was delivered into it (notice-reply.mjs).
      const wakes = readTurnWakes(CONN, { dir: world.dir })
      assert.deepEqual(wakes.noticeIds, [NOTICE_A])
      assert.deepEqual(wakes.checkJobIds, [JOB_A])
    } finally {
      await follow.stop()
    }
  })

  it('wakes an idle agent through the wake file as before', async () => {
    const world = connectedHome()
    world.endTurn()
    const follow = startFollow(world)
    try {
      follow.deliver(checkJobBatch())
      assert.ok(await until(() => world.wakeText().includes('"type":"check_job"') && follow.consumed()), follow.stderr())
      assert.deepEqual(world.held(), [])
      assert.equal(runStepHook(world, toolCall()), null)
    } finally {
      await follow.stop()
    }
  })
})

describe('what the agent read at a step, and what it did not', () => {
  it('an item read at a step is not delivered again when the agent next goes idle', async () => {
    const world = connectedHome()
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    const context = runStepHook(world, toolCall())
    assert.ok(context)
    // The pointer comes back after every step until the note is read whole.
    assert.equal(runStepHook(world, toolCall({ tool_input: { command: 'ls' } })), context)
    assert.equal(readNote(world, context), null, 'read whole, so no longer offered')
    world.endTurn()
    const released = await releaseAtIdle(CONN, { dir: world.dir, state: { local_id: CONVERSATION }, wakeFile: world.wakeFile, home: world.home })
    assert.equal(released, null)
    assert.equal(world.wakeText(), '')
  })

  it('an item handed over but not read whole goes to the idle wake, once, and the pointer stops', async () => {
    const world = connectedHome()
    const follow = startFollow(world)
    try {
      follow.deliver(noticeBatch([[NOTICE_A, 'needs_person'], [NOTICE_B, 'for_the_record']]))
      assert.ok(await until(() => world.held().length === 1 && follow.consumed()), follow.stderr())
      // Cursor may drop this step's context, or the turn may end before the agent reads it.
      assert.ok(runStepHook(world, toolCall()))
      world.endTurn()
      assert.ok(await until(() => world.wakeText().includes('held_for_step')), follow.stderr())
      const lines = world.wakeText().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      assert.equal(lines.length, 1, 'one wake line')
      assert.deepEqual(lines[0].holds, ['system_notice'])
      assert.match(world.wakeText(), new RegExp(REMOTE_WAKE_NOTIFY_PATTERN))
      // The same note the step handed over, whole in the wake: both notices, as they came.
      for (const id of [NOTICE_A, NOTICE_B]) assert.match(lines[0].content, new RegExp(`## Notice ${id}`))
      // The next turn's steps no longer point at it.
      world.inTurn()
      assert.equal(runStepHook(world, toolCall()), null)
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(world.wakeText().split('\n').filter(Boolean).length, lines.length, 'released once')
    } finally {
      await follow.stop()
    }
  })

  it('a stretch with no tool calls ends in the idle wake: what is still held goes to the wake file when the turn ends', async () => {
    const world = connectedHome()
    const follow = startFollow(world)
    try {
      follow.deliver(checkJobBatch())
      assert.ok(await until(() => world.held().length === 1 && follow.consumed()), follow.stderr())
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(world.wakeText(), '', 'still held while Cursor is in the turn')
      world.endTurn()
      assert.ok(await until(() => world.wakeText().includes('held_for_step')), follow.stderr())
      assert.ok(JSON.parse(world.wakeText()).content.includes(`## Check job ${JOB_A}`))
      assert.deepEqual(world.held(), [])
    } finally {
      await follow.stop()
    }
  })

  it('what arrives while an earlier note is unread joins it: one pointer, one note with everything', () => {
    const world = connectedHome()
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    const first = runStepHook(world, toolCall())
    const second = checkJobBatch(checkJob(JOB_B, 'Retire the old importer'))
    holdForNextStep(CONN, second, eventsOf(second), { dir: world.dir })
    const joined = runStepHook(world, toolCall({ tool_input: { command: 'ls' } }))
    assert.notEqual(noteIdIn(joined), noteIdIn(first))
    assert.match(joined, /2 check jobs/)
    const note = readNoteText(noteIdIn(joined), { home: world.home })
    assert.ok(note.includes(JOB_A) && note.includes(JOB_B))
    // Reading the earlier note does not count for the joined one.
    assert.equal(readNote(world, first), joined)
    assert.equal(readNote(world, joined), null)
  })

  it('holds a batch once however often the follow offers it', () => {
    const world = connectedHome()
    const batch = checkJobBatch()
    assert.equal(holdForNextStep(CONN, batch, eventsOf(batch), { dir: world.dir }).duplicate, false)
    assert.equal(holdForNextStep(CONN, batch, eventsOf(batch), { dir: world.dir }).duplicate, true)
    assert.equal(world.held().length, 1)
    runStepHook(world, toolCall())
    assert.equal(holdForNextStep(CONN, batch, eventsOf(batch), { dir: world.dir }).duplicate, true, 'handed over and unread')
  })
})

describe('nothing waiting', () => {
  it('says nothing, and does not start node when no connection has anything held', () => {
    const world = connectedHome()
    // Pointed at a plugin folder that is not there, a started node would fail the hook.
    assert.equal(runStepHook(world, toolCall(), { CLAUDE_PLUGIN_ROOT: path.join(world.home, 'no-plugin-here') }), null)
    assert.equal(runStepHook(world, toolCall()), null)
    assert.equal(fs.existsSync(stepsDir(CONN, world.dir)), false)
  })

  it('says nothing once everything has been read', async () => {
    const world = connectedHome()
    fs.mkdirSync(stepsDir(CONN, world.dir), { recursive: true })
    assert.equal(await stepDeliveryHook(toolCall(), { home: world.home }), null)
  })
})

describe('a check job DevSpec has already settled', () => {
  /** A DevSpec stand-in answering get_connection_dispatch with the jobs in `open`. */
  async function devspec(open, { status = 200 } = {}) {
    const calls = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        calls.push(parsed.params)
        if (status !== 200) {
          res.writeHead(status)
          res.end('upstream unavailable')
          return
        }
        const dispatches = open.filter((id) => id === parsed.params?.arguments?.dispatch_id).map((id) => checkJob(id))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ connection_id: CONN, dispatches, count: dispatches.length }) }] },
        }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    after(() => server.close())
    return { url: `http://127.0.0.1:${server.address().port}/api/mcp`, calls }
  }

  it('is dropped without being handed over; what is still open is handed over', async () => {
    const server = await devspec([JOB_B])
    const world = connectedHome({ state: { token: 'dvs_test_token', mcp_url: server.url } })
    for (const batch of [checkJobBatch(checkJob(JOB_A)), checkJobBatch(checkJob(JOB_B, 'Retire the old importer'))]) {
      holdForNextStep(CONN, batch, eventsOf(batch), { dir: world.dir })
    }
    const context = await runStepHookAsync(world, toolCall(), { DEVSPEC_MCP_URL: server.url })
    assert.match(context, /1 check job\)/)
    const note = readNoteText(noteIdIn(context), { home: world.home })
    assert.ok(note.includes(JOB_B))
    assert.ok(!note.includes(JOB_A), 'the settled job is not handed over')
    assert.deepEqual(world.held(), [], 'and is gone from the queue')
    assert.deepEqual(server.calls.map((call) => [call.name, call.arguments.dispatch_id]).sort(), [
      ['get_connection_dispatch', JOB_A],
      ['get_connection_dispatch', JOB_B],
    ])
  })

  it('when it was the only thing waiting, the step says nothing at all', async () => {
    const server = await devspec([])
    const world = connectedHome({ state: { token: 'dvs_test_token', mcp_url: server.url } })
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    assert.equal(await runStepHookAsync(world, toolCall(), { DEVSPEC_MCP_URL: server.url }), null)
    assert.deepEqual(world.held(), [])
  })

  it('is dropped at idle too, instead of waking the agent for it', async () => {
    const server = await devspec([])
    const world = connectedHome({ state: { token: 'dvs_test_token', mcp_url: server.url } })
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    world.endTurn()
    const released = await releaseAtIdle(CONN, {
      dir: world.dir,
      state: { local_id: CONVERSATION, token: 'dvs_test_token', mcp_url: server.url },
      wakeFile: world.wakeFile,
      home: world.home,
    })
    assert.deepEqual(released, { released: [], pointed: [], dropped: [checkJobAcceptanceKey(checkJob())], note: null })
    assert.equal(world.wakeText(), '')
  })

  it('is handed over when DevSpec cannot say, so a real check is never lost', async () => {
    const server = await devspec([], { status: 503 })
    const world = connectedHome({ state: { token: 'dvs_test_token', mcp_url: server.url } })
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    const context = await runStepHookAsync(world, toolCall(), { DEVSPEC_MCP_URL: server.url })
    assert.ok(readNoteText(noteIdIn(context), { home: world.home }).includes(JOB_A))
  })
})

describe("a helper agent's tool calls", () => {
  it("never receive the parent's items, which wait for the parent's next step", () => {
    const world = connectedHome()
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    // Measured on CLI 2026.11.05: a helper's call carries its own conversation id.
    assert.equal(runStepHook(world, toolCall({ conversation_id: HELPER })), null)
    // Cursor documents parent_tool_call_id on a helper's calls.
    assert.equal(runStepHook(world, toolCall({ parent_tool_call_id: 'tool-call-7' })), null)
    assert.equal(world.held().length, 1, 'still waiting')
    // The parent's own Task call, which ends when its helper does, gets them.
    assert.ok(runStepHook(world, toolCall({ tool_name: 'Task' })))
  })

  it('a connection bonded to another conversation gets nothing, even when it is the only one', () => {
    const world = connectedHome({ state: { local_id: 'some-other-conversation' } })
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    assert.equal(runStepHook(world, toolCall()), null)
    assert.equal(world.held().length, 1)
  })
})

describe("within Cursor's ceiling, nothing cut", () => {
  it('many long items still fit the hook\'s share, and the note holds every one whole', () => {
    const world = connectedHome()
    const ids = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000001`)
    for (const [i, id] of ids.entries()) {
      const batch = noticeBatch(
        [[id, 'needs_person', `Notice ${i}`, `${'A long finding about your change. '.repeat(200)}END-${i}`]],
        `${String(i).padStart(8, '0')}-2222-4222-8222-222222222222`,
      )
      holdForNextStep(CONN, batch, eventsOf(batch), { dir: world.dir })
    }
    const context = runStepHook(world, toolCall())
    assert.ok(context.length <= POST_TOOL_CONTEXT_SHARE, `${context.length} characters`)
    assert.match(context, /60 notices/)
    const note = readNoteText(noteIdIn(context), { home: world.home })
    for (let i = 0; i < ids.length; i += 1) assert.ok(note.includes(`END-${i}`), `notice ${i} whole`)
    assert.ok(noteFiles(world.home, noteIdIn(context)).length > 1, 'in parts, each one Shell page')
    // One reply can answer every notice that needs the person.
    assert.match(note, /One reply can answer all of these notices/)
  })
})

describe('a hand-over that was cut short', () => {
  it('puts back what a hook that died had taken, so the next step or the idle wake delivers it', () => {
    const world = connectedHome()
    holdForNextStep(CONN, checkJobBatch(), eventsOf(checkJobBatch()), { dir: world.dir })
    const steps = stepsDir(CONN, world.dir)
    const [name] = world.held()
    // A pid no process has: the hook that took it was killed past Cursor's timeout.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
    fs.renameSync(path.join(steps, name), path.join(steps, `${name}.taken-${dead}-0badf00d`))
    assert.deepEqual(world.held(), [])
    reclaimAbandoned(steps)
    assert.deepEqual(world.held(), [name])
    assert.ok(runStepHook(world, toolCall()))
  })
})

/** `count` notices of about `size` characters each, held for CONN, each ending in `END-<i>`. */
function holdNotices(world, count, size, from = 0) {
  // A notice's prompt and each record's text hold at most 8,000 characters (remote-ingress-v1.mjs).
  const finding = (chars) => 'A finding about your change. '.repeat(Math.ceil(chars / 29))
  for (let i = from; i < from + count; i += 1) {
    const id = `${String(i).padStart(8, '0')}-0000-4000-8000-0000000000aa`
    const records = []
    for (let rest = size - 7_000, n = 0; rest > 0; rest -= 7_000, n += 1) {
      records.push({ label: 'Finding', record_type: 'memory', record_id: `r${i}.${n}`, title: `Record ${i}.${n}`, text: finding(Math.min(rest, 7_000)), url: null })
    }
    const batch = noticeBatch(
      [[id, 'needs_person', `Notice ${i}`, `${finding(Math.min(size, 7_000))}END-${i}`, records.length > 0 ? records : undefined]],
      `${String(i).padStart(8, '0')}-2222-4222-8222-2222222222cc`,
    )
    holdForNextStep(CONN, batch, eventsOf(batch), { dir: world.dir, now: Date.parse('2026-11-20T03:00:00.000Z') + i })
  }
}

const IDLE = (world, over = {}) => ({ dir: world.dir, state: { local_id: CONVERSATION }, wakeFile: world.wakeFile, home: world.home, ...over })

describe('the idle wake is sized to what Cursor shows from one background command', () => {
  it('a small backlog goes whole in the wake and is delivered', async () => {
    const world = connectedHome()
    holdNotices(world, 2, 300)
    world.endTurn()
    const released = await releaseAtIdle(CONN, IDLE(world))
    assert.equal(released.released.length, 2)
    assert.equal(released.note, null)
    const wake = world.wakeText()
    assert.ok(fitsShellOutput(wake))
    assert.match(wake, new RegExp(REMOTE_WAKE_NOTIFY_PATTERN), 'Cursor wakes the agent for it')
    const line = JSON.parse(wake)
    assert.equal(line.type, 'held_for_step')
    assert.equal(line.read_with, undefined, 'whole in the wake, no file to read')
    for (const end of ['END-0', 'END-1']) assert.ok(line.content.includes(end), end)
    assert.deepEqual(world.held(), [])
    // Written is not delivered: in flight until the reader has printed the wake.
    assert.equal(world.inFlight().length, 1)
    recordPrinted(world.wakeFile, fs.statSync(world.wakeFile).size)
    assert.equal(await releaseAtIdle(CONN, IDLE(world)), null)
    assert.deepEqual(world.inFlight(), [], 'printed, so delivered')
    assert.equal(fs.existsSync(path.join(stepsDir(CONN, world.dir), 'handed.json')), false)
  })

  it('two notices that each fit one output but not together come out in two prints, and each leaves the queue only once printed', async () => {
    const world = connectedHome()
    holdNotices(world, 1, 11_000)
    world.endTurn()
    const first = await releaseAtIdle(CONN, IDLE(world))
    world.inTurn()
    holdNotices(world, 1, 11_000, 1)
    world.endTurn()
    const second = await releaseAtIdle(CONN, IDLE(world))
    assert.equal(first.released.length, 1)
    assert.equal(second.released.length, 1)
    const file = world.wakeText()
    assert.equal(fitsShellOutput(file), false, 'together they are over the limit')
    assert.equal(world.inFlight().length, 2, 'neither delivered by being written')

    // The reader's first print: the first wake alone, within the limit.
    const one = nextOutput(file)
    assert.ok(fitsShellOutput(one), `${one.length} characters`)
    assert.ok(one.includes('END-0') && !one.includes('END-1'))
    recordPrinted(world.wakeFile, Buffer.byteLength(one))
    await releaseAtIdle(CONN, IDLE(world))
    assert.equal(world.inFlight().length, 1, 'the second waits for its print')

    // Its next print: the second.
    const two = nextOutput(file.slice(one.length))
    assert.ok(fitsShellOutput(two))
    assert.ok(two.includes('END-1'))
    assert.equal(one + two, file, 'nothing lost, nothing split')
    recordPrinted(world.wakeFile, Buffer.byteLength(one + two))
    await releaseAtIdle(CONN, IDLE(world))
    assert.deepEqual(world.inFlight(), [])
  })

  it('the real reader prints them in two outputs, each within the limit, and notes how far it printed', async () => {
    const world = connectedHome()
    holdNotices(world, 1, 11_000)
    world.endTurn()
    await releaseAtIdle(CONN, IDLE(world))
    world.inTurn()
    holdNotices(world, 1, 11_000, 1)
    world.endTurn()
    await releaseAtIdle(CONN, IDLE(world))
    const expected = world.wakeText()
    const tail = spawn(process.execPath, [TAIL_SCRIPT, '--file', world.wakeFile], { windowsHide: true })
    const chunks = []
    tail.stdout.on('data', (data) => chunks.push({ at: Date.now(), text: data.toString() }))
    try {
      assert.ok(await until(() => printedThrough(world.wakeFile) === Buffer.byteLength(expected)))
    } finally {
      tail.kill()
      await new Promise((resolve) => tail.once('close', resolve))
    }
    assert.equal(chunks.map((chunk) => chunk.text).join(''), expected)
    // Pipe chunks of one print arrive together; prints are a poll (250 ms) apart.
    const prints = []
    for (const chunk of chunks) {
      if (prints.length > 0 && chunk.at - prints.at(-1).at < 150) prints.at(-1).text += chunk.text
      else prints.push({ ...chunk })
    }
    assert.equal(prints.length, 2, prints.map((print) => print.text.length).join(', '))
    for (const print of prints) assert.ok(fitsShellOutput(print.text))
    await releaseAtIdle(CONN, IDLE(world))
    assert.deepEqual(world.inFlight(), [], 'both printed, both delivered')
  })

  it('a 44,000-character backlog: the wake fits, its note is complete, and nothing leaves the queue until the note is read', async () => {
    const world = connectedHome()
    holdNotices(world, 22, 2_000)
    const raw = world.held().map((name) => JSON.parse(fs.readFileSync(path.join(stepsDir(CONN, world.dir), name), 'utf8')).events)
      .flat().map((event) => JSON.stringify(event) + '\n').join('')
    assert.ok(raw.length > 44_000, `${raw.length} characters held`)
    world.endTurn()
    const released = await releaseAtIdle(CONN, IDLE(world))
    assert.equal(released.pointed.length, 22)
    assert.deepEqual(released.released, [])
    const wake = world.wakeText()
    assert.ok(fitsShellOutput(wake), `${wake.length} characters`)
    assert.match(wake, new RegExp(REMOTE_WAKE_NOTIFY_PATTERN), 'Cursor wakes the agent for it')
    const pointer = JSON.parse(wake)
    assert.equal(pointer.type, 'held_for_step')
    assert.equal(pointer.note, released.note)
    const note = readNoteText(released.note, { home: world.home })
    for (let i = 0; i < 22; i += 1) assert.ok(note.includes(`END-${i}`), `notice ${i} whole`)
    // Still queued: not delivered until read whole.
    const record = JSON.parse(fs.readFileSync(path.join(stepsDir(CONN, world.dir), 'handed.json'), 'utf8'))
    assert.equal(record.items.length, 22)
    assert.equal(record.woken, true)
    // No new wake for the same unread note: an agent that does not read it is not woken in a loop.
    assert.equal(await releaseAtIdle(CONN, IDLE(world)), null)
    assert.equal(world.wakeText(), wake)
    // The turn the wake starts: every step points at it until it is read whole.
    world.inTurn()
    const context = runStepHook(world, toolCall())
    assert.equal(noteIdIn(context), released.note)
    assert.equal(readNote(world, context), null)
    assert.equal(fs.existsSync(path.join(stepsDir(CONN, world.dir), 'handed.json')), false, 'read, so delivered')
    world.endTurn()
    assert.equal(await releaseAtIdle(CONN, IDLE(world)), null)
    assert.equal(world.wakeText(), wake, 'never offered again')
  })

  it('what arrives after a note was woken for joins it, and the next idle wake offers everything', async () => {
    const world = connectedHome()
    holdNotices(world, 22, 2_000)
    world.endTurn()
    const first = await releaseAtIdle(CONN, IDLE(world))
    holdNotices(world, 1, 100, 22)
    const second = await releaseAtIdle(CONN, IDLE(world))
    assert.equal(second.pointed.length, 23)
    assert.notEqual(second.note, first.note)
    assert.ok(readNoteText(second.note, { home: world.home }).includes('END-22'))
    assert.equal(world.wakeText().split('\n').filter(Boolean).length, 2)
  })

  it('the real follow sizes the idle wake the same way', async () => {
    const world = connectedHome()
    holdNotices(world, 22, 2_000)
    const follow = startFollow(world)
    try {
      world.endTurn()
      assert.ok(await until(() => world.wakeText().includes('held_for_step')), follow.stderr())
      assert.ok(fitsShellOutput(world.wakeText()))
      assert.ok(JSON.parse(world.wakeText()).read_with, 'a pointer to the note')
      assert.ok(fs.existsSync(path.join(stepsDir(CONN, world.dir), 'handed.json')))
    } finally {
      await follow.stop()
    }
  })
})

describe('when the connection ends', () => {
  /**
   * A notice handed over at a step and not read, then a check job and another notice
   * held, for connection `id` in `world`.
   */
  function holdSome(world, id = CONN) {
    const notice = noticeBatch([[NOTICE_A, 'needs_person']])
    holdForNextStep(id, notice, eventsOf(notice), { dir: world.dir })
    if (id === CONN) assert.ok(runStepHook(world, toolCall()), 'handed over, not read')
    const job = checkJobBatch()
    holdForNextStep(id, job, eventsOf(job), { dir: world.dir })
    const later = noticeBatch([[NOTICE_B, 'needs_person']], '22222222-2222-4222-8222-2222222222b2')
    holdForNextStep(id, later, eventsOf(later), { dir: world.dir })
  }

  const parkedKeys = (world, id) =>
    fs.readdirSync(parkedDir(id, world.dir)).filter((name) => name.startsWith('w-'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(parkedDir(id, world.dir), name), 'utf8')).key).sort()

  /** A second connection of the same conversation, live, as a reconnect writes it, `old` ended. */
  function reconnect(world, over = {}, old = CONN) {
    const id = randomUUID()
    fs.writeFileSync(path.join(world.dir, `${old}.json`), JSON.stringify({ connection_id: old, enabled: false, end_reason: 'local_stop', agent_name: 'Cursor', local_id: CONVERSATION }))
    fs.writeFileSync(path.join(world.dir, `${id}.json`), JSON.stringify({ connection_id: id, enabled: true, agent_name: 'Cursor', local_id: CONVERSATION, session_id: ROOM, ...over }))
    return id
  }

  it('parks everything out of the hook\'s way: no later tool call starts the hook, nothing is written anywhere unseen', () => {
    const world = connectedHome()
    holdSome(world)
    const parked = parkSteps(CONN, { dir: world.dir })
    assert.equal(parked.parked.length, 3)
    assert.equal(fs.existsSync(stepsDir(CONN, world.dir)), false)
    assert.deepEqual(parkedKeys(world, CONN), [
      checkJobAcceptanceKey(checkJob()),
      noticeBatch([[NOTICE_A, 'needs_person']]).acceptance_key,
      noticeBatch([[NOTICE_B, 'needs_person']], '22222222-2222-4222-8222-2222222222b2').acceptance_key,
    ].sort())
    assert.equal(JSON.parse(fs.readFileSync(path.join(parkedDir(CONN, world.dir), 'manifest.json'), 'utf8')).local_id, CONVERSATION)
    assert.equal(world.wakeText(), '', 'nothing written where no one may read it')
    // Pointed at a plugin folder that is not there, a started node would fail the hook.
    assert.equal(runStepHook(world, toolCall(), { CLAUDE_PLUGIN_ROOT: path.join(world.home, 'no-plugin-here') }), null)
  })

  it('the next connection of the same conversation takes them back and delivers them once, the woken note too', async () => {
    const world = connectedHome()
    holdNotices(world, 22, 2_000)
    world.endTurn()
    await releaseAtIdle(CONN, IDLE(world))
    holdSome(world)
    parkSteps(CONN, { dir: world.dir })
    const next = reconnect(world)
    assert.equal(adoptParked(next, { dir: world.dir, localId: 'another-conversation' }).length, 0, 'never another conversation\'s')
    assert.equal(adoptParked(next, { dir: world.dir, localId: CONVERSATION }).length, 25)
    assert.equal(fs.existsSync(parkedDir(CONN, world.dir)), false)
    world.inTurn()
    const context = runStepHook(world, toolCall())
    const note = readNoteText(noteIdIn(context), { home: world.home })
    for (const end of ['END-0', 'END-21', NOTICE_A, NOTICE_B, JOB_A]) assert.ok(note.includes(end), end)
    assert.equal(readNote(world, context), null)
    world.endTurn()
    assert.equal(await releaseAtIdle(next, IDLE(world, { state: { local_id: CONVERSATION } })), null, 'nothing left to offer')
  })

  it('a remote stop parks them, and the next poller start of the conversation takes them back', async () => {
    // A connection id of its own: a stop signals every process on the machine whose
    // command line names the connection, and other tests' pollers use the fixture's.
    const world = connectedHome({ state: { local_id: 'another-conversation' } })
    const old = randomUUID()
    fs.writeFileSync(path.join(world.dir, `${old}.json`), JSON.stringify({ connection_id: old, enabled: true, agent_name: 'Cursor', local_id: CONVERSATION }))
    holdSome(world, old)
    const stop = spawnSync(process.execPath, [STATE_SCRIPT, 'disable', '--connection-id', old, '--agent', 'Cursor', '--local-id', CONVERSATION], {
      env: { PATH: process.env.PATH, HOME: world.home, DEVSPEC_MCP_URL: UNROUTABLE },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(stop.status, 0, stop.stderr)
    assert.equal(JSON.parse(stop.stdout).steps_parked, 3)
    assert.equal(fs.existsSync(stepsDir(old, world.dir)), false)
    const next = reconnect(world, { token: 'dvs_test_token', mcp_url: UNROUTABLE }, old)
    const env = { ...process.env, HOME: world.home, DEVSPEC_MCP_URL: UNROUTABLE }
    delete env.DEVSPEC_MCP_TOKEN
    const poller = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', next, '--owner-pid', String(process.pid)], { env })
    let stderr = ''
    poller.stdout.resume()
    poller.stderr.on('data', (chunk) => { stderr += chunk })
    const closed = new Promise((resolve) => poller.once('close', resolve))
    try {
      // The files and the poller's own line are separate observations: wait for both.
      assert.ok(await until(() => list(stepsDir(next, world.dir)).filter((name) => name.startsWith('w-')).length === 3 && /took back 3 item/.test(stderr)), stderr)
    } finally {
      poller.kill('SIGTERM')
      await closed
    }
    assert.equal(fs.existsSync(parkedDir(old, world.dir)), false)
  })

  it('a poller that stands down (signed out) parks them', () => {
    const world = connectedHome()
    const id = randomUUID()
    fs.writeFileSync(
      path.join(world.dir, `${id}.json`),
      JSON.stringify({ connection_id: id, enabled: true, agent_name: 'Cursor', local_id: 'conversation-two', auth_source: 'login', principal: 'nobody', mcp_url: UNROUTABLE }),
    )
    holdSome(world, id)
    const run = spawnSync(process.execPath, [POLL_SCRIPT, '--connection-id', id], {
      env: { PATH: process.env.PATH, HOME: world.home, DEVSPEC_MCP_URL: UNROUTABLE },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.match(run.stderr, /signed out/)
    assert.equal(fs.existsSync(stepsDir(id, world.dir)), false)
    assert.equal(parkedKeys(world, id).length, 3)
    assert.equal(JSON.parse(fs.readFileSync(path.join(parkedDir(id, world.dir), 'manifest.json'), 'utf8')).local_id, 'conversation-two')
  })

  it("the next poller start parks every ended connection's items and leaves a live one's", () => {
    const world = connectedHome()
    const stopped = randomUUID()
    const gone = randomUUID()
    fs.writeFileSync(path.join(world.dir, `${stopped}.json`), JSON.stringify({ connection_id: stopped, enabled: false, end_reason: 'local_stop' }))
    for (const id of [CONN, stopped, gone]) holdSome(world, id)
    // A poller started for a connection that has since ended sweeps before it exits.
    const run = spawnSync(process.execPath, [POLL_SCRIPT, '--connection-id', stopped], {
      env: { PATH: process.env.PATH, HOME: world.home, DEVSPEC_MCP_URL: UNROUTABLE },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.match(run.stderr, /disabled in state file/)
    for (const id of [stopped, gone]) {
      assert.equal(fs.existsSync(stepsDir(id, world.dir)), false)
      assert.equal(parkedKeys(world, id).length, 3)
    }
    assert.ok(fs.existsSync(stepsDir(CONN, world.dir)), 'still live: kept')
    assert.ok(runStepHook(world, toolCall()), 'and still delivered')
  })

  it('a reader stopped while Cursor is not reading counts only the wakes it handed over whole; the rest are parked and handed over whole on reconnect', async () => {
    const world = connectedHome()
    world.endTurn()
    // Twenty notices, each released whole in a wake of its own at idle.
    for (let i = 0; i < 20; i += 1) {
      holdNotices(world, 1, 17_000, i)
      assert.equal((await releaseAtIdle(CONN, IDLE(world))).released.length, 1)
    }
    assert.equal(world.inFlight().length, 20)
    const total = fs.statSync(world.wakeFile).size
    // Cursor is not reading: the reader's pipe backs up.
    assert.ok(total > 300_000, `${total} bytes in the wake file`)
    const tail = spawn(process.execPath, [TAIL_SCRIPT, '--file', world.wakeFile], { stdio: ['ignore', 'pipe', 'ignore'] })
    tail.stdout.pause()
    const closed = new Promise((resolve) => tail.once('close', resolve))
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let received = ''
    try {
      // Until what it notes stops moving: the pipe is full and a write waits.
      let noted = -1
      const deadline = Date.now() + 20_000
      for (let still = 0; still < 6 && Date.now() < deadline; await pause(250)) {
        const now = printedThrough(world.wakeFile)
        still = now > 0 && now === noted ? still + 1 : 0
        noted = now
      }
      assert.ok(noted > 0 && noted < total, `${noted} of ${total} bytes noted as printed`)
      // Stopped, it waits for the write still in flight, which cannot finish; the host then kills it.
      tail.kill('SIGTERM')
      await pause(500)
      assert.equal(tail.exitCode, null, 'still finishing the write in flight')
      tail.kill('SIGKILL')
      // What Cursor can still read from the pipe.
      tail.stdout.on('data', (data) => { received += data.toString() })
      tail.stdout.resume()
      await closed
      assert.equal(printedThrough(world.wakeFile), noted, 'nothing noted but what completed')
    } finally {
      tail.kill('SIGKILL')
      await closed
    }
    const noted = printedThrough(world.wakeFile)

    // Delivered: exactly the wakes noted, each whole in what Cursor received.
    const flights = world.inFlight().map((name) => JSON.parse(fs.readFileSync(path.join(stepsDir(CONN, world.dir), name), 'utf8')))
    const delivered = flights.filter((flight) => flight.end <= noted)
    const undelivered = flights.filter((flight) => flight.end > noted)
    assert.ok(delivered.length > 0 && undelivered.length > 0)
    assert.ok(Buffer.byteLength(received) >= noted)
    const shown = received.split('\n\n').filter((wake) => wake.trim()).map((wake) => JSON.parse(wake).content).filter(Boolean)
    for (const flight of delivered) {
      const end = flight.items[0].events.find((event) => event.type === 'system_notice').content.match(/END-\d+/)[0]
      assert.ok(shown.some((content) => content.includes(`${end}\n`) || content.includes(end)), `${end} reached Cursor whole`)
    }

    // The connection ends with Cursor: what was printed is delivered, the rest parked.
    parkSteps(CONN, { dir: world.dir })
    assert.equal(fs.existsSync(stepsDir(CONN, world.dir)), false)
    assert.deepEqual(parkedKeys(world, CONN), undelivered.map((flight) => flight.items[0].key).sort())

    // Reconnected, every undelivered notice is handed over whole, once.
    const next = reconnect(world)
    assert.equal(adoptParked(next, { dir: world.dir, localId: CONVERSATION }).length, undelivered.length)
    world.inTurn()
    const context = runStepHook(world, toolCall())
    const note = readNoteText(noteIdIn(context), { home: world.home })
    for (const flight of undelivered) {
      const end = flight.items[0].events.find((event) => event.type === 'system_notice').content.match(/END-\d+/)[0]
      assert.ok(note.includes(end), `${end} handed over`)
    }
    for (const flight of delivered) {
      const end = flight.items[0].events.find((event) => event.type === 'system_notice').content.match(/END-\d+/)[0]
      assert.ok(!new RegExp(`${end}\\b`).test(note), `${end} not handed over again`)
    }
    assert.equal(readNote(world, context), null)
  })

  it('never takes an item a live hook holds: the hook finishes, puts it back, parks it, and it is delivered once', async () => {
    const world = connectedHome()
    const batch = noticeBatch([[NOTICE_A, 'needs_person']])
    holdForNextStep(CONN, batch, eventsOf(batch), { dir: world.dir })
    let during = null
    const output = await stepDeliveryHook(toolCall(), {
      home: world.home,
      // While the hook holds the item (checking it is still open), the connection ends.
      isOpen: async () => {
        fs.writeFileSync(path.join(world.dir, `${CONN}.json`), JSON.stringify({ connection_id: CONN, enabled: false, end_reason: 'local_stop', agent_name: 'Cursor', local_id: CONVERSATION }))
        const parked = parkSteps(CONN, { dir: world.dir })
        during = { parked: parked.parked.length, left: parked.left, taken: list(stepsDir(CONN, world.dir)).filter((name) => name.includes('.taken-')).length }
        return true
      },
    })
    assert.deepEqual(during, { parked: 0, left: true, taken: 1 }, 'the cleanup left the held item and its folder alone')
    assert.equal(output, null, 'nothing handed over for a connection that has ended')
    assert.equal(fs.existsSync(stepsDir(CONN, world.dir)), false, 'the hook parked it as it finished')
    assert.equal(parkedKeys(world, CONN).length, 1)
    const next = reconnect(world)
    adoptParked(next, { dir: world.dir, localId: CONVERSATION })
    const context = runStepHook(world, toolCall())
    assert.ok(readNoteText(noteIdIn(context), { home: world.home }).includes(NOTICE_A))
    assert.equal(readNote(world, context), null)
    assert.equal(runStepHook(world, toolCall({ tool_input: { command: 'ls' } })), null, 'delivered once')
    assert.equal(world.wakeText(), '')
  })
})

function list(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
