/**
 * Item 9ed0d42e — Connect wake must carry the command body, not a count-only trigger.
 *
 * The poller used to append `{ type: owner_message, count }` to the wake file the
 * instant a command landed in the inbox. That notified Cursor before host wake-follow
 * wrote `buildOwnerMessageEvents`, so the model woke with no body and raced
 * `poll_connection`. Wait-follow owns the wake file; the poller must not write thin wakes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildOwnerMessageEvents } from './devspec-remote-wait.mjs'

const pollerSrc = fs.readFileSync(
  fileURLToPath(new URL('./devspec-remote-poll.mjs', import.meta.url)),
  'utf8',
)

describe('item 9ed0d42e — wake delivery', () => {
  it('poller source no longer appends a thin count-only owner_message wake', () => {
    assert.equal(pollerSrc.includes('appendWakeEvents'), false)
    assert.match(pollerSrc, /9ed0d42e/)
    assert.match(pollerSrc, /buildOwnerMessageEvents/)
    assert.match(pollerSrc, /ensureHostWakeFollow/)
  })

  it('poller cold-arms wake-follow with fromEnd; inject ensure does not', () => {
    // Item 1badd088 — ensureHostWakeFollow(..., { fromEnd: true }) only at startup.
    assert.match(pollerSrc, /1badd088/)
    assert.match(
      pollerSrc,
      /ensureHostWakeFollow\(connectionId,\s*ownerAnchor,\s*\{\s*fromEnd:\s*true\s*\}\)/,
    )
    const injectEnsure = pollerSrc.match(
      /ensureHostWakeFollow\(connectionId,\s*ownerAnchor\)\s*\n\s*const delivered/,
    )
    assert.ok(injectEnsure, 'inject path must call ensureHostWakeFollow without fromEnd')
  })

  it('buildOwnerMessageEvents puts the command body on type owner_message', () => {
    const events = buildOwnerMessageEvents({
      type: 'owner_messages',
      session_id: 'sess-1',
      messages: [
        {
          id: 'msg-1',
          content: 'What is 1 + 1?',
          authority: { kind: 'owner' },
        },
      ],
      context: { owner_ambient: [], room_context: [] },
    })
    const owner = events.find((e) => e.type === 'owner_message')
    assert.ok(owner)
    assert.equal(owner.message.content, 'What is 1 + 1?')
    assert.equal(owner.session_id, 'sess-1')
    assert.equal(typeof owner.count, 'undefined')
  })
})
