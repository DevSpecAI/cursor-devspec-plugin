#!/usr/bin/env node
/**
 * The real poller against a stub server that serves DevSpec's push stream (item
 * 507705dd, following 59afbe7e). While the stream is open the poller must not hold a
 * long poll beside it: it sleeps, and only a pushed frame (or local work starting, or
 * the 45 s presence refresh) sends it to the server, with wait_ms 0. When the stream
 * closes it must go back to held long polls, because that is then the only way it
 * hears anything.
 *
 * The stub answers every poll at once with changed:false. A poller that still
 * long-polled beside the stream would therefore poll back to back, which is what the
 * quiet windows below would catch.
 * Run: node --test hooks/scripts/push-channel-loop.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isPushStreamRequest, openPushStream, refusePushStream } from './fixtures/push-stream.mjs'

const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')
const CONNECTION = '10000000-0000-4000-8000-0000000000b0'
const LOCAL_ID = '80000000-0000-4000-8000-0000000000b0'

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await sleep(25)
  return condition()
}

async function stubServer() {
  const polls = []
  const world = { streamAvailable: true, stream: null, streamsOpened: 0 }
  const server = http.createServer((request, response) => {
    if (isPushStreamRequest(request)) {
      if (!world.streamAvailable) return refusePushStream(response)
      world.streamsOpened++
      world.stream = openPushStream(response)
      return undefined
    }
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      const call = parsed.params ?? {}
      let result = text({})
      if (call.name === 'poll_connection') {
        const waitMs = call.arguments?.wait_ms
        polls.push({ at: Date.now(), waitMs })
        // A held poll is answered after a short pause rather than its full hold, so the
        // fallback phase stays fast without turning into a hot loop.
        if (typeof waitMs === 'number' && waitMs > 0) await sleep(100)
        result = text({ connection_id: CONNECTION, session_id: null, changed: false })
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
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

function startPoller(stub) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-push-loop-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
    enabled: true, connection_id: CONNECTION, session_id: null, agent_name: 'Cursor',
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
    stop: () => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }) },
  }
}

/** Whether no poll at all arrived in the next `ms`, and any that did. */
async function quietFor(stub, ms) {
  const before = stub.polls.length
  await sleep(ms)
  return { quiet: stub.polls.length === before, during: stub.polls.slice(before) }
}

describe('the poller sleeps on an open push stream (items 59afbe7e, 507705dd)', () => {
  it('holds no long poll while the stream is open, fetches at once on a push, and holds polls again once it closes', async () => {
    const stub = await stubServer()
    const poller = startPoller(stub)
    try {
      // Connected: the stream is open and the poller has made its first fetch.
      assert.ok(await until(() => stub.world.stream && stub.polls.length > 0), `the poller opened the stream and polled\n${poller.stderr()}`)

      // Idle with the stream open: no polls at all, although every poll is answered at once.
      const idle = await quietFor(stub, 1_500)
      assert.ok(idle.quiet, `no poll while the stream is open and nothing moved; saw ${JSON.stringify(idle.during)}\n${poller.stderr()}`)

      // A pushed wake: one immediate fetch, which does not hold.
      const beforeWake = stub.polls.length
      const wakeAt = Date.now()
      stub.world.stream.send('wake', {})
      assert.ok(await until(() => stub.polls.length > beforeWake, 3_000), `a pushed wake makes the poller fetch\n${poller.stderr()}`)
      const woken = stub.polls[beforeWake]
      assert.equal(woken.waitMs, 0, 'the fetch after a push asks the server not to hold')
      assert.ok(woken.at - wakeAt < 1_000, `the fetch follows the push at once (took ${woken.at - wakeAt}ms)`)

      // ...and then it goes back to sleep on the stream.
      const afterWake = await quietFor(stub, 1_500)
      assert.ok(afterWake.quiet, `asleep again after handling the push; saw ${JSON.stringify(afterWake.during)}`)

      // The stream closes and cannot be reopened: the poller holds polls again.
      stub.world.streamAvailable = false
      const beforeClose = stub.polls.length
      stub.world.stream.close()
      assert.ok(await until(() => stub.polls.length > beforeClose, 3_000), `the poller polls once the stream has closed\n${poller.stderr()}`)
      assert.ok(stub.polls[beforeClose].waitMs > 0, `the first poll after the stream closed holds (wait_ms ${stub.polls[beforeClose].waitMs})`)
      // Its reconnect is refused, and every poll from then on is a held one.
      assert.ok(await until(() => /SSE push unavailable/.test(poller.stderr()), 8_000), `the refused reconnect is reported\n${poller.stderr()}`)
      const settled = stub.polls.length
      assert.ok(await until(() => stub.polls.length >= settled + 2, 3_000), 'held polls continue')
      assert.ok(stub.polls.slice(settled).every((poll) => poll.waitMs > 0), `every poll after the fallback holds: ${JSON.stringify(stub.polls.slice(settled))}`)
      assert.equal(stub.world.streamsOpened, 1, 'the stream was opened once and not reopened after it was refused')
    } finally {
      poller.stop()
      await stub.close()
    }
  })
})
