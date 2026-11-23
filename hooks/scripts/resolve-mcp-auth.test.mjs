#!/usr/bin/env node
/**
 * The credential the background features use (item 95a67ee4): DEVSPEC_MCP_TOKEN for a
 * machine with no browser, otherwise the plugin's own browser sign-in for the server
 * its mcp.json names, and nothing else. A connection keeps the identity it connected
 * with across a browser login's daily token change.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, it } from 'node:test'
import { loginPrincipal, loginState, renewLogin, saveLogin } from './auth-store.mjs'
import { SignInEndedError } from './sign-in.mjs'
import {
  connectionCredential,
  credentialIdentity,
  credentialRefusal,
  credentialStateFields,
  envTokenNotice,
  envTokenShadowsLogin,
  handleCredentialRefusal,
  resolveDevspecMcpAuth,
} from './resolve-mcp-auth.mjs'

const HOUR = 60 * 60 * 1000
const QUERY = '?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection'
const PROD = `https://api.devspec.ai/api/mcp${QUERY}`
const STAGING = `https://api.devspecstaging.com/api/mcp${QUERY}`

let home
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-resolve-'))
})

const sha = (value) => createHash('sha256').update(value).digest('hex')

function save(mcpUrl, tag, issuedAt = Date.now()) {
  const parsed = new URL(mcpUrl)
  return saveLogin({
    mcpUrl,
    tokens: { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + 24 * HOUR },
    issuer: 'https://issuer.test',
    tokenEndpoint: 'https://issuer.test/oauth/token',
    clientId: 'cursor-client',
    resource: `${parsed.origin}${parsed.pathname}`,
    signedInAs: 'Ada Lovelace',
  }, { home })
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe('which credential the background features use', () => {
  it('with no sign-in, says so plainly and how to sign in, for the production server', () => {
    const auth = resolveDevspecMcpAuth(home, { env: { HOME: home } })
    assert.equal(auth.ok, false)
    assert.equal(auth.code, 'sign_in_required')
    assert.equal(auth.mcp_url, PROD)
    assert.equal(auth.token, undefined)
    assert.match(auth.error, /not signed in to DevSpec \(production\)/)
    assert.match(auth.error, /\/devspec-remote/)
    assert.match(auth.error, /scripts\/devspec-login\.mjs/)
  })

  it("never reads a token from Cursor's MCP settings or any project MCP file", () => {
    const entry = { mcpServers: { devspec: { url: PROD, headers: { Authorization: 'Bearer dvs_pasted' } } } }
    writeJson(path.join(home, '.cursor', 'mcp.json'), entry)
    const project = path.join(home, 'project')
    writeJson(path.join(project, '.cursor', 'mcp.json'), entry)
    writeJson(path.join(project, '.mcp.json'), entry)
    writeJson(path.join(home, '.devspec', 'auth.json'), { token: 'dvs_shared' })
    writeJson(path.join(home, '.pi', 'agent', 'devspec', 'auth.json'), { version: 2, logins: {} })
    const auth = resolveDevspecMcpAuth(project, { env: { HOME: home } })
    assert.equal(auth.ok, false)
    assert.equal(auth.code, 'sign_in_required')
  })

  it("uses the plugin's own browser sign-in for its server, by a stable identity", async () => {
    const login = await save(PROD, 'prod')
    const auth = resolveDevspecMcpAuth(home, { env: { HOME: home } })
    assert.equal(auth.ok, true)
    assert.equal(auth.source, 'login')
    assert.equal(auth.token, 'oat_prod')
    assert.equal(auth.mcp_url, PROD)
    assert.equal(auth.principal, loginPrincipal(login))
    assert.notEqual(auth.principal, sha('oat_prod'))
    assert.equal(auth.signed_in_as, 'Ada Lovelace')
  })

  it('DEVSPEC_API_URL picks the staging login, beside production, with no new login to switch back', async () => {
    await save(PROD, 'prod')
    await save(STAGING, 'staging')
    const staging = resolveDevspecMcpAuth(home, { env: { HOME: home, DEVSPEC_API_URL: 'https://api.devspecstaging.com' } })
    assert.equal(staging.token, 'oat_staging')
    assert.equal(staging.mcp_url, STAGING)
    assert.equal(resolveDevspecMcpAuth(home, { env: { HOME: home } }).token, 'oat_prod')
  })

  it('DEVSPEC_MCP_TOKEN wins for a machine with no browser, keeps its old fingerprint, and is called out', async () => {
    const env = { HOME: home, DEVSPEC_MCP_TOKEN: ' dvs_ci ', DEVSPEC_MCP_URL: 'https://devspec.example/api/mcp' }
    assert.equal(envTokenShadowsLogin({ env }), false, 'nothing to call out without a browser login')
    await save(PROD, 'prod')
    const auth = resolveDevspecMcpAuth(home, { env })
    assert.deepEqual(auth, { ok: true, token: 'dvs_ci', mcp_url: 'https://devspec.example/api/mcp', source: 'env', principal: sha('dvs_ci') })
    assert.equal(envTokenShadowsLogin({ env: { HOME: home, DEVSPEC_MCP_TOKEN: 'dvs_ci' } }), true)
    const notice = envTokenNotice('linux')
    assert.match(notice, /DEVSPEC_MCP_TOKEN is set/)
    assert.match(notice, /ignore your browser sign-in/)
    assert.match(notice, /unset DEVSPEC_MCP_TOKEN/)
    assert.match(notice, /restart cursor-agent/)
  })

  it('a login that has ended is reported with where to reconnect and how to sign in again', async () => {
    await save(STAGING, 'staging', Date.now() - 13 * HOUR)
    await renewLogin(STAGING, { home, refresh: async () => { throw new SignInEndedError('ended') } })
    const auth = resolveDevspecMcpAuth(home, { env: { HOME: home, DEVSPEC_API_URL: 'https://api.devspecstaging.com' } })
    assert.equal(auth.ok, false)
    assert.equal(auth.code, 'signed_out')
    assert.match(auth.error, /sign-in for Cursor's background features has ended/)
    assert.match(auth.error, /https:\/\/app\.devspecstaging\.com\/settings\/agents/)
    assert.match(auth.error, /--server https:\/\/api\.devspecstaging\.com/)
  })
})

describe("a connection's credential", () => {
  it('takes the login’s current token on every use, and never another login', async () => {
    const login = await save(PROD, 'first')
    const auth = resolveDevspecMcpAuth(home, { env: { HOME: home } })
    const state = { connection_id: 'c', mcp_url: PROD, ...credentialStateFields(auth) }
    assert.equal(state.token, undefined, 'a browser login’s token is never written into connection state')
    assert.equal(state.auth_source, 'login')
    assert.equal(state.principal, loginPrincipal(login))

    // Thirteen hours on, the token is renewed.
    const file = path.join(home, '.devspec', 'cursor', 'auth.json')
    const store = JSON.parse(fs.readFileSync(file, 'utf8'))
    Object.assign(Object.values(store.logins)[0], {
      issuedAt: new Date(Date.now() - 13 * HOUR).toISOString(),
      expiresAt: new Date(Date.now() + 11 * HOUR).toISOString(),
    })
    fs.writeFileSync(file, JSON.stringify(store))
    await renewLogin(PROD, { home, refresh: async () => ({ accessToken: 'oat_second', refreshToken: 'rt_second', issuedAt: Date.now(), expiresAt: Date.now() + 24 * HOUR }) })
    const renewed = connectionCredential(state, { home })
    assert.equal(renewed.ok, true)
    assert.equal(renewed.token, 'oat_second')
    assert.equal(credentialIdentity(state), `login:${loginPrincipal(login)}`)

    await save(PROD, 'someone-else')
    const other = connectionCredential(state, { home })
    assert.equal(other.ok, false)
    assert.equal(other.code, 'signed_in_again')
    assert.match(other.error, /Run \/devspec-remote/)
  })

  it('a connection made with DEVSPEC_MCP_TOKEN keeps that token and its exact binding', () => {
    const state = { connection_id: 'c', mcp_url: PROD, ...credentialStateFields({ ok: true, token: 'dvs_ci', source: 'env', mcp_url: PROD }) }
    assert.equal(state.token, 'dvs_ci')
    assert.equal(connectionCredential(state, { home }).token, 'dvs_ci')
    assert.equal(credentialIdentity(state), 'dvs_ci')
  })

  it('a connection whose login was signed out says so', async () => {
    const login = await save(PROD, 'prod')
    const state = { connection_id: 'c', mcp_url: PROD, auth_source: 'login', principal: loginPrincipal(login) }
    fs.rmSync(path.join(home, '.devspec', 'cursor', 'auth.json'))
    const credential = connectionCredential(state, { home })
    assert.equal(credential.code, 'signed_out')
    assert.match(credential.error, /signed out of DevSpec/)
  })
})

describe("DevSpec's refusals", () => {
  const refusal = (status, body, retryable = false) => Object.assign(new Error(`MCP HTTP ${status}`), {
    status, serverCode: body.code ?? null, retryable, body: JSON.stringify(body),
  })

  it("a disconnected tool is told in DevSpec's own sentence, then how to sign in again", () => {
    const said = 'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.'
    const mapped = credentialRefusal(refusal(401, { error: said, code: 'signed_out', retryable: false }), { mcpUrl: PROD })
    assert.equal(mapped.code, 'signed_out')
    assert.ok(mapped.message.startsWith(said))
    assert.match(mapped.message, /To sign in again, run \/devspec-remote/)
  })

  it('an unknown token is refused plainly, and a passing outage is not a refusal', () => {
    const invalid = refusal(401, { error: 'Invalid or revoked API token', code: 'invalid_api_token', retryable: false })
    assert.match(credentialRefusal(invalid, { mcpUrl: PROD }).message, /no longer accepts Cursor's sign-in/)
    assert.match(credentialRefusal(invalid, { mcpUrl: PROD, source: 'env' }).message, /DEVSPEC_MCP_TOKEN/)
    assert.equal(credentialRefusal(refusal(503, { code: 'auth_validation_unavailable', retryable: true }, true)), null)
    assert.equal(credentialRefusal(new Error('fetch failed')), null)
  })

  it('a refused browser login is ended, so the next sign-in starts afresh', async () => {
    const login = await save(PROD, 'prod')
    const auth = { mcp_url: PROD, source: 'login', principal: loginPrincipal(login) }
    const mapped = await handleCredentialRefusal(refusal(401, { error: 'gone', code: 'signed_out' }), auth, { env: { HOME: home } })
    assert.equal(mapped.code, 'signed_out')
    assert.equal(loginState(PROD, { home }).kind, 'ended')
    assert.equal(resolveDevspecMcpAuth(home, { env: { HOME: home } }).code, 'signed_out')
  })
})
