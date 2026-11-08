/**
 * One local HTTP server playing DevSpec (protected-resource metadata, the MCP endpoint,
 * the "copy this code" page) and Clerk (authorization-server metadata, authorize,
 * token and revocation endpoints), for the browser sign-in tests (item 95a67ee4).
 *
 * It behaves like the real ones where it matters:
 * - a code is only exchanged with the PKCE verifier matching its challenge, for the
 *   same redirect address and app it was issued to;
 * - a renewal key is single-use: spending one twice ends the whole grant;
 * - the MCP endpoint takes only live access tokens, and answers a disconnected tool
 *   with DevSpec's `signed_out` refusal.
 * "The person clicks Allow" is a GET of the authorize URL (approve()).
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

export const SIGNED_OUT_SENTENCE = 'This tool was disconnected from your DevSpec account. You can reconnect it from Agent setup in your DevSpec settings.'

export async function startFakeDevspec({ expiresIn = 86_400 } = {}) {
  const fake = {
    base: '',
    mcpUrl: '',
    codes: new Map(),
    grants: new Map(), // refresh token → { grant, spent }
    deadGrants: new Set(),
    liveAccess: new Map(), // access token → grant
    exchanges: [],
    refreshes: [],
    revocations: [],
    mcpCalls: [],
    authorizations: [],
    requests: [],
    signedOut: false,
    deny: false,
    refreshDelayMs: 0,
    resourceOverride: null,
    expiresIn,
    toolResult: (name) => (name === 'verify_agent_connection' ? { connected_as: 'Ada Lovelace' } : { ok: true }),
  }
  let counter = 0
  const issue = (grant) => {
    counter += 1
    const access = `oat_${counter}`
    const refresh = `rt_${counter}`
    fake.liveAccess.set(access, grant)
    fake.grants.set(refresh, { grant, spent: false })
    return { access_token: access, refresh_token: refresh, expires_in: fake.expiresIn, token_type: 'bearer' }
  }

  const answerRefresh = (body, json) => {
    const held = fake.grants.get(body.refresh_token)
    if (!held || fake.deadGrants.has(held.grant)) return json(400, { error: 'invalid_grant' })
    if (held.spent) {
      // A renewal key used twice: treat it as theft and end the whole grant.
      fake.deadGrants.add(held.grant)
      return json(400, { error: 'invalid_grant' })
    }
    held.spent = true
    return json(200, issue(held.grant))
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', fake.base)
    fake.requests.push(`${req.method} ${url.pathname}`)
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (url.pathname === '/.well-known/oauth-protected-resource/api/mcp') {
        return json(200, { resource: fake.resourceOverride ?? `${fake.base}/api/mcp`, authorization_servers: [fake.base], scopes_supported: ['devspec', 'offline_access'] })
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, {
          issuer: fake.base,
          authorization_endpoint: `${fake.base}/oauth/authorize`,
          token_endpoint: `${fake.base}/oauth/token`,
          revocation_endpoint: `${fake.base}/oauth/token/revoke`,
        })
      }
      if (url.pathname === '/oauth/authorize') {
        const p = url.searchParams
        fake.authorizations.push(Object.fromEntries(p))
        const back = new URL(p.get('redirect_uri'))
        back.searchParams.set('state', p.get('state'))
        if (fake.deny) back.searchParams.set('error', 'access_denied')
        else {
          counter += 1
          const code = `code_${counter}`
          fake.codes.set(code, { challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), clientId: p.get('client_id'), resource: p.get('resource') })
          back.searchParams.set('code', code)
          back.searchParams.set('iss', fake.base)
        }
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      if (url.pathname === '/oauth-code') {
        // DevSpec's copy-a-code page: shows code#state for the person to paste back.
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(`${url.searchParams.get('code')}#${url.searchParams.get('state')}`)
      }
      if (url.pathname === '/oauth/token' && req.method === 'POST') {
        const body = Object.fromEntries(new URLSearchParams(raw))
        if (body.grant_type === 'refresh_token') {
          fake.refreshes.push(body)
          if (fake.refreshDelayMs) {
            setTimeout(() => answerRefresh(body, json), fake.refreshDelayMs)
            return
          }
          return answerRefresh(body, json)
        }
        fake.exchanges.push(body)
        const grant = fake.codes.get(body.code ?? '')
        const verified = grant && grant.redirectUri === body.redirect_uri && grant.clientId === body.client_id &&
          createHash('sha256').update(body.code_verifier ?? '').digest('base64url') === grant.challenge
        if (!verified) return json(400, { error: 'invalid_grant' })
        fake.codes.delete(body.code)
        return json(200, issue(`grant_${body.code}`))
      }
      if (url.pathname === '/oauth/token/revoke' && req.method === 'POST') {
        fake.revocations.push(Object.fromEntries(new URLSearchParams(raw)))
        return json(200, {})
      }
      if (url.pathname === '/api/mcp' && req.method === 'POST') {
        const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        const parsed = JSON.parse(raw || '{}')
        fake.mcpCalls.push({ bearer, name: parsed.params?.name, plugin: req.headers['x-devspec-plugin'] ?? null, url: url.toString() })
        if (fake.signedOut) return json(401, { error: SIGNED_OUT_SENTENCE, code: 'signed_out', retryable: false })
        const grant = fake.liveAccess.get(bearer)
        if (!grant || fake.deadGrants.has(grant)) return json(401, { error: 'Invalid or revoked API token', code: 'invalid_api_token', retryable: false })
        const result = fake.toolResult(parsed.params?.name, parsed.params?.arguments)
        return json(200, { jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })
      }
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.base = `http://127.0.0.1:${server.address().port}`
  fake.mcpUrl = `${fake.base}/api/mcp?tool_namespace=devspec&model_tools=heartbeat_connection,detach_connection`
  fake.close = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() })
  return fake
}

/** The person clicks Allow: the browser follows the approval back to wherever it was sent. */
export async function approve(authorizeUrl) {
  const response = await fetch(authorizeUrl)
  return { status: response.status, text: await response.text() }
}

/** Fake app ids for the fake sign-in server, in the shape of CURSOR_CLIENT_IDS. */
export function fakeClientIds(fake) {
  return { [fake.base]: 'cursor-test-client' }
}
