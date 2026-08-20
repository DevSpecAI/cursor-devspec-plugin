#!/usr/bin/env node
/**
 * Unit tests for devspec-remote-wait's owner-command batch parsing and event
 * building. Run: node --test hooks/scripts/devspec-remote-wait.test.mjs
 *
 * Regression coverage for item b9fb49a9: an inbox batch's session_id (already
 * stamped by the poller's appendInbox) must survive into both the per-message
 * owner_message event and the summary wake event, so the agent consuming this
 * stream always has a live, event-sourced session id — never a value it must
 * cache and risk going stale after a server-side session reattach.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  parseOwnerBatches,
  buildOwnerMessageEvents,
  describeAttachment,
  materialiseAttachments,
  MAX_INLINE_ATTACHMENT_CHARS,
  applyArmTurnSemantics,
  armEndsTurn,
  clearTurnMarker,
  notifyWorkingEnded,
  offsetAfterAdvisoryHistory,
  resolveFromEndOffset,
  resolveWatchOffset,
  consumeInboxSlice,
  resolveConnectionsDir,
  resolveOwnerPid,
} from './devspec-remote-wait.mjs'

const CANONICAL_CONNECTION = '11111111-1111-4111-8111-111111111111'
function canonicalCommand(messageId = '33333333-3333-4333-8333-333333333333') {
  return {
    message_id: messageId,
    content: { mode: 'full', body: 'full command body', complete: true },
    attachments: [{
      materialization: 'metadata', filename: 'design.png', mime_type: 'image/png', type: 'image',
      size_bytes: 42, resource_id: '88888888-8888-4888-8888-888888888888',
    }],
    requester: { user_id: '55555555-5555-4555-8555-555555555555', display_name: 'Owner' },
    authority: { kind: 'owner', decision_source: 'server' },
    addressee: { connection_id: CANONICAL_CONNECTION },
    delivery: { turn_id: '77777777-7777-4777-8777-777777777777' },
  }
}
function canonicalBatch(message = canonicalCommand(), over = {}) {
  return {
    type: 'owner_messages', connection_id: CANONICAL_CONNECTION, session_id: 'sess-live',
    next_after_message_id: 'opaque-cursor', messages: [message],
    ingress: {
      canonical: true, schema_version: 1, envelope_id: '22222222-2222-4222-8222-222222222222',
      window: { has_more: true, next_cursor: 'continuation' },
    },
    ...over,
  }
}

describe('parseOwnerBatches', () => {
  it('keeps only owner_messages lines with a non-empty messages array', () => {
    const lines = [
      JSON.stringify({ type: 'owner_messages', session_id: 's1', messages: [{ id: 'm1' }] }),
      JSON.stringify({ type: 'advisory_context', session_id: 's1', messages: [{ id: 'a1' }] }),
      JSON.stringify({ type: 'owner_messages', session_id: 's2', messages: [] }),
      'not json',
    ]
    const batches = parseOwnerBatches(lines)
    assert.equal(batches.length, 1)
    assert.equal(batches[0].session_id, 's1')
  })
})

describe('canonical one-command-turn wake', () => {
  it('renders every typed context bucket as actor-labelled advisory data', () => {
    const entry = (kind, name) => ({
      message_id: `${kind}-message`, content: `${kind} context`, advisory: true,
      actor: { kind, display_name: name, agent_tool: kind === 'human' ? null : 'tool', model: null },
    })
    const typed = {
      human_context: [entry('human', 'Owner')], agent_context: [entry('agent', 'Teammate')],
      ai_context: [entry('ai', 'Dev')], system_context: [entry('system', 'DevSpec')],
    }
    const events = buildOwnerMessageEvents(canonicalBatch(undefined, {
      context: { typed, windows: [{ next_cursor: 'continuation' }], locally_omitted: 3 },
    }))
    const context = events[0]
    assert.equal(context.type, 'model_context')
    assert.equal(context.advisory, true)
    assert.equal(context.locally_omitted, 3)
    for (const bucket of Object.keys(typed)) assert.match(context.typed[bucket][0].actor_label, /:/)
    assert.equal(events.at(-1).turn_id, '77777777-7777-4777-8777-777777777777')
  })

  it('keeps metadata attachments as stable resource references without filesystem recovery', () => {
    const events = buildOwnerMessageEvents(canonicalBatch(), { writeFile: () => { throw new Error('must not write') } })
    const attachment = events.find((event) => event.type === 'owner_message').message.attachments[0]
    assert.equal(attachment.delivery, 'resource')
    assert.equal(attachment.resource_id, '88888888-8888-4888-8888-888888888888')
  })

  it('dequeues only the first canonical command turn and leaves the queued turn for reconnect/re-arm', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-turn-queue-'))
    const file = path.join(dir, 'inbox.jsonl')
    try {
      const first = JSON.stringify(canonicalBatch()) + '\n'
      const secondMessage = canonicalCommand('99999999-9999-4999-8999-999999999999')
      const second = JSON.stringify(canonicalBatch(secondMessage)) + '\n'
      fs.writeFileSync(file, first + second)
      const slice = consumeInboxSlice(file, 0, { canonicalOnly: true, oneCommandTurn: true })
      assert.equal(slice.batches.length, 1)
      assert.equal(slice.batches[0].messages[0].message_id, canonicalCommand().message_id)
      assert.equal(slice.newOffset, Buffer.byteLength(first, 'utf8'))
      const queued = consumeInboxSlice(file, slice.newOffset, { canonicalOnly: true, oneCommandTurn: true })
      assert.equal(queued.batches[0].messages[0].message_id, secondMessage.message_id)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildOwnerMessageEvents (item b9fb49a9 — session id must not be dropped)', () => {
  it('stamps the batch session_id on every owner_message event', () => {
    const batch = {
      session_id: 'sess-live',
      next_after_message_id: 'msg-2',
      messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
    }
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    const ownerEvents = events.filter((e) => e.type === 'owner_message')
    assert.equal(ownerEvents.length, 2)
    for (const e of ownerEvents) assert.equal(e.session_id, 'sess-live')
    assert.deepEqual(
      ownerEvents.map((e) => e.message.id),
      ['msg-1', 'msg-2'],
    )
  })

  it('stamps the batch session_id on the trailing wake event too', () => {
    const batch = { session_id: 'sess-live', messages: [{ id: 'msg-1' }] }
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    const wake = events.find((e) => e.type === 'wake')
    assert.equal(wake.session_id, 'sess-live')
    assert.equal(wake.count, 1)
    assert.equal(wake.inbox, '/tmp/inbox.jsonl')
  })

  it('emits session_id: null for a sessionless dispatch batch rather than throwing', () => {
    const batch = { messages: [{ id: 'msg-1' }] } // no session_id field at all
    const events = buildOwnerMessageEvents(batch, { inboxFile: '/tmp/inbox.jsonl' })
    assert.equal(events.find((e) => e.type === 'owner_message').session_id, null)
    assert.equal(events.find((e) => e.type === 'wake').session_id, null)
  })

  it('event order with no context is every owner_message first, then one trailing wake', () => {
    const batch = { session_id: 's', messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    const events = buildOwnerMessageEvents(batch, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['owner_message', 'owner_message', 'owner_message', 'wake'],
    )
  })
})

/**
 * THE INJECTION FIX (item 27058153) — the room must arrive in the same payload as the
 * command. This is the regression test for the live failure that started the work:
 * Brandon posted "1", "2", "3" untargeted, then asked a targeted "what's the next
 * number?", and Claude Code could not answer despite holding all three on disk,
 * because the wake payload contained the command alone.
 */
