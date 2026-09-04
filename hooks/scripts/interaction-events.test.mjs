import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  activeContinuation,
  answerSummary,
  buildInteractionAnswerEvents,
  classifyContinuationStart,
  continuationDelivered,
  continuationIdentity,
  DELIVERED,
  interactionAcceptanceKey,
  interactionActivityPlan,
  interactionAnswerRecord,
  interactionNegotiationArgs,
  INTERACTION_ANSWER_RECORD_TYPE,
  INTERACTION_EVENT_CONTRACT_URI,
  negotiatesInteractionEvents,
  turnEndInteractionDecision,
  validateInteractionAnswerRecord,
  validateInteractionEvent,
} from './interaction-events.mjs'
import {
  describeManageQuestionBridge,
  respondArguments,
  validateManageQuestionInput,
} from './manage-question-bridge.mjs'
import { parseWakeBatches } from './devspec-remote-wait.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const POLL_SCRIPT = path.join(HERE, 'devspec-remote-poll.mjs')

const CONNECTION = '10000000-0000-4000-8000-000000000001'
const SIBLING = '10000000-0000-4000-8000-0000000000ff'
const SESSION = '20000000-0000-4000-8000-000000000002'
const OTHER_SESSION = '20000000-0000-4000-8000-0000000000ff'
const EVENT = '30000000-0000-4000-8000-000000000003'
const RESPONSE = '40000000-0000-4000-8000-000000000004'
const QUESTION = '50000000-0000-4000-8000-000000000005'
const CLAIM = '60000000-0000-4000-8000-000000000006'
const ATTEMPT = '70000000-0000-4000-8000-000000000007'
const CAPABILITY = 'dvsc_test_capability'

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

function event(overrides = {}) {
  return {
    kind: 'devspec.interaction_event',
    version: 1,
    event_id: EVENT,
    response_id: RESPONSE,
    question_id: QUESTION,
    origin_connection_id: CONNECTION,
    source_session_id: SESSION,
    response_kind: 'single_select',
    answer: 'Ship it',
    answered_at: '2026-08-26T18:00:00.000Z',
    claim_token: CLAIM,
    lease_expires_at: '2026-08-26T18:00:30.000Z',
    ...overrides,
  }
}

function continuation(overrides = {}) {
  return {
    event_id: EVENT,
    response_id: RESPONSE,
    claim_token: CLAIM,
    question_id: QUESTION,
    attempt_id: ATTEMPT,
    connection_id: CONNECTION,
    session_id: SESSION,
    started_at: '2026-08-26T18:00:01.000Z',
    wake_offset_after: 400,
    ...overrides,
  }
}

function record(overrides = {}) {
  return {
    ...interactionAnswerRecord({
      connectionId: CONNECTION,
      sessionId: SESSION,
      event: event(),
      attemptId: ATTEMPT,
      disposition: DELIVERED,
    }),
    ...overrides,
  }
}

// Criterion ff81fde4 — negotiate only when ready; never send a version that loops.
describe('Cursor interaction-event negotiation', () => {
  it('negotiates only with the capability and session the whole loop needs', () => {
    const ready = { capability: CAPABILITY, sessionId: SESSION }
    assert.deepEqual(interactionNegotiationArgs(ready), { interaction_event_version: 1 })
    assert.equal(negotiatesInteractionEvents(ready), true)

    for (const unready of [
      undefined,
      {},
      { capability: CAPABILITY },
      { sessionId: SESSION },
      { capability: 'not-a-capability', sessionId: SESSION },
      { capability: CAPABILITY, sessionId: 'nope' },
      { capability: CAPABILITY, sessionId: SESSION, enabled: false },
    ]) {
      // Omitted, not falsified: an unaware poll neither wakes nor consumes an event,
      // and there is no unsupported version to be refused in a loop.
      assert.deepEqual(interactionNegotiationArgs(unready), {})
      assert.equal(negotiatesInteractionEvents(unready), false)
    }
  })

  it('sends the negotiation and the capability header on the same poll, or neither', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    assert.match(poll, /const negotiatesInteraction = Object\.keys\(interactionArgs\)\.length > 0/)
    assert.match(poll, /\.\.\.\(negotiatesInteraction \? \{ connectionCapability: capability \} : \{\}\)/)
    assert.match(poll, /const ack = negotiatesInteraction \? pendingInteractionAck : null/)
  })

  it('reads the event lane before the canonical acceptance gate', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    const lane = poll.indexOf('const interaction = await consumeInteractionEvents(res)')
    const canonical = poll.indexOf('const delivered = await consumePollResult(res,')
    assert.ok(lane > -1 && canonical > lane,
      'an event-only response carries no canonical ingress; reading it as a room page would reject it')
  })
})

