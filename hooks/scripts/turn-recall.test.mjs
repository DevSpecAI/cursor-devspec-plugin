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
import { wakeLines } from './devspec-wake-file.mjs'
import {
  deliverableRecall,
  forgetShown,
  recallConversation,
  recallPollArguments,
  noteRecallReads,
  RECALL_INLINE_NOTE,
  rememberShown,
  SEEN_STORE,
  seenRecallKeys,
  seenStoreFile,
  settleRecallHandover,
  withTurnRecall,
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
      const events = withTurnRecall(wake(), recall(), { home, sessionId: 's1' })
      assert.deepEqual(events.map((event) => event.type), ['owner_message', 'turn_recall', 'room_unread', 'wake'])
      const carried = events[1]
      assert.equal(carried.block, recall().formatted_block)
      assert.equal(carried.executable, false)
      assert.equal(carried.session_id, 's1')
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
      assert.deepEqual(withTurnRecall(run, recall(), { home }).map((event) => event.type), ['automation_dispatch', 'turn_recall', 'wake'])
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
      assert.deepEqual(withTurnRecall(checkJob, recall(), { home }), checkJob)
      assert.deepEqual(withTurnRecall(notice, recall(), { home }), notice)
      assert.equal(settleRecallHandover('chat-1', checkJob, { turn_recall: recall() }, { home }), 'none')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [])
      // And a wake with no recall is left exactly as it was.
      assert.deepEqual(withTurnRecall(wake(), null, { home }), wake())
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
      const events = withTurnRecall(wake(), recall({ block }), { home, sessionId: 's1' })
      const carried = events.find((event) => event.type === 'turn_recall')
      assert.equal(carried.block, undefined)
      assert.match(carried.read, /^cat ~\/\.devspec\/notes\/[0-9a-f]{16}\.md$/)
      assert.ok(carried.parts > 1)
      assert.ok(carried.note.includes(carried.read))
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
      assert.ok(fitsShellOutput(wakeLines(withTurnRecall(wake(), recall({ block }), { home }))))
      assert.ok(wakeLines(wake(body)).length + block.length > 20_000)
      const events = withTurnRecall(wake(body), recall({ block }), { home })
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
      const events = withTurnRecall(wake(), recall({ block }), { home })
      const carried = events.find((event) => event.type === 'turn_recall')
      assert.equal(carried.block, undefined)
      assert.equal(readNoteText(/notes\/([0-9a-f]{16})\.md/.exec(carried.read)[1], { home }), block)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves the wake as it was when an oversize recall cannot be written to a note: the command goes, never part of the recall', () => {
    const home = tempHome()
    try {
      fs.writeFileSync(path.join(home, '.devspec'), 'a file where the folder should be')
      const block = `== PROACTIVE PROJECT RECALL ==\n${'x'.repeat(30_000)}`
      assert.deepEqual(withTurnRecall(wake(), recall({ block }), { home }), wake())
      assert.equal(settleRecallHandover('chat-1', wake(), { turn_recall: recall({ block }) }, { home }), 'none')
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
  it('measured at the boundary: a 19,990-character command wake that fits gets no recall rather than a 20,431-character one, and the command is byte for byte as it was', () => {
    const home = tempHome()
    try {
      const command = wakeOfLength(19_990)
      assert.ok(fitsShellOutput(wakeLines(command)))
      for (const each of [smallRecall(), mediumRecall(), largeRecall()]) {
        const events = withTurnRecall(command, each, { home })
        assert.equal(wakeLines(events), wakeLines(command), 'no recall, inline or pointer, fits beside this command')
      }
      // Nothing was written for a pointer that could not be given.
      assert.equal(fs.existsSync(path.join(home, '.devspec', 'notes')), false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('takes the inline route only when the whole wake fits, then the pointer only when that fits, otherwise none, across every size up to the limit', () => {
    const home = tempHome()
    try {
      const seen = { inline: 0, pointer: 0, none: 0 }
      for (let chars = 17_000; chars <= 20_000; chars += 97) {
        const command = wakeOfLength(chars)
        for (const each of [smallRecall(), mediumRecall(), largeRecall()]) {
          const events = withTurnRecall(command, each, { home })
          const carried = events.find((event) => event.type === 'turn_recall')
          // The command's own events are untouched, in order, whatever happens.
          assert.deepEqual(events.filter((event) => event.type !== 'turn_recall'), command)
          if (!carried) seen.none += 1
          else {
            seen[carried.block === undefined ? 'pointer' : 'inline'] += 1
            assert.ok(fitsShellOutput(wakeLines(events)), `a ${chars}-character command wake was pushed past the limit`)
          }
          // Inline whenever inline fits; never a pointer when inline would have fitted.
          if (carried?.block === undefined) {
            const inline = { type: 'turn_recall', session_id: null, executable: false, note: RECALL_INLINE_NOTE, block: each.formatted_block }
            assert.equal(fitsShellOutput(wakeLines([command[0], inline, ...command.slice(1)])), false, `inline would have fitted at ${chars}`)
          }
        }
      }
      // The sweep crossed all three routes, so each was really decided by the size.
      assert.ok(seen.inline > 0 && seen.pointer > 0 && seen.none > 0, JSON.stringify(seen))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('counts the bytes of the whole wake too: a non-Latin command near 40,000 bytes gets no recall that would pass it', () => {
    const home = tempHome()
    try {
      const body = '要件は変更を管理します。'.repeat(1_090) // ~13,000 characters, ~39,240 bytes
      const command = wake(body)
      assert.ok(fitsShellOutput(wakeLines(command)))
      for (const each of [smallRecall(), mediumRecall(), largeRecall()]) {
        const events = withTurnRecall(command, each, { home })
        assert.ok(fitsShellOutput(wakeLines(events)))
        assert.equal(events.find((event) => event.type === 'owner_message').body, body)
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
  }

  it('an inline recall, once its wake is written', () => {
    const home = tempHome()
    try {
      const batch = { turn_recall: recall({ keys: [key(1), key(2)] }) }
      assert.equal(settleRecallHandover('chat-1', withTurnRecall(wake(), batch.turn_recall, { home }), batch, { home }), 'shown')
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(1), key(2)])
      // A wake that carried no recall shows nothing.
      assert.equal(settleRecallHandover('chat-2', wake(), batch, { home }), 'none')
      assert.deepEqual(seenRecallKeys('chat-2', { home }), [])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a recall in a note only once the agent has read every part of it whole; a pointer never read leaves its records unshown', () => {
    const home = tempHome()
    try {
      const batch = { turn_recall: { ...largeRecall(), seen_keys: [key(3), key(4)] } }
      const events = withTurnRecall(wake(), batch.turn_recall, { home })
      const id = noteIdIn(events.find((event) => event.type === 'turn_recall').read)
      const files = noteFiles(home, id)
      assert.ok(files.length > 1)
      assert.equal(settleRecallHandover('chat-1', events, batch, { home }), 'awaiting_read')
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

  it('counts Cursor\'s Read tool as a read too, by the length it reports', () => {
    const home = tempHome()
    try {
      const batch = { turn_recall: { ...mediumRecall(), seen_keys: [key(5)] } }
      const events = withTurnRecall(wakeOfLength(19_000), batch.turn_recall, { home })
      const id = noteIdIn(events.find((event) => event.type === 'turn_recall').read)
      assert.equal(settleRecallHandover('chat-1', events, batch, { home }), 'awaiting_read')
      const [file] = noteFiles(home, id)
      assert.deepEqual(noteRecallReads(readCall(file, { conversation: 'chat-1', contentLength: 10 }), { home }), [], 'a partial read')
      assert.deepEqual(noteRecallReads(readCall(file, { conversation: 'chat-1' }), { home }), [id])
      assert.deepEqual(seenRecallKeys('chat-1', { home }), [key(5)])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