describe('buildOwnerMessageEvents — packaged room context', () => {
  const oneTwoThree = {
    session_id: 'sess-live',
    next_after_message_id: 'm4',
    context: {
      owner_ambient: [
        { id: 'm1', content: '1', author: { kind: 'human', name: 'Brandon' } },
        { id: 'm2', content: '2', author: { kind: 'human', name: 'Brandon' } },
        { id: 'm3', content: '3', author: { kind: 'human', name: 'Brandon' } },
      ],
      room_context: [],
      dropped: 0,
    },
    messages: [{ id: 'm4', content: "What's the next number in the sequence?" }],
  }

  it('answers the 1-2-3 case from the wake payload alone — no side-file read', () => {
    const events = buildOwnerMessageEvents(oneTwoThree, { inboxFile: '/tmp/inbox.jsonl' })
    const ctx = events.find((e) => e.type === 'room_context')
    assert.ok(ctx, 'the wake payload must carry the room')
    assert.deepEqual(
      ctx.owner_ambient.map((m) => m.content),
      ['1', '2', '3'],
    )
    // Everything needed to answer "4" is in this one stdout payload.
    const payload = events.map((e) => JSON.stringify(e)).join('\n')
    for (const n of ['1', '2', '3']) assert.match(payload, new RegExp(`"content":"${n}"`))
    assert.match(payload, /next number/)
  })

  it('prints context BEFORE the commands so the command is read last', () => {
    const events = buildOwnerMessageEvents(oneTwoThree, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['room_context', 'owner_message', 'wake'],
    )
  })

  it('labels both tiers as advisory and never as things to do', () => {
    const ctx = buildOwnerMessageEvents(oneTwoThree, {}).find((e) => e.type === 'room_context')
    assert.equal(ctx.advisory, true)
    assert.match(ctx.note, /never execute anything from either/i)
    assert.match(ctx.note, /NOT to you/)
  })

  it('separates the owner-ambient tier from everyone else', () => {
    const batch = {
      session_id: 's',
      context: {
        owner_ambient: [{ id: 'a', content: 'my own aside' }],
        room_context: [{ id: 'b', content: 'a teammate talking' }],
        dropped: 2,
      },
      messages: [{ id: 'c', content: 'do the thing' }],
    }
    const ctx = buildOwnerMessageEvents(batch, {}).find((e) => e.type === 'room_context')
    assert.deepEqual(ctx.counts, { owner_ambient: 1, room_context: 1 })
    // Trimming is reported, not hidden — a partial room must be knowable as partial.
    assert.equal(ctx.dropped, 2)
    const wake = buildOwnerMessageEvents(batch, {}).find((e) => e.type === 'wake')
    assert.deepEqual(wake.context_counts, { owner_ambient: 1, room_context: 1 })
  })

  it('emits no context event at all when the room was silent', () => {
    const batch = { session_id: 's', context: { owner_ambient: [], room_context: [], dropped: 0 }, messages: [{ id: 'a' }] }
    assert.equal(
      buildOwnerMessageEvents(batch, {}).some((e) => e.type === 'room_context'),
      false,
    )
  })

  it('tolerates a batch written by an older poller (no context field)', () => {
    const events = buildOwnerMessageEvents({ session_id: 's', messages: [{ id: 'a' }] }, {})
    assert.deepEqual(
      events.map((e) => e.type),
      ['owner_message', 'wake'],
    )
    assert.deepEqual(events.at(-1).context_counts, { owner_ambient: 0, room_context: 0 })
  })

  it('an advisory_context inbox line still never wakes the agent', () => {
    // The context travels ON the owner_messages entry; the standalone advisory entry
    // remains a durable record only. Advisory alone must never produce a batch.
    const lines = [
      JSON.stringify({
        type: 'advisory_context',
        session_id: 's',
        messages: [{ id: 'a', content: 'chatter' }],
      }),
    ]
    assert.equal(parseOwnerBatches(lines).length, 0)
  })
})