// Criterion 5666b13b — the exact waiting workflow only, never ambient command or chat.
describe('exact targeting and non-authority', () => {
  it('accepts this connection and source session, and only those', () => {
    assert.equal(validateInteractionEvent(event(), {
      connectionId: CONNECTION, sessionId: SESSION,
    }).ok, true)

    const sibling = validateInteractionEvent(event({ origin_connection_id: SIBLING }), {
      connectionId: CONNECTION, sessionId: SESSION,
    })
    assert.equal(sibling.ok, false)
    assert.match(sibling.error, /exact connection/)

    const foreign = validateInteractionEvent(event({ source_session_id: OTHER_SESSION }), {
      connectionId: CONNECTION, sessionId: SESSION,
    })
    assert.equal(foreign.ok, false)
    assert.match(foreign.error, /source session/)

    // A replacement connection is a different connection: it inherits nothing.
    assert.equal(validateInteractionEvent(event(), {
      connectionId: SIBLING, sessionId: SESSION,
    }).ok, false)
  })

  it('rejects malformed and unsupported payloads before any host effect', () => {
    for (const [candidate, pattern] of [
      [{}, /exactly match/],
      [event({ version: 2 }), /version/],
      [event({ kind: 'devspec.owner_message' }), /kind/],
      [event({ response_kind: 'poll' }), /response_kind/],
      [event({ answer: '  ' }), /empty|bound/],
      [event({ answer: 'x'.repeat(201) }), /bound/],
      [event({ response_kind: 'multi_select', answer: [] }), /bounded array/],
      [event({ response_kind: 'multi_select', answer: ['a', 'a'] }), /distinct/],
      [event({ answered_at: 'later' }), /answered_at/],
      [{ ...event(), extra: 1 }, /exactly match/],
    ]) {
      const result = validateInteractionEvent(candidate, {
        connectionId: CONNECTION, sessionId: SESSION,
      })
      assert.equal(result.ok, false)
      assert.match(result.error, pattern)
    }
  })

  it('wakes as its own non-authoritative event, never as a command', () => {
    const [answer] = buildInteractionAnswerEvents(record(), { inboxFile: '/tmp/inbox' })
    assert.equal(answer.type, 'question_answer')
    assert.equal(answer.authoritative, false)
    assert.equal(answer.executable, false)
    assert.equal(answer.authority, 'mechanical_response_only')
    assert.equal(answer.authoritative_source, INTERACTION_EVENT_CONTRACT_URI)
    assert.match(answer.note, /not a command/)
    assert.match(answer.note, /manage-question respond/)
    const encoded = JSON.stringify(buildInteractionAnswerEvents(record()))
    assert.doesNotMatch(encoded, /owner_message|automation|project_scope|command_turn/)
  })

  it('keeps the answer event inside the pattern Cursor is told to notify on', async () => {
    // The whole chain is worthless if Cursor is never told to notify: this event type
    // and REMOTE_WAKE_NOTIFY_PATTERN must move together or the room reads Live and
    // is deaf.
    const { REMOTE_WAKE_NOTIFY_PATTERN } = await import('../../scripts/launch-cli-session.mjs')
    const [answer] = buildInteractionAnswerEvents(record())
    assert.ok(REMOTE_WAKE_NOTIFY_PATTERN.split('|').includes(answer.type))
  })

  it('lets the host follow wake on a delivered record and nothing else', () => {
    const lines = [
      JSON.stringify(record()),
      JSON.stringify(record({ connection_id: SIBLING })),
      JSON.stringify(record({ event: event({ origin_connection_id: SIBLING }) })),
      JSON.stringify(record({ disposition: 'terminal_generation' })),
      JSON.stringify(record({ attempt_id: null })),
      JSON.stringify(record({ session_id: OTHER_SESSION })),
    ]
    const batches = parseWakeBatches(lines, { canonicalOnly: true, connectionId: CONNECTION })
    assert.deepEqual(batches.map((b) => b.type), [INTERACTION_ANSWER_RECORD_TYPE])
    // Without a connection to check against, an answer record can never wake anyone.
    assert.deepEqual(parseWakeBatches(lines, { canonicalOnly: true }), [])
    assert.equal(validateInteractionAnswerRecord(record(), CONNECTION), true)
  })
})

