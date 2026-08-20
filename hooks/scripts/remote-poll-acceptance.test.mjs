import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { executeCursorHostControl } from './cursor-host-control.mjs'
import {
  advancePollCursorState,
  appendAcceptedJsonl,
  buildPollCursorArgs,
  inspectPollResponseV1,
  playbookAcceptanceKey,
} from './remote-poll-acceptance.mjs'
import { canonicalAcceptanceKey } from './remote-ingress-v1.mjs'
import {
  FIXTURE_ID,
  emptyFixtureContext,
  fixtureContextEntry,
  fixtureControl,
  fixtureEnvelope,
  fixturePlaybookDispatch,
  fixturePollResponse,
  fixtureWindow,
} from './remote-ingress-test-fixtures.mjs'

describe('poll acceptance integration seam', () => {
  it('keeps explicit playbooks independent from canonical conversation commands', () => {
    const playbook = fixturePlaybookDispatch()
    const accepted = inspectPollResponseV1(
      fixturePollResponse({ dispatches: [playbook] }),
      FIXTURE_ID.connection,
    )
    assert.equal(accepted.ok, true)
    assert.equal(accepted.canonicalWake, true)
    assert.deepEqual(accepted.playbooks, [playbook])
    assert.equal(accepted.envelope.commands.some((command) => command.message_id === playbook.id), false)
    assert.equal(playbookAcceptanceKey(playbook), `playbook:${playbook.run_id}`)
  })

  it('rejects action-item/unknown dispatches rather than reviving assignment delivery', () => {
    const actionAssignment = { ...fixturePlaybookDispatch(), kind: 'action_item_assignment' }
    const accepted = inspectPollResponseV1(
      fixturePollResponse({ dispatches: [actionAssignment] }),
      FIXTURE_ID.connection,
    )
    assert.equal(accepted.ok, false)
    assert.match(accepted.error, /playbook dispatch/)
  })

  it('separates live cursor_v2, older catch_up_cursor, legacy cursor and dispatch cursor', () => {
    const envelope = fixtureEnvelope()
    envelope.window = fixtureWindow(envelope.commands, {
      total_known: 50,
      truncated: true,
      has_more: true,
      next_cursor: 'older-page-cursor',
      fetch_id: 'stable-page',
      omission_reason: 'history_before_window',
    })
    const accepted = inspectPollResponseV1(fixturePollResponse({ envelope }), FIXTURE_ID.connection)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.liveCursorV2, 'live-cursor-v2')
    assert.equal(accepted.catchUpCursor, 'older-page-cursor')
    assert.equal(accepted.dispatchCursor, 'dispatch-watermark')
    const draining = advancePollCursorState({
      liveCursorV2: 'live-before-drain',
      legacyCursor: null,
      catchUpCursor: 'older-page-cursor',
      dispatchCursor: 'dispatch-before',
    }, accepted, { drainingCatchUp: true })
    assert.equal(draining.liveCursorV2, 'live-before-drain')
    assert.equal(draining.catchUpCursor, 'older-page-cursor')
    assert.equal(draining.dispatchCursor, 'dispatch-watermark')

    assert.deepEqual(buildPollCursorArgs({
      liveCursorV2: accepted.liveCursorV2,
      legacyCursor: accepted.legacyCursor,
      catchUpCursor: accepted.catchUpCursor,
      dispatchCursor: accepted.dispatchCursor,
    }), {
      cursor_v2: 'live-cursor-v2',
      catch_up: true,
      catch_up_cursor: 'older-page-cursor',
      dispatch_cursor: 'dispatch-watermark',
    })
  })

  it('accepts replay continuation as inert context without a conversational wake', () => {
    const context = emptyFixtureContext()
    context.human_context.push(fixtureContextEntry({ kind: 'human', content: 'historical command text' }))
    const envelope = fixtureEnvelope({
      wakeKind: 'history_reseed', deliveryState: 'replay', context,
      window: fixtureWindow(context.human_context, {
        total_known: 30, truncated: true, has_more: true, next_cursor: 'older-2',
        fetch_id: 'history-fetch', omission_reason: 'history_before_window',
      }),
    })
    const accepted = inspectPollResponseV1(fixturePollResponse({ envelope }), FIXTURE_ID.connection)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.canonicalWake, false)
    assert.equal(accepted.catchUpCursor, 'older-2')
  })

  it('makes durable acceptance idempotent across append-before-cursor restart replay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-acceptance-'))
    const file = path.join(dir, 'inbox.jsonl')
    const envelope = fixtureEnvelope()
    const key = canonicalAcceptanceKey(envelope)
    try {
      const abandonedLock = `${file}.accept.lock`
      fs.mkdirSync(abandonedLock)
      fs.writeFileSync(path.join(abandonedLock, 'owner'), '2147483647\n')
      const first = appendAcceptedJsonl(file, { type: 'owner_messages', messages: envelope.commands }, key)
      assert.deepEqual(first, { ok: true, duplicate: false, error: null })
      // A fresh process has no in-memory dedupe set; the inbox itself is the ledger.
      const replay = appendAcceptedJsonl(file, { type: 'owner_messages', messages: envelope.commands }, key)
      assert.deepEqual(replay, { ok: true, duplicate: true, error: null })
      assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes canonical controls separately and authorizes ack only after execution', async () => {
    const control = fixtureControl('compact')
    const envelope = fixtureEnvelope({ wakeKind: 'control', control })
    const accepted = inspectPollResponseV1(fixturePollResponse({ envelope }), FIXTURE_ID.connection)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.canonicalWake, false)
    assert.deepEqual(accepted.control, control)

    const unsupported = await executeCursorHostControl(control)
    assert.deepEqual(unsupported, {
      executed: false, ackId: null, reason: 'unsupported_by_cursor_host',
    })
    assert.deepEqual(buildPollCursorArgs({ controlAck: unsupported.ackId }), {})
    const failed = await executeCursorHostControl(control, {
      compact: async () => ({ executed: false, reason: 'host refused' }),
    })
    assert.equal(failed.ackId, null)
    const executed = await executeCursorHostControl(control, {
      compact: async () => ({ executed: true }),
    })
    assert.equal(executed.executed, true)
    assert.equal(executed.ackId, control.id)
    assert.deepEqual(buildPollCursorArgs({ controlAck: executed.ackId }), { control_ack: control.id })
  })
})