/**
 * Attachments (item 99165e12). The server sends base64 `content` plus, for images, a
 * `dataUrl` carrying the SAME bytes again. Emitting that verbatim is the defect: a
 * 500KB screenshot measured at 1.37MB of stdout (~341k tokens) of base64 the model
 * still cannot see as an image. These lock in the fix — payload goes to disk, only a
 * descriptor goes to the model.
 */
describe('attachments: payload to disk, descriptor to the model', () => {
  const png = (bytes = 4096) => Buffer.alloc(bytes, 7).toString('base64')

  const imageAttachment = (over = {}) => ({
    filename: 'shot.png',
    mimeType: 'image/png',
    type: 'image',
    sizeBytes: 4096,
    content: png(),
    dataUrl: 'data:image/png;base64,' + png(),
    ...over,
  })

  it('writes an image to disk and returns a path, not the payload', () => {
    const written = []
    const d = describeAttachment(imageAttachment(), {
      dir: '/att',
      messageId: 'm1',
      index: 0,
      writeFile: (t, b) => written.push([t, b.length]),
    })
    assert.equal(d.delivery, 'file')
    assert.equal(d.path, path.join('/att', 'm1-0-shot.png'))
    assert.equal(d.content, undefined)
    assert.equal(d.dataUrl, undefined)
    // Decoded to the true byte length, not the inflated base64 length.
    assert.equal(written[0][1], 4096)
  })

  it('never emits base64 into the wake event', () => {
    const b64 = png(8192)
    const events = buildOwnerMessageEvents(
      {
        session_id: 's1',
        messages: [{ id: 'm1', content: 'why is this wrong?', attachments: [imageAttachment({ content: b64 })] }],
      },
      { attachmentDir: '/att', writeFile: () => {} },
    )
    const out = events.map((e) => JSON.stringify(e)).join('\n')
    assert.equal(out.includes(b64.slice(0, 64)), false)
    // And the turn stays small rather than scaling with the image.
    assert.ok(out.length < 2000, `wake payload should stay small, was ${out.length}`)
  })

  it('prefers content over dataUrl and never carries both', () => {
    const d = describeAttachment(imageAttachment(), {
      dir: '/att', messageId: 'm', index: 0, writeFile: () => {},
    })
    assert.equal('content' in d, false)
    assert.equal('dataUrl' in d, false)
  })

  it('recovers the payload from dataUrl when content is absent', () => {
    const written = []
    const d = describeAttachment(
      { filename: 'a.png', mimeType: 'image/png', type: 'image', dataUrl: 'data:image/png;base64,' + png(512) },
      { dir: '/att', messageId: 'm', index: 0, writeFile: (t, b) => written.push(b.length) },
    )
    assert.equal(d.delivery, 'file')
    assert.equal(written[0], 512)
  })

  it('keeps SMALL text inline — a file path for 30 bytes helps nobody', () => {
    const d = describeAttachment(
      {
        filename: 'note.txt', mimeType: 'text/plain', type: 'text',
        content: Buffer.from('ship it').toString('base64'),
      },
      { dir: '/att', messageId: 'm', index: 0, writeFile: () => { throw new Error('should not write') } },
    )
    assert.equal(d.delivery, 'inline')
    assert.equal(d.content, 'ship it')
  })

  it('sends LARGE text to disk instead of inlining it', () => {
    const big = 'x'.repeat(MAX_INLINE_ATTACHMENT_CHARS + 1)
    const d = describeAttachment(
      { filename: 'big.txt', mimeType: 'text/plain', type: 'text', content: Buffer.from(big).toString('base64') },
      { dir: '/att', messageId: 'm', index: 0, writeFile: () => {} },
    )
    assert.equal(d.delivery, 'file')
    assert.equal(d.content, undefined)
  })

  it('sanitises the filename — no directory escape, no shell-hostile chars', () => {
    const d = describeAttachment(imageAttachment({ filename: '../../etc/passwd' }), {
      dir: '/att', messageId: 'm', index: 0, writeFile: () => {},
    })
    assert.equal(d.path.includes('..'), false)
    assert.equal(d.path, path.join('/att', 'm-0-passwd'))
  })

  it('says so when it cannot write, rather than silently inlining base64', () => {
    const d = describeAttachment(imageAttachment(), {
      dir: '/att', messageId: 'm', index: 0,
      writeFile: () => { throw new Error('disk full') },
    })
    assert.equal(d.delivery, 'unavailable')
    assert.match(d.note, /disk full/)
    assert.equal(d.content, undefined)
  })

  it('declines rather than drops when there is nowhere to write', () => {
    const d = describeAttachment(imageAttachment(), { messageId: 'm', index: 0 })
    assert.equal(d.delivery, 'unavailable')
    assert.equal(d.content, undefined)
  })

  it('an image descriptor TELLS the model to open it', () => {
    const d = describeAttachment(imageAttachment(), {
      dir: '/att', messageId: 'm', index: 0, writeFile: () => {},
    })
    // Without this the model sees a path and treats it as decoration.
    assert.match(d.note, /OPEN THIS PATH/)
  })

  it('drops payload-less stubs instead of emitting empty descriptors', () => {
    const m = materialiseAttachments(
      { id: 'm1', attachments: [{ filename: 'ghost.png', mimeType: 'image/png', type: 'image' }] },
      { dir: '/att', writeFile: () => {} },
    )
    assert.equal('attachments' in m, false)
  })

  it('leaves a command with no attachments completely unchanged', () => {
    const msg = { id: 'm1', content: 'no files here' }
    assert.equal(materialiseAttachments(msg, { dir: '/att', writeFile: () => {} }), msg)
  })
})

