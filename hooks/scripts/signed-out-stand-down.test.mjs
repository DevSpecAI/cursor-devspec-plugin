/**
 * When DevSpec stops accepting the background features' sign-in (the person
 * disconnected Cursor on the Agent setup page), remote control stops and says so in
 * DevSpec's own words plus how to sign in again: never a connection that just goes
 * quiet (item 95a67ee4, criterion 6). The real poller and wait, against a stub server.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SIGNED_OUT_SENTENCE } from '../../tests/helpers/fake-devspec-sign-in.mjs'
import { loginPrincipal, loginState, saveLogin } from './auth-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONNECTION = '30000000-0000-4000-8000-000000000003'

function runToExit(script, args, env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script} did not stop:\n${stderr}`)) }, timeoutMs)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

test('the poller stands a connection down when DevSpec says the tool was disconnected, and the wait tells the agent', async () => {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      calls.push({ bearer: req.headers.authorization, name: JSON.parse(raw || '{}').params?.name })
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: SIGNED_OUT_SENTENCE, code: 'signed_out', retryable: false }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const mcpUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-signed-out-'))
  try {
    const login = await saveLogin({
      mcpUrl,
      tokens: { accessToken: 'oat_live', refreshToken: 'rt_live', issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000 },
      issuer: 'https://issuer.test',
      tokenEndpoint: 'https://issuer.test/oauth/token',
      clientId: 'cursor-client',
      resource: mcpUrl,
    }, { home })
    const dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true })
    const stateFile = path.join(dir, `${CONNECTION}.json`)
    fs.writeFileSync(stateFile, JSON.stringify({
      enabled: true,
      connection_id: CONNECTION,
      agent_name: 'Cursor',
      mcp_url: mcpUrl,
      auth_source: 'login',
      principal: loginPrincipal(login),
    }), { mode: 0o600 })
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }

    const poller = await runToExit('devspec-remote-poll.mjs', ['--connection-id', CONNECTION], env)
    assert.equal(poller.code, 1)
    assert.ok(calls.length >= 2 && calls.every((c) => c.bearer === 'Bearer oat_live'), 'it used the login’s token, and asked again before giving up')
    const ended = poller.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((e) => e.type === 'session_ended')
    assert.equal(ended.reason, 'signed_out')
    assert.ok(ended.message.startsWith(SIGNED_OUT_SENTENCE), ended.message)
    assert.match(ended.message, /To sign in again, run \/devspec-remote/)

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(state.enabled, false)
    assert.equal(state.end_reason, 'signed_out')
    assert.equal(state.ended_from_ui, false, 'not a UI End')
    assert.equal(state.end_message, ended.message)
    assert.equal(loginState(mcpUrl, { home }).kind, 'ended', 'the refused login is not used again')

    // The agent's wait wakes with the same sentence instead of exiting silently.
    const wakeFile = path.join(home, 'wake.jsonl')
    const wait = await runToExit('devspec-remote-wait.mjs', ['--connection-id', CONNECTION, '--pending', '--wake-file', wakeFile], env)
    assert.equal(wait.code, 1)
    const woke = JSON.parse(wait.stdout.split('\n').filter(Boolean).at(-1))
    assert.deepEqual([woke.type, woke.reason, woke.message], ['session_ended', 'signed_out', ended.message])
    assert.match(fs.readFileSync(wakeFile, 'utf8'), /signed_out/)
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() })
    fs.rmSync(home, { recursive: true, force: true })
  }
})
