#!/usr/bin/env node
/**
 * Cursor remote-control story emitter (item 1c480040).
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import {
  logRemoteControlStory,
  REMOTE_CONTROL_STORY_PHASES,
} from './remote-control-story.mjs'

describe('REMOTE_CONTROL_STORY_PHASES', () => {
  it('includes shared OpenCode/Cursor/server vocabulary', () => {
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('seed_filter'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('inject'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('mirror_decision'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('poll_error'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('stall'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('wake'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('create_chat'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('wait_armed'))
  })
})

describe('logRemoteControlStory', () => {
  let writes
  let restoreWrite

  beforeEach(() => {
    writes = []
    restoreWrite = mock.method(process.stderr, 'write', (chunk) => {
      writes.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    restoreWrite?.mock?.restore?.()
    mock.restoreAll()
  })

  it('writes a story JSON line to stderr (poll.log via spawn redirect)', () => {
    logRemoteControlStory({
      phase: 'inject',
      outcome: 'delivered',
      connectionId: 'conn-1',
      agent: 'Cursor',
      reason: 'owner_commands',
      data: { commands: 2 },
    })
    assert.equal(writes.length, 1)
    assert.match(writes[0], /^story \{/)
    const json = JSON.parse(writes[0].replace(/^story\s+/, '').trim())
    assert.equal(json.type, 'remote_control_story')
    assert.equal(json.phase, 'inject')
    assert.equal(json.outcome, 'delivered')
    assert.equal(json.connectionId, 'conn-1')
    assert.equal(json.agent, 'Cursor')
    assert.equal(json.reason, 'owner_commands')
    assert.equal(json.commands, 2)
  })
})
