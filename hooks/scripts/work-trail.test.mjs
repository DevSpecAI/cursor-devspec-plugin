import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TRAIL_MAX_CHARS,
  TRAIL_POST_MIN_GAP_MS,
  TRAIL_SEED_TEXT,
  advanceTrailState,
  clampTrail,
  elideLongOutput,
  hashPostedContent,
  isDevspecPostSessionTool,
  renderHookTrailPart,
  serializeTranscriptJsonl,
  shouldPostTrail,
} from './work-trail.mjs'

describe('shouldPostTrail', () => {
  it('skips empty unless forced seed', () => {
    assert.equal(
      shouldPostTrail({
        trail: '',
        trailHash: 'x',
        now: 1000,
      }),
      false,
    )
    assert.equal(
      shouldPostTrail({
        trail: '',
        trailHash: 'x',
        now: 1000,
        force: true,
        seed: true,
      }),
      true,
    )
  })

  it('dedupes by hash and throttles by gap', () => {
    const hash = hashPostedContent('Working…')
    assert.equal(
      shouldPostTrail({
        trail: 'Working…',
        trailHash: hash,
        lastPostedTrailHash: hash,
        lastPostedAt: 0,
        now: 5000,
      }),
      false,
    )
    assert.equal(
      shouldPostTrail({
        trail: 'Working…\n\n$ tool',
        trailHash: hashPostedContent('Working…\n\n$ tool'),
        lastPostedTrailHash: hash,
        lastPostedAt: 1000,
        now: 1000 + TRAIL_POST_MIN_GAP_MS - 1,
      }),
      false,
    )
    assert.equal(
      shouldPostTrail({
        trail: 'Working…\n\n$ tool',
        trailHash: hashPostedContent('Working…\n\n$ tool'),
        lastPostedTrailHash: hash,
        lastPostedAt: 1000,
        now: 1000 + TRAIL_POST_MIN_GAP_MS,
      }),
      true,
    )
  })
})

describe('advanceTrailState', () => {
  it('seeds Working…', () => {
    const r = advanceTrailState({ prev: null, part: TRAIL_SEED_TEXT, mode: 'seed', now: 10 })
    assert.ok(r)
    assert.equal(r.trail, TRAIL_SEED_TEXT)
    assert.equal(r.shouldPost, true)
    assert.equal(r.nextState.cumulative, TRAIL_SEED_TEXT)
  })

  it('appends tool parts and replaces seed', () => {
    const seed = advanceTrailState({ prev: null, part: TRAIL_SEED_TEXT, mode: 'seed', now: 10 })
    const next = advanceTrailState({
      prev: seed.nextState,
      part: '$ Shell ls',
      mode: 'afterShellExecution',
      now: 10 + TRAIL_POST_MIN_GAP_MS,
    })
    assert.ok(next)
    assert.equal(next.trail, '$ Shell ls')
    assert.equal(next.shouldPost, true)
  })

  it('prefers transcript re-serialize when provided', () => {
    const jsonl = [
      JSON.stringify({
        role: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Shell', input: { command: 'pwd' } }],
        },
      }),
    ].join('\n')
    const r = advanceTrailState({
      prev: { cumulative: TRAIL_SEED_TEXT, lastPostedHash: hashPostedContent(TRAIL_SEED_TEXT), lastPostedAt: 1 },
      part: '$ ignored',
      mode: 'postToolUse',
      transcriptText: jsonl,
      now: 1 + TRAIL_POST_MIN_GAP_MS,
    })
    assert.ok(r)
    assert.match(r.trail, /\$ Shell/)
    assert.doesNotMatch(r.trail, /ignored/)
  })
})

describe('renderHookTrailPart', () => {
  it('renders shell / tool / file / MCP / thought', () => {
    assert.match(
      renderHookTrailPart('afterShellExecution', { command: 'npm test', output: 'ok', duration: 12 }),
      /\$ npm test \(12ms\)/,
    )
    assert.match(
      renderHookTrailPart('postToolUse', { tool_name: 'Read', tool_input: { path: 'a.ts' }, tool_output: 'hi' }),
      /\$ Read a\.ts/,
    )
    assert.match(renderHookTrailPart('afterFileEdit', { file_path: 'x.ts', edits: [{}, {}] }), /✎ x\.ts \(2 edits\)/)
    assert.match(
      renderHookTrailPart('afterMCPExecution', { tool_name: 'search_index', result: { ok: true } }),
      /\$ MCP:search_index/,
    )
    assert.match(renderHookTrailPart('afterAgentThought', { text: 'planning' }), /» planning/)
  })

  it('skips DevSpec post_session_message tools', () => {
    assert.equal(
      renderHookTrailPart('afterMCPExecution', {
        tool_name: 'post_session_message',
        tool_input: { message: 'hi' },
      }),
      null,
    )
    assert.equal(isDevspecPostSessionTool({ tool_name: 'CallMcpTool', tool_input: { toolName: 'post_session_message' } }), true)
  })
})

describe('clamp / elide / serialize', () => {
  it('clamps oversized trails', () => {
    const big = 'x'.repeat(TRAIL_MAX_CHARS + 50)
    const out = clampTrail(big)
    assert.ok(out.length <= TRAIL_MAX_CHARS)
    assert.ok(out.startsWith('… earlier output trimmed'))
  })

  it('elides long outputs', () => {
    const out = elideLongOutput('a'.repeat(20_000), 100)
    assert.ok(out.length < 200)
    assert.match(out, /chars elided/)
  })

  it('serializeTranscriptJsonl keeps tool_use, skips long narration', () => {
    const jsonl = [
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
            { type: 'text', text: 'short' },
            { type: 'text', text: 'x'.repeat(500) },
          ],
        },
      }),
      JSON.stringify({
        message: { role: 'user', content: [{ type: 'text', text: 'ignore me' }] },
      }),
    ].join('\n')
    const out = serializeTranscriptJsonl(jsonl)
    assert.match(out, /\$ Grep/)
    assert.match(out, /short/)
    assert.doesNotMatch(out, /ignore me/)
    assert.doesNotMatch(out, /xxxxx/)
  })
})