// Criterion 7ad8dc8f — dedupe and ACK ordering survive crash/redelivery.
describe('durable application through Cursor own acceptance ledger', () => {
  it('keys acceptance on the event, not the claim, so a redelivery is recognised', () => {
    assert.equal(interactionAcceptanceKey(event()), `interaction:${EVENT}`)
    assert.equal(
      interactionAcceptanceKey(event({ claim_token: '60000000-0000-4000-8000-0000000000ff' })),
      `interaction:${EVENT}`,
      'a fresh claim token on the same answer must collide with the stored key',
    )
  })

  it('applies only the start outcomes the contract permits', () => {
    assert.deepEqual(classifyContinuationStart({ outcome: 'started', attempt_id: ATTEMPT }), {
      action: 'apply', outcome: 'started', attemptId: ATTEMPT,
    })
    assert.equal(classifyContinuationStart({ outcome: 'already_acked' }).action, 'settle')
    assert.equal(classifyContinuationStart({ outcome: 'terminal_same_claim' }).action, 'settle')
    for (const outcome of [
      'blocked_by_activity', 'blocked_by_attachment', 'stale_generation',
      'recovery_requires_reclaim', 'source_session_unavailable',
    ]) {
      assert.equal(classifyContinuationStart({ outcome }).action, 'wait', outcome)
    }
    // Fails closed: unknown, attempt-less and absent results all wait.
    assert.equal(classifyContinuationStart({ outcome: 'invented' }).action, 'wait')
    assert.equal(classifyContinuationStart({ outcome: 'started' }).action, 'wait')
    assert.equal(classifyContinuationStart(null).action, 'wait')
  })

  it('checks the ledger before the start, and persists before it acknowledges', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    const apply = poll.slice(poll.indexOf('async function applyInteractionEvent'))
    const dedupe = apply.indexOf('hasAcceptedKey(')
    const start = apply.indexOf("name: 'report_pickup'")
    const persist = apply.indexOf('appendAcceptedJsonl(')
    const ack = apply.lastIndexOf('pendingInteractionAck = {')
    assert.ok(dedupe > -1 && start > dedupe,
      'opening an attempt for an already-durable answer is itself a duplicate host effect')
    assert.ok(persist > start, 'persistence follows the continuation start')
    assert.ok(ack > persist, 'the ACK follows durable persistence')
    // The release lives in its own helper above applyInteractionEvent.
    assert.match(poll, /interaction_pre_persistence_failure: true/)
    assert.match(apply, /releaseUnappliedInteraction\(event, decision\.attemptId\)/)
  })
})

