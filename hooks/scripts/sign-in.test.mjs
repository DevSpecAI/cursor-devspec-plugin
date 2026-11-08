/**
 * Browser sign-in protocol (item 95a67ee4), against one local server playing DevSpec
 * and Clerk whose token endpoint only pays out when the PKCE verifier matches.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { approve, startFakeDevspec } from '../../tests/helpers/fake-devspec-sign-in.mjs'
import {
  CURSOR_CLIENT_IDS,
  SignInEndedError,
  browserCanReachThisMachine,
  clientIdFor,
  discoverSignIn,
  openInBrowser,
  refreshTokens,
  startCopyCodeSignIn,
  startLoopbackSignIn,
} from './sign-in.mjs'

let fake
before(async () => { fake = await startFakeDevspec() })
after(async () => { await fake.close() })

const discovery = () => discoverSignIn(fake.mcpUrl)

test('discovery follows DevSpec to its sign-in server, from the address with its query', async () => {
  const found = await discovery()
  assert.equal(found.resource, `${fake.base}/api/mcp`)
  assert.equal(found.issuer, fake.base)
  assert.equal(found.tokenEndpoint, `${fake.base}/oauth/token`)
  assert.equal(found.revocationEndpoint, `${fake.base}/oauth/token/revoke`)
})

test('discovery refuses metadata for a different address, and a server without browser sign-in', async () => {
  fake.resourceOverride = 'https://elsewhere.test/api/mcp'
  try {
    await assert.rejects(discovery(), /different address/)
  } finally {
    fake.resourceOverride = null
  }
  await assert.rejects(discoverSignIn(`${fake.base}/other/mcp`), /does not offer browser sign-in yet/)
})

test("each DevSpec sign-in server has Cursor's own app, and an unknown one is refused", () => {
  assert.equal(clientIdFor('https://clerk.devspec.ai'), 'bGf2U1lPyRZDYkzY')
  assert.equal(clientIdFor('https://apt-hare-75.clerk.accounts.dev'), '0gPBpmMnw37junr4')
  assert.equal(Object.keys(CURSOR_CLIENT_IDS).length, 2)
  assert.throws(() => clientIdFor('https://attacker.test'), /does not know how to sign in/)
})

test('the approval comes back through the browser to this machine, and only with the matching state', async () => {
  const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'cursor-test-client' })
  const request = new URL(pending.url)
  assert.equal(request.searchParams.get('scope'), 'devspec offline_access')
  assert.equal(request.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(request.searchParams.get('client_id'), 'cursor-test-client')
  assert.equal(request.searchParams.get('resource'), `${fake.base}/api/mcp`)
  assert.match(request.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

  // A callback this machine did not start is refused, and the real one still works.
  const forged = new URL(request.searchParams.get('redirect_uri'))
  forged.searchParams.set('code', 'stolen')
  forged.searchParams.set('state', 'someone-elses')
  assert.equal((await fetch(forged)).status, 400)

  const page = await approve(pending.url)
  assert.equal(page.status, 200)
  assert.match(page.text, /Signed in to DevSpec/)
  assert.match(page.text, /Restart Cursor to finish connecting\./)
  assert.match(page.text, /color-scheme:light dark/)
  assert.match(page.text, /@media \(prefers-color-scheme:dark\)/)
  assert.match(page.text, /logo-icon\.png/)
  const tokens = await pending.done
  assert.match(tokens.accessToken, /^oat_/)
  assert.match(tokens.refreshToken, /^rt_/)
  assert.ok(tokens.expiresAt - tokens.issuedAt === 86_400_000)
  assert.equal(fake.exchanges.at(-1).resource, `${fake.base}/api/mcp`)
  await assert.rejects(fetch(request.searchParams.get('redirect_uri')), 'the listener is gone once the sign-in finishes')
})

test('Deny in the browser ends the sign-in plainly', async () => {
  const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'cursor-test-client' })
  const outcome = assert.rejects(pending.done, /canceled in the browser/)
  fake.deny = true
  try {
    await approve(pending.url)
  } finally {
    fake.deny = false
  }
  await outcome
})

test('an approval returned by a different sign-in server is refused', async () => {
  const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'cursor-test-client' })
  const request = new URL(pending.url)
  const back = new URL(request.searchParams.get('redirect_uri'))
  back.searchParams.set('code', 'code-mixup')
  back.searchParams.set('state', request.searchParams.get('state'))
  back.searchParams.set('iss', 'https://attacker.test')
  const outcome = assert.rejects(pending.done, /different server/)
  assert.equal((await fetch(back)).status, 400)
  await outcome
})

test('an unanswered sign-in closes its listener by itself', async () => {
  const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: 'cursor-test-client', waitMs: 20 })
  await assert.rejects(pending.done, /timed out/)
})

test("on a machine the browser cannot reach, the person pastes the code DevSpec's page shows", async () => {
  const codePageUrl = `${fake.base}/oauth-code`
  const flow = startCopyCodeSignIn({ discovery: await discovery(), clientId: 'cursor-test-client', codePageUrl })
  assert.equal(new URL(flow.url).searchParams.get('redirect_uri'), codePageUrl)
  const shown = (await approve(flow.url)).text
  const [code] = shown.split('#')
  await assert.rejects(flow.complete(`${code}#not-this-sign-in`), /not from this sign-in/)
  await assert.rejects(flow.complete(code), /not from this sign-in/)
  const tokens = await flow.complete(`  ${shown}\n`)
  assert.match(tokens.accessToken, /^oat_/)
})

test('renewal rotates the key, and a spent or revoked key ends the sign-in', async () => {
  const found = await discovery()
  const pending = await startLoopbackSignIn({ discovery: found, clientId: 'cursor-test-client' })
  await approve(pending.url)
  const first = await pending.done
  const renewed = await refreshTokens({ tokenEndpoint: found.tokenEndpoint, clientId: 'cursor-test-client', refreshToken: first.refreshToken, resource: found.resource })
  assert.notEqual(renewed.refreshToken, first.refreshToken)
  await assert.rejects(
    refreshTokens({ tokenEndpoint: found.tokenEndpoint, clientId: 'cursor-test-client', refreshToken: first.refreshToken, resource: found.resource }),
    SignInEndedError,
  )
})

test('an SSH session uses the copy-a-code page, because its browser cannot reach this machine', () => {
  assert.equal(browserCanReachThisMachine({}), true)
  assert.equal(browserCanReachThisMachine({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }), false)
  assert.equal(browserCanReachThisMachine({ SSH_TTY: '/dev/pts/1' }), false)
})

test('the browser is opened without a shell, with the link as one argument', () => {
  const calls = []
  const spawnFn = (cmd, args) => { calls.push([cmd, args]); return { on() { return this }, unref() {} } }
  const link = 'https://x.test/a?b=1&c=$(whoami)'
  openInBrowser(link, { platform: 'linux', spawnFn })
  openInBrowser(link, { platform: 'darwin', spawnFn })
  assert.deepEqual(calls, [['xdg-open', [link]], ['open', [link]]])
})
