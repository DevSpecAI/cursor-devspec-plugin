/**
 * Signing the background features in (item 95a67ee4): one browser approval, naming
 * Cursor, the first time /devspec-remote needs DevSpec; one approval however many
 * callers ask at once; the copy-a-code path where the browser cannot reach this
 * machine; and the login command's refusals and sign-out.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { approve, fakeClientIds, SIGNED_OUT_SENTENCE, startFakeDevspec } from '../../tests/helpers/fake-devspec-sign-in.mjs'
import { beginBackgroundSignIn, lastSignInResult, livePendingSignIn, loginState, recordPendingSignIn, saveLogin } from './auth-store.mjs'
import { resolveDevspecMcpAuth } from './resolve-mcp-auth.mjs'
import { authForConnect, finishCodeSignIn, runBackgroundSignIn, startCodeSignIn } from './sign-in-flow.mjs'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const LOGIN_SCRIPT = path.join(here, '..', '..', 'scripts', 'devspec-login.mjs')

let fake
let home
before(async () => { fake = await startFakeDevspec() })
after(async () => { await fake.close() })
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-sign-in-flow-'))
  fake.signedOut = false
})

/** The plugin pointed at the fake server, the way a person points it at staging. */
const envFor = () => ({ HOME: home, DEVSPEC_API_URL: fake.base })

/**
 * The detached helper, run in this process, with the person clicking Allow after
 * `delayMs`. (Callers here pass `waitForUrlMs: 0`: the real helper is its own process,
 * and a caller's short synchronous wait for its link would stall one run in-process.)
 */
function helperThatApproves({ delayMs = 50, clicks = [] } = {}) {
  return (mcpUrl, opts) => {
    void runBackgroundSignIn(mcpUrl, {
      ...opts,
      clientIds: fakeClientIds(fake),
      open: (url) => {
        clicks.push(url)
        if (delayMs !== null) setTimeout(() => { void approve(url) }, delayMs)
      },
    })
  }
}

test('the first connect starts one browser approval naming Cursor, and connects once it is given', async () => {
  const clicks = []
  const lines = []
  const before = fake.requests.length
  const auth = await authForConnect(home, {
    env: envFor(),
    home,
    report: (line) => lines.push(line),
    begin: (url, opts) => beginBackgroundSignIn(url, { ...opts, waitForUrlMs: 0, spawnChild: helperThatApproves({ clicks }) }),
  })
  assert.equal(auth.ok, true, auth.error)
  assert.equal(auth.source, 'login')
  assert.equal(auth.signed_in_now, true)
  assert.equal(auth.mcp_url, fake.mcpUrl)
  assert.equal(clicks.length, 1, 'one browser tab')
  const asked = new URL(clicks[0])
  assert.equal(asked.searchParams.get('client_id'), 'cursor-test-client')
  assert.match(asked.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  assert.match(lines.join('\n'), /approve Cursor in your browser/)
  // The approval came back through the browser; nothing asked DevSpec whether it happened.
  const asks = fake.requests.slice(before)
  assert.deepEqual(asks.filter((r) => !/^GET \/\.well-known\//.test(r)), [
    'GET /oauth/authorize', 'POST /oauth/token', 'POST /api/mcp',
  ])
  // Saved only after DevSpec accepted it, at the plugin's address, with the plugin header.
  const verify = fake.mcpCalls.at(-1)
  assert.equal(verify.name, 'verify_agent_connection')
  assert.match(verify.plugin, /^cursor\/\d+\.\d+\.\d+$/)
  assert.equal(verify.url, fake.mcpUrl)
  assert.equal(loginState(fake.mcpUrl, { home }).login.signedInAs, 'Ada Lovelace')
})

test('when nobody approves in time, connect hands back the link; approving later needs no second approval', async () => {
  const clicks = []
  let approveLater
  const helper = (mcpUrl, opts) => {
    void runBackgroundSignIn(mcpUrl, {
      ...opts,
      clientIds: fakeClientIds(fake),
      open: (url) => { clicks.push(url); approveLater = () => approve(url) },
    })
  }
  const begin = (url, opts) => beginBackgroundSignIn(url, { ...opts, waitForUrlMs: 0, spawnChild: helper })
  const first = await authForConnect(home, { env: envFor(), home, waitMs: 300, report: () => {}, begin })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'sign_in_pending')
  assert.equal(first.sign_in_url, clicks[0])
  assert.match(first.error, /Still waiting for your OK in the browser/)
  assert.match(first.error, /run \/devspec-remote again/)

  // Connecting again while the approval is still open joins it rather than opening another.
  const again = await authForConnect(home, { env: envFor(), home, waitMs: 200, report: () => {}, begin })
  assert.equal(again.code, 'sign_in_pending')
  assert.equal(clicks.length, 1)

  await approveLater()
  for (let i = 0; i < 50 && loginState(fake.mcpUrl, { home }).kind !== 'active'; i++) await new Promise((r) => setTimeout(r, 20))
  const done = await authForConnect(home, { env: envFor(), home, report: () => {}, begin: () => assert.fail('no second approval') })
  assert.equal(done.ok, true)
  assert.equal(clicks.length, 1)
})

