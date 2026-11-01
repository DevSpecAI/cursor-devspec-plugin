#!/usr/bin/env node
/**
 * The local room transcript (item 1a4f0246 / a5fe5e8a) and the 1.6.0 wire it is built from.
 *
 * Every page here is a legal remote-ingress 1.6.0 envelope, checked by the real
 * validator before the store sees it, and every assertion is about what ends up in
 * the copy on disk — not about what a function returned.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  canonicalAcceptanceKey,
  emptyCanonicalContextCarry,
  isSessionEventsV1,
  REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
  REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
  REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION,
  REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION,
  validateRemoteIngressEnvelopeV1,
} from './remote-ingress-v1.mjs'
import {
  applyIngressToStore,
  beginDrain,
  completeEmptyDrain,
  createTranscriptStore,
  loadTranscriptStore,
  MAX_REPAIRS_PER_DAY,
  messagesSinceLastReply,
  observeSessionActivity,
  observeSessionEvents,
  persistTranscriptStore,
  sessionActivityView,
  takePendingRedrain,
  transcriptPaths,
  transcriptPollArguments,
  transcriptSummary,
} from './room-transcript.mjs'
import { commandWakeContext, writeRoomState } from './devspec-remote-poll.mjs'
import { buildOwnerMessageEvents, parseWakeBatches } from './devspec-remote-wait.mjs'

const CONN = '10000000-0000-4000-8000-000000000001'
const OTHER_AGENT = '10000000-0000-4000-8000-000000000099'
const OWNER = '20000000-0000-4000-8000-000000000002'
const SESSION = 'a0000000-0000-4000-8000-00000000000a'
const SESSION_2 = 'b0000000-0000-4000-8000-00000000000b'
const RESOURCE = '70000000-0000-4000-8000-000000000007'
const ME_LABEL = 'Cursor · Careful Moth'

const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (n) => new Date(Date.UTC(2026, 8, 24, 8, 0, 0) + n * 1000).toISOString()
const order = (n) => ({ sequence: n, created_at: at(n), message_id: id(n) })
let envelopeCounter = 0
const envelopeId = () => `60000000-0000-4000-8000-${String(++envelopeCounter).padStart(12, '0')}`

function entry(n, { kind = 'human', name = 'Ali Price', tool = null, text = `message ${n}` } = {}) {
  return {
    message_id: id(n),
    order: order(n),
    actor: {
      kind,
      user_id: kind === 'human' ? OWNER : null,
      display_name: name,
      agent_tool: tool,
      model: null,
    },
    source_type:
      kind === 'human'
        ? 'user'
        : kind === 'agent'
          ? 'external_agent'
          : kind === 'ai'
            ? 'assistant'
            : 'system',
    relationship: 'before_window',
    content: text,
    advisory: true,
  }
}

function command(n, { text = `please do ${n}` } = {}) {
  return {
    message_id: id(n),
    order: order(n),
    content: { mode: 'full', body: text, complete: true },
    attachments: [],
    requester: { user_id: OWNER, display_name: 'Ali Price' },
    authority: {
      kind: 'owner',
      mode: 'owner',
      requested_by_user_id: OWNER,
      connection_owner_user_id: OWNER,
      decision_source: 'server',
    },
    project_scope: null,
    addressee: {
      connection_id: CONN,
      agent_name: 'Cursor',
      codename: 'Careful Moth',
      label: ME_LABEL,
    },
    delivery: {
      provenance_ref: '40000000-0000-4000-8000-000000000004',
      turn_id: '50000000-0000-4000-8000-000000000005',
      primary_provenance_ref: '40000000-0000-4000-8000-000000000004',
      is_primary: true,
    },
  }
}

const BUCKET = {
  human: 'human_context',
  agent: 'agent_context',
  ai: 'ai_context',
  system: 'system_context',
}

function page({
  entries = [],
  commands = [],
  described = {},
  room = {},
  window = {},
  history = false,
  extra = {},
} = {}) {
  const context = { human_context: [], agent_context: [], ai_context: [], system_context: [] }
  for (const e of [...entries].sort((a, b) => a.order.sequence - b.order.sequence)) {
    context[BUCKET[e.actor.kind]].push(e)
  }
  const rows = [...commands, ...entries].sort((a, b) => a.order.sequence - b.order.sequence)
  const first = rows[0]?.order ?? null
  const last = rows.at(-1)?.order ?? null
  const live = commands.length > 0
  return {
    kind: 'devspec.remote_ingress',
    schema_version: 1,
    contract_version: REMOTE_INGRESS_ROOM_CONTEXT_CONTRACT_VERSION,
    policy_version: REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
    envelope_id: envelopeId(),
    connection: {
      connection_id: CONN,
      agent_name: 'Cursor',
      codename: 'Careful Moth',
      label: ME_LABEL,
    },
    wake: history
      ? { kind: 'history_reseed', active: false, reason_id: 'history' }
      : live
        ? { kind: 'conversational_command', active: true, reason_id: 'command_available' }
        : { kind: 'advisory_update', active: false, reason_id: 'advisory_context_changed' },
    delivery_state: history ? 'reseed' : 'live',
    command_message_ids: commands.map((c) => c.message_id),
    commands,
    control: null,
    context,
    system_notices: [],
    room_context: {
      version: 1,
      messages: rows.map((row) => ({
        message_id: row.message_id,
        addressee: { kind: 'room' },
        attachments: [],
        state: 'final',
        ...(commands.includes(row)
          ? { addressee: { kind: 'connection', connection_id: CONN, label: ME_LABEL } }
          : {}),
        ...(described[row.message_id] ?? {}),
      })),
      coverage: room.coverage === undefined ? null : room.coverage,
      ...(room.open_check !== undefined ? { open_check: room.open_check } : {}),
      ...(room.deletions !== undefined ? { deletions: room.deletions } : {}),
    },
    window: {
      policy_version: REMOTE_INGRESS_ROOM_CONTEXT_POLICY_VERSION,
      returned: rows.length,
      total_known: null,
      source_window: { start: first, end: last },
      truncated: false,
      has_more: false,
      next_cursor: null,
      fetch_id: null,
      omission_reason: null,
      ...window,
    },
    ...extra,
  }
}

function coverage(through, eligible, deleted = 0, open = []) {
  return {
    through: order(through),
    eligible_count: eligible,
    deleted_count: deleted,
    open_message_ids: open,
  }
}

function apply(store, ingress, options = {}) {
  const err = validateRemoteIngressEnvelopeV1(ingress, CONN)
  assert.equal(err, null, err ?? undefined)
  return applyIngressToStore(store, ingress, { sessionId: SESSION, ...options })
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'room-transcript-'))
}

function linesOnDisk(dir, sessionId = SESSION) {
  const text = fs.readFileSync(transcriptPaths(CONN, sessionId, dir).transcript, 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('remote-ingress 1.6.0 on the wire', () => {
  it('accepts a legal room-context page and keeps 1.5.0 exactly as strict as before', () => {
    const legal = page({
      entries: [entry(1)],
      commands: [command(2)],
      room: { coverage: coverage(2, 2) },
    })
    assert.equal(validateRemoteIngressEnvelopeV1(legal, CONN), null)
    const asOld = {
      ...legal,
      contract_version: REMOTE_INGRESS_SENDER_STYLE_CONTRACT_VERSION,
      policy_version: REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION,
      window: { ...legal.window, policy_version: REMOTE_INGRESS_SENDER_STYLE_POLICY_VERSION },
    }
    assert.notEqual(validateRemoteIngressEnvelopeV1(asOld, CONN), null)
    const { room_context: _gone, ...withoutRoom } = legal
    assert.notEqual(validateRemoteIngressEnvelopeV1(withoutRoom, CONN), null)
  })

  it('rejects pages that would poison a copy', () => {
    const bad = [
      page({ commands: [command(1)], described: { [id(1)]: { state: 'deleted' } } }),
      page({
        entries: [entry(1)],
        described: { [id(1)]: { state: 'in_progress' } },
        room: { coverage: coverage(1, 1) },
      }),
      page({
        entries: [entry(1)],
        room: { coverage: coverage(1, 1), open_check: [{ message_id: id(9), state: 'final' }] },
      }),
      page({
        entries: [entry(1)],
        room: {
          deletions: {
            message_ids: [id(5)],
            truncated: true,
            total: 900,
            seen: { through: { deleted_at: at(5), message_id: id(5) }, total: 900 },
          },
        },
      }),
      page({
        entries: [entry(1)],
        extra: {
          session_activity: {
            version: 1,
            advisory: true,
            status: 'unavailable',
            as_of: at(1),
            revision: null,
            entries: [
              {
                kind: 'memory',
                id: id(7),
                title: 'x',
                status: null,
                relation: 'produced',
                creator: null,
              },
            ],
            truncated: false,
          },
        },
      }),
    ]
    for (const ingress of bad) {
      assert.notEqual(validateRemoteIngressEnvelopeV1(ingress, CONN), null)
    }
  })
})

describe('a room with more than 60 messages', () => {
  it('is drained to the start, verified against coverage, and keeps merging newer arrivals', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    let result = apply(
      store,
      page({
        entries: range(41, 100).map((n) => entry(n)),
        history: true,
        room: { coverage: coverage(100, 100) },
        window: { has_more: true, next_cursor: 'older-1' },
      }),
      { drainPoll: true },
    )
    assert.equal(result.verdict, 'unverified')
    assert.equal(takePendingRedrain(store), null)
    result = apply(
      store,
      page({
        entries: range(1, 40).map((n) => entry(n)),
        history: true,
        room: { coverage: coverage(40, 40) },
      }),
      { drainPoll: true },
    )
    assert.equal(result.verdict, 'consistent')
    result = apply(
      store,
      page({
        entries: range(101, 103).map((n) => entry(n)),
        room: { coverage: coverage(103, 103) },
      }),
    )
    assert.equal(result.verdict, 'consistent')
    persistTranscriptStore(store, { dir })
    const lines = linesOnDisk(dir)
    assert.equal(lines.length, 103)
    assert.deepEqual(
      lines.map((line) => line.seq),
      range(1, 103),
    )
    assert.equal(new Set(lines.map((line) => line.message_id)).size, 103)
    assert.equal(transcriptSummary(store, { dir }).status, 'complete')
    assert.equal(transcriptSummary(store, { dir }).complete, true)
  })

  it('is not declared complete while the drain is unfinished, and an empty room completes at once', () => {
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    apply(
      store,
      page({
        entries: [entry(61)],
        history: true,
        room: { coverage: coverage(61, 61) },
        window: { has_more: true, next_cursor: 'older' },
      }),
      { drainPoll: true },
    )
    assert.equal(transcriptSummary(store).status, 'backfilling')
    const empty = createTranscriptStore(CONN, SESSION)
    beginDrain(empty)
    completeEmptyDrain(empty)
    assert.equal(empty.backfill.complete, true)
  })
})

describe("another agent's screenshot", () => {
  it('keeps who it was for and the file reference, and downloads nothing', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    const shot = {
      materialization: 'metadata',
      filename: 'screen.png',
      mime_type: 'image/png',
      type: 'image',
      size_bytes: 2048,
      resource_id: RESOURCE,
    }
    apply(
      store,
      page({
        entries: [entry(1, { text: 'Here is the screenshot' })],
        described: {
          [id(1)]: {
            addressee: { kind: 'connection', connection_id: OTHER_AGENT, label: 'Pi · Racing Gecko' },
            attachments: [shot],
          },
        },
      }),
    )
    persistTranscriptStore(store, { dir })
    const [line] = linesOnDisk(dir)
    assert.equal(line.to, 'Pi · Racing Gecko')
    assert.deepEqual(line.attachments, [
      { filename: 'screen.png', mime_type: 'image/png', size_bytes: 2048, resource_id: RESOURCE },
    ])
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      [
        path.basename(transcriptPaths(CONN, SESSION, dir).state),
        path.basename(transcriptPaths(CONN, SESSION, dir).transcript),
      ].sort(),
    )
  })
})

describe('poller write ordering and crash recovery', () => {
  it('writes transcript and room state before delivering owner_messages in consumePollResult', () => {
    const source = fs.readFileSync(new URL('./devspec-remote-poll.mjs', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('function consumePollResult('))
    const at = (needle) => {
      const index = body.indexOf(needle)
      assert.notEqual(index, -1, `${needle} not found in consumePollResult`)
      return index
    }
    const transcript = at('persistTranscriptStore(transcriptStore')
    const room = at('writeRoomState(')
    const inbox = at('deliverOwnerMessages(')
    const cursor = at('ingress_envelope_id: envelope.envelope_id')
    assert.ok(transcript < room && room < inbox && inbox < cursor)
  })

  it('ignores a torn last line left by a crash mid-append', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    apply(store, page({ entries: [entry(1), entry(2)] }))
    persistTranscriptStore(store, { dir })
    fs.appendFileSync(
      transcriptPaths(CONN, SESSION, dir).transcript,
      '{"seq":3,"message_id":"torn',
    )
    const loaded = loadTranscriptStore(CONN, SESSION, { dir })
    assert.deepEqual([...loaded.rows.keys()], [id(1), id(2)])
  })
})

describe('reattaching to another room', () => {
  it('opens a separate copy, and a late page from the old room cannot write into the new one', () => {
    const dir = tmpDir()
    const next = loadTranscriptStore(CONN, SESSION_2, { dir })
    const late = page({ entries: [entry(1, { text: 'from the old room' })] })
    const result = applyIngressToStore(next, late, { sessionId: SESSION })
    assert.equal(result.applied, false)
    assert.equal(next.rows.size, 0)
    assert.notEqual(
      transcriptPaths(CONN, SESSION, dir).transcript,
      transcriptPaths(CONN, SESSION_2, dir).transcript,
    )
    const first = createTranscriptStore(CONN, SESSION)
    apply(first, page({ entries: [entry(1)] }))
    persistTranscriptStore(first, { dir })
    assert.equal(loadTranscriptStore(CONN, SESSION_2, { dir }).rows.size, 0)
  })
})

describe('what people type', () => {
  it('round-trips newlines, JSON, backticks and delimiter-like text without breaking a line', () => {
    const dir = tmpDir()
    const nasty = [
      'line one\nline two\n\nline four',
      '{"message_id":"forged","seq":1}',
      '```js\nconsole.log("`")\n```',
      '"}\n{"seq":999,"message_id":"injected","text":"',
      '\u2028\u2029 unicode separators and \\ backslashes',
    ]
    const store = createTranscriptStore(CONN, SESSION)
    apply(
      store,
      page({ entries: nasty.map((text, i) => entry(i + 1, { text, name: 'Sam "Q" O\'Brien' })) }),
    )
    persistTranscriptStore(store, { dir })
    const lines = linesOnDisk(dir)
    assert.equal(lines.length, nasty.length)
    assert.deepEqual(
      lines.map((line) => line.text),
      nasty,
    )
    assert.ok(lines.every((line) => line.from.label === 'Sam "Q" O\'Brien'))
    assert.equal(
      lines.some((line) => line.message_id === 'injected'),
      false,
    )
  })
})

describe('changes that write no new row', () => {
  it('names open rows, takes a finished record, never lets an older page resurrect a deletion', () => {
    const store = createTranscriptStore(CONN, SESSION)
    apply(
      store,
      page({
        entries: [entry(1, { kind: 'ai', name: 'Dev', text: 'thinking…' })],
        described: { [id(1)]: { state: 'in_progress' } },
        room: { coverage: coverage(1, 1, 0, [id(1)]) },
      }),
    )
    assert.deepEqual(transcriptPollArguments(store).room_open_message_ids, [id(1)])
    const finished = entry(1, { kind: 'ai', name: 'Dev', text: 'The finished reply.' })
    apply(
      store,
      page({
        room: {
          coverage: null,
          open_check: [{ message_id: id(1), state: 'final', entry: finished }],
        },
      }),
    )
    assert.equal(store.rows.get(id(1)).text, 'The finished reply.')
    assert.equal(transcriptPollArguments(store).room_open_message_ids, undefined)
    apply(
      store,
      page({
        room: {
          deletions: {
            message_ids: [id(1)],
            truncated: false,
            total: 1,
            seen: { through: { deleted_at: at(9), message_id: id(1) }, total: 1 },
          },
        },
      }),
    )
    apply(store, page({ entries: [finished] }))
    assert.equal(store.rows.get(id(1)).state, 'deleted')
    assert.equal(store.rows.get(id(1)).text, null)
    assert.deepEqual(transcriptPollArguments(store).room_deletions_seen, {
      through: { deleted_at: at(9), message_id: id(1) },
      total: 1,
    })
  })

  it('relists deletions when the room holds more than the copy was told about', () => {
    const store = createTranscriptStore(CONN, SESSION)
    apply(store, page({ entries: [entry(1), entry(2)] }))
    const late = apply(
      store,
      page({
        room: {
          deletions: { message_ids: [], truncated: false, total: 1, seen: { through: null, total: 1 } },
        },
      }),
    )
    assert.equal(late.verdict, 'relist_deletions')
    assert.equal(transcriptPollArguments(store).room_deletions_seen, null)
  })
})

describe('the room state file', () => {
  it('says what each section is — present, none, unavailable or not sent — and never prints anything', () => {
    const writes = []
    const printed = []
    const realWrite = process.stdout.write
    process.stdout.write = (chunk) => {
      printed.push(String(chunk))
      return true
    }
    try {
      const store = createTranscriptStore(CONN, SESSION)
      const ingress = page({
        entries: [
          entry(1),
          entry(2, {
            kind: 'agent',
            name: `${ME_LABEL} (Ali Price)`,
            tool: ME_LABEL,
            text: 'my reply',
          }),
          entry(3),
        ],
        extra: {
          session_activity: {
            version: 1,
            advisory: true,
            status: 'unavailable',
            as_of: at(3),
            revision: null,
            entries: [],
            truncated: false,
          },
        },
      })
      apply(store, ingress)
      observeSessionActivity(store, ingress.session_activity)
      persistTranscriptStore(store, { dir: tmpDir() })
      writeRoomState(
        CONN,
        { session_id: SESSION, ingress },
        {},
        {
          write: (_file, value) => writes.push(value),
          transcript: transcriptSummary(store),
          activity: sessionActivityView(store),
        },
      )
    } finally {
      process.stdout.write = realWrite
    }
    assert.deepEqual(printed, [])
    const [doc] = writes
    assert.equal(doc.sections.session_activity, 'unavailable')
    assert.equal(doc.sections.session_polls, 'none_or_unavailable')
    assert.equal(doc.sections.active_session_plans, 'none')
    assert.equal(doc.sections.system_notices, 'none')
    assert.equal(doc.sections.transcript, 'backfilling')
    assert.equal(doc.transcript.complete, false)
    assert.equal(doc.transcript.messages, 3)
    assert.equal(doc.transcript.approx_tokens_is_estimate, true)
    assert.equal(doc.transcript.since_my_last_reply, null)
    assert.equal(doc.transcript.has_my_reply, true)
  })
})

describe('the wake points at the transcript (item 7fe8e3d1)', () => {
  const drained = (entries, commands = []) => {
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    const ingress = page({ entries, commands })
    apply(store, ingress, { drainPoll: true })
    return { store, ingress }
  }
  const mine = (n, text = 'my reply') =>
    entry(n, { kind: 'agent', name: `${ME_LABEL} (Ali Price)`, tool: ME_LABEL, text })

  it('names the transcript and the room file, and leaves counting what is unread to the reader', () => {
    const { store, ingress } = drained(
      [mine(1), ...range(2, 51).map((n) => entry(n))],
      [command(52, { text: 'what do you think?' })],
    )
    const wake = commandWakeContext(store, ingress, { connectionId: CONN, dir: '/tmp/d' })
    assert.equal(Object.hasOwn(wake, 'since_last_reply'), false)
    assert.equal(wake.transcript, transcriptPaths(CONN, SESSION, '/tmp/d').transcript)
    assert.equal(wake.room_state, path.join('/tmp/d', `${CONN}.room.json`))
  })

  it('counts from the start of the room when I have never replied, and skips deleted messages', () => {
    const { store } = drained([entry(1), entry(2), entry(3)])
    assert.equal(messagesSinceLastReply(store, 4), 3)
    apply(store, page({ room: { open_check: [{ message_id: id(2), state: 'deleted' }] } }))
    assert.equal(messagesSinceLastReply(store, 4), 2)
    assert.equal(messagesSinceLastReply(store, 2), 1)
  })

  it('names no transcript for a copy that holds nothing', () => {
    const store = createTranscriptStore(CONN, SESSION)
    const ingress = page({ commands: [command(1)] })
    assert.equal(commandWakeContext(store, ingress, { connectionId: CONN }).transcript, null)
    assert.equal(commandWakeContext(null, ingress, { connectionId: CONN }).transcript, null)
  })

  it('keeps a message far longer than 12,000 characters whole', () => {
    const long = `start ${'x'.repeat(40_000)} end`
    const dir = tmpDir()
    const { store } = drained([entry(1, { text: long }), entry(2)])
    persistTranscriptStore(store, { dir })
    assert.equal(linesOnDisk(dir)[0].text, long)
  })

  it("keeps a delegated command's scope and the server's instruction on its line", () => {
    const delegated = command(1)
    delegated.requester = {
      user_id: '21000000-0000-4000-8000-000000000002',
      display_name: 'Brandon Young',
    }
    delegated.authority = {
      kind: 'delegated',
      mode: 'project',
      requested_by_user_id: '21000000-0000-4000-8000-000000000002',
      connection_owner_user_id: OWNER,
      decision_source: 'server',
    }
    delegated.project_scope = {
      kind: 'devspec_project',
      policy_id: 'delegated_project_v1',
      project_id: '80000000-0000-4000-8000-000000000008',
      instruction: 'Use only the server-selected DevSpec project.',
    }
    const dir = tmpDir()
    const { store } = drained([], [delegated])
    persistTranscriptStore(store, { dir })
    assert.deepEqual(linesOnDisk(dir)[0].delivered_as_command, {
      authority: 'delegated',
      project_scope: {
        project_id: '80000000-0000-4000-8000-000000000008',
        instruction: 'Use only the server-selected DevSpec project.',
      },
    })
  })

  it('never wakes this agent for a message addressed to another agent', () => {
    const dir = tmpDir()
    const forPi = page({
      entries: [entry(1, { text: 'Pi, please redeploy staging' })],
      described: {
        [id(1)]: {
          addressee: { kind: 'connection', connection_id: OTHER_AGENT, label: 'Pi · Racing Gecko' },
        },
      },
    })
    assert.equal(validateRemoteIngressEnvelopeV1(forPi, CONN), null)
    const advisoryRecord = JSON.stringify({
      type: 'advisory_context',
      connection_id: CONN,
      session_id: SESSION,
      ingress: { canonical: true, envelope: forPi },
      context: emptyCanonicalContextCarry(),
    })
    const batches = parseWakeBatches([advisoryRecord], {
      canonicalOnly: true,
      connectionId: CONN,
    })
    assert.deepEqual(batches, [])
    assert.deepEqual(
      batches.flatMap((batch) => buildOwnerMessageEvents(batch)),
      [],
    )
    const store = createTranscriptStore(CONN, SESSION)
    apply(store, forPi)
    persistTranscriptStore(store, { dir })
    const [line] = linesOnDisk(dir)
    assert.equal(line.to, 'Pi · Racing Gecko')
    assert.equal(Object.hasOwn(line, 'delivered_as_command'), false)
    const hijack = page({ commands: [command(2)] })
    hijack.commands[0].addressee = {
      connection_id: OTHER_AGENT,
      agent_name: 'Pi',
      codename: 'Racing Gecko',
      label: 'Pi · Racing Gecko',
    }
    assert.notEqual(validateRemoteIngressEnvelopeV1(hijack, CONN), null)
  })
})

describe('what the session produced and referenced', () => {
  const item = (status, over = {}) => ({
    kind: 'task',
    id: id(500),
    title: 'Detach asks first',
    status,
    relation: 'produced',
    creator: { kind: 'agent', label: 'Pi · Racing Gecko · Ali Price' },
    ...over,
  })
  const list = (entries, status = 'available') => ({
    version: 1,
    advisory: true,
    status,
    as_of: at(1),
    revision: status === 'available' ? `sha256:${'a'.repeat(64)}` : null,
    entries: status === 'available' ? entries : [],
    truncated: false,
  })

  it('is kept as references only, never as a claim about how anything stands now', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    observeSessionActivity(store, list([item('open')]), new Date(at(10)))
    observeSessionActivity(store, list([item('implemented')]), new Date(at(20)))
    observeSessionActivity(store, list([], 'unavailable'), new Date(at(25)))
    let view = sessionActivityView(store)
    assert.match(view.note, /Never how anything stands now/)
    assert.deepEqual(
      view.items.map((entry) => entry.id),
      [id(500)],
    )
    assert.deepEqual(Object.keys(view.items[0]).sort(), [
      'creator',
      'id',
      'kind',
      'relation',
      'title',
    ])
    assert.deepEqual(view.events, [])
    assert.equal(JSON.stringify(view).includes('implemented'), false)
    persistTranscriptStore(store, { dir })
    view = sessionActivityView(loadTranscriptStore(CONN, SESSION, { dir }))
    assert.deepEqual(
      view.items.map((entry) => entry.id),
      [id(500)],
    )
  })

  const events = (list, status = 'available', revision = `sha256:${'e'.repeat(64)}`) => ({
    version: 1,
    advisory: true,
    status,
    as_of: at(50),
    revision: status === 'unavailable' ? null : revision,
    events: status === 'available' ? list : [],
    truncated: false,
  })
  const produced = {
    id: `produced:task:${id(500)}`,
    at: at(10),
    kind: 'task',
    record_id: id(500),
    event: 'produced',
    actor: { kind: 'agent', label: 'Pi · Racing Gecko · Ali Price' },
  }
  const moved = {
    id: 'lifecycle:10000000-0000-4000-8000-000000000777',
    at: at(20),
    kind: 'task',
    record_id: id(500),
    event: 'lifecycle_changed',
    from: 'open',
    to: 'implemented',
  }
  const done = {
    id: 'lifecycle:10000000-0000-4000-8000-000000000778',
    at: at(30),
    kind: 'task',
    record_id: id(500),
    event: 'lifecycle_changed',
    from: 'implemented',
    to: 'done',
  }

  it('keeps the server history of what happened, append-only, with when it happened', () => {
    const dir = tmpDir()
    const store = createTranscriptStore(CONN, SESSION)
    observeSessionActivity(store, list([item('open')]), new Date(at(10)))
    assert.deepEqual(transcriptPollArguments(store).session_events_version, 1)
    assert.equal(transcriptPollArguments(store).session_events_revision, null)
    observeSessionEvents(store, events([produced, moved]), new Date(at(21)))
    assert.equal(transcriptPollArguments(store).session_events_revision, `sha256:${'e'.repeat(64)}`)
    observeSessionEvents(store, events([], 'unchanged'), new Date(at(22)))
    observeSessionEvents(store, events([], 'unavailable'), new Date(at(23)))
    assert.equal(sessionActivityView(store).events_readable, false)
    observeSessionEvents(
      store,
      events([{ ...moved, to: 'dismissed' }, done], 'available', `sha256:${'f'.repeat(64)}`),
      new Date(at(31)),
    )
    const view = sessionActivityView(store)
    assert.equal(view.events_readable, true)
    assert.deepEqual(view.events, [produced, moved, done])
    assert.deepEqual(
      view.events.map((event) => event.at),
      [at(10), at(20), at(30)],
    )
    persistTranscriptStore(store, { dir })
    const reloaded = loadTranscriptStore(CONN, SESSION, { dir })
    assert.deepEqual(sessionActivityView(reloaded).events, [produced, moved, done])
    assert.equal(
      transcriptPollArguments(reloaded).session_events_revision,
      `sha256:${'f'.repeat(64)}`,
    )
  })

  it('validates the section it keeps, and refuses a malformed one', () => {
    assert.equal(isSessionEventsV1(events([produced, moved, done])), true)
    assert.equal(isSessionEventsV1(events([], 'unchanged')), true)
    assert.equal(isSessionEventsV1(events([], 'unavailable')), true)
    assert.equal(isSessionEventsV1(events([produced, produced])), false)
    assert.equal(isSessionEventsV1(events([{ ...moved, kind: 'memory' }])), false)
    assert.equal(isSessionEventsV1(events([{ ...produced, status: 'open' }])), false)
    assert.equal(isSessionEventsV1({ ...events([], 'unchanged'), events: [produced] }), false)
    assert.equal(
      isSessionEventsV1({ ...events([], 'unavailable'), revision: `sha256:${'e'.repeat(64)}` }),
      false,
    )
  })
})

describe('when the copy disagrees with the room', () => {
  function completeCopy(n) {
    const store = createTranscriptStore(CONN, SESSION)
    beginDrain(store)
    apply(
      store,
      page({
        entries: range(1, n).map((i) => entry(i)),
        history: true,
        room: { coverage: coverage(n, n) },
      }),
      { drainPoll: true },
    )
    return store
  }

  it('detects a missing row after a complete drain and asks, within a daily budget, to re-read', () => {
    const store = completeCopy(5)
    const result = apply(store, page({ entries: [entry(7)], room: { coverage: coverage(7, 7) } }))
    assert.equal(result.verdict, 'redrain')
    assert.equal(takePendingRedrain(store), 'mismatch')
    for (let i = 1; i < MAX_REPAIRS_PER_DAY; i++) {
      apply(store, page({ entries: [entry(7)], room: { coverage: coverage(7, 7) } }))
      assert.equal(takePendingRedrain(store), 'mismatch')
    }
    apply(store, page({ entries: [entry(7)], room: { coverage: coverage(7, 7) } }))
    assert.equal(takePendingRedrain(store), null)
    assert.equal(transcriptSummary(store).status, 'mismatch')
  })

  it('repairs by re-draining: the missing row is filled and a row the room no longer has is dropped', () => {
    const store = completeCopy(5)
    apply(store, page({ entries: [entry(4, { text: 'stray' })] }))
    store.rows.set(id(99), { ...store.rows.get(id(4)), seq: 3.5, message_id: id(99) })
    beginDrain(store)
    const result = apply(
      store,
      page({
        entries: [...range(1, 5), 6].map((i) => entry(i)),
        history: true,
        room: { coverage: coverage(6, 6) },
      }),
      { drainPoll: true },
    )
    assert.equal(result.verdict, 'consistent')
    assert.equal(store.rows.has(id(99)), false)
    assert.equal(store.rows.has(id(6)), true)
  })
})
