import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach } from 'node:test'
import {
  handleExplicitReply,
  extractPostSessionArgs,
} from './mark-explicit-reply.mjs'
import {
  turnMarkerPath,
  writeTurnMarker,
  explicitReplyMarkerPath,
  consumeExplicitReplyMarker,
} from './mirror-turn.mjs'

const TEST_CONN_ID = 'test-conn-explicit-reply-1234'
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

describe('mark-explicit-reply', () => {
  beforeEach(() => {
    try {
      fs.rmSync(turnMarkerPath(TEST_CONN_ID), { force: true })
      fs.rmSync(explicitReplyMarkerPath(TEST_CONN_ID), { force: true })
    } catch {
      /* ignore */
    }
  })

  afterEach(() => {
    try {
      fs.rmSync(turnMarkerPath(TEST_CONN_ID), { force: true })
      fs.rmSync(explicitReplyMarkerPath(TEST_CONN_ID), { force: true })
    } catch {
      /* ignore */
    }
  })

  it('extractPostSessionArgs parses object, nested arguments, and JSON strings', () => {
    assert.deepEqual(extractPostSessionArgs({ tool_input: { message: 'hello' } }), { message: 'hello' })
    assert.deepEqual(extractPostSessionArgs({ tool_input: JSON.stringify({ message: 'hi' }) }), { message: 'hi' })
    assert.deepEqual(extractPostSessionArgs({ arguments: { complete_turn: true } }), { complete_turn: true })
  })

  it('skips non-post_session_message tools', async () => {
    const res = await handleExplicitReply({
      tool_name: 'read_file',
      tool_input: { path: 'foo.ts' },
    })
    assert.equal(res, false)
    assert.equal(fs.existsSync(explicitReplyMarkerPath(TEST_CONN_ID)), false)
  })

  it('writes explicit-reply marker on post_session_message', async () => {
    writeTurnMarker(TEST_CONN_ID)
    assert.equal(fs.existsSync(turnMarkerPath(TEST_CONN_ID)), true)

    const res = await handleExplicitReply({
      tool_name: 'devspec__post_session_message',
      tool_input: {
        connection_id: TEST_CONN_ID,
        message: 'Mid-turn update',
      },
    })
    assert.equal(res, true)
    assert.equal(fs.existsSync(explicitReplyMarkerPath(TEST_CONN_ID)), true)
    // When complete_turn is not true, turn marker is left alone for mid-turn work
    assert.equal(fs.existsSync(turnMarkerPath(TEST_CONN_ID)), true)
    assert.equal(consumeExplicitReplyMarker(TEST_CONN_ID), true)
  })

  it('clears turn marker immediately when complete_turn is true', async () => {
    writeTurnMarker(TEST_CONN_ID)
    assert.equal(fs.existsSync(turnMarkerPath(TEST_CONN_ID)), true)

    const res = await handleExplicitReply({
      tool_name: 'post_session_message',
      tool_input: {
        connection_id: TEST_CONN_ID,
        message: 'Final answer',
        complete_turn: true,
      },
    })
    assert.equal(res, true)
    assert.equal(fs.existsSync(explicitReplyMarkerPath(TEST_CONN_ID)), true)
    assert.equal(fs.existsSync(turnMarkerPath(TEST_CONN_ID)), false)
    assert.equal(consumeExplicitReplyMarker(TEST_CONN_ID), true)
  })

  it('handles CallMcpTool wrapping of post_session_message with complete_turn', async () => {
    writeTurnMarker(TEST_CONN_ID)
    assert.equal(fs.existsSync(turnMarkerPath(TEST_CONN_ID)), true)

    const res = await handleExplicitReply({
      tool_name: 'CallMcpTool',
      tool_input: {
        server: 'devspec',
        toolName: 'post_session_message',
        arguments: {
          connection_id: TEST_CONN_ID,
          message: 'Done',
          complete_turn: true,
        },
      },
    })
    assert.equal(res, true)
    assert.equal(fs.existsSync(explicitReplyMarkerPath(TEST_CONN_ID)), true)
    assert.equal(fs.existsSync(turnMarkerPath(TEST_CONN_ID)), false)
  })
})
