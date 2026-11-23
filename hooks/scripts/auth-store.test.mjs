/**
 * The background features' login file (item 95a67ee4): one login per DevSpec server,
 * owner-only, renewed once past half its life under a cross-process lock that spends
 * Clerk's single-use renewal key exactly once however many processes ask at once.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { approve, startFakeDevspec } from '../../tests/helpers/fake-devspec-sign-in.mjs'
import {
  authDir,
  authFilePath,
  currentLoginSync,
  loginPrincipal,
  loginState,
  markLoginEnded,
  needsRenewal,
  principalOf,
  removeLogin,
  renewLogin,
  saveLogin,
} from './auth-store.mjs'
import { discoverSignIn, SignInEndedError, startLoopbackSignIn } from './sign-in.mjs'

const run = promisify(execFile)
const HOUR = 60 * 60 * 1000
const here = path.dirname(fileURLToPath(import.meta.url))
const PROD = 'https://api.devspec.ai/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection'
const STAGING = 'https://api.devspecstaging.com/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection'

let home
let fake
before(async () => { fake = await startFakeDevspec() })
after(async () => { await fake.close() })
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-auth-store-'))
})

function tokens(tag, issuedAt = Date.now(), lifeMs = 24 * HOUR) {
  return { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + lifeMs }
}

function save(mcpUrl, tag, issuedAt, lifeMs, extra = {}) {
  return saveLogin({
    mcpUrl,
    tokens: tokens(tag, issuedAt, lifeMs),
    issuer: 'https://issuer.test',
    tokenEndpoint: 'https://issuer.test/oauth/token',
    clientId: 'cursor-client',
    resource: new URL(mcpUrl).origin + new URL(mcpUrl).pathname,
    signedInAs: 'Ada Lovelace',
    ...extra,
  }, { home })
}

/** A real grant at the fake Clerk, saved as if it were issued `ageMs` ago. */
async function realLogin(ageMs) {
  const discovery = await discoverSignIn(fake.mcpUrl)
  const pending = await startLoopbackSignIn({ discovery, clientId: 'cursor-test-client' })
  await approve(pending.url)
  const issued = await pending.done
  const issuedAt = Date.now() - ageMs
  return saveLogin({
    mcpUrl: fake.mcpUrl,
    tokens: { ...issued, issuedAt, expiresAt: issuedAt + 24 * HOUR },
    issuer: discovery.issuer,
    tokenEndpoint: discovery.tokenEndpoint,
    revocationEndpoint: discovery.revocationEndpoint,
    clientId: 'cursor-test-client',
    resource: discovery.resource,
  }, { home })
}

test('a login is saved owner-only, keyed by the server and not by the address query', async () => {
  await save(PROD, 'prod')
  assert.equal(fs.statSync(authFilePath({ home })).mode & 0o777, 0o600)
  assert.equal(fs.statSync(authDir({ home })).mode & 0o777, 0o700)
  assert.equal(authFilePath({ home }), path.join(home, '.devspec', 'cursor', 'auth.json'))
  const saved = JSON.parse(fs.readFileSync(authFilePath({ home }), 'utf8'))
  assert.deepEqual(Object.keys(saved.logins), ['https://api.devspec.ai/api/mcp'])
  assert.equal(loginState('https://api.devspec.ai/api/mcp/', { home }).login.accessToken, 'oat_prod')
})

test('staging and production logins sit side by side; signing out removes only one', async () => {
  await save(PROD, 'prod')
  await save(STAGING, 'staging')
  assert.equal(loginState(PROD, { home }).login.accessToken, 'oat_prod')
  assert.equal(loginState(STAGING, { home }).login.accessToken, 'oat_staging')
  const removed = await removeLogin(STAGING, { home })
  assert.equal(removed.refreshToken, 'rt_staging')
  assert.equal(loginState(STAGING, { home }).kind, 'none')
  assert.equal(loginState(PROD, { home }).kind, 'active')
})

test('a login can never be saved under a server other than the one it was approved for', async () => {
  await assert.rejects(save(PROD, 'x', Date.now(), 24 * HOUR, { resource: 'https://api.devspecstaging.com/api/mcp' }))
  assert.equal(loginState(PROD, { home }).kind, 'none')
})

test('a login keeps one identity across renewals; a pasted token keeps its old fingerprint', async () => {
  assert.equal(principalOf({ token: 'dvs_env' }), createHash('sha256').update('dvs_env').digest('hex'))
  const login = await save(PROD, 'first', Date.now() - 13 * HOUR)
  const before = loginPrincipal(login)
  const renewed = await renewLogin(PROD, { home, refresh: async () => tokens('second') })
  assert.equal(renewed.status, 'renewed')
  assert.equal(renewed.login.accessToken, 'oat_second')
  assert.equal(loginPrincipal(renewed.login), before)
  assert.match(before, /^[a-f0-9]{64}$/)
  assert.notEqual(before, principalOf({ token: 'oat_second' }))
})

test('a token is renewed once past half its life, never before', async () => {
  assert.equal(needsRenewal({ issuedAt: new Date(0).toISOString(), expiresAt: new Date(24 * HOUR).toISOString() }, 11 * HOUR), false)
  assert.equal(needsRenewal({ issuedAt: new Date(0).toISOString(), expiresAt: new Date(24 * HOUR).toISOString() }, 12 * HOUR), true)
  await save(PROD, 'fresh')
  let calls = 0
  const result = await renewLogin(PROD, { home, refresh: async () => { calls += 1; return tokens('unused') } })
  assert.equal(result.status, 'fresh')
  assert.equal(calls, 0)
})