// Criterion 8e731b9e — the plugin-owned trail and hung-turn recovery stay intact.
describe('existing Cursor mechanics are left alone', () => {
  it('lets only the exact writer touch an open interaction attempt', () => {
    const held = continuation()
    assert.deepEqual(interactionActivityPlan({ verb: 'keepalive', continuation: held }),
      { kind: 'exact_keepalive' })
    assert.equal(interactionActivityPlan({ verb: 'pickup', continuation: held }).kind, 'suppress')
    assert.equal(interactionActivityPlan({ verb: 'complete', continuation: held }).kind, 'suppress')
    // With nothing open, Cursor's ordinary turn verbs are untouched.
    assert.deepEqual(interactionActivityPlan({ verb: 'complete', continuation: null }),
      { kind: 'generic', verb: 'complete' })
  })

  it('holds turn-end completion until the answer reached the chat', () => {
    assert.equal(continuationDelivered(continuation(), 399), false)
    assert.equal(continuationDelivered(continuation(), 400), true)
    assert.equal(continuationDelivered(continuation({ wake_offset_after: null }), 9_999), false)
    assert.equal(turnEndInteractionDecision({ continuation: null }).action, 'none')
    assert.equal(turnEndInteractionDecision({
      continuation: continuation(), wakeFileBytes: 10,
    }).action, 'hold')
    assert.equal(turnEndInteractionDecision({
      continuation: continuation(), wakeFileBytes: 4_000,
    }).action, 'complete')
  })

  it('survives a detached moment and fails closed on another session or connection', () => {
    assert.deepEqual(activeContinuation(continuation(), {
      connectionId: CONNECTION, sessionId: SESSION,
    }), continuation())
    // Detached: still held, so a same-row reattach resumes it.
    assert.deepEqual(activeContinuation(continuation(), {
      connectionId: CONNECTION, sessionId: null,
    }), continuation())
    assert.equal(activeContinuation(continuation(), {
      connectionId: CONNECTION, sessionId: OTHER_SESSION,
    }), null)
    assert.equal(activeContinuation(continuation(), {
      connectionId: SIBLING, sessionId: SESSION,
    }), null)
    assert.equal(activeContinuation(continuation({ attempt_id: 'no' }), {
      connectionId: CONNECTION, sessionId: SESSION,
    }), null)
  })

  it('leaves the work trail and hung-turn recovery paths in place', () => {
    const poll = source('hooks/scripts/devspec-remote-poll.mjs')
    const mirror = source('hooks/scripts/mirror-turn.mjs')
    // The trail seed, the CLI trail watch and the force-complete-and-inject recovery
    // are Cursor's own mechanics; the answer lane must not have displaced them.
    assert.match(poll, /seedWorkTrailForConnection/)
    assert.match(poll, /ensureCliTrailWatch/)
    assert.match(poll, /shouldForceCompleteAndInject/)
    assert.match(mirror, /clearTrailState/)
  })
})

describe('question bridge', () => {
  it('describes only the question tool and takes no identity argument', () => {
    const described = describeManageQuestionBridge()
    assert.equal(described.tool, 'manage_directed_question')
    assert.equal(described.contract, INTERACTION_EVENT_CONTRACT_URI)
    assert.match(described.usage, /Never pass connection, capability or identity arguments/)
    assert.doesNotMatch(JSON.stringify(described), /poll_connection|heartbeat_connection/)
    // The high bar travels with the tool description, not just the docs.
    assert.match(described.description, /never a way to hand judgement work back/)
  })

  it('guards the question payload the way the server does', () => {
    const create = {
      action: 'create',
      client_request_id: EVENT,
      response_kind: 'single_select',
      prompt: 'Which one?',
      options: ['A', 'B'],
      allow_custom: true,
    }
    assert.equal(validateManageQuestionInput(create), null)
    assert.match(validateManageQuestionInput({ ...create, client_request_id: 'x' }), /client_request_id/)
    assert.match(validateManageQuestionInput({ ...create, options: ['A'] }), /two options/)
    assert.match(validateManageQuestionInput({ ...create, options: ['A', 'A'] }), /distinct/)
    assert.match(validateManageQuestionInput({ ...create, prompt: ' ' }), /non-empty prompt/)
    assert.equal(validateManageQuestionInput({
      action: 'create', client_request_id: EVENT, response_kind: 'text', prompt: 'Why?',
    }), null)
    assert.match(validateManageQuestionInput({
      action: 'create', client_request_id: EVENT, response_kind: 'text', prompt: 'Why?',
      options: ['A', 'B'],
    }), /no options/)
    assert.equal(validateManageQuestionInput({ action: 'list' }), null)
    assert.match(validateManageQuestionInput({ action: 'cancel', question_id: QUESTION }), /expected_revision/)
    assert.equal(validateManageQuestionInput({
      action: 'cancel', question_id: QUESTION, expected_revision: 2,
    }), null)
    // Caller identity is never an argument here.
    for (const forged of ['connection_id', 'origin_connection_id', 'capability', 'token']) {
      assert.match(validateManageQuestionInput({ action: 'list', [forged]: 'x' }), /unknown or identity-bearing/)
    }
  })

  it('completes the exact attempt in the same request as the reply', () => {
    assert.deepEqual(respondArguments({
      connectionId: CONNECTION,
      continuation: continuation(),
      message: 'Done.',
      agent: 'Cursor',
    }), {
      connection_id: CONNECTION,
      message: 'Done.',
      agent_name: 'Cursor',
      attempt_id: ATTEMPT,
      command_turn_unbound: true,
      complete_turn: true,
      interaction_event_id: EVENT,
      interaction_response_id: RESPONSE,
      interaction_claim_token: CLAIM,
    })
    assert.deepEqual(continuationIdentity(continuation()), {
      interaction_event_id: EVENT,
      interaction_response_id: RESPONSE,
      interaction_claim_token: CLAIM,
    })
  })
})