describe('arming and the working indicator (item 68f7b30c)', () => {
  /** A real temp CONNECTIONS_DIR with a turn marker already written by the poller. */
  function withMarker(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-turn-'))
    const conn = 'conn-1'
    const marker = path.join(dir, `${conn}.turn`)
    fs.writeFileSync(marker, JSON.stringify({ startedAt: Date.now() }))
    try {
      return fn({ dir, conn, marker })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('a re-arm (--pending) LEAVES the marker — the agent is still working', () => {
    withMarker(({ dir, conn, marker }) => {
      // The documented pattern: re-arm the instant the agent wakes so mid-turn
      // owner mail is not dropped. That must not turn the driver's dots off.
      const ended = applyArmTurnSemantics(conn, { pending: true, fromEnd: false }, dir)
      assert.equal(ended, false)
      assert.equal(fs.existsSync(marker), true)
    })
  })

  it('a flagless re-arm also LEAVES the marker (default is resume, not idle)', () => {
    withMarker(({ dir, conn, marker }) => {
      const ended = applyArmTurnSemantics(conn, {}, dir)
      assert.equal(ended, false)
      assert.equal(fs.existsSync(marker), true)
    })
  })

  it('a FIRST arm (--from-end) clears it — a seed turn nobody will wake for', () => {
    withMarker(({ dir, conn, marker }) => {
      const ended = applyArmTurnSemantics(conn, { fromEnd: true, pending: false }, dir)
      assert.equal(ended, true)
      assert.equal(fs.existsSync(marker), false)
    })
  })

  it('--pending --after-reply clears it — Cursor CLI turn-end without Stop (fe456bf9)', () => {
    withMarker(({ dir, conn, marker }) => {
      const ended = applyArmTurnSemantics(
        conn,
        { pending: true, afterReply: true, fromEnd: false },
        dir,
      )
      assert.equal(ended, true)
      assert.equal(fs.existsSync(marker), false)
    })
  })

  it('--after-reply alone does NOT clear (must be paired with --pending)', () => {
    withMarker(({ dir, conn, marker }) => {
      const ended = applyArmTurnSemantics(conn, { afterReply: true }, dir)
      assert.equal(ended, false)
      assert.equal(fs.existsSync(marker), true)
    })
  })

  it('turn completion clears it — the Stop hook path still ends "working"', () => {
    withMarker(({ dir, conn, marker }) => {
      // mirror-turn.mjs stop does exactly this; asserted here so the pair
      // "survives a re-arm, does NOT survive turn end" is locked in one place.
      clearTurnMarker(conn, dir)
      assert.equal(fs.existsSync(marker), false)
    })
  })

  it('--pending wins if both flags are passed without --after-reply (never hide real work)', () => {
    assert.equal(armEndsTurn({ fromEnd: true, pending: true }), false)
    assert.equal(armEndsTurn({ fromEnd: true }), true)
    assert.equal(armEndsTurn({ pending: true }), false)
    assert.equal(armEndsTurn({ pending: true, afterReply: true }), true)
    assert.equal(armEndsTurn({}), false)
  })

  it('is a no-op without a connection id rather than throwing', () => {
    withMarker(({ dir, marker }) => {
      assert.equal(applyArmTurnSemantics(null, { fromEnd: true }, dir), true)
      assert.equal(fs.existsSync(marker), true)
    })
  })
})

describe('notifyWorkingEnded (item cd989606 — immediate report_complete)', () => {
  it('calls heartbeat busy:false then report_complete (Stop parity)', async () => {
    const calls = []
    const result = await notifyWorkingEnded({
      connectionId: 'conn-1',
      state: { token: 'dvs_test', mcp_url: 'https://example.test/api/mcp' },
      call: async (opts) => {
        calls.push(opts)
        return { ok: true }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].name, 'heartbeat_connection')
    assert.equal(calls[0].arguments.busy, false)
    assert.equal(calls[0].arguments.connection_id, 'conn-1')
    assert.equal(calls[1].name, 'report_complete')
    assert.equal(calls[1].arguments.connection_id, 'conn-1')
    assert.equal(calls[1].arguments.reason, 'turn_end')
    assert.equal(calls[0].timeoutMs, 15_000)
    assert.equal(calls[1].timeoutMs, 15_000)
  })

  it('returns no_token without calling MCP when auth is missing', async () => {
    let called = 0
    const result = await notifyWorkingEnded({
      connectionId: 'conn-1',
      state: {},
      resolveAuth: () => ({ token: null }),
      call: async () => {
        called++
        return { ok: true }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no_token')
    assert.equal(called, 0)
  })

  it('still reports complete if heartbeat fails', async () => {
    const calls = []
    const result = await notifyWorkingEnded({
      connectionId: 'conn-1',
      state: { token: 'dvs_test', mcp_url: 'https://example.test/api/mcp' },
      call: async (opts) => {
        calls.push(opts.name)
        if (opts.name === 'heartbeat_connection') throw new Error('network')
        return { ok: true }
      },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['heartbeat_connection', 'report_complete'])
  })
})

describe('offsetAfterAdvisoryHistory (item 1f177af4 — first-arm keeps queued owner_messages)', () => {
  const advisory = (extra = {}) =>
    `${JSON.stringify({ type: 'advisory_context', messages: [{ id: 'a1', ...extra }] })}\n`
  const owner = (id = 'm1') =>
    `${JSON.stringify({ type: 'owner_messages', messages: [{ id }] })}\n`

  it('empty inbox seeks to EOF (0)', () => {
    assert.equal(offsetAfterAdvisoryHistory(''), 0)
    assert.equal(offsetAfterAdvisoryHistory(null), 0)
  })

  it('advisory-only inbox seeks to EOF (no phantom wake)', () => {
    const text = advisory() + advisory({ content: 'café' })
    assert.equal(offsetAfterAdvisoryHistory(text), Buffer.byteLength(text, 'utf8'))
  })

  it('advisory then owner_messages starts at the owner_messages line', () => {
    const prefix = advisory({ content: 'café' })
    const text = prefix + owner('7cc60994')
    assert.equal(offsetAfterAdvisoryHistory(text), Buffer.byteLength(prefix, 'utf8'))
  })

  it('owner_messages at the start of the file starts at 0', () => {
    assert.equal(offsetAfterAdvisoryHistory(owner()), 0)
  })

  it('empty owner_messages array is treated as advisory (not a wake)', () => {
    const emptyOwner = `${JSON.stringify({ type: 'owner_messages', messages: [] })}\n`
    const text = advisory() + emptyOwner
    assert.equal(offsetAfterAdvisoryHistory(text), Buffer.byteLength(text, 'utf8'))
  })

  it('incomplete trailing owner_messages line (no newline) is not a wake', () => {
    const prefix = advisory()
    const incomplete = '{"type":"owner_messages","messages":[{"id":"x"}]}'
    const text = prefix + incomplete
    assert.equal(offsetAfterAdvisoryHistory(text), Buffer.byteLength(text, 'utf8'))
  })

  it('two owner_messages batches start at the first', () => {
    const prefix = advisory()
    const text = prefix + owner('first') + owner('second')
    assert.equal(offsetAfterAdvisoryHistory(text), Buffer.byteLength(prefix, 'utf8'))
  })

  it('resolveFromEndOffset reads a file with the same contract', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-from-end-'))
    const file = path.join(dir, 'inbox.jsonl')
    try {
      fs.writeFileSync(file, '')
      assert.equal(resolveFromEndOffset(file), 0)
      const prefix = advisory()
      fs.writeFileSync(file, prefix + owner())
      assert.equal(resolveFromEndOffset(file), Buffer.byteLength(prefix, 'utf8'))
      fs.writeFileSync(file, prefix)
      assert.equal(resolveFromEndOffset(file), Buffer.byteLength(prefix, 'utf8'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--pending keeps the saved inbox_byte_offset even when unread owner_messages exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-pending-offset-'))
    const file = path.join(dir, 'inbox.jsonl')
    try {
      fs.writeFileSync(file, advisory() + owner())
      assert.equal(
        resolveWatchOffset({
          pending: true,
          fromEnd: true,
          inboxByteOffset: 42,
          file,
        }),
        42,
      )
      assert.equal(
        resolveWatchOffset({
          pending: true,
          fromEnd: false,
          inboxByteOffset: 99,
          file,
        }),
        99,
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('consumeInboxSlice (item e8832794 — advancing the watch cursor must not throw)', () => {
  const ownerLine = `${JSON.stringify({ type: 'owner_messages', messages: [{ id: 'm1' }] })}\n`
  const advisoryLine = `${JSON.stringify({ type: 'advisory_context', messages: [{ id: 'a1' }] })}\n`

  it('advances the byte cursor and returns the owner batch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-consume-'))
    const file = path.join(dir, 'inbox.jsonl')
    try {
      fs.writeFileSync(file, ownerLine)
      const slice = consumeInboxSlice(file, 0)
      assert.equal(slice.newOffset, Buffer.byteLength(ownerLine, 'utf8'))
      assert.equal(slice.batches.length, 1)
      assert.equal(slice.batches[0].messages[0].id, 'm1')
      let offset = 0
      offset = slice.newOffset
      assert.equal(offset, slice.newOffset)
      const again = consumeInboxSlice(file, offset)
      assert.equal(again.lines.length, 0)
      assert.equal(again.newOffset, offset)
      assert.equal(again.batches.length, 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still advances past advisory-only lines (cursor must move even when nothing wakes)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-consume-adv-'))
    const file = path.join(dir, 'inbox.jsonl')
    try {
      fs.writeFileSync(file, advisoryLine)
      const slice = consumeInboxSlice(file, 0)
      assert.equal(slice.newOffset, Buffer.byteLength(advisoryLine, 'utf8'))
      assert.equal(slice.batches.length, 0)
      assert.ok(slice.lines.length > 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveConnectionsDir', () => {
  it('uses DEVSPEC_REMOTE_CONNECTIONS_DIR when set', () => {
    assert.equal(
      resolveConnectionsDir({ DEVSPEC_REMOTE_CONNECTIONS_DIR: 'C:\\tmp\\rc' }, '/home/x'),
      'C:\\tmp\\rc',
    )
  })

  it('falls back to ~/.devspec/remote-control/connections', () => {
    assert.equal(
      resolveConnectionsDir({ DEVSPEC_REMOTE_CONNECTIONS_DIR: '  ' }, '/home/x'),
      path.join('/home/x', '.devspec', 'remote-control', 'connections'),
    )
  })
})

describe('wait CLI (item e8832794 — queued owner_messages must wake, not throw const)', () => {
  it('--from-end against a queued owner_messages inbox prints wake and exits 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-wait-cli-'))
    const connectionId = randomUUID()
    const inbox = path.join(dir, `${connectionId}.inbox.jsonl`)
    const script = fileURLToPath(new URL('./devspec-remote-wait.mjs', import.meta.url))
    const line = `${JSON.stringify(canonicalBatch(canonicalCommand(), {
      connection_id: connectionId,
      session_id: 'sess-test',
      messages: [{ ...canonicalCommand(), addressee: { connection_id: connectionId } }],
    }))}\n`
    fs.writeFileSync(inbox, line)
    const env = { ...process.env, DEVSPEC_REMOTE_CONNECTIONS_DIR: dir }
    delete env.DEVSPEC_MCP_TOKEN
    try {
      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [script, '--connection-id', connectionId, '--from-end', '--poll-ms', '50'],
          { env, cwd: dir, windowsHide: true },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => {
          stdout += d.toString()
        })
        child.stderr.on('data', (d) => {
          stderr += d.toString()
        })
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`wait CLI timed out\nstderr=${stderr}\nstdout=${stdout}`))
        }, 20000)
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ stdout, stderr, code })
        })
      })
      // The const-offset bug threw before printing. Wake on stdout is the
      // contract. Windows Node may then abort (0xC0000409) on process.exit
      // while leftover HTTP handles close — that is after a successful wake.
      assert.doesNotMatch(stderr, /Assignment to constant variable/)
      assert.match(stderr, /wake \(1 msg\)/)
      assert.match(stdout, /"type":"owner_message"/)
      assert.match(stdout, /"type":"wake"/)
      if (code !== 0) {
        assert.equal(
          code,
          3221226505,
          `unexpected exit ${code}\nstderr=${stderr}\nstdout=${stdout}`,
        )
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveOwnerPid (item 5c884554 — wait copy skips worker-server)', () => {
  const workerCmd =
    '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\node.exe" "C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\index.js" worker-server'
  const resumeCmd =
    '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\node.exe" "C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\index.js" --resume abc'

  it('explicit worker-server pid falls through to auto/--resume', () => {
    if (process.platform !== 'win32') {
      assert.equal(
        resolveOwnerPid(20196, 22808, {
          processNameOf: () => 'node.exe',
          processCommandLineOf: () => workerCmd,
          resolveAuto: () => 22808,
        }),
        20196,
      )
      return
    }
    assert.equal(
      resolveOwnerPid(20196, 22808, {
        processNameOf: () => 'node.exe',
        processCommandLineOf: () => workerCmd,
        resolveAuto: () => 22808,
      }),
      22808,
    )
  })

  it('explicit --resume cursor-agent node.exe is kept', () => {
    assert.equal(
      resolveOwnerPid(22808, 999, {
        processNameOf: () => 'node.exe',
        processCommandLineOf: () => resumeCmd,
        resolveAuto: () => {
          throw new Error('auto should not run')
        },
      }),
      22808,
    )
  })

  it('keeps --resume when Agents Connect prompt names the wait script (item 36de7cb4)', () => {
    const resumeWithWaitPrompt =
      '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\node.exe" ' +
      '"C:\\Users\\x\\AppData\\Local\\cursor-agent\\versions\\1\\index.js" --resume abc ' +
      '--approve-mcps "node C:\\\\x\\\\devspec-remote-wait.mjs --from-end"'
    assert.equal(
      resolveOwnerPid(22808, 999, {
        processNameOf: () => 'node.exe',
        processCommandLineOf: () => resumeWithWaitPrompt,
        resolveAuto: () => {
          throw new Error('auto should not run')
        },
      }),
      22808,
    )
  })
})
