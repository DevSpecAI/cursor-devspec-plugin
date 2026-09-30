import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyProgressFailure, recordProgressFailure, progressDiagnosticPath, MAX_DIAGNOSTIC_BYTES } from './progress-diagnostics.mjs'
const id = '10000000-0000-4000-8000-000000000001'
const fixture = fn => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-diagnostics-')); try { fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) } }

test('retains actionable categories, never arbitrary error prose, bodies or credentials', () => fixture(dir => {
  const error = Object.assign(new Error('Failed to write work trail: activity_attempt_closed Bearer SYMBOLIC_SECRET'), { status: 400, serverCode: 'SYMBOLIC_PRIVATE', retryable: false })
  assert.equal(recordProgressFailure(id, error, { dir, now: 0 }), true)
  const raw = fs.readFileSync(progressDiagnosticPath(id, dir), 'utf8')
  assert.equal(raw.includes('SYMBOLIC'), false)
  assert.deepEqual(JSON.parse(raw), { at: '1970-01-01T00:00:00.000Z', connectionId: id, source: 'trail_watch', phase: 'trail', reason: 'activity_attempt_closed', httpStatus: 400, retryable: false })
  if (process.platform !== 'win32') assert.equal(fs.statSync(progressDiagnosticPath(id, dir)).mode & 0o777, 0o600)
}))

test('distinguishes network and server auth outages from unclassified refusals', () => {
  assert.equal(classifyProgressFailure({ cause: { code: 'ECONNRESET' } }).reason, 'network_failure')
  assert.deepEqual(classifyProgressFailure({ status: 503, serverCode: 'auth_validation_unavailable', retryable: true }), { reason: 'http_failure', httpStatus: 503, serverCode: 'auth_validation_unavailable', retryable: true })
  assert.equal(classifyProgressFailure(new Error('private unknown body')).reason, 'unclassified_failure')
  assert.equal(classifyProgressFailure({ code: 'timeout' }).reason, 'timeout')
})

test('rotates one archive and bounds total bytes including pre-existing oversized files', () => fixture(dir => {
  const file = progressDiagnosticPath(id, dir)
  fs.writeFileSync(file, 'x'.repeat(MAX_DIAGNOSTIC_BYTES - 10), { mode: 0o600 })
  assert.equal(recordProgressFailure(id, new Error('unknown'), { dir }), true)
  assert.ok(fs.statSync(file).size < MAX_DIAGNOSTIC_BYTES)
  assert.ok(fs.statSync(file + '.1').size <= MAX_DIAGNOSTIC_BYTES)
  fs.writeFileSync(file, 'x'.repeat(MAX_DIAGNOSTIC_BYTES + 1))
  assert.equal(recordProgressFailure(id, new Error('unknown'), { dir }), true)
  assert.ok(fs.statSync(file).size < MAX_DIAGNOSTIC_BYTES)
  assert.equal(fs.existsSync(file + '.1'), false)
}))

test('bad identity, non-file paths, and failed diagnostics never affect the reporter', () => fixture(dir => {
  assert.equal(recordProgressFailure('../elsewhere', new Error('private'), { dir }), false)
  const file = progressDiagnosticPath(id, dir)
  fs.mkdirSync(file)
  assert.equal(recordProgressFailure(id, new Error('private'), { dir }), false)
}))

test('real detached-style reporter preserves a refusal with stderr discarded', { timeout: 10000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-reporter-'))
  const dir = path.join(home, '.devspec', 'remote-control', 'connections')
  fs.mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, `${id}.json`)
  let calls = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls++
      fs.writeFileSync(statePath, JSON.stringify({ enabled: false }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Failed to write work trail: activity_attempt_closed SYMBOLIC_PRIVATE' }] } }))
    })
  })
  let child
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const transcriptDir = path.join(home, '.cursor', 'projects', 'fixture', 'agent-transcripts', id)
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, `${id}.jsonl`), JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'SYMBOLIC_TRANSCRIPT' }] } }) + '\n')
    fs.writeFileSync(statePath, JSON.stringify({ enabled: true, local_id: id, session_id: id, mcp_token: 'SYMBOLIC_TOKEN', mcp_url: `http://127.0.0.1:${server.address().port}/mcp` }))
    fs.writeFileSync(path.join(dir, `${id}.turn`), '{}')
    child = spawn(process.execPath, [fileURLToPath(new URL('./cli-trail-watch.mjs', import.meta.url)), '--connection-id', id, '--poll-ms', '250'], { stdio: 'ignore', env: { ...process.env, HOME: home, USERPROFILE: home } })
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reporter did not exit')), 5000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(code, 0)
    assert.equal(calls, 1)
    const raw = fs.readFileSync(progressDiagnosticPath(id, dir), 'utf8')
    assert.equal(JSON.parse(raw).reason, 'activity_attempt_closed')
    assert.equal(raw.includes('SYMBOLIC'), false)
  } finally {
    if (child && child.exitCode === null) child.kill()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('does not follow a log symlink', { skip: process.platform === 'win32' }, () => fixture(dir => {
  const target = path.join(dir, 'target')
  fs.writeFileSync(target, 'preserve')
  fs.symlinkSync(target, progressDiagnosticPath(id, dir))
  assert.equal(recordProgressFailure(id, new Error('private'), { dir }), false)
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve')
}))