test('a renewal DevSpec refuses ends the login; a passing failure keeps it', async () => {
  await save(PROD, 'old', Date.now() - 20 * HOUR)
  const failed = await renewLogin(PROD, { home, refresh: async () => { throw new Error('offline') } })
  assert.equal(failed.status, 'failed')
  assert.equal(loginState(PROD, { home }).kind, 'active')
  assert.ok(loginState(PROD, { home }).login.renewFailedAt)
  const ended = await renewLogin(PROD, { home, refresh: async () => { throw new SignInEndedError('ended') } })
  assert.equal(ended.status, 'ended')
  assert.equal(loginState(PROD, { home }).kind, 'ended')
})

test('only the refused login is ended, never a newer one', async () => {
  const old = await save(PROD, 'old')
  const newer = await save(PROD, 'newer')
  assert.equal(await markLoginEnded(PROD, loginPrincipal(old), { home }), false)
  assert.equal(loginState(PROD, { home }).kind, 'active')
  assert.equal(await markLoginEnded(PROD, loginPrincipal(newer), { home }), true)
  assert.equal(loginState(PROD, { home }).kind, 'ended')
})

test('five processes renewing at once spend the single-use renewal key exactly once', async () => {
  const login = await realLogin(13 * HOUR)
  fake.refreshDelayMs = 150
  const before = fake.refreshes.length
  const storeUrl = pathToFileURL(path.join(here, 'auth-store.mjs')).href
  const script = `const { renewLogin } = await import(${JSON.stringify(storeUrl)});
    const result = await renewLogin(${JSON.stringify(fake.mcpUrl)});
    process.stdout.write(JSON.stringify({ status: result.status, token: result.login?.accessToken }))`
  try {
    const outputs = await Promise.all(Array.from({ length: 5 }, () =>
      run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home } })))
    const results = outputs.map(({ stdout }) => JSON.parse(stdout))
    const spent = fake.refreshes.slice(before)
    assert.deepEqual(spent.map((r) => r.refresh_token), [login.refreshToken], 'the old key went to Clerk once')
    assert.equal(results.filter((r) => r.status === 'renewed').length, 1)
    assert.deepEqual(new Set(results.map((r) => r.token)).size, 1, 'every process ends with the same token')
    const saved = loginState(fake.mcpUrl, { home }).login
    assert.equal(saved.accessToken, results[0].token)
    assert.equal(fake.deadGrants.size, 0, 'the grant is still alive')
  } finally {
    fake.refreshDelayMs = 0
  }
})

test('a hook never renews in its own process: a detached helper does, and the hook takes its result', async () => {
  const login = await realLogin(13 * HOUR)
  // The hook runs in its own process, as Cursor runs it (this process serves the fake
  // DevSpec, so it must stay free while the hook waits).
  const storeUrl = pathToFileURL(path.join(here, 'auth-store.mjs')).href
  const script = `const { currentLoginSync } = await import(${JSON.stringify(storeUrl)});
    process.stdout.write(JSON.stringify(currentLoginSync(${JSON.stringify(fake.mcpUrl)})))`
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home } })
  const state = JSON.parse(stdout)
  assert.equal(state.kind, 'active')
  assert.notEqual(state.login.accessToken, login.accessToken, 'renewed by scripts/devspec-login.mjs --renew')
  assert.equal(needsRenewal(state.login), false)
  assert.equal(loginPrincipal(state.login), loginPrincipal(login))
})

test('a token renewal that cannot happen now hands back the token that still works, then stops retrying for a while', async () => {
  await save(PROD, 'old', Date.now() - 13 * HOUR)
  let asked = 0
  let clock = Date.now()
  const now = () => (clock += 500)
  const first = currentLoginSync(PROD, { home, now, renew: () => { asked += 1 } })
  assert.equal(first.kind, 'active')
  assert.equal(first.login.accessToken, 'oat_old')
  assert.equal(asked, 1)
  // The renewal ran and failed for a passing reason (offline): for a while, callers
  // use the working token straight away instead of each waiting on another attempt.
  await renewLogin(PROD, { home, refresh: async () => { throw new Error('offline') } })
  const second = currentLoginSync(PROD, { home, renew: () => { asked += 1 } })
  assert.equal(second.login.accessToken, 'oat_old')
  assert.equal(asked, 1)
})

test('a token that has already stopped working and cannot be renewed is reported, not handed out', async () => {
  await save(PROD, 'stale', Date.now() - 30 * HOUR)
  let clock = Date.now()
  const state = currentLoginSync(PROD, { home, now: () => (clock += 1_000), renew: () => {} })
  assert.equal(state.kind, 'expired')
})

test('an abandoned lock from a process that died does not block renewal', async () => {
  await save(PROD, 'old', Date.now() - 20 * HOUR)
  fs.writeFileSync(`${authFilePath({ home })}.lock`, '999999999')
  const result = await renewLogin(PROD, { home, refresh: async () => tokens('after-crash') })
  assert.equal(result.login.accessToken, 'oat_after-crash')
})

test('a corrupt file reads as signed out', () => {
  fs.mkdirSync(authDir({ home }), { recursive: true })
  fs.writeFileSync(authFilePath({ home }), '{ not json')
  assert.equal(loginState(PROD, { home }).kind, 'none')
})

test('the login command renews by itself when run as the detached helper', async () => {
  const login = await realLogin(13 * HOUR)
  const script = path.join(here, '..', '..', 'scripts', 'devspec-login.mjs')
  await run(process.execPath, [script, '--renew', '--server', fake.mcpUrl], { env: { ...process.env, HOME: home, USERPROFILE: home } })
  const after = loginState(fake.mcpUrl, { home }).login
  assert.notEqual(after.accessToken, login.accessToken)
  assert.equal(after.loginId, login.loginId)
})
