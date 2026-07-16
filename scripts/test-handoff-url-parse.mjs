import assert from 'node:assert/strict'
import {
  normalizeProtocolUrl,
  isHandoffOpenUrl,
  parseHandoffUrl,
} from '../scripts/open-handler-core.mjs'

function expectOpen(raw) {
  const url = normalizeProtocolUrl(raw)
  assert.ok(url, `normalize failed for ${raw}`)
  assert.equal(isHandoffOpenUrl(url), true, `isHandoffOpenUrl failed for ${raw}`)
}

expectOpen('devspec://open?t=abc')
expectOpen('devspec://open/?t=abc')
expectOpen('devspec:///open?t=abc')
expectOpen('"devspec://open/?t=abc"')
expectOpen('devspec:open?t=abc')

assert.equal(parseHandoffUrl('devspec://open/?t=abc')?.error, 'malformed_token')
assert.equal(parseHandoffUrl('https://example.com'), null)
assert.equal(parseHandoffUrl('devspec://other?t=abc'), null)

const unsignedCli = parseHandoffUrl('devspec://open?repo=DevSpecAI%2FDevSpecV2&surface=cli')
assert.equal(unsignedCli?.slug, 'DevSpecAI/DevSpecV2')
assert.equal(unsignedCli?.surface, 'cli')
assert.equal(unsignedCli?.unsigned, true)

const unsignedIde = parseHandoffUrl('devspec://open?repo=DevSpecAI%2FDevSpecV2')
assert.equal(unsignedIde?.surface, 'ide')

console.log('ok: handoff URL parsing accepts Chrome open/? forms and surface=cli')
