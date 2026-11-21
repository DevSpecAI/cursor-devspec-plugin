#!/usr/bin/env node
/**
 * Project recall for a command sent from a DevSpec room (turn-recall.mjs): what the
 * poller asks for, what a conversation remembers as shown, and how a wake carries the
 * recall without ever cutting it. Every test runs in its own temporary home.
 * Run: node --test hooks/scripts/turn-recall.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { fitsShellOutput, readNoteText } from './hook-context-budget.mjs'
import { nextOutput } from './devspec-wake-tail.mjs'
import { wakeLines } from './devspec-wake-file.mjs'
import {
  deliverableRecall,
  forgetShown,
  recallConversation,
  recallPollArguments,
  noteRecallReads,
  RECALL_INLINE_NOTE,
  RECALL_POINTER_NOTE,
  RECALL_UNSAVED_NOTE,
  recallWakeOut,
  rememberShown,
  SEEN_STORE,
  seenRecallKeys,
  seenStoreFile,
  settleRecallHandover,
} from './turn-recall.mjs'
import { catCall, noteFiles, noteIdIn, readCall } from '../../tests/helpers/note-reads.mjs'

/** The wake as built with its recall placed, before any whole-wake note: what the old withTurnRecall gave. */
const placed = (events, recall, opts) => recallWakeOut(events, recall, opts).full

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOOKS_JSON = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devspec-turn-recall-'))
}

const key = (n, version = 1) => `memory:00000000-0000-4000-8000-${String(n).padStart(12, '0')}:v${version}`

/** A recall as DevSpec returns it on poll_connection. */
function recall({ block = '== PROACTIVE PROJECT RECALL ==\n- [MEMORY · decision] **Ship on staging first**', keys = [key(1)] } = {}) {
  return { version: 1, formatted_block: block, seen_keys: keys, cards: keys.map((seenKey) => ({ seenKey, dedupe_key: seenKey })) }
}

/** One command's wake events, as devspec-remote-wait.mjs builds them. */
function wake(body = 'Fix the login redirect on the settings page') {
  return [
    { type: 'owner_message', from: 'Ali', authority: 'owner', message_id: 'm1', body_chars: body.length, body, session_id: 's1' },
    { type: 'room_unread', session_id: 's1', advisory: true, executable: false, unread: 1 },
    { type: 'wake', reason: 'canonical_conversational_command', session_id: 's1', count: 1 },
  ]
}

