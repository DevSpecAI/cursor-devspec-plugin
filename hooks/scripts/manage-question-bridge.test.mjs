import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  describeManageQuestionBridge,
  validateManageQuestionInput,
  useManageQuestionBridge,
  respondToQuestion,
} from './manage-question-bridge.mjs'
import { persistConnectionCapability } from './manage-plan-bridge.mjs'
import { ROOM_MESSAGE_MAX_CHARS } from './room-message.mjs'

const REQ_ID = '30000000-0000-4000-8000-000000000003'
const QUESTION_ID = '50000000-0000-4000-8000-000000000005'

describe('manage-question-bridge keep_turn batching and validation', () => {
  const baseCreate = {
    action: 'create',
    client_request_id: REQ_ID,
    response_kind: 'single_select',
    prompt: 'Which target environment?',
    options: ['Staging', 'Production'],
  }

  it('advertises keep_turn in the described inputSchema', () => {
    const described = describeManageQuestionBridge()
    assert.deepEqual(described.inputSchema.properties.keep_turn, {
      type: 'boolean',
      description:
        'Keep the current turn open after asking (pass true only when you still have work or on every question of an independent batch except the last). create only.',
    })
  })

  it('accepts boolean keep_turn on create and ask', () => {
    assert.equal(validateManageQuestionInput({ ...baseCreate, keep_turn: true }), null)
    assert.equal(validateManageQuestionInput({ ...baseCreate, keep_turn: false }), null)
    assert.equal(validateManageQuestionInput({ ...baseCreate, action: 'ask', keep_turn: true }), null)
  })

  it('rejects non-boolean keep_turn or keep_turn on non-create actions', () => {
    assert.match(validateManageQuestionInput({ ...baseCreate, keep_turn: 'yes' }), /keep_turn must be a boolean/)
    assert.match(validateManageQuestionInput({ ...baseCreate, keep_turn: 1 }), /keep_turn must be a boolean/)
    assert.match(validateManageQuestionInput({ action: 'list', keep_turn: true }), /keep_turn/)
    assert.match(
      validateManageQuestionInput({ action: 'get', question_id: QUESTION_ID, keep_turn: true }),
      /keep_turn/,
    )
    assert.match(
      validateManageQuestionInput({
        action: 'cancel',
        question_id: QUESTION_ID,
        expected_revision: 1,
        keep_turn: false,
      }),
      /keep_turn/,
    )
  })

  it('rejects invalid input before resolving connection state', async () => {
    const res = await useManageQuestionBridge({ ...baseCreate, keep_turn: 'invalid' })
    assert.equal(res.ok, false)
    assert.match(res.error, /keep_turn must be a boolean/)
  })
})

describe('manage-question respond', () => {
  const CONNECTION = '10000000-0000-4000-8000-000000000001'
  const SESSION = '20000000-0000-4000-8000-000000000002'
  const LOCAL = 'cursor-chat-respond'
  const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`

  /** A live, attached, capability-bound bond whose answered question awaits a reply. */
  function answeredQuestion(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-question-respond-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, 'connections'), { recursive: true })
    fs.mkdirSync(path.join(root, 'local', 'cursor'), { recursive: true })
    fs.writeFileSync(path.join(root, 'connections', `${CONNECTION}.json`), JSON.stringify({
      connection_id: CONNECTION, local_id: LOCAL, enabled: true, agent_name: 'Cursor', cwd: root, session_id: SESSION,
      interaction_continuation: {
        event_id: id(3), response_id: id(4), claim_token: id(5), question_id: id(6), attempt_id: id(7),
        connection_id: CONNECTION, session_id: SESSION, started_at: '2026-10-31T12:00:00.000Z', wake_offset_after: 1,
      },
    }))
    fs.writeFileSync(path.join(root, 'local', 'cursor', `${LOCAL}.json`), JSON.stringify({
      connection_id: CONNECTION, local_id: LOCAL, agent_name: 'Cursor', session_id: SESSION, status: 'live',
    }))
    persistConnectionCapability({ connectionId: CONNECTION, localId: LOCAL, capability: 'dvsc_fixture' }, { root })
    const calls = []
    const options = {
      localId: LOCAL,
      root,
      resolveAuth: () => ({ ok: true, token: 'dvs_fixture', mcp_url: 'https://example.test/api/mcp' }),
      mcpCall: async (call) => { calls.push(call); return { message_id: id(8) } },
    }
    return { calls, options }
  }

  it('sends a long reply whole, where it used to be cut at 12,000 characters', async (t) => {
    const { calls, options } = answeredQuestion(t)
    const reply = `start ${'r'.repeat(30_000)} end`
    const res = await respondToQuestion({ message: reply }, options)
    assert.equal(res.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'post_session_message')
    assert.equal(calls[0].arguments.message, reply)
    assert.equal(calls[0].arguments.complete_turn, true)
  })

  it('refuses a reply over the room limit with the numbers, and posts nothing', async (t) => {
    const { calls, options } = answeredQuestion(t)
    const res = await respondToQuestion({ message: 'r'.repeat(ROOM_MESSAGE_MAX_CHARS + 1) }, options)
    assert.equal(res.ok, false)
    assert.match(res.error, /100,001 characters/)
    assert.match(res.error, /at most 100,000/)
    assert.match(res.error, /Nothing was posted/)
    assert.equal(calls.length, 0)
    // At the limit exactly, it goes.
    assert.equal((await respondToQuestion({ message: 'r'.repeat(ROOM_MESSAGE_MAX_CHARS) }, options)).ok, true)
    assert.equal(calls.length, 1)
  })
})
