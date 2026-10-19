import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  describeManageQuestionBridge,
  validateManageQuestionInput,
  useManageQuestionBridge,
} from './manage-question-bridge.mjs'

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
