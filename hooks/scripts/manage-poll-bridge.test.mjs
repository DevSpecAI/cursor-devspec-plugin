import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  MANAGE_POLL_INPUT_SCHEMA,
  describeManagePollBridge,
  useManagePollBridge,
  validateManagePollInput,
} from './manage-poll-bridge.mjs'
import { persistConnectionCapability } from './manage-plan-bridge.mjs'
import { FIXTURE_ID } from './remote-ingress-test-fixtures.mjs'

const roots = []
function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-poll-bridge-'))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

function writeBoundState(base, {
  connectionId = FIXTURE_ID.connection,
  localId = 'cursor-chat-a',
  sessionId = 'abababab-abab-4bab-8bab-abababababab',
} = {}) {
  const connections = path.join(base, 'connections')
  const local = path.join(base, 'local', 'cursor')
  fs.mkdirSync(connections, { recursive: true })
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(connections, `${connectionId}.json`), JSON.stringify({
    connection_id: connectionId,
    local_id: localId,
    enabled: true,
    agent_name: 'Cursor',
    cwd: base,
    session_id: sessionId,
  }))
  fs.writeFileSync(path.join(local, `${localId}.json`), JSON.stringify({
    connection_id: connectionId,
    local_id: localId,
    agent_name: 'Cursor',
    session_id: sessionId,
    status: 'live',
  }))
}

describe('Cursor manage_poll describe/use bridge', () => {
  it('describes the bounded poll schema on demand and uses no directed-question turn/wake machinery', () => {
    const described = describeManagePollBridge()
    assert.equal(described.tool, 'manage_poll')
    assert.deepEqual(described.inputSchema, MANAGE_POLL_INPUT_SCHEMA)
    assert.deepEqual(described.inputSchema.required, ['action'])
    assert.deepEqual(
      described.inputSchema.properties.action.enum,
      ['create', 'list', 'get', 'update', 'end', 'retract', 'supersede'],
    )
    assert.equal(Object.hasOwn(described, 'respondSchema'), false)
    assert.doesNotMatch(JSON.stringify(described), /dvsc_|question_answer|interaction_continuation|keep_turn/)
    assert.match(described.usage, /stdin/)
  })

  it('rejects model-supplied identity/capability fields and validates poll semantics', () => {
    for (const forged of ['connection_id', 'local_id', 'capability', 'token', 'vote']) {
      assert.match(validateManagePollInput({ action: 'list', [forged]: 'x' }), /identity-bearing/)
    }
    assert.equal(
      validateManagePollInput({
        action: 'create',
        client_request_id: 'poll-req-1',
        question: 'Which approach?',
        options: ['Option A', 'Option B'],
        recommendation_index: 0,
      }),
      null,
    )
    assert.match(validateManagePollInput({ action: 'create', question: 'Q', options: ['A', 'B'] }), /client_request_id/)
    assert.match(validateManagePollInput({ action: 'create', client_request_id: '1', question: 'Q', options: ['A'] }), /between 2 and 30/)
    assert.match(
      validateManagePollInput({
        action: 'create',
        client_request_id: '1',
        question: 'Q',
        options: ['A', 'B'],
        recommendation_index: 2,
      }),
      /outside the options/,
    )
    assert.match(validateManagePollInput({ action: 'end', poll_id: 'p1' }), /expected_revision/)
    assert.equal(validateManagePollInput({ action: 'end', poll_id: 'p1', expected_revision: 2 }), null)
    assert.match(validateManagePollInput({ action: 'retract', poll_id: 'p1', expected_revision: 1 }), /reason/)
    assert.equal(
      validateManagePollInput({ action: 'retract', poll_id: 'p1', expected_revision: 1, reason: 'Superseded' }),
      null,
    )
  })

  it('attaches the hidden capability for the exact host bond, redacts errors, and leaves continuation state untouched', async () => {
    const base = root()
    writeBoundState(base)
    persistConnectionCapability({
      connectionId: FIXTURE_ID.connection,
      localId: 'cursor-chat-a',
      capability: 'dvsc_poll-secret',
    }, { root: base })

    const calls = []
    const ok = await useManagePollBridge(
      {
        action: 'create',
        client_request_id: 'poll-req-1',
        question: 'Roll out now or stage first?',
        options: ['Stage first', 'Roll out now'],
      },
      {
        localId: 'cursor-chat-a',
        root: base,
        resolveAuth: () => ({ ok: true, token: 'dvs_tok', mcp_url: 'https://api.devspec.ai/api/mcp' }),
        mcpCall: async (req) => {
          calls.push(req)
          return { poll: { id: 'poll-1', revision: 1 } }
        },
      },
    )
    assert.equal(ok.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'manage_poll')
    assert.equal(calls[0].connectionCapability, 'dvsc_poll-secret')

    const failed = await useManagePollBridge(
      { action: 'list' },
      {
        localId: 'cursor-chat-a',
        root: base,
        resolveAuth: () => ({ ok: true, token: 'dvs_tok', mcp_url: 'https://api.devspec.ai/api/mcp' }),
        mcpCall: async () => {
          throw new Error('upstream rejected dvsc_poll-secret')
        },
      },
    )
    assert.equal(failed.ok, false)
    assert.doesNotMatch(failed.error, /dvsc_poll-secret/)
    assert.match(failed.error, /\[redacted\]/)
  })
})
