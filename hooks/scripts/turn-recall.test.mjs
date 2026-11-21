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
import { readerHeader, readerPage } from './devspec-wake-tail.mjs'
import { wakeLines } from './devspec-wake-file.mjs'
import {
  deliverableRecall,
  forgetShown,
  recallConversation,
  recallPollArguments,
  noteRecallReads,
  RECALL_IN_NEXT_WAKE,
  RECALL_POINTER_NOTE,
  RECALL_UNSAVED_NOTE,
  RECALL_WHOLE_NOTE,
  recallWakeOut,
  rememberShown,
  SEEN_STORE,
  seenRecallKeys,
  seenStoreFile,
  settleRecallHandover,
} from './turn-recall.mjs'
import { catCall, noteFiles, noteIdIn, readCall } from '../../tests/helpers/note-reads.mjs'

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
        assert.equal(run.stdout, '{}', 'an answer that asks Cursor for nothing (item 6ddde907)')
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
/** The text of the note a `read` command names. */
const noteOf = (read, home) => readNoteText(noteIdIn(read), { home })

describe('a wake that carries the recall: always in a note, never inline', () => {
  it('puts a short pointer to the recall\'s note right after the command, ahead of the room notes and the wake line', () => {
    const home = tempHome()
    try {
      for (const each of [smallRecall(), mediumRecall(), largeRecall()]) {
        const out = recallWakeOut(wake(), each, { home })
        assert.equal(out.recall, 'pointer')
        assert.deepEqual(out.events.map((event) => event.type), ['owner_message', 'turn_recall', 'room_unread', 'wake'])
        const pointer = out.events[1]
        assert.equal(pointer.block, undefined, 'never inline')
        assert.equal(pointer.note, RECALL_POINTER_NOTE)
        assert.equal(noteOf(pointer.read, home), each.formatted_block, 'the note holds it whole')
        assert.ok(fitsShellOutput(wakeLines(out.events)))
        assert.equal(out.recallWake, null)
      }
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
      assert.deepEqual(recallWakeOut(run, recall(), { home }).events.map((event) => event.type), ['automation_dispatch', 'turn_recall', 'wake'])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('carries none on a wake with no command (a check job, a notice), or with no recall', () => {
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
      for (const events of [checkJob, notice]) {
        const out = recallWakeOut(events, recall(), { home })
        assert.deepEqual(out.wakes, [events])
        assert.equal(out.recall, 'none')
        assert.equal(settleRecallHandover('chat-1', out, { turn_recall: recall() }, { home }), 'none')
      }
      assert.deepEqual(recallWakeOut(wake(), null, { home }), { wakes: [wake()], events: wake(), recallWake: null, note: null, full: wake(), recall: 'none' })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('when the recall\'s note cannot be written: the command goes as it is, with one short line saying so, and nothing is shown', () => {
    const home = tempHome()
    try {
      fs.writeFileSync(path.join(home, '.devspec'), 'a file where the folder should be')
      const batch = { turn_recall: largeRecall() }
      const out = recallWakeOut(wake(), batch.turn_recall, { home })
      assert.equal(out.recall, 'unsaved')
      assert.deepEqual(out.events[1], { type: 'turn_recall', note: RECALL_UNSAVED_NOTE })
      assert.deepEqual(out.events.filter((event) => event.type !== 'turn_recall'), wake(), 'the command as it is')
      // The line is no longer than the pointer it stands in for, so it fits wherever that would have.
      const pointer = { type: 'turn_recall', read: `cat ~/.devspec/notes/${'0'.repeat(16)}.md`, note: RECALL_POINTER_NOTE }
      assert.ok(JSON.stringify(out.events[1]).length <= JSON.stringify(pointer).length)
      assert.equal(settleRecallHandover('chat-1', out, batch, { home }), 'none')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      // A near-limit command with no room for the line beside it, but room for the waiting line: the line follows as a wake of its own.
      const near = recallWakeOut(wakeOfLength(19_870), batch.turn_recall, { home })
      assert.deepEqual(near.events, [...wakeOfLength(19_870), RECALL_IN_NEXT_WAKE], 'the command, ending with the line that more follows')
      assert.deepEqual(near.recallWake, [{ type: 'turn_recall', for: 'm1', note: RECALL_UNSAVED_NOTE }])
      // A command that needs the whole note (too long on its own, or no room for the waiting line) is held.
      for (const each of [null, mediumRecall()]) assert.ok(recallWakeOut(wakeOfLength(25_300), each, { home }).held instanceof Error)
      assert.ok(recallWakeOut(wakeOfLength(19_990), mediumRecall(), { home }).held instanceof Error)
      fs.rmSync(path.join(home, '.devspec'), { force: true })
      assert.equal(recallWakeOut(wakeOfLength(25_300), mediumRecall(), { home }).recall, 'whole')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the three routes, by the size of the command', () => {
  /** The note a `wake_in_note` line points to, read back whole. */
  const wakeNote = (out, home) => readNoteText(noteIdIn(out.events[0].read), { home })

  it('a command that fits with the one-line marker but not with the pointer (19,870): the command\'s wake as it is, ending with that marker, then a pointer-only wake naming it, printed whole, in order', () => {
    const home = tempHome()
    try {
      const command = wakeOfLength(19_870)
      for (const each of [smallRecall(), mediumRecall(), largeRecall()]) {
        const out = recallWakeOut(command, each, { home })
        assert.equal(out.recall, 'separate')
        assert.equal(out.note, null)
        assert.deepEqual(out.events, [...command, RECALL_IN_NEXT_WAKE], 'the command, byte for byte, in its own wake, saying its recall is next')
        assert.deepEqual(Object.keys(out.recallWake[0]).sort(), ['for', 'note', 'read', 'type'])
        assert.equal(out.recallWake[0].for, 'm1', 'naming the command it belongs to')
        assert.equal(noteOf(out.recallWake[0].read, home), each.formatted_block)
        for (const wake of out.wakes) assert.ok(fitsShellOutput(wakeLines(wake)))
        // The wake reader hands them over in order, each whole, one output each.
        const wakes = out.wakes.map(wakeLines)
        const first = readerPage(wakes, { home })
        assert.equal(first.text, readerHeader(1, 1) + wakeLines(out.events))
        const second = readerPage(wakes.slice(first.through), { home })
        assert.equal(second.text, readerHeader(1, 0) + wakeLines(out.recallWake))
        for (const page of [first, second]) assert.ok(fitsShellOutput(page.text))
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a command in the residual window (fits on its own, not with the 31-character marker; 19,990) takes the whole note, whose line says plainly the command and its recall are in it', () => {
    const home = tempHome()
    try {
      const command = wakeOfLength(19_990)
      assert.ok(fitsShellOutput(wakeLines(command)), 'it fits on its own')
      assert.equal(fitsShellOutput(wakeLines([...command, RECALL_IN_NEXT_WAKE])), false, 'but not with the marker')
      const out = recallWakeOut(command, mediumRecall(), { home })
      assert.equal(out.recall, 'whole')
      assert.equal(out.recallWake, null)
      assert.deepEqual(out.events.map((event) => event.type), ['wake_in_note'])
      assert.equal(out.events[0].note, RECALL_WHOLE_NOTE)
      assert.ok(wakeNote(out, home).includes(JSON.stringify(command[0])), 'the command, byte for byte, in the note')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a command that does not fit on its own (25,300): one note holding it and its recall, behind one short line; any wake too long on its own likewise', () => {
    const home = tempHome()
    try {
      const out = recallWakeOut(wakeOfLength(25_300), mediumRecall(), { home })
      assert.equal(out.recall, 'whole')
      assert.deepEqual(out.events.map((event) => event.type), ['wake_in_note'])
      assert.deepEqual(out.events[0].carries, ['owner_message', 'turn_recall', 'room_unread', 'wake'])
      assert.equal(wakeNote(out, home), wakeLines(out.full))
      assert.ok(wakeNote(out, home).includes(JSON.stringify(wakeOfLength(25_300)[0])), 'the command, byte for byte')
      assert.ok(wakeNote(out, home).includes(JSON.stringify(mediumRecall().formatted_block)), 'and its recall')
      const notice = [{ type: 'system_notice', notice_id: 'n1', content: 'finding '.repeat(4_000) }, { type: 'wake' }]
      const alone = recallWakeOut(notice, null, { home })
      assert.deepEqual(alone.events[0].carries, ['system_notice', 'wake'])
      assert.equal(wakeNote(alone, home), wakeLines(notice))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('across every size to past the limit: pointer beside the command, else a pointer wake of its own, else the whole note, each only when the cheaper one does not fit', () => {
    const home = tempHome()
    try {
      const seen = { pointer: 0, separate: 0, whole: 0 }
      const pointerEvent = { type: 'turn_recall', read: `cat ~/.devspec/notes/${'0'.repeat(16)}.md`, note: RECALL_POINTER_NOTE }
      // Every 97 characters, plus each side of the marker's boundary (the residual window
      // where a command fits on its own but not with the marker is its line, 31
      // characters) and the 19,990 case.
      const marker = JSON.stringify(RECALL_IN_NEXT_WAKE).length + 1
      assert.equal(marker, 31)
      const reserve = 20_000 - marker
      const sizes = [...Array.from({ length: 42 }, (_, n) => 17_000 + n * 97), reserve - 1, reserve, reserve + 1, 19_990]
      for (const chars of sizes) {
        const command = wakeOfLength(chars)
        for (const each of [smallRecall(), largeRecall()]) {
          const out = recallWakeOut(command, each, { home })
          seen[out.recall] += 1
          for (const wake of out.wakes) assert.ok(fitsShellOutput(wakeLines(wake)), `a ${chars}-character command gave a wake past the limit`)
          assert.ok(out.wakes.flat().every((event) => event.block === undefined), 'the recall is never inline in a wake')
          const besideFits = fitsShellOutput(wakeLines([command[0], pointerEvent, ...command.slice(1)]))
          const markedFits = fitsShellOutput(wakeLines([...command, RECALL_IN_NEXT_WAKE]))
          assert.equal(out.recall, besideFits ? 'pointer' : markedFits ? 'separate' : 'whole', `at ${chars}`)
          // A delivery split into two wakes says so inside the command's own wake, at its end.
          if (out.recallWake) assert.deepEqual(out.events.at(-1), RECALL_IN_NEXT_WAKE, `at ${chars}`)
          if (out.recall !== 'whole') assert.deepEqual(out.events.filter((event) => event.type !== 'turn_recall' && event.type !== 'recall_in_next_wake'), command)
          else assert.equal(wakeNote(out, home), wakeLines(out.full))
        }
      }
      for (const [route, count] of Object.entries(seen)) assert.ok(count > 0, `${route} never used: ${JSON.stringify(seen)}`)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('counts the bytes of the whole wake too: a non-Latin command near 40,000 bytes goes inline with its pointer', () => {
    const home = tempHome()
    try {
      const body = '要件は変更を管理します。'.repeat(1_090) // ~13,000 characters, ~39,240 bytes
      const out = recallWakeOut(wake(body), largeRecall(), { home })
      for (const wake of out.wakes) assert.ok(fitsShellOutput(wakeLines(wake)))
      assert.equal(out.events.find((event) => event.type === 'owner_message').body, body)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('what counts as shown: only a read of the recall\'s note', () => {
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
    assert.equal(run.stdout, '{}', 'it only observes: it adds nothing to what Cursor passes on, and still answers (item 6ddde907)')
  }

  for (const [route, command] of [['pointer', () => wake()], ['separate', () => wakeOfLength(19_870)]]) {
    it(`the ${route} route: written is not shown; partial, helper and mention reads are not either; a whole read is`, () => {
      const home = tempHome()
      try {
        const batch = { turn_recall: { ...largeRecall(), seen_keys: [key(3), key(4)] } }
        const out = recallWakeOut(command(), batch.turn_recall, { home })
        assert.equal(out.recall, route)
        const read = (route === 'pointer' ? out.events : out.recallWake).find((event) => event.type === 'turn_recall').read
        const id = noteIdIn(read)
        const files = noteFiles(home, id)
        assert.ok(files.length > 1)
        assert.equal(settleRecallHandover('chat-1', out, batch, { home }), 'awaiting_read')
        assert.deepEqual(seenRecallKeys('chat-1', { home }), [], 'written, not read')
        assert.deepEqual(recallPollArguments('chat-1', { home }), { turn_recall_version: 1 }, 'so the next command can be offered them again')

        runAfterTool(home, { conversation_id: 'chat-1', tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: JSON.stringify({ output: 'README.md\n', exitCode: 0 }) })
        runAfterTool(home, { conversation_id: 'chat-1', tool_name: 'Shell', tool_input: { command: `test -e ~/.devspec/notes/${id}.md` }, tool_output: JSON.stringify({ output: '', exitCode: 0 }) })
        runAfterTool(home, catCall(home, files[0], { conversation: 'helper-chat' }))
        for (const file of files.slice(0, -1)) runAfterTool(home, catCall(home, file, { conversation: 'chat-1' }))
        assert.deepEqual(seenRecallKeys('chat-1', { home }), [])

        runAfterTool(home, catCall(home, files.at(-1), { conversation: 'chat-1' }))
        assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(3), key(4)])
        assert.deepEqual(fs.readdirSync(path.join(home, '.devspec', 'recall', 'cursor', 'pending')), [])
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    })
  }

  it('the whole route: shown once the note keeping the command with it is read; two such commands give two notes, each read on its own', () => {
    const home = tempHome()
    try {
      const first = { turn_recall: { ...mediumRecall(), seen_keys: [key(6)] } }
      const second = { turn_recall: { ...largeRecall(), seen_keys: [key(7)] } }
      const outA = recallWakeOut(wakeOfLength(25_300), first.turn_recall, { home })
      const outB = recallWakeOut(wakeOfLength(25_300, 'b'), second.turn_recall, { home })
      assert.notEqual(outA.note.id, outB.note.id, 'each wake has its own note')
      assert.equal(settleRecallHandover('chat-1', outA, first, { home }), 'awaiting_read')
      assert.equal(settleRecallHandover('chat-1', outB, second, { home }), 'awaiting_read')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      for (const file of noteFiles(home, outB.note.id)) runAfterTool(home, catCall(home, file, { conversation: 'chat-1' }))
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
      const out = recallWakeOut(wake(), batch.turn_recall, { home })
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
