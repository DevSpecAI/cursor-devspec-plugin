#!/usr/bin/env node
/**
 * The real poller against a stub server with DevSpec's push stream open (item
 * 2540fd35). A nudge is handled only by a poll that started after it and looked at the
 * live end of the room, so:
 *
 * - a nudge pushed while the poller pages BACK through older room history (after it
 *   joins or resumes a busy room) is still owed when the drain ends, and the poller
 *   looks at the live end straight away instead of sleeping until its 45 s safety tick;
 * - an answer on the interaction-event lane alone carries no room ingress, so it does
 *   not handle a room nudge either;
 * - a poll that fails is retried after the error back-off, not slept on.
 *
 * Both used to wait for the safety tick: every poll cleared the nudge as it started,
 * including history pages and polls that then failed. The windows asserted below are a
 * few seconds, far inside the 45 s tick, so the old behaviour fails them.
 * Run: node --test hooks/scripts/push-gate-ack-loop.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isPushStreamRequest, openPushStream } from './fixtures/push-stream.mjs'
import { FIXTURE_ID, fixtureContextEntry, fixtureEnvelope, fixtureWindow } from './remote-ingress-test-fixtures.mjs'
import { resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'

const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')
const CONNECTION = FIXTURE_ID.connection
const SESSION = '20000000-0000-4000-8000-0000000000c1'
const LOCAL_ID = '80000000-0000-4000-8000-0000000000c1'

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(25)
  return condition()
}

/** One page of older room history: advisory context only, more pages behind it or not. */
function historyPage(sequence, nextCursor) {
  const entry = fixtureContextEntry({ sequence, kind: 'human', content: `older message ${sequence}` })
  return fixtureEnvelope({
    envelopeId: `e0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    wakeKind: 'advisory_update',
    commands: [],
    context: { human_context: [entry], agent_context: [], ai_context: [], system_context: [] },
    window: fixtureWindow([entry], nextCursor
      ? {
          total_known: null,
          truncated: true,
          has_more: true,
          next_cursor: nextCursor,
          fetch_id: `session:${SESSION}:messages`,
          omission_reason: 'history_before_window',
        }
      : { fetch_id: `session:${SESSION}:messages` }),
  })
}

/**
 * A stub DevSpec. `answer(args, world)` decides each poll's reply; everything else is
 * answered with an empty result. The push stream is always available.
 */
async function stubServer(answer) {
  const polls = []
  const world = { stream: null }
  const server = http.createServer((request, response) => {
    if (isPushStreamRequest(request)) {
      world.stream = openPushStream(response)
      return undefined
    }
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      const call = parsed.params ?? {}
      if (call.name === 'poll_connection') {
        const args = call.arguments ?? {}
        polls.push({ at: Date.now(), args })
        const reply = await answer(args, world, polls.length)
        if (reply?.httpStatus) {
          response.writeHead(reply.httpStatus, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'unavailable' }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: text(reply) }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: text({}) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/api/mcp`,
    world,
    polls,
    close: () => {
      world.stream?.close()
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

function startPoller(stub, { sessionId = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-push-ack-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true, connection_id: CONNECTION, session_id: sessionId, agent_name: 'Cursor',
    local_id: LOCAL_ID, token: 'dvs_test_token', mcp_url: stub.url,
  }), { mode: 0o600 })
  const env = { ...process.env, HOME: home }
  delete env.DEVSPEC_DISABLE_SSE
  const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', CONNECTION], { env })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return {
    stderr: () => stderr,
    stop: () => {
      child.kill('SIGKILL')
      try { fs.rmSync(resolveSpaceFreeWakeFile(CONNECTION), { force: true }) } catch { /* ignore */ }
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const quietLive = () => ({ status: 'live', session_id: SESSION, changed: false, cursor: null, cursor_v2: 'after:live-1', dispatch_cursor: 'dispatch-1' })

describe('a nudge is handled only by a poll that looked at the live end (item 2540fd35)', () => {
  it('a nudge pushed during a history drain is answered as soon as the drain ends', async () => {
    let drainDoneAt = null
    const stub = await stubServer(async (args, world) => {
      const page = (envelope) => ({
        status: 'live', session_id: SESSION, changed: true, cursor: null,
        cursor_v2: 'after:live-1', dispatch_cursor: 'dispatch-1', ingress: envelope, dispatches: [],
      })
      if (!args.catch_up_cursor && args.catch_up === true && !drainDoneAt) {
        // The seed: the newest page, with older history behind it.
        return page(historyPage(30, 'before:page-2'))
      }
      if (args.catch_up_cursor === 'before:page-2') {
        // A message lands in the room while the poller is still reading older pages.
        world.stream?.send('wake', {})
        await sleep(50)
        return page(historyPage(20, 'before:page-3'))
      }
      if (args.catch_up_cursor === 'before:page-3') {
        drainDoneAt = Date.now()
        return page(historyPage(10, null))
      }
      return quietLive()
    })
    const poller = startPoller(stub, { sessionId: SESSION })
    try {
      assert.ok(await until(() => drainDoneAt !== null, 15_000), `the poller drained the history pages\n${poller.stderr()}`)
      const lastPage = stub.polls.findIndex((poll) => poll.args.catch_up_cursor === 'before:page-3')
      assert.ok(
        await until(() => stub.polls.length > lastPage + 1, 4_000),
        `a live poll follows the drain at once, not on the 45 s safety tick\n${poller.stderr()}`,
      )
      const live = stub.polls[lastPage + 1]
      assert.equal(live.args.catch_up_cursor, undefined, 'the poll after the drain reads the live end')
      assert.equal(live.args.wait_ms, 0, 'and asks the server not to hold')
      assert.ok(live.at - drainDoneAt < 3_000, `it followed the last page within seconds (${live.at - drainDoneAt}ms)`)
      // Handled: it goes back to sleep on the stream.
      const before = stub.polls.length
      await sleep(1_500)
      assert.equal(stub.polls.length, before, `asleep again once the nudge is handled; saw ${JSON.stringify(stub.polls.slice(before).map((p) => p.args.catch_up_cursor ?? 'live'))}`)
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  it('an answer on the interaction-event lane alone does not handle a room nudge', async () => {
    // The server answers the nudge's poll on the directed-question event lane only, with
    // no room ingress at all (here one this poller cannot apply). The room was not read,
    // so the nudge is still owed: the next lap polls after the short empty-turn back-off
    // instead of sleeping until the 45 s safety tick.
    let eventOnlyNext = false
    let eventOnlyAt = null
    const stub = await stubServer(async () => {
      if (eventOnlyNext) {
        eventOnlyNext = false
        eventOnlyAt = Date.now()
        return { status: 'live', session_id: null, changed: true, interaction_event_version: 1, interaction_events: [] }
      }
      return { connection_id: CONNECTION, session_id: null, changed: false }
    })
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => stub.world.stream && stub.polls.length > 0), `the poller opened the stream and polled\n${poller.stderr()}`)
      await sleep(500)
      const idleBefore = stub.polls.length
      await sleep(1_000)
      assert.equal(stub.polls.length, idleBefore, 'idle on the open stream: no polls')

      eventOnlyNext = true
      stub.world.stream.send('wake', {})
      assert.ok(await until(() => eventOnlyAt !== null, 3_000), `the pushed wake sent a poll\n${poller.stderr()}`)
      const afterEventOnly = stub.polls.length
      assert.ok(
        await until(() => stub.polls.length > afterEventOnly, 3_500),
        `the room nudge is still owed after an event-lane-only answer\n${poller.stderr()}`,
      )
      const settled = stub.polls.length
      await sleep(1_500)
      assert.equal(stub.polls.length, settled, 'the room read that followed handled it; the poller sleeps again')
    } finally {
      poller.stop()
      await stub.close()
    }
  })

  it('a poll that fails is retried after its back-off, then the poller sleeps again', async () => {
    let failNext = false
    let failedAt = null
    const stub = await stubServer(async () => {
      if (failNext) {
        failNext = false
        failedAt = Date.now()
        return { httpStatus: 503 }
      }
      return { connection_id: CONNECTION, session_id: null, changed: false }
    })
    const poller = startPoller(stub)
    try {
      assert.ok(await until(() => stub.world.stream && stub.polls.length > 0), `the poller opened the stream and polled\n${poller.stderr()}`)
      await sleep(500)
      const idleBefore = stub.polls.length
      await sleep(1_000)
      assert.equal(stub.polls.length, idleBefore, 'idle on the open stream: no polls')

      failNext = true
      stub.world.stream.send('wake', {})
      assert.ok(await until(() => failedAt !== null, 3_000), `the pushed wake sent a poll, which failed\n${poller.stderr()}`)
      const afterFailure = stub.polls.length
      // errorBackoffMs(1) is 2 s; the safety tick is 45 s.
      assert.ok(
        await until(() => stub.polls.length > afterFailure, 4_500),
        `the failed poll is retried after its back-off\n${poller.stderr()}`,
      )
      const retry = stub.polls[afterFailure]
      assert.ok(retry.at - failedAt >= 1_500, `the retry waited for the back-off (${retry.at - failedAt}ms)`)
      const settled = stub.polls.length
      await sleep(1_500)
      assert.equal(stub.polls.length, settled, 'one successful retry settles it; the poller sleeps again')
    } finally {
      poller.stop()
      await stub.close()
    }
  })
})
