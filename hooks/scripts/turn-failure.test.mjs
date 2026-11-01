/**
 * Item 9a850303: a Cursor turn that errored or was stopped tells the room, once, and
 * only for a room command nobody has answered yet.
 * Run: node --test hooks/scripts/turn-failure.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { lastTurnError, parseTurnFailure, postTurnFailure, turnFailureMessage } from './turn-failure.mjs'
import { appendRequestEvent, readRequestState } from './requests.mjs'

// What Cursor CLI 2026.10.19 wrote for an account at its usage limit (2026-10-31).
const LIMIT = "You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more."
const CONN = '11111111-2222-4333-8444-555555555555'
const COMMAND = '66666666-7777-4888-8999-aaaaaaaaaaaa'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-turn-failure-'))
}

function transcript(dir, lines) {
  const file = path.join(dir, 'transcript.jsonl')
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return file
}

function stopInput(status, transcriptPath) {
  return JSON.stringify({ hook_event_name: 'stop', status, loop_count: 0, conversation_id: 'c', transcript_path: transcriptPath })
}

describe('reading the failure', () => {
  it("takes Cursor's error from the turn's turn_ended line", () => {
    const dir = scratch()
    try {
      const file = transcript(dir, [
        { type: 'turn_ended', status: 'completed' },
        { role: 'user', message: 'hi' },
        { type: 'turn_ended', status: 'error', error: LIMIT },
      ])
      assert.equal(lastTurnError(file), LIMIT)
      assert.deepEqual(parseTurnFailure(stopInput('error', file)), { status: 'error', text: LIMIT })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an error with no text when the transcript has none or is missing', () => {
    const dir = scratch()
    try {
      const file = transcript(dir, [{ type: 'turn_ended', status: 'error' }])
      assert.deepEqual(parseTurnFailure(stopInput('error', file)), { status: 'error', text: null })
      assert.deepEqual(parseTurnFailure(stopInput('error', path.join(dir, 'gone.jsonl'))), { status: 'error', text: null })
      assert.deepEqual(parseTurnFailure(stopInput('error', null)), { status: 'error', text: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never borrows an earlier turn\'s error when the last turn ended cleanly', () => {
    const dir = scratch()
    try {
      const file = transcript(dir, [
        { type: 'turn_ended', status: 'error', error: 'old failure' },
        { type: 'turn_ended', status: 'completed' },
      ])
      assert.equal(lastTurnError(file), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads aborted, and nothing for a completed turn', () => {
    assert.deepEqual(parseTurnFailure(stopInput('aborted', null)), { status: 'aborted', text: null })
    assert.equal(parseTurnFailure(stopInput('completed', null)), null)
    assert.equal(parseTurnFailure('not json'), null)
  })
})

describe('the room message', () => {
  it("quotes Cursor's words and says where to fix it", () => {
    const message = turnFailureMessage({ status: 'error', text: `${LIMIT}\nSecond line` }, 'Cursor')
    assert.match(message, /^Cursor couldn't finish this\. It said:\n\n> You've hit your usage limit/)
    assert.match(message, /\n> Second line\n/)
    assert.match(message, /on the computer it's running on\. Once that's sorted, send your message again\.$/)
  })

  it('still says it stopped when there is no text', () => {
    assert.match(turnFailureMessage({ status: 'error', text: null }, 'Cursor'), /couldn't finish this.*terminal/)
  })

  it('says a stopped turn was stopped', () => {
    assert.match(turnFailureMessage({ status: 'aborted', text: null }, 'Cursor'), /was stopped before it finished/)
  })
})

describe('answering the room command', () => {
  function withCommand(dir, extra = []) {
    appendRequestEvent(CONN, { op: 'open', id: COMMAND, kind: 'command' }, { dir })
    appendRequestEvent(CONN, { op: 'current', ref: COMMAND }, { dir })
    for (const event of extra) appendRequestEvent(CONN, event, { dir })
  }

  it('posts once with complete_turn and marks the command answered', async () => {
    const dir = scratch()
    try {
      withCommand(dir)
      const file = transcript(dir, [{ type: 'turn_ended', status: 'error', error: LIMIT }])
      const posts = []
      const answered = await postTurnFailure({
        raw: stopInput('error', file), connectionId: CONN, dir, agentName: 'Cursor',
        post: async (args) => posts.push(args),
      })
      assert.deepEqual(answered, [COMMAND])
      assert.equal(posts.length, 1)
      assert.equal(posts[0].complete_turn, true)
      assert.equal(posts[0].phase, undefined, 'an error-phase post is dropped when no bubble is open')
      assert.ok(posts[0].message.includes(`> ${LIMIT}`))
      assert.equal(readRequestState(CONN, { dir }).open.get(COMMAND).answered, true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('posts nothing for an answered command, a typed prompt, or a completed turn', async () => {
    const cases = [
      { setup: (dir) => withCommand(dir, [{ op: 'answered', id: COMMAND }]), status: 'error' },
      {
        setup: (dir) => {
          appendRequestEvent(CONN, { op: 'open', id: COMMAND, kind: 'typed_prompt' }, { dir })
          appendRequestEvent(CONN, { op: 'current', ref: COMMAND }, { dir })
        },
        status: 'error',
      },
      { setup: (dir) => withCommand(dir), status: 'completed' },
    ]
    for (const { setup, status } of cases) {
      const dir = scratch()
      try {
        setup(dir)
        const posts = []
        await postTurnFailure({
          raw: stopInput(status, null), connectionId: CONN, dir, agentName: 'Cursor',
          post: async (args) => posts.push(args),
        })
        assert.equal(posts.length, 0)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
