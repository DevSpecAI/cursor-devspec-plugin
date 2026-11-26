#!/usr/bin/env node
/**
 * The real poller against a stub DevSpec: which room command each pickup starts, and
 * what each turn-finished report from the poller names (item a4391300,
 * turn-commands.mjs).
 *
 * - A command handed over at idle is started by name, and the turn it starts ends by
 *   naming it.
 * - A command handed over while a turn is already running is started by name too,
 *   and the running turn's end does not finish it.
 * - A check job or an automation run reaching an idle agent reports no pickup at all,
 *   so it cannot start a room command, and its turn ends unbound.
 * - A turn left hanging when the next command arrives is ended by naming its own
 *   command, before the new one is started.
 *
 * The stub refuses DevSpec's push stream, so the poller holds long polls; each held
 * poll is answered after a short pause. No --owner-pid is passed, so the poller arms
 * no wake-follow beside it (that needs an owner) and nothing else ends the turns
 * these tests start.
 * Run: node --test hooks/scripts/command-pickup.test.mjs
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
import {
  FIXTURE_ID,
  fixtureAutomationDispatch,
  fixtureCommand,
  fixtureEnvelope,
  fixtureOrder,
  fixtureUuid,
} from './remote-ingress-test-fixtures.mjs'
import { resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'
import { startRoomCommands } from './command-start.mjs'

const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')
const CONNECTION = FIXTURE_ID.connection
const FIRST = { turnId: FIXTURE_ID.turn, messageId: FIXTURE_ID.message }
const SECOND = { turnId: fixtureUuid(202), messageId: fixtureUuid(201) }
const CHECK_JOB = fixtureUuid(400)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(25)
  return condition()
}

function command(identity, body, sequence) {
  const base = fixtureCommand(body)
  const provenance = identity === FIRST ? FIXTURE_ID.provenance : fixtureUuid(203)
  return {
    ...base,
    message_id: identity.messageId,
    order: fixtureOrder(sequence, identity.messageId),
    delivery: { ...base.delivery, turn_id: identity.turnId, provenance_ref: provenance, primary_provenance_ref: provenance },
  }
}

const commandPoll = (identity, body, sequence) => ({
  status: 'live',
  session_id: null,
  changed: true,
  cursor: identity.messageId,
  cursor_v2: `after:command-${sequence}`,
  dispatch_cursor: 'dispatch-0',
  ingress: fixtureEnvelope({
    envelopeId: fixtureUuid(500 + sequence),
    commands: [command(identity, body, sequence)],
  }),
  dispatches: [],
})

const dispatchPoll = (dispatch) => ({
  status: 'live',
  session_id: null,
  changed: true,
  cursor: null,
  cursor_v2: 'after:dispatch-1',
  dispatch_cursor: '2026-11-20T12:00:00.000Z',
  ingress: fixtureEnvelope({ envelopeId: fixtureUuid(600), wakeKind: 'advisory_update', commands: [] }),
  dispatches: [dispatch],
})

function checkJob() {
  return {
    id: CHECK_JOB,
    kind: 'check_job',
    check_job_id: CHECK_JOB,
    check_kind: 'conflict',
    record: { type: 'task', id: fixtureUuid(401), title: 'Fix the login redirect' },
    entries: 1,
    yours: false,
    offered_at: '2026-11-20T12:00:00.000Z',
    delivery_connection_id: CONNECTION,
  }
}

/** A stub DevSpec that serves queued poll responses, one per poll, and records every call. */
async function stubDevSpec() {
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
      calls.push({ name, args })
      let result = {}
      if (name === 'poll_connection') {
        polls.push(args)
        const next = queue.shift()
        if (next) {
          idleCursor = { cursor: next.cursor, cursor_v2: next.cursor_v2, dispatch_cursor: next.dispatch_cursor }
          result = next
        } else {
          await sleep(100)
          result = { status: 'live', session_id: null, changed: false, ...idleCursor }
        }
      } else if (name === 'report_pickup') {
        result = { outcome: 'picked_up' }
      } else if (name === 'report_complete') {
        result = { closed_as: 'done' }
      }
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
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    polls,
    serve: (payload) => queue.push(payload),
    named: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

async function startPoller() {
  const stub = await stubDevSpec()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-command-pickup-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true,
    connection_id: CONNECTION,
    session_id: null,
    agent_name: 'Cursor',
    token: 'dvs_test_token',
    mcp_url: stub.url,
    ingress_version: 1,
  }), { mode: 0o600 })
  const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], {
    env: { ...process.env, HOME: home },
  })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const marker = path.join(dir, `${CONNECTION}.turn`)
  const turnCommands = path.join(dir, `${CONNECTION}.turn-commands.json`)
  const inbox = path.join(dir, `${CONNECTION}.inbox.jsonl`)
  const inboxCount = () => {
    try {
      return fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }
  return {
    stub,
    dir,
    home,
    inboxCount,
    stderr: () => stderr,
    /** A turn already running, as a typed prompt or another wake leaves it. */
    startTurn: (over = {}) => fs.writeFileSync(marker, JSON.stringify({ startedAt: Date.now(), held: true, ...over })),
    /** Simulate the agent actually reading the command from the wake reader / step note. */
    startCommand: (identity) =>
      startRoomCommands({
        connectionId: CONNECTION,
        commands: [identity],
        dir,
        home,
      }),
    /** The turn ends with nothing else reporting it, so the poller's backstop does. */
    endTurn: () => fs.rmSync(marker, { force: true }),
    recorded: () => {
      try {
        return JSON.parse(fs.readFileSync(turnCommands, 'utf8')).commands
      } catch {
        return null
      }
    },
    busySince: (index) => stub.polls.slice(index).some((poll) => poll.busy === true),
    async cleanup() {
      child.kill('SIGKILL')
      await stub.close()
      try { fs.rmSync(resolveSpaceFreeWakeFile(CONNECTION), { force: true }) } catch { /* nothing to clean */ }
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const pickupOf = (identity) => ({
  connection_id: CONNECTION,
  command_turn_id: identity.turnId,
  command_message_id: identity.messageId,
})

describe('the plugin names the room command each pickup starts only once the agent begins it (items a4391300, 3d327b4a)', () => {
  it('leaves a command waiting while only the poller has fetched it, then starts it by name once the agent reads it', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.stub.serve(commandPoll(FIRST, 'ship the release notes', 1))
      assert.ok(await until(() => run.inboxCount() >= 1), `no inbox write; stderr:\n${run.stderr()}`)
      // Wait a couple of polls: poller alone must NOT send report_pickup or flip busy to true.
      const afterInboxPolls = run.stub.polls.length
      assert.ok(await until(() => run.stub.polls.length >= afterInboxPolls + 2))
      assert.deepEqual(run.stub.named('report_pickup'), [], 'poller receipt must not prematurely report pickup')
      assert.equal(run.busySince(afterInboxPolls), false, 'poller receipt must not prematurely show Working')

      // Now the agent actually reads the wake and begins handling it.
      await run.startCommand(FIRST)
      assert.deepEqual(run.stub.named('report_pickup'), [pickupOf(FIRST)])
      assert.deepEqual(run.recorded(), [{ turn_id: FIRST.turnId, message_id: FIRST.messageId }])

      const pollsSoFar = run.stub.polls.length
      assert.ok(await until(() => run.busySince(pollsSoFar)), 'the turn the command started reports busy')
      run.endTurn()
      assert.ok(await until(() => run.stub.named('report_complete').length >= 1), `no completion; stderr:\n${run.stderr()}`)
      assert.deepEqual(run.stub.named('report_complete'), [{ ...pickupOf(FIRST), reason: 'turn_end' }])
      assert.equal(run.recorded(), null, 'the turn\'s end removes the record of what started it')
      assert.deepEqual(run.stub.named('report_pickup'), [pickupOf(FIRST)], 'the turn\'s start sent no pickup of its own')
    } finally {
      await run.cleanup()
    }
  })

  it('starts a command handed over mid-turn by name once read, and the running turn\'s end does not finish it', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.startTurn()
      assert.ok(await until(() => run.busySince(0)), 'the running turn reports busy')
      assert.deepEqual(run.stub.named('report_pickup'), [], 'a running turn no command started sends no pickup')

      run.stub.serve(commandPoll(FIRST, 'and update the changelog too', 1))
      assert.ok(await until(() => run.inboxCount() >= 1), `no inbox write; stderr:\n${run.stderr()}`)
      assert.deepEqual(run.stub.named('report_pickup'), [], 'mid-turn inbox receipt alone sends no pickup')

      await run.startCommand(FIRST)
      assert.deepEqual(run.stub.named('report_pickup'), [pickupOf(FIRST)])
      assert.equal(run.recorded(), null, 'a command joining a running turn is not one the turn started')

      run.endTurn()
      assert.ok(await until(() => run.stub.named('report_complete').length >= 1), `no completion; stderr:\n${run.stderr()}`)
      assert.deepEqual(run.stub.named('report_complete'), [
        { connection_id: CONNECTION, command_turn_unbound: true, reason: 'turn_end' },
      ])
    } finally {
      await run.cleanup()
    }
  })

  for (const [what, dispatch] of [['a check job', checkJob()], ['an automation run', fixtureAutomationDispatch()]]) {
    it(`reports no pickup when ${what} reaches an idle agent, and its turn ends unbound`, async () => {
      const run = await startPoller()
      try {
        assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
        run.stub.serve(dispatchPoll(dispatch))
        assert.ok(await until(() => run.busySince(1)), `the turn ${what} starts reports busy; stderr:\n${run.stderr()}`)
        // A few more ticks of the running turn: still no pickup.
        const pollsSoFar = run.stub.polls.length
        assert.ok(await until(() => run.stub.polls.length >= pollsSoFar + 2))
        assert.deepEqual(run.stub.named('report_pickup'), [], `${what} starts no room command`)

        run.endTurn()
        assert.ok(await until(() => run.stub.named('report_complete').length >= 1), `no completion; stderr:\n${run.stderr()}`)
        assert.deepEqual(run.stub.named('report_complete'), [
          { connection_id: CONNECTION, command_turn_unbound: true, reason: 'turn_end' },
        ])
        assert.deepEqual(run.stub.named('report_pickup'), [])
      } finally {
        await run.cleanup()
      }
    })
  }

  it('ends a turn left hanging by naming its own command before it starts the next one', async () => {
    const run = await startPoller()
    try {
      assert.ok(await until(() => run.stub.polls.length >= 1), `no poll; stderr:\n${run.stderr()}`)
      run.stub.serve(commandPoll(FIRST, 'ship the release notes', 1))
      assert.ok(await until(() => run.inboxCount() >= 1), `no first inbox write; stderr:\n${run.stderr()}`)
      await run.startCommand(FIRST)
      assert.equal(run.stub.named('report_pickup').length, 1)

      // The turn is still open but has gone quiet for longer than the hung-turn window.
      run.startTurn({ startedAt: Date.now() - 5 * 60_000 })
      run.stub.serve(commandPoll(SECOND, 'are you still there?', 2))
      assert.ok(await until(() => run.inboxCount() >= 2), `no second inbox write; stderr:\n${run.stderr()}`)
      await run.startCommand(SECOND)

      const order = run.stub.calls
        .filter((call) => call.name === 'report_pickup' || call.name === 'report_complete')
        .map((call) => ({ name: call.name, args: call.args }))
      assert.deepEqual(order, [
        { name: 'report_pickup', args: pickupOf(FIRST) },
        { name: 'report_complete', args: { ...pickupOf(FIRST), reason: 'max_turn_ms' } },
        { name: 'report_pickup', args: pickupOf(SECOND) },
      ])
      assert.deepEqual(run.recorded(), [{ turn_id: SECOND.turnId, message_id: SECOND.messageId }])
    } finally {
      await run.cleanup()
    }
  })
})
