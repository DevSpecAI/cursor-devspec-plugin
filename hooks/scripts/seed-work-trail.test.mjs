import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TRAIL_SEED_TEXT, advanceTrailState, hashPostedContent } from './work-trail.mjs'

describe('seedWorkTrailForConnection (logic via advanceTrailState)', () => {
  it('seeds Working… from an empty trail', () => {
    const r = advanceTrailState({ prev: null, part: TRAIL_SEED_TEXT, mode: 'seed', now: 10 })
    assert.ok(r)
    assert.equal(r.trail, TRAIL_SEED_TEXT)
    assert.equal(r.shouldPost, true)
    assert.equal(r.seed, true)
  })

  it('skips seed when a non-seed trail is already growing', () => {
    const r = advanceTrailState({
      prev: {
        cumulative: '$ Shell ls\nok',
        lastPostedHash: hashPostedContent('$ Shell ls\nok'),
        lastPostedAt: 1,
      },
      part: TRAIL_SEED_TEXT,
      mode: 'seed',
      now: 5000,
    })
    assert.equal(r, null)
  })

  it('allows re-seed when only the seed text is present', () => {
    const r = advanceTrailState({
      prev: {
        cumulative: TRAIL_SEED_TEXT,
        lastPostedHash: hashPostedContent(TRAIL_SEED_TEXT),
        lastPostedAt: 1,
      },
      part: TRAIL_SEED_TEXT,
      mode: 'seed',
      now: 5000,
    })
    // Same hash → throttle/dedupe skips post
    assert.ok(r)
    assert.equal(r.shouldPost, false)
  })
})

describe('seedWorkTrailForConnection module contract', () => {
  it('exports seedWorkTrailForConnection', async () => {
    const mod = await import('./seed-work-trail.mjs')
    assert.equal(typeof mod.seedWorkTrailForConnection, 'function')
  })

  it('returns skipped when args are missing', async () => {
    const { seedWorkTrailForConnection } = await import('./seed-work-trail.mjs')
    const r = await seedWorkTrailForConnection({})
    assert.equal(r.ok, false)
    assert.equal(r.skipped, true)
    assert.equal(r.reason, 'missing_args')
  })
})
