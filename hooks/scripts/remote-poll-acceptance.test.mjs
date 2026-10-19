import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { executeCursorHostControl } from './cursor-host-control.mjs'
import { resolveSpaceFreeWakeFile } from './devspec-wake-file.mjs'
import {
  advancePollCursorState,
  appendAcceptedCanonicalJsonl,
  appendAcceptedJsonl,
  buildPollCursorArgs,
  inspectPollResponseV1,
  isCatchUpCursorRefusal,
  automationAcceptanceKey,
  automationRunInstruction,
} from './remote-poll-acceptance.mjs'
import { canonicalAcceptanceKey, validateRemoteIngressEnvelopeV1 } from './remote-ingress-v1.mjs'
import {
  FIXTURE_ID,
  emptyFixtureContext,
  fixtureActivePlanEnvelope,
  fixtureCommand,
  fixtureContextEntry,
  fixtureControl,
  fixtureEnvelope,
  fixtureAutomationDispatch,
  fixturePollResponse,
  fixtureWindow,
} from './remote-ingress-test-fixtures.mjs'

describe('poll acceptance integration seam', () => {
  it('accepts the negotiated strict 1.3 active-plan projection as advisory envelope data', () => {
    const envelope = fixtureActivePlanEnvelope()
    const accepted = inspectPollResponseV1(fixturePollResponse({ envelope }), FIXTURE_ID.connection)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.envelope.contract_version, '1.3.0')
    assert.equal(accepted.envelope.active_session_plans.advisory, true)
    assert.equal(accepted.canonicalWake, true)
  })

  it('keeps explicit automations independent from canonical conversation commands', () => {
    const automation = fixtureAutomationDispatch()
    const accepted = inspectPollResponseV1(
      fixturePollResponse({ dispatches: [automation] }),
      FIXTURE_ID.connection,
    )
    assert.equal(accepted.ok, true)
    assert.equal(accepted.canonicalWake, true)
    assert.deepEqual(accepted.automations, [automation])
    assert.equal(accepted.envelope.commands.some((command) => command.message_id === automation.id), false)
    assert.equal(automationAcceptanceKey(automation), `automation:${automation.run_id}`)
  })

  it('rejects action-item/unknown dispatches rather than reviving assignment delivery', () => {
    const actionAssignment = { ...fixtureAutomationDispatch(), kind: 'action_item_assignment' }
    const accepted = inspectPollResponseV1(
      fixturePollResponse({ dispatches: [actionAssignment] }),
      FIXTURE_ID.connection,
    )
    assert.equal(accepted.ok, false)
    assert.match(accepted.error, /automation dispatch/)
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

  it('generic duplicate detection still fails closed on later malformed interior records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-acceptance-'))
    const file = path.join(dir, 'control.jsonl')
    try {
      fs.writeFileSync(file, [
        JSON.stringify({ acceptance_key: 'control:1', type: 'host_control' }),
        '{"malformed":}',
        JSON.stringify({ acceptance_key: 'control:2', type: 'host_control' }),
        '',
      ].join('\n'))
      const result = appendAcceptedJsonl(file, { type: 'host_control' }, 'control:1')
      assert.equal(result.ok, false)
      assert.equal(result.duplicate, false)
      assert.match(result.error, /malformed complete interior/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('durably filters an expanded retry window per command message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-acceptance-'))
    const file = path.join(dir, 'inbox.jsonl')
    const first = fixtureCommand('first')
    const second = structuredClone(fixtureCommand('second'))
    second.message_id = FIXTURE_ID.control
    second.order = {
      sequence: 2,
      created_at: '2026-08-19T12:00:02.000Z',
      message_id: FIXTURE_ID.control,
    }
    second.delivery = {
      ...second.delivery,
      provenance_ref: FIXTURE_ID.resource,
      primary_provenance_ref: FIXTURE_ID.provenance,
      is_primary: false,
    }
    const record = (envelope) => ({
      type: 'owner_messages',
      count: envelope.commands.length,
      connection_id: FIXTURE_ID.connection,
      messages: envelope.commands,
      context: null,
      ingress: { canonical: true, envelope },
    })
    try {
      const initial = fixtureEnvelope({ commands: [first] })
      assert.equal(appendAcceptedCanonicalJsonl(file, record(initial)).duplicate, false)
      fs.appendFileSync(file, '{"newline_terminated_but_malformed":}\n')
      const expanded = fixtureEnvelope({ commands: [first, second] })
      const accepted = appendAcceptedCanonicalJsonl(file, record(expanded))
      assert.equal(accepted.duplicate, false)
      assert.deepEqual(accepted.record.messages.map((command) => command.message_id), [second.message_id])
      assert.deepEqual(accepted.record.ingress.envelope.command_message_ids, [second.message_id])
      assert.equal(validateRemoteIngressEnvelopeV1(accepted.record.ingress.envelope, FIXTURE_ID.connection), null)
      assert.equal(appendAcceptedCanonicalJsonl(file, record(expanded)).duplicate, true)
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
      assert.deepEqual(lines.map((line) => line.messages.map((command) => command.message_id)), [
        [first.message_id],
        [second.message_id],
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on a malformed complete interior acceptance record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-acceptance-'))
    const file = path.join(dir, 'inbox.jsonl')
    const envelope = fixtureEnvelope()
    const record = {
      type: 'owner_messages',
      count: envelope.commands.length,
      connection_id: FIXTURE_ID.connection,
      messages: envelope.commands,
      context: null,
      ingress: { canonical: true, envelope },
    }
    try {
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'advisory_context', messages: [] }),
        '{"malformed":}',
        JSON.stringify({ type: 'advisory_context', messages: [] }),
        '',
      ].join('\n'))
      const result = appendAcceptedCanonicalJsonl(file, record)
      assert.equal(result.ok, false)
      assert.match(result.error, /malformed complete interior/)
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

  it('renders delivery_connection_id in both claim_automation_run and record_automation_run and drops provider/model prose', () => {
    const dispatch = fixtureAutomationDispatch()
    const prompt = automationRunInstruction(dispatch)
    assert.match(
      prompt,
      new RegExp(`claim_automation_run\\(\\{ run_id: "${dispatch.run_id}", connection_id: "${dispatch.delivery_connection_id}" \\}\\)`),
    )
    assert.match(
      prompt,
      new RegExp(`record_automation_run\\(\\{ run_id: "${dispatch.run_id}", connection_id: "${dispatch.delivery_connection_id}"`),
    )
    assert.doesNotMatch(prompt, /always pass provider/i)
    assert.doesNotMatch(prompt, /provider:\s*"cursor"/i)
  })

  it('never starts a history drain from a page the server is holding back (delivery_retry)', () => {
    const envelope = fixtureEnvelope({
      wakeKind: 'advisory_update',
      commands: [],
      window: {
        policy_version: '2026-08-19.3',
        returned: 0,
        total_known: null,
        source_window: {
          start: { sequence: 9, created_at: '2026-08-19T12:00:09.000Z', message_id: FIXTURE_ID.message },
          end: { sequence: 9, created_at: '2026-08-19T12:00:09.000Z', message_id: FIXTURE_ID.message },
        },
        truncated: true,
        has_more: true,
        next_cursor: 'after:held-page',
        fetch_id: 'session:held:messages',
        omission_reason: 'delivery_retry',
      },
    })
    const accepted = inspectPollResponseV1(
      fixturePollResponse({ envelope, over: { cursor_v2: 'live-retry' } }),
      FIXTURE_ID.connection,
    )
    assert.equal(accepted.ok, true)
    assert.equal(accepted.deliveryRetry, true)
    assert.equal(accepted.catchUpCursor, null)

    // Steady state: forward delivery_retry continuation is NOT installed as catchUpCursor.
    assert.deepEqual(
      advancePollCursorState(
        { liveCursorV2: 'live-before', legacyCursor: null, catchUpCursor: null, dispatchCursor: 'd1' },
        accepted,
      ),
      {
        liveCursorV2: 'live-retry',
        legacyCursor: null,
        catchUpCursor: null,
        dispatchCursor: 'dispatch-watermark',
      },
    )

    // Draining older history while a live page is held preserves the existing older catchUpCursor.
    assert.deepEqual(
      advancePollCursorState(
        { liveCursorV2: 'live-before', legacyCursor: null, catchUpCursor: 'before:older-page', dispatchCursor: 'd1' },
        accepted,
        { drainingCatchUp: true },
      ),
      {
        liveCursorV2: 'live-before',
        legacyCursor: null,
        catchUpCursor: 'before:older-page',
        dispatchCursor: 'dispatch-watermark',
      },
    )
  })

  it('recognises the server refusing a poisoned catch-up cursor', () => {
    assert.equal(isCatchUpCursorRefusal(new Error('catch_up_cursor has the wrong direction.')), true)
    assert.equal(
      isCatchUpCursorRefusal(new Error('catch_up_cursor requires catch_up: true on an attached connection.')),
      true,
    )
    assert.equal(isCatchUpCursorRefusal(new Error('rate limit exceeded')), false)
    assert.equal(isCatchUpCursorRefusal(null), false)
  })

  it('recovers a live poller from a persisted poisoned catch_up_cursor, survives a held retry page, and delivers the pending command once', async () => {
    const POLL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'devspec-remote-poll.mjs')
    const SESSION = '20000000-0000-4000-8000-000000000002'
    const polls = []
    let heldServed = false
    let commandDelivered = false

    const heldEnvelope = fixtureEnvelope({
      envelopeId: 'e0000000-0000-4000-8000-000000000001',
      wakeKind: 'advisory_update',
      commands: [],
      window: {
        policy_version: '2026-08-19.3',
        returned: 0,
        total_known: null,
        source_window: {
          start: { sequence: 9, created_at: '2026-08-19T12:00:09.000Z', message_id: FIXTURE_ID.message },
          end: { sequence: 9, created_at: '2026-08-19T12:00:09.000Z', message_id: FIXTURE_ID.message },
        },
        truncated: true,
        has_more: true,
        next_cursor: 'after:held-page-2',
        fetch_id: `session:${SESSION}:messages`,
        omission_reason: 'delivery_retry',
      },
    })

    const liveCommandEnvelope = fixtureEnvelope({
      envelopeId: 'e0000000-0000-4000-8000-000000000002',
      body: 'ship the recovered command',
    })

    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        const parsed = JSON.parse(body)
        const call = parsed.params ?? {}
        const args = call.arguments ?? {}
        let result = { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }

        if (call.name === 'poll_connection') {
          polls.push(args)
          if (args.catch_up_cursor && !String(args.catch_up_cursor).startsWith('before:')) {
            result = {
              isError: true,
              content: [{ type: 'text', text: 'catch_up_cursor has the wrong direction.' }],
            }
          } else if (!heldServed) {
            heldServed = true
            result = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'live',
                  session_id: SESSION,
                  changed: true,
                  cursor: null,
                  cursor_v2: 'after:held-tick',
                  dispatch_cursor: 'dispatch-1',
                  ingress: heldEnvelope,
                  dispatches: [],
                }),
              }],
            }
          } else if (!commandDelivered) {
            commandDelivered = true
            result = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'live',
                  session_id: SESSION,
                  changed: true,
                  cursor: FIXTURE_ID.message,
                  cursor_v2: 'after:command-tick',
                  dispatch_cursor: 'dispatch-1',
                  ingress: liveCommandEnvelope,
                  dispatches: [],
                }),
              }],
            }
          } else {
            await new Promise((r) => setTimeout(r, 150))
            result = {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'live',
                  session_id: SESSION,
                  changed: false,
                  cursor: FIXTURE_ID.message,
                  cursor_v2: 'after:command-tick',
                  dispatch_cursor: 'dispatch-1',
                }),
              }],
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
      })
    })

    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-recovery-'))
    const connDir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(connDir, { recursive: true })
    const statePath = path.join(connDir, `${FIXTURE_ID.connection}.json`)
    const inboxPath = path.join(connDir, `${FIXTURE_ID.connection}.inbox.jsonl`)
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        enabled: true,
        connection_id: FIXTURE_ID.connection,
        session_id: SESSION,
        agent_name: 'Cursor',
        token: 'dvs_test_token',
        mcp_url: mcpUrl,
        ingress_version: 1,
        ingress_cursor_v2: 'before-wedge',
        ingress_catch_up_cursor: 'after:poisoned-forward-cursor',
      }),
      { mode: 0o600 },
    )

    const child = spawn(process.execPath, [POLL_SCRIPT, '--connection-id', FIXTURE_ID.connection], {
      env: { ...process.env, HOME: home },
    })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (chunk) => { stderr += chunk })

    const readInbox = () => {
      try {
        return fs.readFileSync(inboxPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      } catch {
        return []
      }
    }
    const readState = () => {
      try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'))
      } catch {
        return {}
      }
    }
    const until = async (pred, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs
      while (!pred() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      return pred()
    }

    try {
      assert.ok(
        await until(() => readInbox().some((r) => r.type === 'owner_messages')),
        `poller did not deliver recovered owner_messages; stderr:\n${stderr}`,
      )
      // Wait for at least one steady idle poll after command delivery so we verify no re-poisoning or duplicate delivery.
      assert.ok(await until(() => polls.length >= 4), `expected >= 4 polls, got ${polls.length}`)

      // 1. First poll sent the persisted poisoned cursor and was refused.
      assert.equal(polls[0].catch_up_cursor, 'after:poisoned-forward-cursor')
      // 2. Subsequent polls never sent a poisoned catch_up_cursor again, even after receiving a delivery_retry page.
      assert.equal(polls.slice(1).some((p) => p.catch_up_cursor), false)
      assert.equal(polls[1].catch_up, true, 'recovery poll re-reads with catch_up: true')
      assert.equal(readState().ingress_catch_up_cursor, null)

      // 3. The pending command was delivered to the inbox exactly once.
      const ownerRecords = readInbox().filter((r) => r.type === 'owner_messages')
      assert.equal(ownerRecords.length, 1)
      assert.deepEqual(
        ownerRecords[0].messages.map((m) => m.message_id),
        [FIXTURE_ID.message],
      )
    } finally {
      child.kill('SIGKILL')
      try {
        fs.rmSync(resolveSpaceFreeWakeFile(FIXTURE_ID.connection), { force: true })
      } catch { /* ignore */ }
      fs.rmSync(home, { recursive: true, force: true })
      await new Promise((r) => server.close(r))
    }
  })
})