test('a sign-in DevSpec refuses is never saved, and is canceled at the sign-in server', async () => {
  const revoked = fake.revocations.length
  // The person approves, then DevSpec answers the confirmation with its signed_out refusal.
  const helper = (mcpUrl, opts) => {
    void runBackgroundSignIn(mcpUrl, {
      ...opts,
      clientIds: fakeClientIds(fake),
      open: (url) => { fake.signedOut = true; void approve(url) },
    })
  }
  const result = await authForConnect(home, { env: envFor(), home, report: () => {}, begin: (url, opts) => beginBackgroundSignIn(url, { ...opts, waitForUrlMs: 0, spawnChild: helper }) })
  fake.signedOut = false
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sign_in_failed')
  assert.match(result.error, /DevSpec did not accept the new sign-in/)
  assert.equal(loginState(fake.mcpUrl, { home }).kind, 'none')
  assert.equal(fake.revocations.length, revoked + 1)
})

test('a server without browser sign-in is said plainly, and nothing waits on it', async () => {
  const env = { HOME: home, DEVSPEC_MCP_URL: `${fake.base}/not-mcp` }
  const helper = (mcpUrl, opts) => { void runBackgroundSignIn(mcpUrl, { ...opts, clientIds: fakeClientIds(fake), open: () => assert.fail('no browser') }) }
  const auth = await authForConnect(home, { env, home, report: () => {}, begin: (url, opts) => beginBackgroundSignIn(url, { ...opts, waitForUrlMs: 0, spawnChild: helper }) })
  assert.equal(auth.code, 'sign_in_failed')
  assert.match(auth.error, /does not offer browser sign-in yet/)
  assert.equal(lastSignInResult(`${fake.base}/not-mcp`, { home }).outcome, 'failed')
})

test('over SSH the person copies the code from DevSpec’s page and pastes it back', async () => {
  const env = { ...envFor(), SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' }
  const auth = await authForConnect(home, {
    env,
    home,
    report: () => {},
    begin: () => assert.fail('no loopback listener over SSH'),
    startCode: (mcpUrl, opts) => startCodeSignIn(mcpUrl, { ...opts, clientIds: fakeClientIds(fake) }),
  })
  assert.equal(auth.code, 'sign_in_code_required')
  assert.equal(new URL(auth.sign_in_url).searchParams.get('redirect_uri'), `${fake.base}/oauth-code`)
  assert.match(auth.error, /--paste "<the code>"/)
  const shown = (await approve(auth.sign_in_url)).text
  await assert.rejects(finishCodeSignIn(fake.mcpUrl, 'code#not-this-one', { home }), /not from this sign-in/)
  const login = await finishCodeSignIn(fake.mcpUrl, shown, { home })
  assert.equal(login.signedInAs, 'Ada Lovelace')
  assert.equal(resolveDevspecMcpAuth(home, { env }).ok, true)
})

test('parallel callers start one browser approval between them', async () => {
  const mcpUrl = 'https://api.devspecstaging.com/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection'
  const tabs = path.join(home, 'tabs.log')
  const storeUrl = pathToFileURL(path.join(here, 'auth-store.mjs')).href
  // Each process is a hook or helper; the "helper" each would start opens a tab and
  // says which link it is waiting on.
  const script = `const store = await import(${JSON.stringify(storeUrl)});
    const fs = await import('node:fs');
    const result = store.beginBackgroundSignIn(${JSON.stringify(mcpUrl)}, {
      spawnChild: (url) => {
        fs.appendFileSync(${JSON.stringify(tabs)}, 'tab\\n')
        store.recordPendingSignIn(url, { pid: process.pid, url: 'https://approve.test/one' })
      },
    });
    process.stdout.write(JSON.stringify(result))
    setTimeout(() => {}, 300)`
  const results = (await Promise.all(Array.from({ length: 6 }, () =>
    run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home } }))))
    .map(({ stdout }) => JSON.parse(stdout))
  assert.equal(fs.readFileSync(tabs, 'utf8').trim().split('\n').length, 1, 'one tab')
  assert.equal(results.filter((r) => r.status === 'started').length, 1)
  assert.ok(results.every((r) => r.status === 'started' || r.status === 'pending'))
})