describe('answer rendering', () => {
  it('summarises every response kind without losing the verbatim answer', () => {
    assert.equal(answerSummary(event({ response_kind: 'text', answer: 'the second one' })), 'the second one')
    assert.equal(answerSummary(event()), 'Ship it')
    assert.equal(answerSummary(event({ response_kind: 'multi_select', answer: ['a', 'b'] })), 'a, b')
    const [delivered] = buildInteractionAnswerEvents(
      record({ event: event({ response_kind: 'multi_select', answer: ['a', 'b'] }) }),
    )
    assert.deepEqual(delivered.answer, ['a', 'b'])
    assert.equal(delivered.answer_summary, 'a, b')
  })
})

// Criterion 7ccf218b — the real poller, driven against a stub server.
describe('poller round trip', () => {
  function stateHome(extra = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-cursor-interaction-'))
    const dir = path.join(home, '.devspec', 'remote-control', 'connections')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${CONNECTION}.json`), JSON.stringify({
      enabled: true,
      connection_id: CONNECTION,
      session_id: SESSION,
      agent_name: 'Cursor',
      token: 'dvs_test_token',
      ingress_version: 1,
      ...extra,
    }), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, `${CONNECTION}.capability.json`), JSON.stringify({
      version: 1,
      connection_id: CONNECTION,
      local_id: 'cursor-chat-test',
      capability: CAPABILITY,
    }), { mode: 0o600 })
    return { home, dir }
  }

  async function stubMcp(handler) {
    const requests = []
    const server = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', async () => {
        const parsed = JSON.parse(body)
        requests.push({ parsed, capability: request.headers['x-devspec-connection-capability'] })
        const result = (await handler(parsed)) ?? { content: [{ type: 'text', text: '{}' }] }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      requests,
      close: () => new Promise((resolve) => server.close(resolve)),
    }
  }

  function pollResponse(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }

  async function drive(handler, { seedInbox = null } = {}) {
    const stub = await stubMcp(handler)
    const { home, dir } = stateHome({ mcp_url: stub.url })
    if (seedInbox) fs.writeFileSync(path.join(dir, `${CONNECTION}.inbox.jsonl`), seedInbox)
    const child = spawn(process.execPath, [
      POLL_SCRIPT, '--connection-id', CONNECTION, '--owner-pid', String(process.pid),
    ], { env: { ...process.env, HOME: home } })
    child.stdout.resume()
    child.stderr.resume()
    return {
      stub,
      dir,
      async waitForAck(timeoutMs = 15_000) {
        const deadline = Date.now() + timeoutMs
        const acks = () => stub.requests.filter(
          (entry) => entry.parsed.params?.arguments?.interaction_event_ack,
        )
        while (acks().length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return acks()
      },
      async cleanup() {
        child.kill('SIGKILL')
        await stub.close()
        fs.rmSync(home, { recursive: true, force: true })
        try {
          const { resolveSpaceFreeWakeFile } = await import('./devspec-wake-file.mjs')
          fs.rmSync(resolveSpaceFreeWakeFile(CONNECTION), { force: true })
        } catch { /* nothing to clean */ }
      },
    }
  }

  it('claims, starts the exact attempt, persists, then acknowledges', async () => {
    let polls = 0
    const run = await drive(async (parsed) => {
      const call = parsed.params ?? {}
      if (call.name === 'poll_connection') {
        polls++
        const first = polls === 1
        if (!first) await new Promise((resolve) => setTimeout(resolve, 150))
        return pollResponse(first
          ? {
              connection_id: CONNECTION,
              session_id: SESSION,
              changed: true,
              interaction_event_version: 1,
              interaction_events: [event()],
              commands: [],
              dispatches: [],
            }
          : {
              connection_id: CONNECTION,
              session_id: SESSION,
              changed: false,
              interaction_event_version: 1,
              interaction_events: [],
            })
      }
      if (call.name === 'report_pickup') {
        return pollResponse({ outcome: 'started', attempt_id: ATTEMPT, phase: 'working' })
      }
      return pollResponse({})
    })
    try {
      const acked = await run.waitForAck()
      const polled = run.stub.requests.filter((e) => e.parsed.params?.name === 'poll_connection')
      const pickups = run.stub.requests.filter((e) => e.parsed.params?.name === 'report_pickup')

      assert.equal(polled[0].parsed.params.arguments.interaction_event_version, 1)
      assert.equal(polled[0].capability, CAPABILITY, 'the claim needs the capability header')
      assert.equal(pickups.length, 1, 'exactly one attempt per answer')
      assert.equal(pickups[0].capability, CAPABILITY)
      assert.deepEqual(pickups[0].parsed.params.arguments, {
        connection_id: CONNECTION,
        interaction_event_version: 1,
        interaction_event_id: EVENT,
        interaction_response_id: RESPONSE,
        interaction_claim_token: CLAIM,
      })
      assert.ok(acked.length >= 1)
      assert.deepEqual(acked[0].parsed.params.arguments.interaction_event_ack, {
        event_id: EVENT,
        response_id: RESPONSE,
        claim_token: CLAIM,
      })

      const inbox = fs.readFileSync(path.join(run.dir, `${CONNECTION}.inbox.jsonl`), 'utf8')
      const written = inbox.trim().split('\n').map((line) => JSON.parse(line))
      assert.deepEqual(written.map((r) => r.type), [INTERACTION_ANSWER_RECORD_TYPE])
      assert.equal(written[0].disposition, DELIVERED)
      assert.equal(written[0].attempt_id, ATTEMPT)
      assert.equal(written[0].acceptance_key, `interaction:${EVENT}`)
      const state = JSON.parse(fs.readFileSync(path.join(run.dir, `${CONNECTION}.json`), 'utf8'))
      assert.equal(state.interaction_continuation.attempt_id, ATTEMPT)
    } finally {
      await run.cleanup()
    }
  })

  it('acknowledges a redelivery after a crash without opening a second attempt', async () => {
    // The crash window: the ledger entry is durable, the ACK never went out. The server
    // redelivers with a FRESH claim token and the host must settle it, not re-run it.
    const redelivered = event({ claim_token: '60000000-0000-4000-8000-0000000000ff' })
    const run = await drive(async (parsed) => {
      const call = parsed.params ?? {}
      if (call.name !== 'poll_connection') return pollResponse({})
      const acking = Boolean(call.arguments.interaction_event_ack)
      if (acking) await new Promise((resolve) => setTimeout(resolve, 150))
      return pollResponse({
        connection_id: CONNECTION,
        session_id: SESSION,
        changed: !acking,
        interaction_event_version: 1,
        interaction_events: acking ? [] : [redelivered],
        commands: [],
        dispatches: [],
      })
    }, {
      seedInbox: JSON.stringify({ ...record(), acceptance_key: `interaction:${EVENT}` }) + '\n',
    })
    try {
      const acked = await run.waitForAck()
      assert.deepEqual(acked[0].parsed.params.arguments.interaction_event_ack, {
        event_id: EVENT,
        response_id: RESPONSE,
        claim_token: redelivered.claim_token,
      })
      assert.equal(
        run.stub.requests.filter((e) => e.parsed.params?.name === 'report_pickup').length,
        0,
        'a redelivered answer must not open another attempt',
      )
      const inbox = fs.readFileSync(path.join(run.dir, `${CONNECTION}.inbox.jsonl`), 'utf8')
      assert.equal(inbox.trim().split('\n').length, 1, 'and must not be applied twice')
    } finally {
      await run.cleanup()
    }
  })
})

describe('Cursor directed-question policy surfaces', () => {
  it('teaches asking and the reply that closes the turn', () => {
    const skill = source('skills/devspec.remote/SKILL.md')
    const doc = source('docs/remote-control/remote-control-cursor.md')
    assert.match(skill, /manage-question/)
    assert.match(skill, /question_answer/)
    assert.match(doc, /question_answer/)
    assert.match(doc, /devspec:\/\/product\/interaction-event-contract/)
  })
})
