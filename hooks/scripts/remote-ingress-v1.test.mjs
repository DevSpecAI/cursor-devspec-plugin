import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  emptyCanonicalContextCarry,
  mergeCanonicalContextCarry,
  normalizeRemoteIngressV1,
  validateRemoteIngressEnvelopeV1,
} from './remote-ingress-v1.mjs'
import {
  FIXTURE_ID as ID,
  emptyFixtureContext as emptyContext,
  fixtureCommand as command,
  fixtureContextEntry as contextEntry,
  fixtureEnvelope,
  fixtureWindow as windowFor,
} from './remote-ingress-test-fixtures.mjs'

function envelope({ body = 'ship it', wake = true, context = emptyContext(), commands } = {}) {
  return fixtureEnvelope({ body, wakeKind: wake ? 'conversational_command' : 'advisory_update', context, commands })
}

describe('canonical remote ingress v1', () => {
  it('preserves a large complete command body and all canonical metadata exactly', () => {
    const body = 'begin\n' + 'x'.repeat(250_000) + '\nend'
    const ingress = envelope({ body })
    const result = normalizeRemoteIngressV1({ changed: true, ingress, commands: [{ content: 'preview only' }] }, ID.connection)
    assert.equal(result.ok, true)
    assert.equal(result.wake, true)
    assert.equal(result.envelope.commands[0].content.body, body)
    assert.deepEqual(result.envelope.commands[0], ingress.commands[0])
  })

  it('fails closed on missing, malformed, preview, and unknown canonical ingress', () => {
    assert.equal(normalizeRemoteIngressV1({ changed: true, commands: [command()] }, ID.connection).ok, false)
    const preview = envelope()
    preview.commands[0].content = { mode: 'preview', body: 'ship…', complete: false }
    assert.equal(normalizeRemoteIngressV1({ changed: true, ingress: preview }, ID.connection).ok, false)
    const unknown = envelope()
    unknown.schema_version = 2
    assert.equal(normalizeRemoteIngressV1({ changed: true, ingress: unknown }, ID.connection).ok, false)
  })

  it('keeps typed AI context inert even when its body looks executable', () => {
    const context = emptyContext()
    context.ai_context.push(contextEntry())
    const ingress = envelope({ wake: false, context })
    const result = normalizeRemoteIngressV1({ changed: true, ingress }, ID.connection)
    assert.equal(result.ok, true)
    assert.equal(result.wake, false)
    assert.equal(result.envelope.context.ai_context[0].advisory, true)
  })

  it('rejects an unavailable attachment for the command', () => {
    const ingress = envelope()
    ingress.commands[0].attachments[0] = {
      materialization: 'unavailable', filename: 'lost.png', mime_type: 'image/png', type: 'image',
      size_bytes: null, resource_id: null, reason: 'access_denied',
    }
    assert.match(validateRemoteIngressEnvelopeV1(ingress, ID.connection), /attachment unavailable/)
  })

  it('matches canonical Zod safe-integer, UUID sentinel, datetime and cross-field behavior', () => {
    const valid = envelope()
    valid.envelope_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    valid.commands[0].message_id = '00000000-0000-0000-0000-000000000000'
    valid.commands[0].order.message_id = valid.commands[0].message_id
    valid.command_message_ids = [valid.commands[0].message_id]
    valid.window.source_window.start = valid.commands[0].order
    valid.window.source_window.end = valid.commands[0].order
    assert.equal(validateRemoteIngressEnvelopeV1(valid, ID.connection), null)

    const unsafe = envelope()
    unsafe.commands[0].order.sequence = Number.MAX_SAFE_INTEGER + 1
    unsafe.window.source_window.start = unsafe.commands[0].order
    unsafe.window.source_window.end = unsafe.commands[0].order
    assert.match(validateRemoteIngressEnvelopeV1(unsafe, ID.connection), /commands/)

    const impossibleDate = envelope()
    impossibleDate.commands[0].order.created_at = '2026-02-30T12:00:00Z'
    impossibleDate.window.source_window.start = impossibleDate.commands[0].order
    impossibleDate.window.source_window.end = impossibleDate.commands[0].order
    assert.match(validateRemoteIngressEnvelopeV1(impossibleDate, ID.connection), /commands/)

    const mismatch = envelope()
    mismatch.commands[0].requester.user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    assert.match(validateRemoteIngressEnvelopeV1(mismatch, ID.connection), /commands/)
  })

  it('strictly bounds large typed context and honestly reports row/window omissions', () => {
    let carry = emptyCanonicalContextCarry()
    for (let i = 0; i < 25; i++) {
      const context = emptyContext()
      const bucket = ['human_context', 'agent_context', 'ai_context', 'system_context'][i % 4]
      const kind = bucket.replace('_context', '')
      context[bucket].push(contextEntry({ sequence: i + 2, kind, content: i === 24 ? 'x'.repeat(20_000) : 'x'.repeat(700) }))
      carry = mergeCanonicalContextCarry(carry, envelope({ wake: false, context }), {
        maxCount: 20, maxChars: 12_000, maxWindows: 5,
      })
    }
    const rows = Object.values(carry.context).flat()
    assert.ok(rows.length <= 20)
    assert.ok(rows.reduce((sum, row) => sum + row.content.length, 0) <= 12_000)
    assert.equal(carry.windows.length, 5)
    assert.ok(carry.locally_omitted > 0)
    assert.ok(carry.windows_omitted > 0)
    assert.equal(carry.local_omission_reason, 'model_budget')
  })

  it('preserves continuation/window metadata and bounded context omissions across responses', () => {
    const context = emptyContext()
    context.ai_context.push(contextEntry())
    const first = envelope({ wake: false, context })
    first.window = windowFor([context.ai_context[0]], {
      total_known: 10, truncated: true, has_more: true, next_cursor: 'opaque-next',
      fetch_id: 'stable-fetch', omission_reason: 'policy_limit',
    })
    const carry = mergeCanonicalContextCarry(emptyCanonicalContextCarry(), first, { maxCount: 1, maxChars: 1000 })
    assert.equal(carry.windows[0].next_cursor, 'opaque-next')
    assert.equal(carry.context.ai_context[0].message_id, context.ai_context[0].message_id)
    const replayed = mergeCanonicalContextCarry(carry, first, { maxCount: 20, maxChars: 12_000 })
    assert.equal(replayed.context.ai_context.length, 1)
    assert.equal(replayed.windows.length, 1)
  })
})