test('an approval whose helper died is not joined: the next caller starts a fresh one', () => {
  const mcpUrl = 'https://api.devspec.ai/api/mcp'
  recordPendingSignIn(mcpUrl, { pid: 999999999, url: 'https://approve.test/dead', startedAt: Date.now() }, { home })
  assert.equal(livePendingSignIn(mcpUrl, { home }), null)
  let spawned = 0
  const started = beginBackgroundSignIn(mcpUrl, {
    home,
    waitForUrlMs: 0,
    spawnChild: () => { spawned += 1 },
  })
  assert.equal(started.status, 'started')
  assert.equal(spawned, 1)
})

test('with DEVSPEC_MCP_TOKEN set, connect uses it and says it overrides the browser sign-in', async () => {
  await saveLogin({
    mcpUrl: fake.mcpUrl,
    tokens: { accessToken: 'oat_x', refreshToken: 'rt_x', issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000 },
    issuer: fake.base,
    tokenEndpoint: `${fake.base}/oauth/token`,
    clientId: 'cursor-test-client',
    resource: `${fake.base}/api/mcp`,
  }, { home })
  const auth = await authForConnect(home, { env: { ...envFor(), DEVSPEC_MCP_TOKEN: 'dvs_ci' }, home, begin: () => assert.fail('no approval') })
  assert.equal(auth.source, 'env')
  assert.equal(auth.token, 'dvs_ci')
  assert.match(auth.warning_env_token, /DEVSPEC_MCP_TOKEN is set/)
})

test('the login command refuses to sign in while DEVSPEC_MCP_TOKEN is set, instead of reporting a success it would ignore', async () => {
  const outcome = await run(process.execPath, [LOGIN_SCRIPT], { env: { PATH: process.env.PATH, HOME: home, DEVSPEC_MCP_TOKEN: 'dvs_ci' } })
    .then(() => assert.fail('it should refuse'), (err) => err)
  assert.equal(outcome.code, 1)
  assert.match(outcome.stdout, /DEVSPEC_MCP_TOKEN is set in this environment/)
  assert.equal(fs.existsSync(path.join(home, '.devspec', 'cursor', 'auth.json')), false)
})

test('the login command says where things stand, and signs out of one server only', async () => {
  const staging = 'https://api.devspecstaging.com/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection'
  for (const [mcpUrl, tag] of [[fake.mcpUrl, 'fake'], [staging, 'staging']]) {
    const parsed = new URL(mcpUrl)
    await saveLogin({
      mcpUrl,
      tokens: { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000 },
      issuer: fake.base,
      tokenEndpoint: `${fake.base}/oauth/token`,
      revocationEndpoint: `${fake.base}/oauth/token/revoke`,
      clientId: 'cursor-test-client',
      resource: `${parsed.origin}${parsed.pathname}`,
      signedInAs: 'Ada Lovelace',
    }, { home })
  }
  const env = { PATH: process.env.PATH, HOME: home }
  const status = await run(process.execPath, [LOGIN_SCRIPT, '--status', '--server', fake.base], { env })
  assert.match(status.stdout, /Signed in through the browser as Ada Lovelace/)
  const revoked = fake.revocations.length
  const out = await run(process.execPath, [LOGIN_SCRIPT, '--sign-out', '--server', fake.base], { env })
  assert.match(out.stdout, /Signed Cursor's background features out of DevSpec/)
  assert.equal(loginState(fake.mcpUrl, { home }).kind, 'none')
  assert.equal(loginState(staging, { home }).kind, 'active')
  assert.deepEqual(fake.revocations.slice(revoked).map((r) => [r.token, r.token_type_hint, r.client_id]), [['rt_fake', 'refresh_token', 'cursor-test-client']])
})

test("DevSpec's refusal sentence reaches the person when a login it no longer accepts is used to connect", async () => {
  const { registerConnection } = await import('./remote-control-state.mjs')
  const parsed = new URL(fake.mcpUrl)
  await saveLogin({
    mcpUrl: fake.mcpUrl,
    tokens: { accessToken: 'oat_gone', refreshToken: 'rt_gone', issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000 },
    issuer: fake.base,
    tokenEndpoint: `${fake.base}/oauth/token`,
    clientId: 'cursor-test-client',
    resource: `${parsed.origin}${parsed.pathname}`,
  }, { home })
  fake.signedOut = true
  const result = await registerConnection({
    localId: 'cursor-chat-1',
    projectId: '00000000-0000-4000-8000-000000000001',
    cwd: home,
    projectHome: home,
    resolveAuth: (cwd, opts) => resolveDevspecMcpAuth(cwd, { ...opts, env: envFor() }),
    emitPhase: async () => {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'signed_out')
  assert.ok(result.error.startsWith(SIGNED_OUT_SENTENCE))
  assert.match(result.error, /To sign in again, run \/devspec-remote/)
})
