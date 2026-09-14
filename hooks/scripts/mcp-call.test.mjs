#!/usr/bin/env node
/**
 * MCP HTTP call timeouts (item 0c2fb922). A dropped gateway used to hang
 * wait/mirror-turn/report_complete forever because fetch has no default timeout.
 * Run: node --test hooks/scripts/mcp-call.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  mcpRequestHeaders,
  readServerFailure,
  isRetryableHttpFailure,
  mcpToolsCallWithRetry,
} from './mcp-call.mjs'

describe('DEFAULT_MCP_CALL_TIMEOUT_MS', () => {
  it('bounds non-hold MCP tools/call at 30s', () => {
    assert.equal(DEFAULT_MCP_CALL_TIMEOUT_MS, 30_000)
  })
})

describe('connection capability header', () => {
  it('is absent from ordinary MCP calls and present only for a valid bridge value', () => {
    assert.equal(mcpRequestHeaders({ token: 'dvs_token' })['X-DevSpec-Connection-Capability'], undefined)
    assert.equal(mcpRequestHeaders({ token: 'dvs_token', connectionCapability: 'model-value' })['X-DevSpec-Connection-Capability'], undefined)
    assert.equal(
      mcpRequestHeaders({ token: 'dvs_token', connectionCapability: 'dvsc_hidden' })['X-DevSpec-Connection-Capability'],
      'dvsc_hidden',
    )
  })
})

/**
 * The server's typed failure contract reaching callers (DevSpec item f24de10a).
 * Before this, every non-OK response collapsed into an untyped Error whose only
 * carrier was a message string, so a caller wanting to tell "could not check the
 * credential right now" from "the credential is dead" had to regex prose.
 */
describe('readServerFailure', () => {
  it('reads the outage contract', () => {
    const f = readServerFailure(503, JSON.stringify({
      code: 'auth_validation_unavailable', credential_type: 'api_token', retryable: true,
    }))
    assert.equal(f.status, 503)
    assert.equal(f.serverCode, 'auth_validation_unavailable')
    assert.equal(f.retryable, true)
    assert.equal(f.credentialType, 'api_token')
  })

  it('reads the rejection contract', () => {
    const f = readServerFailure(401, JSON.stringify({ code: 'invalid_api_token', retryable: false }))
    assert.equal(f.serverCode, 'invalid_api_token')
    assert.equal(f.retryable, false)
  })

  it('still yields the status for a body-less gateway failure', () => {
    const f = readServerFailure(502, 'Bad Gateway')
    assert.equal(f.status, 502)
    assert.equal(f.serverCode, null)
    assert.equal(f.retryable, null)
  })

  it('does not invent fields from an unparseable body', () => {
    const f = readServerFailure(500, '<html>nginx {truncated')
    assert.equal(f.status, 500)
    assert.equal(f.serverCode, null)
  })
})

describe('isRetryableHttpFailure', () => {
  it('retries what the server called retryable', () => {
    assert.equal(isRetryableHttpFailure({ status: 503, retryable: true }), true)
  })

  it('does NOT retry a rejected credential', () => {
    assert.equal(isRetryableHttpFailure({ status: 401, serverCode: 'invalid_api_token', retryable: false }), false)
  })

  it("lets the server's explicit false win over the status", () => {
    assert.equal(isRetryableHttpFailure({ status: 503, retryable: false }), false)
  })

  it('retries a body-less gateway failure on status alone', () => {
    for (const status of [408, 429, 502, 503, 504]) {
      assert.equal(isRetryableHttpFailure({ status, retryable: null }), true, `status ${status}`)
    }
  })

  it('does not retry a 4xx verdict on the request', () => {
    for (const status of [400, 401, 403, 404]) {
      assert.equal(isRetryableHttpFailure({ status, retryable: null }), false, `status ${status}`)
    }
  })

  it('never retries a deliberate abort', () => {
    // err.code is the ABORT reason in this module, not the server's code.
    assert.equal(isRetryableHttpFailure({ code: 'owner_gone', status: 503 }), false)
    assert.equal(isRetryableHttpFailure({ code: 'timeout', status: 503 }), false)
  })
})

describe('mcpToolsCallWithRetry — the one-shot connect path', () => {
  const noSleep = async () => {}
  const badGateway = () =>
    Object.assign(new Error('MCP HTTP 502: Bad Gateway'), { status: 502, retryable: null })

  it('retries a body-less 502 to eventual success', async () => {
    let calls = 0
    const out = await mcpToolsCallWithRetry({ name: 'register_connection' }, {
      sleepFn: noSleep,
      call: async () => {
        calls++
        if (calls < 3) throw badGateway()
        return 'ok'
      },
    })
    assert.equal(out, 'ok')
    assert.equal(calls, 3)
  })

  it('does NOT retry a credential the server rejected', async () => {
    let calls = 0
    await assert.rejects(
      mcpToolsCallWithRetry({}, {
        sleepFn: noSleep,
        call: async () => {
          calls++
          throw Object.assign(new Error('MCP HTTP 401: Invalid or revoked API token'), {
            status: 401, serverCode: 'invalid_api_token', retryable: false,
          })
        },
      }),
      /Invalid or revoked API token/,
    )
    assert.equal(calls, 1, 'a dead token must not be hammered')
  })

  it('is bounded and rethrows the last error', async () => {
    let calls = 0
    await assert.rejects(
      mcpToolsCallWithRetry({}, { sleepFn: noSleep, call: async () => { calls++; throw badGateway() } }),
      /MCP HTTP 502/,
    )
    assert.equal(calls, 3)
  })

  it('passes the call arguments through unchanged', async () => {
    let seen = null
    await mcpToolsCallWithRetry({ name: 'x', arguments: { a: 1 } }, {
      sleepFn: noSleep,
      call: async (args) => { seen = args; return 'ok' },
    })
    assert.deepEqual(seen, { name: 'x', arguments: { a: 1 } })
  })
})