describe('the seen store: what one conversation has been shown', () => {
  it('remembers shown versions newest last, each once, and gives them back for the next poll', () => {
    const home = tempHome()
    try {
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      assert.equal(rememberShown('chat-1', [key(1), key(2)], { home }), true)
      assert.equal(rememberShown('chat-1', [key(3), key(1)], { home }), true)
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(2), key(3), key(1)])
      // An edited record is a new version, so a new key: it is not "already shown".
      assert.equal(seenRecallKeys('chat-1', { home }).includes(key(2, 2)), false)
      // Another conversation has its own store.
      assert.deepEqual(seenRecallKeys('chat-2', { home }), [])
      assert.equal(fs.statSync(seenStoreFile('chat-1', home)).mode & 0o777, 0o600)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps at most as many keys as DevSpec takes with one poll, dropping the oldest', () => {
    const home = tempHome()
    try {
      const keys = Array.from({ length: SEEN_STORE.maxKeys + 88 }, (_, n) => key(n))
      rememberShown('chat-1', keys, { home })
      const kept = seenRecallKeys('chat-1', { home })
      assert.equal(kept.length, SEEN_STORE.maxKeys)
      assert.deepEqual(kept, keys.slice(-SEEN_STORE.maxKeys))
      assert.ok(fs.statSync(seenStoreFile('chat-1', home)).size <= SEEN_STORE.maxBytes)
      assert.deepEqual(recallPollArguments('chat-1', { home }).seen_recall_versions, kept)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('never keeps a key DevSpec would refuse, so a bad key cannot make the whole poll invalid', () => {
    const home = tempHome()
    try {
      rememberShown('chat-1', [key(1), `memory:${'x'.repeat(SEEN_STORE.maxKeyChars)}:v1`, 'memory: spaced:v1', '', 7, null], { home })
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(1)])
      // Even a store edited by hand to hold one is filtered on the way out.
      const file = seenStoreFile('chat-1', home)
      const kept = JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.writeFileSync(file, JSON.stringify({ ...kept, keys: [...kept.keys, 'y'.repeat(SEEN_STORE.maxKeyChars + 1)] }))
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(1)])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('reads an unreadable or foreign store as nothing shown, which only repeats a card', () => {
    const home = tempHome()
    try {
      rememberShown('chat-1', [key(1)], { home })
      fs.writeFileSync(seenStoreFile('chat-1', home), '{not json')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      assert.deepEqual(recallPollArguments('chat-1', { home }), { turn_recall_version: 1 })
      // A store whose conversation is not this one is not this one's.
      fs.writeFileSync(seenStoreFile('chat-1', home), JSON.stringify({ version: 1, conversation: 'chat-9', keys: [key(1)] }))
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      // And a write that fails says so and throws nothing.
      fs.rmSync(path.join(home, '.devspec'), { recursive: true, force: true })
      fs.writeFileSync(path.join(home, '.devspec'), 'a file where the folder should be')
      assert.equal(rememberShown('chat-1', [key(2)], { home }), false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('removes a conversation untouched for 30 days when another conversation first writes its store', () => {
    const home = tempHome()
    try {
      rememberShown('old-chat', [key(1)], { home })
      rememberShown('recent-chat', [key(2)], { home })
      const now = Date.now()
      const old = new Date(now - SEEN_STORE.ttlMs - 60_000)
      fs.utimesSync(seenStoreFile('old-chat', home), old, old)
      rememberShown('new-chat', [key(3)], { home, now })
      assert.equal(fs.existsSync(seenStoreFile('old-chat', home)), false)
      assert.deepEqual(seenRecallKeys('recent-chat', { home }), [key(2)])
      assert.deepEqual(seenRecallKeys('new-chat', { home }), [key(3)])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('belongs to the Cursor chat the connection is bound to, or the connection when the chat is not known', () => {
    assert.equal(recallConversation({ local_id: 'chat-1' }, 'conn-1'), 'chat-1')
    assert.equal(recallConversation({ local_id: '  ' }, 'conn-1'), 'connection:conn-1')
    assert.equal(recallConversation(null, 'conn-1'), 'connection:conn-1')
    assert.equal(recallConversation(null, null), null)
  })

  it('is forgotten when Cursor compacts the conversation, as hooks.json has Cursor run the preCompact hook', () => {
    const home = tempHome()
    try {
      rememberShown('chat-1', [key(1)], { home })
      rememberShown('chat-2', [key(2)], { home })
      const entries = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.preCompact
      const runHooks = (input) =>
        entries.map((entry) =>
          spawnSync('sh', ['-c', entry.command], {
            input,
            env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
            encoding: 'utf8',
          }))
      for (const run of runHooks(JSON.stringify({ conversation_id: 'chat-1', trigger: 'auto' }))) {
        assert.equal(run.status, 0, run.stderr)
        assert.equal(run.stdout, '')
      }
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      assert.deepEqual(seenRecallKeys('chat-2', { home }), [key(2)])
      // A hook input it cannot read changes nothing and still exits cleanly.
      for (const run of runHooks('nope')) assert.equal(run.status, 0)
      assert.deepEqual(seenRecallKeys('chat-2', { home }), [key(2)])
      forgetShown('chat-2', { home })
      assert.deepEqual(seenRecallKeys('chat-2', { home }), [])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('what the poller asks DevSpec for', () => {
  it('negotiates turn recall on every poll, and sends the versions shown only once there are some', () => {
    const home = tempHome()
    try {
      assert.deepEqual(recallPollArguments('chat-1', { home }), { turn_recall_version: 1 })
      rememberShown('chat-1', [key(1)], { home })
      assert.deepEqual(recallPollArguments('chat-1', { home }), { turn_recall_version: 1, seen_recall_versions: [key(1)] })
      assert.deepEqual(recallPollArguments(null, { home }), { turn_recall_version: 1 })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the recall DevSpec returns', () => {
  it('is handed over exactly as DevSpec wrote it, with the keys of the records in it', () => {
    const block = '\n== PROACTIVE PROJECT RECALL ==\n  - [REQUIREMENT] **Never cut**  \n'
    assert.deepEqual(deliverableRecall(recall({ block, keys: [key(1), key(2)] })), {
      version: 1,
      formatted_block: block,
      seen_keys: [key(1), key(2)],
    })
    // Keys from the cards when DevSpec named none.
    assert.deepEqual(deliverableRecall({ ...recall(), seen_keys: [] }).seen_keys, [key(1)])
  })

  it('is nothing to hand over when DevSpec found nothing, ran out of time, or sent something unknown', () => {
    assert.equal(deliverableRecall({ version: 1, cards: [], formatted_block: '', seen_keys: [] }), null)
    assert.equal(deliverableRecall({ version: 1, cards: [], formatted_block: '', seen_keys: [], degraded_timeout: true, degraded_reason: 'timeout' }), null)
    assert.equal(deliverableRecall({ ...recall(), version: 2 }), null)
    assert.equal(deliverableRecall({ ...recall(), formatted_block: '   \n' }), null)
    assert.equal(deliverableRecall('== PROACTIVE PROJECT RECALL =='), null)
    assert.equal(deliverableRecall(null), null)
  })
})

describe('a wake that carries the recall', () => {
  it('puts it right after the command, ahead of the room notes and the wake line, when the whole wake still reaches the agent whole', () => {
    const home = tempHome()
    try {
      const events = placed(wake(), recall(), { home })
      assert.deepEqual(events.map((event) => event.type), ['owner_message', 'turn_recall', 'room_unread', 'wake'])
      const carried = events[1]
      assert.equal(carried.block, recall().formatted_block)
      assert.equal(carried.note, RECALL_INLINE_NOTE)
      assert.ok(fitsShellOutput(wakeLines(events)))
      assert.equal(fs.existsSync(path.join(home, '.devspec', 'notes')), false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('follows an automation run the same way', () => {
    const home = tempHome()
    try {
      const run = [
        { type: 'automation_dispatch', session_id: null, dispatch: { run_id: 'r1' }, instruction: 'Run the nightly dependency review' },
        { type: 'wake', reason: 'automation_dispatch', session_id: null, count: 1 },
      ]
      assert.deepEqual(placed(run, recall(), { home }).map((event) => event.type), ['automation_dispatch', 'turn_recall', 'wake'])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('carries none on a wake with no command: a check job or a notice', () => {
    const home = tempHome()
    try {
      const checkJob = [
        { type: 'check_job', check_job_id: 'j1', instruction: 'Rule this check' },
        { type: 'wake', reason: 'check_job', count: 1 },
      ]
      const notice = [
        { type: 'system_notice', notice_id: 'n1', kind: 'server_notice', content: 'A finding on your work' },
        { type: 'wake', reason: 'exact_connection_system_notice', count: 1 },
      ]
      assert.deepEqual(placed(checkJob, recall(), { home }), checkJob)
      assert.deepEqual(placed(notice, recall(), { home }), notice)
      assert.equal(settleRecallHandover('chat-1', recallWakeOut(checkJob, recall(), { home }), { turn_recall: recall() }, { home }), 'none')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      // And a wake with no recall is left exactly as it was.
      assert.deepEqual(placed(wake(), null, { home }), wake())
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('hands an oversize recall over whole in a note, never cut, and the wake with its pointer still reaches the agent whole', () => {
    const home = tempHome()
    try {
      // Every requirement that qualifies is shown, uncapped: a recall can outgrow one output.
      const lines = Array.from({ length: 400 }, (_, n) => `- [REQUIREMENT] **Requirement ${n}** — ${'governs the change; '.repeat(4)}(get_requirement({ id: "${n}" }))`)
      const block = `== PROACTIVE PROJECT RECALL ==\n${lines.join('\n')}`
      assert.ok(block.length > 40_000)
      const events = placed(wake(), recall({ block }), { home })
      const carried = events.find((event) => event.type === 'turn_recall')
      assert.equal(carried.block, undefined)
      assert.match(carried.read, /^cat ~\/\.devspec\/notes\/[0-9a-f]{16}\.md$/)
      assert.ok(noteFiles(home, noteIdIn(carried.read)).length > 1, 'in parts that each reach the agent whole')
      assert.equal(carried.note, RECALL_POINTER_NOTE)
      const id = /notes\/([0-9a-f]{16})\.md/.exec(carried.read)[1]
      assert.equal(readNoteText(id, { home }), block)
      assert.ok(fitsShellOutput(wakeLines(events)))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('goes to a note when the command itself leaves too little room, so it never pushes the wake past what Cursor shows', () => {
    const home = tempHome()
    try {
      const body = 'Here is the whole failing log:\n' + 'TypeError at render (app.tsx:12)\n'.repeat(530)
      const lines = Array.from({ length: 16 }, (_, n) => `- [MEMORY · decision] **Decision ${n}** — the settings page keeps its redirect (get_memory({ id: "${n}" }))`)
      const block = `== PROACTIVE PROJECT RECALL ==\n${lines.join('\n')}`
      // The command fits on its own, and the recall would fit a wake on its own, but not both.
      assert.ok(fitsShellOutput(wakeLines(wake(body))))
      assert.ok(fitsShellOutput(wakeLines(placed(wake(), recall({ block }), { home }))))
      assert.ok(wakeLines(wake(body)).length + block.length > 20_000)
      const events = placed(wake(body), recall({ block }), { home })
      const carried = events.find((event) => event.type === 'turn_recall')
      assert.equal(carried.block, undefined)
      assert.equal(readNoteText(/notes\/([0-9a-f]{16})\.md/.exec(carried.read)[1], { home }), block)
      assert.ok(fitsShellOutput(wakeLines(events)))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('counts bytes as well as characters: a recall in a non-Latin script goes to a note before Cursor would move the output to a file', () => {
    const home = tempHome()
    try {
      // 14,000 characters, but over 40,000 bytes once written into the wake.
      const block = `== PROACTIVE PROJECT RECALL ==\n${'要件は変更を管理します。'.repeat(1_160)}`
      assert.ok(block.length < 20_000 && Buffer.byteLength(block) > 40_000)
      const events = placed(wake(), recall({ block }), { home })
      const carried = events.find((event) => event.type === 'turn_recall')
      assert.equal(carried.block, undefined)
      assert.equal(readNoteText(/notes\/([0-9a-f]{16})\.md/.exec(carried.read)[1], { home }), block)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('when no note can be written: a command that fits goes with one short line saying its recall could not be saved, and nothing is shown', () => {
    const home = tempHome()
    try {
      fs.writeFileSync(path.join(home, '.devspec'), 'a file where the folder should be')
      const block = `== PROACTIVE PROJECT RECALL ==\n${'x'.repeat(30_000)}`
      const batch = { turn_recall: recall({ block }) }
      const out = recallWakeOut(wake(), batch.turn_recall, { home })
      assert.equal(out.recall, 'unsaved')
      assert.deepEqual(out.events.map((event) => event.type), ['owner_message', 'turn_recall', 'room_unread', 'wake'])
      assert.deepEqual(out.events[1], { type: 'turn_recall', note: RECALL_UNSAVED_NOTE })
      // The line is no longer than the pointer it stands in for, so it fits wherever that would have.
      const pointer = { type: 'turn_recall', read: `cat ~/.devspec/notes/${'0'.repeat(16)}.md`, note: RECALL_POINTER_NOTE }
      assert.ok(JSON.stringify(out.events[1]).length <= JSON.stringify(pointer).length)
      assert.deepEqual(out.events.filter((event) => event.type !== 'turn_recall'), wake(), 'the command as it is')
      assert.equal(settleRecallHandover('chat-1', out, batch, { home }), 'none')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      // A command that fits, with no recall, goes as it is: it needs no note.
      assert.deepEqual(recallWakeOut(wake(), null, { home }).events, wake())
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('when no note can be written: only a command too long to fit on its own is held; one that fits goes inline with its recall in a wake of its own, or a line that it could not be saved', () => {
    const home = tempHome()
    try {
      fs.writeFileSync(path.join(home, '.devspec'), 'a file where the folder should be')
      // 19,990 alone fits: the command goes as it is; a recall that fits a wake of its own follows it, needing no note.
      const near = recallWakeOut(wakeOfLength(19_990), mediumRecall(), { home })
      assert.equal(near.recall, 'separate')
      assert.deepEqual(near.events, wakeOfLength(19_990))
      // One too long even for a wake of its own needed a note: it gives way to the line, in that wake.
      const tooLong = recallWakeOut(wakeOfLength(19_990), recall({ block: `== PROACTIVE PROJECT RECALL ==\n${'r'.repeat(25_000)}` }), { home })
      assert.equal(tooLong.recall, 'unsaved')
      assert.deepEqual(tooLong.events, wakeOfLength(19_990))
      assert.deepEqual(tooLong.recallWake, [{ type: 'turn_recall', for: 'm1', note: RECALL_UNSAVED_NOTE }])
      // 25,300 does not fit on its own: held, with or without recall.
      for (const each of [null, mediumRecall()]) {
        const over = recallWakeOut(wakeOfLength(25_300), each, { home })
        assert.ok(over.held instanceof Error)
        assert.equal(over.wakes, undefined)
      }
      // Once notes can be written again, it goes out whole in its note.
      fs.rmSync(path.join(home, '.devspec'), { force: true })
      assert.equal(recallWakeOut(wakeOfLength(25_300), mediumRecall(), { home }).recall, 'whole')
      assert.equal(recallWakeOut(wakeOfLength(25_300), null, { home }).events[0].type, 'wake_in_note')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

/** One wake whose JSON lines are exactly `chars` characters long, its command body padded to get there. */
function wakeOfLength(chars, filler = 'a') {
  const bare = wakeLines(wake('')).length
  // body_chars grows by a digit or so as the body grows: settle it in a few passes.
  let body = filler.repeat(Math.max(0, chars - bare))
  for (let pass = 0; pass < 4; pass += 1) {
    const over = wakeLines(wake(body)).length - chars
    if (over === 0) break
    body = filler.repeat(Math.max(0, body.length - over))
  }
  const events = wake(body)
  assert.equal(wakeLines(events).length, chars)
  return events
}

const smallRecall = () => recall()
const mediumRecall = () => recall({
  block: `== PROACTIVE PROJECT RECALL ==\n${Array.from({ length: 16 }, (_, n) => `- [MEMORY · decision] **Decision ${n}** — the settings page keeps its redirect (get_memory({ id: "${n}" }))`).join('\n')}`,
})
const largeRecall = () => recall({
  block: `== PROACTIVE PROJECT RECALL ==\n${Array.from({ length: 400 }, (_, n) => `- [REQUIREMENT] **Requirement ${n}** — ${'governs the change; '.repeat(4)}`).join('\n')}`,
})

describe('a command wake near Cursor\'s limit', () => {
  /** The note a `wake_in_note` line points to, read back whole. */
  const wakeNote = (out, home) => readNoteText(noteIdIn(out.events[0].read), { home })

  it('measured at the boundary: a 19,990-character command goes inline in its own wake, byte for byte, and its recall follows as the next wake, and the reader prints both whole, in order', () => {
    const home = tempHome()
    try {
      const command = wakeOfLength(19_990)
      for (const [each, route] of [[smallRecall(), 'separate'], [mediumRecall(), 'separate'], [largeRecall(), 'separate_pointer']]) {
        const out = recallWakeOut(command, each, { home })
        assert.equal(out.recall, route)
        assert.equal(out.note, null)
        assert.deepEqual(out.events, command, 'the command, byte for byte, in its own wake')
        assert.equal(out.recallWake.length, 1)
        const [carried] = out.recallWake
        assert.equal(carried.type, 'turn_recall')
        assert.equal(carried.for, 'm1', 'naming the command it belongs to')
        if (route === 'separate') assert.equal(carried.block, each.formatted_block)
        else assert.equal(readNoteText(noteIdIn(carried.read), { home }), each.formatted_block)
        for (const wake of out.wakes) assert.ok(fitsShellOutput(wakeLines(wake)))
        // As the wake file holds them: the reader prints the command's wake, then the recall's.
        const file = out.wakes.map(wakeLines).join('')
        const first = nextOutput(file)
        assert.equal(first, wakeLines(command))
        assert.equal(nextOutput(file.slice(first.length)), wakeLines(out.recallWake))
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves a wake that fits unchanged, and keeps any wake too long on its own whole in a note, with or without recall', () => {
    const home = tempHome()
    try {
      assert.deepEqual(recallWakeOut(wake(), null, { home }), { wakes: [wake()], events: wake(), recallWake: null, note: null, full: wake(), recall: 'none' })
      const notice = [{ type: 'system_notice', notice_id: 'n1', content: 'finding '.repeat(4_000) }, { type: 'wake' }]
      const out = recallWakeOut(notice, null, { home })
      assert.deepEqual(out.events[0].carries, ['system_notice', 'wake'])
      assert.equal(wakeNote(out, home), wakeLines(notice))
      // 25,300 with recall: the command does not fit on its own, so it and its recall go whole into one note.
      const over = recallWakeOut(wakeOfLength(25_300), mediumRecall(), { home })
      assert.equal(over.recall, 'whole')
      assert.equal(wakeNote(over, home), wakeLines(over.full))
      assert.ok(wakeNote(over, home).includes(JSON.stringify(wakeOfLength(25_300)[0])))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('across every size to past the limit: each route only when the cheaper one does not fit, the command inline whenever it fits on its own, and every wake within the limit', () => {
    const home = tempHome()
    try {
      const seen = { inline: 0, pointer: 0, separate: 0, separate_pointer: 0, whole: 0 }
      const pointerEvent = { type: 'turn_recall', read: `cat ~/.devspec/notes/${'0'.repeat(16)}.md`, note: RECALL_POINTER_NOTE }
      for (let chars = 17_000; chars <= 21_000; chars += 97) {
        const command = wakeOfLength(chars)
        for (const each of [smallRecall(), mediumRecall(), largeRecall()]) {
          const out = recallWakeOut(command, each, { home })
          seen[out.recall] += 1
          for (const wake of out.wakes) assert.ok(fitsShellOutput(wakeLines(wake)), `a ${chars}-character command gave a wake past the limit`)
          const inlineEvent = { type: 'turn_recall', note: RECALL_INLINE_NOTE, block: each.formatted_block }
          const wouldFit = (event) => fitsShellOutput(wakeLines([command[0], event, ...command.slice(1)]))
          if (out.recall !== 'inline') assert.equal(wouldFit(inlineEvent), false, `inline would have fitted at ${chars}`)
          if (out.recall.startsWith('separate') || out.recall === 'whole') assert.equal(wouldFit(pointerEvent), false, `the pointer would have fitted at ${chars}`)
          if (out.recall === 'whole') {
            assert.equal(fitsShellOutput(wakeLines(command)), false, `the command fitted on its own at ${chars}`)
            assert.equal(wakeNote(out, home), wakeLines(out.full))
          } else {
            // The command's own events, untouched and in order, in its wake.
            assert.deepEqual(out.events.filter((event) => event.type !== 'turn_recall'), command)
          }
        }
      }
      for (const [route, count] of Object.entries(seen)) assert.ok(count > 0, `${route} never used: ${JSON.stringify(seen)}`)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('counts the bytes of the whole wake too: a non-Latin command near 40,000 bytes never goes out past them', () => {
    const home = tempHome()
    try {
      const body = '要件は変更を管理します。'.repeat(1_090) // ~13,000 characters, ~39,240 bytes
      const command = wake(body)
      assert.ok(fitsShellOutput(wakeLines(command)))
      for (const each of [smallRecall(), mediumRecall(), largeRecall()]) {
        const out = recallWakeOut(command, each, { home })
        for (const wake of out.wakes) assert.ok(fitsShellOutput(wakeLines(wake)))
        assert.equal(out.events.find((event) => event.type === 'owner_message').body, body, 'the command inline, as it fits on its own')
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('what counts as shown', () => {
  const afterTool = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.postToolUse.filter((entry) => entry.command.includes('turn-recall.mjs'))

  /** The plugin's postToolUse hook for recall reads, run as hooks.json has Cursor run it. */
  function runAfterTool(home, input) {
    assert.equal(afterTool.length, 1, 'hooks.json runs the recall read check after each tool call')
    const run = spawnSync('sh', ['-c', afterTool[0].command], {
      input: JSON.stringify(input),
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, '', 'it only observes: it adds nothing to what Cursor passes on')
    return run.stdout
  }

  it('an inline recall, once its wake is written', () => {
    const home = tempHome()
    try {
      const batch = { turn_recall: recall({ keys: [key(1), key(2)] }) }
      assert.equal(settleRecallHandover('chat-1', recallWakeOut(wake(), batch.turn_recall, { home }), batch, { home }), 'shown')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(1), key(2)])
      // A wake with no command to recall for (a check job, a notice) settles nothing.
      assert.equal(settleRecallHandover('chat-2', recallWakeOut([{ type: 'check_job' }, { type: 'wake' }], batch.turn_recall, { home }), batch, { home }), 'none')
      assert.deepEqual(seenRecallKeys('chat-2', { home }), [])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a recall in a note only once the agent has read every part of it whole; a pointer never read leaves its records unshown', () => {
    const home = tempHome()
    try {
      const batch = { turn_recall: { ...largeRecall(), seen_keys: [key(3), key(4)] } }
      const out = recallWakeOut(wake(), batch.turn_recall, { home })
      const id = noteIdIn(out.events.find((event) => event.type === 'turn_recall').read)
      const files = noteFiles(home, id)
      assert.ok(files.length > 1)
      assert.equal(settleRecallHandover('chat-1', out, batch, { home }), 'awaiting_read')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [], 'pointed at, not read')
      assert.deepEqual(recallPollArguments('chat-1', { home }), { turn_recall_version: 1 }, 'so the next command can be offered them again')

      // Tool calls that are not a whole read of it: another command, a mention, the same
      // read in another conversation (a helper agent's), and only some of the parts.
      runAfterTool(home, { conversation_id: 'chat-1', tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: JSON.stringify({ output: 'README.md\n', exitCode: 0 }) })
      runAfterTool(home, { conversation_id: 'chat-1', tool_name: 'Shell', tool_input: { command: `test -e ~/.devspec/notes/${id}.md` }, tool_output: JSON.stringify({ output: '', exitCode: 0 }) })
      runAfterTool(home, catCall(home, files[0], { conversation: 'helper-chat' }))
      for (const file of files.slice(0, -1)) runAfterTool(home, catCall(home, file, { conversation: 'chat-1' }))
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])

      // The last part read whole: shown, and the note no longer waits.
      runAfterTool(home, catCall(home, files.at(-1), { conversation: 'chat-1' }))
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(3), key(4)])
      assert.deepEqual(fs.readdirSync(path.join(home, '.devspec', 'recall', 'cursor', 'pending')), [])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a recall in a wake of its own after a near-limit command: shown once that wake is written', () => {
    const home = tempHome()
    try {
      const batch = { turn_recall: { ...mediumRecall(), seen_keys: [key(8)] } }
      const out = recallWakeOut(wakeOfLength(19_990), batch.turn_recall, { home })
      assert.equal(out.recall, 'separate')
      assert.equal(settleRecallHandover('chat-1', out, batch, { home }), 'shown')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(8)])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a recall that went out with its command whole in a note (a command too long on its own): shown once that note is read; two such commands give two notes, each read on its own', () => {
    const home = tempHome()
    try {
      const first = { turn_recall: { ...mediumRecall(), seen_keys: [key(6)] } }
      const second = { turn_recall: { ...largeRecall(), seen_keys: [key(7)] } }
      const commandA = wakeOfLength(25_300)
      const commandB = wakeOfLength(25_300, 'b')
      const outA = recallWakeOut(commandA, first.turn_recall, { home })
      const outB = recallWakeOut(commandB, second.turn_recall, { home })
      assert.notEqual(outA.note.id, outB.note.id, 'each wake has its own note')
      assert.equal(settleRecallHandover('chat-1', outA, first, { home }), 'awaiting_read')
      assert.equal(settleRecallHandover('chat-1', outB, second, { home }), 'awaiting_read')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])

      // Neither displaces the other: both notes are there, whole, and each is read on its own.
      assert.ok(readNoteText(outA.note.id, { home }).includes(JSON.stringify(commandA[0])))
      assert.ok(readNoteText(outB.note.id, { home }).includes(JSON.stringify(commandB[0])))
      for (const file of noteFiles(home, outB.note.id)) assert.equal(runAfterTool(home, catCall(home, file, { conversation: 'chat-1' })), '')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(7)])
      for (const file of noteFiles(home, outA.note.id)) runAfterTool(home, catCall(home, file, { conversation: 'chat-1' }))
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(7), key(6)])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('counts Cursor\'s Read tool as a read too, by the length it reports', () => {
    const home = tempHome()
    try {
      const batch = { turn_recall: { ...mediumRecall(), seen_keys: [key(5)] } }
      const out = recallWakeOut(wakeOfLength(19_000), batch.turn_recall, { home })
      const id = noteIdIn(out.events.find((event) => event.type === 'turn_recall').read)
      assert.equal(settleRecallHandover('chat-1', out, batch, { home }), 'awaiting_read')
      const [file] = noteFiles(home, id)
      assert.deepEqual(noteRecallReads(readCall(file, { conversation: 'chat-1', contentLength: 10 }), { home }), [], 'a partial read')
      assert.deepEqual(noteRecallReads(readCall(file, { conversation: 'chat-1' }), { home }), [id])
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(5)])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
