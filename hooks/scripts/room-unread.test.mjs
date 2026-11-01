#!/usr/bin/env node
/**
 * What this agent has not read in its room (item 55feedd7 / a5fe5e8a, decision c4c6190f).
 * Run: node --test hooks/scripts/room-unread.test.mjs
 *
 * Every test builds a throwaway home: a bond, a connection file, the poller's
 * transcript and its state. Nothing reads or writes the real ~/.devspec.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { writePrivateJson, writePrivateText } from './private-state.mjs'
import { projectInput } from './project-input.mjs'
import {
  isRealMessage,
  messageVersion,
  postToolNotice,
  prePostHold,
  presentedStatePath,
  readCommand,
  readPage,
  readStatePath,
  wakeNotice,
} from './room-unread.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'room-unread.mjs')
const CONN = '11111111-2222-4333-8444-555555555555'
const SESSION = '66666666-7777-4888-9999-000000000000'
const CONVERSATION = 'conv-abc'
const ME = 'Cursor · Amber Dolphin'

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

let seq = 0
const msg = (fields = {}) => {
  seq += 1
  return {
    seq,
    at: `2026-10-06T13:${String(seq).padStart(2, '0')}:00.000Z`,
    message_id: `m-${seq}`,
    from: { label: 'Ali Price', kind: 'human' },
    to: null,
    text: `message ${seq}`,
    attachments: [],
    state: 'final',
    ...fields,
  }
}
const presence = () =>
  msg({ from: { label: 'System', kind: 'system' }, text: '🔗 **Pi · Keen Puma** joined the session.' })
const mine = (text = 'my reply') =>
  msg({ from: { label: `${ME} (Ali Price)`, kind: 'agent', you: true }, text })
const pi = (fields = {}) => msg({ from: { label: 'Pi · Keen Puma (Ali Price)', kind: 'agent' }, ...fields })

/** A home with this conversation bonded to a connection attached to the room. */
function makeHome(lines, { enabled = true, sessionId = SESSION, bond = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-unread-'))
  roots.push(home)
  const remote = path.join(home, '.devspec', 'remote-control')
  if (bond) {
    writePrivateJson(path.join(remote, 'local', 'cursor', `${CONVERSATION}.json`), {
      connection_id: CONN,
    })
  }
  writePrivateJson(path.join(remote, 'connections', `${CONN}.json`), {
    connection_id: CONN,
    local_id: bond ? CONVERSATION : 'other-conv',
    agent_name: 'Cursor',
    enabled,
    session_id: sessionId,
  })
  writePrivateJson(path.join(remote, 'connections', `${CONN}.${SESSION}.transcript-state.json`), {
    version: 1,
    self_label: ME,
  })
  const room = { home, dir: path.join(remote, 'connections') }
  writeRoom(room, lines)
  return room
}

function writeRoom(room, lines) {
  const file = path.join(room.dir, `${CONN}.${SESSION}.transcript.jsonl`)
  writePrivateText(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const later = new Date(Date.now() + (room.ticks = (room.ticks ?? 0) + 1) * 1000)
  fs.utimesSync(file, later, later)
}

const env = { CURSOR_CONVERSATION_ID: CONVERSATION }
const hookInput = (tool = 'Read', extra = {}) => ({
  conversation_id: CONVERSATION,
  tool_name: tool,
  ...extra,
})
const postTool = (room, input = hookInput()) =>
  postToolNotice({ input, env, home: room.home, scriptPath: SCRIPT })
const prePost = (room, input = hookInput('MCP:devspec__post_session_message')) =>
  prePostHold({ input, env, home: room.home, scriptPath: SCRIPT })
const readerRun = (room) =>
  spawnSync(process.execPath, [SCRIPT, 'read', '--connection-id', CONN], {
    env: { ...process.env, HOME: room.home, DEVSPEC_REMOTE_CONNECTIONS_DIR: room.dir },
    encoding: 'utf8',
  })
const parseReader = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const noticeOf = (out) =>
  JSON.parse(JSON.parse(out).hookSpecificOutput.additionalContext.split('\n')[1])
const readFile = (room) => readStatePath(CONN, SESSION, room.dir)

describe('what counts is what a person sees, never the row state', () => {
  it('counts text from a person, another agent or Dev, whatever its state', () => {
    assert.equal(isRealMessage(msg()), true)
    assert.equal(
      isRealMessage(pi({ state: 'in_progress', text: 'Working on it: found the cause' })),
      true,
      'a trail bubble showing speech',
    )
    assert.equal(isRealMessage(msg({ from: { label: 'Dev', kind: 'ai' } })), true)
    assert.equal(
      isRealMessage(msg({ text: '', attachments: [{ filename: 'shot.png' }] })),
      true,
      'files are something to see',
    )
  })

  it('never counts system lines, empty or deleted rows, or my own messages', () => {
    assert.equal(isRealMessage(presence()), false)
    assert.equal(isRealMessage(pi({ text: '' })), false, 'the empty final row Pi leaves behind')
    assert.equal(
      isRealMessage(pi({ state: 'in_progress', text: '  ' })),
      false,
      'an empty Working bubble',
    )
    assert.equal(isRealMessage(msg({ state: 'deleted', text: null })), false)
    assert.equal(isRealMessage(mine()), false)
  })

  it('gives equal content an equal version, so a bubble that finishes as read is not news', () => {
    const live = pi({ state: 'in_progress', text: 'done' })
    assert.equal(messageVersion(live), messageVersion({ ...live, state: 'final' }))
    assert.notEqual(messageVersion(live), messageVersion({ ...live, text: 'done, and more' }))
  })
})

describe('the mid-turn notice (PostToolUse)', () => {
  it('tells once, as counts, and never carries a body', () => {
    const lines = [
      presence(),
      msg({ text: 'please look at the deploy' }),
      pi({ text: 'secret plan details' }),
      pi({ text: '' }),
      mine(),
    ]
    const room = makeHome(lines)
    const out = postTool(room)
    assert.ok(out, 'something new arrived, so it speaks')
    const notice = noticeOf(out)
    assert.deepEqual(Object.keys(notice).sort(), [
      'by',
      'oldest_at',
      'read_with',
      'to_you',
      'unread',
      'updated',
    ])
    assert.equal(notice.unread, 2)
    assert.equal(notice.updated, 0)
    assert.equal(notice.to_you, 0)
    assert.deepEqual(notice.by, { 'Ali Price': 1, 'Pi · Keen Puma (Ali Price)': 1 })
    assert.equal(notice.oldest_at, lines[1].at)
    assert.equal(notice.read_with, readCommand(CONN, SCRIPT))
    assert.ok(
      !out.includes('please look at the deploy') && !out.includes('secret plan details'),
      'counts only',
    )
    assert.equal(postTool(room), null)
  })

  it('stays quiet when the room changed only by my own message, and speaks for the next real one', () => {
    const lines = [msg()]
    const room = makeHome(lines)
    assert.ok(postTool(room))
    lines.push(mine())
    writeRoom(room, lines)
    assert.equal(postTool(room), null)
    lines.push(pi({ text: 'heads-up: I moved the file you are editing' }))
    writeRoom(room, lines)
    const notice = noticeOf(postTool(room))
    assert.equal(notice.unread, 2, 'the count is everything unread, not just the newest')
  })

  it('counts a message addressed to me, and a command delivered to me', () => {
    const room = makeHome([
      pi({ to: ME }),
      msg({ to: ME, delivered_as_command: { authority: 'owner' } }),
      msg({ to: 'Pi · Keen Puma' }),
    ])
    assert.equal(noticeOf(postTool(room)).to_you, 2)
  })

  it('is silent for a subagent, and for a conversation with no attached room', () => {
    assert.equal(postTool(makeHome([msg()]), hookInput('Read', { agent_id: 'sub-1' })), null)
    assert.equal(postTool(makeHome([msg()], { bond: false })), null)
    assert.equal(postTool(makeHome([msg()], { enabled: false })), null)
    assert.equal(postTool(makeHome([msg()], { sessionId: null })), null)
  })
})

describe('the reader is the only thing that marks a message read', () => {
  it('hands over unread messages oldest first, whole, and marks exactly those', () => {
    const lines = [
      presence(),
      msg({ text: 'first' }),
      pi({ text: 'second' }),
      mine(),
      msg({ text: 'third', to: ME }),
    ]
    const room = makeHome(lines)
    const run = readerRun(room)
    assert.equal(run.status, 0, run.stderr)
    const [header, ...entries] = parseReader(run.stdout)
    assert.deepEqual(header.room_messages, {
      returned: 3,
      unread: 3,
      updated: 0,
      remaining: 0,
      next: null,
    })
    assert.deepEqual(
      entries.map((entry) => entry.text),
      ['first', 'second', 'third'],
    )
    assert.equal(entries[2].for_you, true)
    const read = JSON.parse(fs.readFileSync(readFile(room), 'utf8')).read
    assert.deepEqual(
      Object.keys(read).sort(),
      [lines[1], lines[2], lines[4]].map((line) => line.message_id).sort(),
    )
    assert.equal(parseReader(readerRun(room).stdout)[0].note, 'Nothing unread.')
  })

  it('a wake, a notice, a hold and my own reply move nothing', () => {
    const lines = [msg()]
    const room = makeHome(lines)
    assert.ok(
      wakeNotice({ connectionId: CONN, sessionId: SESSION, home: room.home, scriptPath: SCRIPT }),
    )
    lines.push(pi())
    writeRoom(room, lines)
    assert.ok(postTool(room))
    lines.push(msg())
    writeRoom(room, lines)
    assert.ok(prePost(room))
    lines.push(mine())
    writeRoom(room, lines)
    assert.equal(
      fs.existsSync(readFile(room)),
      false,
      'no read record until the reader hands something over',
    )
    const [header] = parseReader(readerRun(room).stdout)
    assert.equal(header.room_messages.unread, 3)
  })

  it('reports a message that changed after I read it as updated, with its current text', () => {
    const live = pi({ state: 'in_progress', text: 'Investigating' })
    const lines = [live]
    const room = makeHome(lines)
    readerRun(room)
    lines[0] = { ...live, state: 'final' }
    writeRoom(room, lines)
    assert.equal(postTool(room), null)
    lines[0] = {
      ...live,
      state: 'final',
      text: 'Investigating. Found it: the migration number clashes with yours.',
    }
    writeRoom(room, lines)
    const notice = noticeOf(postTool(room))
    assert.equal(notice.unread, 0)
    assert.equal(notice.updated, 1)
    const [header, entry] = parseReader(readerRun(room).stdout)
    assert.equal(header.room_messages.updated, 1)
    assert.equal(entry.updated, true)
    assert.equal(entry.text, lines[0].text)
  })

  it('pages a backlog with a total and the way to the rest, never cutting a message', () => {
    const lines = [
      msg({ text: 'a'.repeat(400) }),
      msg({ text: 'b'.repeat(400) }),
      msg({ text: 'c'.repeat(400) }),
    ]
    const first = readPage({
      lines,
      read: {},
      selfLabel: ME,
      budget: 1_000,
      writeOverflow: () => assert.fail('nothing is too big'),
    })
    assert.equal(first.printed.length, 1)
    assert.equal(first.total, 3)
    assert.ok(JSON.parse(first.printed[0]).text === 'a'.repeat(400), 'whole')
    const second = readPage({
      lines,
      read: first.read,
      selfLabel: ME,
      budget: 1_000,
      writeOverflow: () => assert.fail(),
    })
    assert.equal(JSON.parse(second.printed[0]).text, 'b'.repeat(400))
    assert.equal(second.total, 2)
  })

  it('hands over a message too long for a page as a file, whole', () => {
    const huge = 'z'.repeat(5_000)
    const lines = [msg({ text: huge })]
    let stored = null
    const page = readPage({
      lines,
      read: {},
      selfLabel: ME,
      budget: 1_000,
      writeOverflow: (line) => {
        stored = line.text
        return '/tmp/x.txt'
      },
    })
    const entry = JSON.parse(page.printed[0])
    assert.equal(entry.text, null)
    assert.equal(entry.text_chars, 5_000)
    assert.equal(entry.text_file, '/tmp/x.txt')
    assert.equal(stored, huge)
    assert.ok(page.read[lines[0].message_id], 'handed over, so read')
  })
})

describe('the pre-post check (PreToolUse on post_session_message)', () => {
  it('holds a post once for news it was never told about, then lets it through', () => {
    const lines = [msg()]
    const room = makeHome(lines)
    postTool(room)
    lines.push(pi({ text: 'Colorful Llama fixed it before I got there' }))
    writeRoom(room, lines)
    const held = JSON.parse(prePost(room)).hookSpecificOutput
    assert.equal(held.permissionDecision, 'deny')
    assert.ok(held.permissionDecisionReason.includes('"unread":2'))
    assert.ok(!held.permissionDecisionReason.includes('Colorful Llama fixed it'), 'counts only')
    assert.equal(prePost(room), null, 'once per batch, so it can never loop')
  })

  it('holds post_session_message once in projectInput("pre", ...) when unpresented room messages exist', () => {
    const lines = [msg({ text: 'Hold this post once' })]
    const room = makeHome(lines)
    const first = projectInput(
      'pre',
      {
        conversation_id: CONVERSATION,
        tool_name: 'MCP:devspec__post_session_message',
        tool_input: { message: 'My reply', complete_turn: true },
      },
      { home: room.home, env },
    )
    assert.equal(first?.permission, 'deny')
    assert.ok(first?.agent_message?.includes('"unread":1'))

    const second = projectInput(
      'pre',
      {
        conversation_id: CONVERSATION,
        tool_name: 'MCP:devspec__post_session_message',
        tool_input: { message: 'My reply', complete_turn: true },
      },
      { home: room.home, env },
    )
    assert.notEqual(second?.permission, 'deny')
  })

  it('lets a post straight through when nothing is unread, or everything was already told', () => {
    const room = makeHome([mine()])
    assert.equal(prePost(room), null)
    const told = makeHome([msg()])
    assert.ok(postTool(told))
    assert.equal(prePost(told), null, 'a hold for news it already has is only friction')
    const woken = makeHome([msg({ to: ME, delivered_as_command: { authority: 'owner' } })])
    assert.ok(
      wakeNotice({ connectionId: CONN, sessionId: SESSION, home: woken.home, scriptPath: SCRIPT }),
    )
    assert.equal(prePost(woken), null, 'answering the command it was woken with is never held')
  })

  it('looks only at room posts', () => {
    assert.equal(prePost(makeHome([msg()]), hookInput('MCP:devspec__get_task')), null)
    assert.ok(
      prePost(makeHome([msg()]), hookInput('mcp__devspec__post_session_message')),
      'either server name',
    )
  })

  it('keeps what it was told apart from what it read', () => {
    const room = makeHome([msg()])
    prePost(room)
    assert.ok(fs.existsSync(presentedStatePath(CONN, SESSION, room.dir)))
    assert.equal(fs.existsSync(readFile(room)), false)
  })
})

describe('the read command', () => {
  it('quotes a plugin path with spaces or quotes so the shell runs it as written', () => {
    const command = readCommand(CONN, "/x/DevSpec Autopilot Plugin/it's/room-unread.mjs")
    const run = spawnSync('sh', ['-c', `printf '%s\\n' ${command.replace(/^node /, '')}`], {
      encoding: 'utf8',
    })
    assert.deepEqual(run.stdout.trim().split('\n'), [
      "/x/DevSpec Autopilot Plugin/it's/room-unread.mjs",
      'read',
      '--connection-id',
      CONN,
    ])
  })
})
