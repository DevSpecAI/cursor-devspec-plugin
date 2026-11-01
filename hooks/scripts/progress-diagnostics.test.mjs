import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { classifyProgressFailure, recordProgressFailure } from './progress-diagnostics.mjs'
import { fixture, ID } from '../../tests/helpers/local-diagnostics.mjs'

test('progress diagnostics are off by default', () => fixture(({ root }) => {
  assert.equal(recordProgressFailure(ID, new Error('private')), false)
  assert.equal(fs.existsSync(root), false)
}))

test('only safe failure categories enter an opted-in run', () => fixture(({ events }) => {
  assert.equal(recordProgressFailure(ID, Object.assign(new Error('Failed to write work trail: activity_attempt_closed SYMBOLIC_PRIVATE'), { status: 400 })), true)
  assert.equal(events()[0].reason, 'activity_attempt_closed')
  assert.equal(events()[0].httpStatus, 400)
  assert.equal(JSON.stringify(events()).includes('SYMBOLIC'), false)
  assert.equal(classifyProgressFailure({ cause: { code: 'ECONNRESET' } }).reason, 'network_failure')
  assert.equal(classifyProgressFailure({ code: 'timeout' }).reason, 'timeout')
  assert.deepEqual(classifyProgressFailure({ status: 503, serverCode: 'auth_validation_unavailable', retryable: true }), { reason: 'http_failure', serverCode: 'auth_validation_unavailable', retryable: true, httpStatus: 503 })
  assert.equal(classifyProgressFailure({ serverCode: 'SYMBOLIC_SECRET' }).serverCode, undefined)
}, true))

test('real reporter preserves refusal locally with stderr ignored, and performs no log upload', { timeout: 10000 }, () => fixture(async ({ home, connections, events }) => {
  const statePath = path.join(connections, `${ID}.json`)
  let calls = 0, child
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      calls++
      assert.equal(req.url, '/mcp')
      fs.writeFileSync(statePath, JSON.stringify({ enabled: false }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Failed to write work trail: activity_attempt_closed SYMBOLIC_PRIVATE' }] } }))
    })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const transcriptDir = path.join(home, '.cursor', 'projects', 'fixture', 'agent-transcripts', ID)
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, `${ID}.jsonl`), JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'SYMBOLIC_TRANSCRIPT' }] } }) + '\n')
    fs.writeFileSync(statePath, JSON.stringify({ enabled: true, local_id: ID, session_id: ID, mcp_token: 'SYMBOLIC_TOKEN', mcp_url: `http://127.0.0.1:${server.address().port}/mcp` }))
    fs.writeFileSync(path.join(connections, `${ID}.turn`), '{}')
    child = spawn(process.execPath, [fileURLToPath(new URL('./cli-trail-watch.mjs', import.meta.url)), '--connection-id', ID, '--poll-ms', '250'], { stdio: 'ignore', env: { ...process.env, HOME: home, USERPROFILE: home } })
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reporter did not exit')), 5000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(code, 0); assert.equal(calls, 1)
    assert.equal(events().find(e => e.kind === 'progress_failure').reason, 'activity_attempt_closed')
    const mcp = events().find(e => e.kind === 'mcp' && e.phase === 'end')
    assert.ok(mcp.request_bytes > 0); assert.ok(mcp.response_bytes > 0)
    assert.equal(JSON.stringify(events()).includes('SYMBOLIC'), false)
  } finally {
    if (child && child.exitCode === null) child.kill()
    await new Promise(resolve => server.close(resolve))
  }
}, true))
