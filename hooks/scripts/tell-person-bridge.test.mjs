#!/usr/bin/env node
/**
 * The agent's own `tell-person` command (item 140a7f68): a DevSpec write that carries
 * tell_person is the agent's to tell its person about, and in a turn only notices or
 * check jobs woke this is how it reaches the room.
 * Run: node --test hooks/scripts/tell-person-bridge.test.mjs
 *
 * These run the real bridge over a real connection directory with the DevSpec call
 * stubbed: what it sends, with which connection's capability and credential, what it
 * notes on the turn so the end-of-turn backstop never posts a second copy, and that a
 * refusal comes back as DevSpec gave it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CursorMcpRefusal } from './mcp-call.mjs'
import { persistConnectionCapability } from './manage-plan-bridge.mjs'
import { postTellPersonAtStop, readTurnWakes, recordTellPerson, recordTurnWake } from './notice-reply.mjs'
import { appendRequestEvent } from './requests.mjs'
import { FIXTURE_ID } from './remote-ingress-test-fixtures.mjs'
import { describeTellPersonBridge, useTellPersonBridge, validateTellPersonInput } from './tell-person-bridge.mjs'

const CONN = FIXTURE_ID.connection
const LOCAL = 'cursor-chat-tell'
const ROOM = 'abababab-abab-4bab-8bab-abababababab'
const NOTICE = 'f7d6a637-bb5a-4bcc-98ee-354e5f309a6b'
const CAPABILITY = 'dvsc_tell-secret'
const MESSAGE = 'I closed Brandon’s duplicate of my task while tidying mine.'

const roots = []
function root() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tell-person-'))
  roots.push(base)
  const connections = path.join(base, 'connections')
  const local = path.join(base, 'local', 'cursor')
  fs.mkdirSync(connections, { recursive: true })
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(connections, `${CONN}.json`), JSON.stringify({
    connection_id: CONN, local_id: LOCAL, enabled: true, agent_name: 'Cursor', cwd: base, session_id: ROOM,
    token: 'dvs_connection_token', mcp_url: 'https://api.devspec.ai/api/mcp',
  }))
  fs.writeFileSync(path.join(local, `${LOCAL}.json`), JSON.stringify({
    connection_id: CONN, local_id: LOCAL, agent_name: 'Cursor', session_id: ROOM, status: 'live',
  }))
  persistConnectionCapability({ connectionId: CONN, localId: LOCAL, capability: CAPABILITY }, { root: base })
  return base
}
afterEach(() => {
  for (const base of roots.splice(0)) fs.rmSync(base, { recursive: true, force: true })
})

/** A turn a for-the-record notice woke, in which a write carried tell_person. */
function noticeTurnWithMark(base) {
  const dir = path.join(base, 'connections')
  recordTurnWake(CONN, { noticeIds: [NOTICE], forTheRecordIds: [NOTICE] }, { dir, newTurn: true })
  appendRequestEvent(CONN, { op: 'current', ref: null }, { dir })
  recordTellPerson(CONN, { dir })
  return dir
}

const stored = (args) => ({ connection_id: args.connection_id, message_id: 'e3333333-3333-4333-8333-333333333333', delivery: { status: 'stored', message_id: 'e3333333-3333-4333-8333-333333333333' } })

describe('the tell-person command', () => {
  it('describes itself by the rule it serves, and takes only a message', () => {
    assert.match(describeTellPersonBridge().rule, /semantics\.notice_audience\.telling_anyway/)
    assert.equal(validateTellPersonInput({ message: MESSAGE }), null)
    assert.match(validateTellPersonInput({ message: '  ' }), /non-empty/)
    assert.match(validateTellPersonInput({ message: MESSAGE, system_notice_ids: [NOTICE] }), /only message/)
    assert.match(validateTellPersonInput('hi'), /one JSON object/)
  })

  it('posts the agent\'s own message with its connection\'s capability and credential, and the backstop adds no second copy', async () => {
    const base = root()
    const dir = noticeTurnWithMark(base)
    const calls = []
    const told = await useTellPersonBridge({ message: MESSAGE }, {
      localId: LOCAL,
      root: base,
      mcpCall: async (request) => {
        calls.push(request)
        return stored(request.arguments)
      },
    })
    assert.equal(told.ok, true, told.error)
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.name, 'post_session_message')
    assert.equal(call.connectionCapability, CAPABILITY)
    assert.equal(call.token, 'dvs_connection_token', 'the connection\'s own credential, which the speech lane requires')
    const { assistant_source_id: sourceId, ...rest } = call.arguments
    assert.match(sourceId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(rest, { connection_id: CONN, ingest_version: 2, message: MESSAGE, phase: 'answer', complete_turn: false, agent_name: 'Cursor' })
    assert.equal(typeof readTurnWakes(CONN, { dir }).personToldAt, 'number')

    // The end-of-turn backstop sees the person was told and posts nothing.
    const transcript = path.join(base, 'transcript.jsonl')
    fs.writeFileSync(transcript, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Told them.' }] } })}\n`)
    let backstopPosts = 0
    const backstop = await postTellPersonAtStop({
      raw: JSON.stringify({ status: 'completed', transcript_path: transcript }),
      connectionId: CONN,
      sessionId: ROOM,
      connectionCapability: CAPABILITY,
      dir,
      post: async () => { backstopPosts++ },
    })
    assert.equal(backstop, null)
    assert.equal(backstopPosts, 0)
  })

  it('returns DevSpec\'s refusal as given, redacted of the capability, and leaves the backstop in place', async () => {
    const base = root()
    const dir = noticeTurnWithMark(base)
    const receipt = { delivery: { status: 'rejected', reason: 'not_attached', retryable: false }, error: `refused for ${CAPABILITY}` }
    const failed = await useTellPersonBridge({ message: MESSAGE }, {
      localId: LOCAL,
      root: base,
      mcpCall: async () => { throw new CursorMcpRefusal(JSON.stringify(receipt), receipt) },
    })
    assert.equal(failed.ok, false)
    assert.deepEqual(failed.refusal.details.delivery, receipt.delivery, 'the structured answer, not a sentence')
    assert.doesNotMatch(JSON.stringify(failed), /dvsc_tell-secret/)
    assert.match(JSON.stringify(failed), /\[redacted\]/)
    assert.equal(readTurnWakes(CONN, { dir }).personToldAt, undefined, 'not told, so the backstop still stands')

    // A conversation that holds no live bond sends nothing at all.
    let sent = 0
    const unbound = await useTellPersonBridge({ message: MESSAGE }, { localId: 'another-chat', root: base, mcpCall: async () => { sent++ } })
    assert.equal(unbound.ok, false)
    assert.equal(sent, 0)
  })
})
