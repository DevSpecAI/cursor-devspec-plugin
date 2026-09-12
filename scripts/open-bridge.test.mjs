import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { applyCors, isAllowedOrigin } from './open-bridge.mjs'

/** Minimal ServerResponse stand-in — applyCors only ever sets headers. */
function fakeRes() {
  const headers = {}
  return { headers, setHeader: (k, v) => (headers[k] = v) }
}

describe('loopback bridge CORS', () => {
  it('allows the app origins and rejects everything else', () => {
    for (const ok of [
      'https://app.devspec.ai',
      'https://app.devspecstaging.com',
      'https://devspec.ai',
      'https://staging.devspec.ai',
      'http://localhost:3000',
      'http://127.0.0.1:3007',
    ]) {
      assert.equal(isAllowedOrigin(ok), true, ok)
    }
    for (const bad of [
      'https://evil.example',
      // A different TLD is not covered by the .devspec.ai suffix rule — only the
      // named staging app host is.
      'https://api.devspecstaging.com',
      'https://evil.devspecstaging.com',
      '',
      null,
      undefined,
    ]) {
      assert.equal(isAllowedOrigin(bad), false, String(bad))
    }
  })

  it('serves CORS and Private Network Access to the staging app host', () => {
    const res = fakeRes()
    applyCors({ headers: { origin: 'https://app.devspecstaging.com' } }, res)
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://app.devspecstaging.com')
    assert.equal(res.headers['Access-Control-Allow-Private-Network'], 'true')
  })

  /*
   * Chrome preflights a public HTTPS page reaching loopback (Private Network
   * Access) and fails the fetch unless the preflight opts in. Without this the
   * app cannot tell "launcher installed" from "launcher missing", which is the
   * difference between a useful message and a silent no-op launch.
   */
  it('opts in to Private Network Access for an allowed origin', () => {
    const res = fakeRes()
    applyCors({ headers: { origin: 'https://devspec.ai' } }, res)
    assert.equal(res.headers['Access-Control-Allow-Private-Network'], 'true')
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://devspec.ai')
    assert.equal(res.headers['Vary'], 'Origin')
  })

  it('does not offer Private Network Access to a foreign origin', () => {
    const res = fakeRes()
    applyCors({ headers: { origin: 'https://evil.example' } }, res)
    assert.equal(res.headers['Access-Control-Allow-Private-Network'], undefined)
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
  })
})
