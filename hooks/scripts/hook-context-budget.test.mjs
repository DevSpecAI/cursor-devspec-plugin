#!/usr/bin/env node
/**
 * The plugin's hooks share Cursor's one ceiling on the context hooks add to an event.
 * Run: node --test hooks/scripts/hook-context-budget.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { execFileSync } from 'node:child_process'

import { catCall, noteFiles, readCall } from '../../tests/helpers/note-reads.mjs'
import {
  CURSOR_HOOK_CONTEXT_MAX_CHARS,
  CURSOR_HOOK_CONTEXT_SEPARATOR,
  CURSOR_SHELL_OUTPUT_MAX_BYTES,
  CURSOR_SHELL_OUTPUT_MAX_CHARS,
  fitHookContext,
  hookContextShare,
  NOTE_PART_BYTES,
  NOTE_PART_CHARS,
  noteParts,
  notePointer,
  noteReadThrough,
  postToolUseOutput,
  readNoteText,
  seal,
  splitText,
  unseal,
  writeNote,
  POST_TOOL_CONTEXT_HOOKS,
  POST_TOOL_CONTEXT_SHARE,
  SESSION_START_CONTEXT_SHARE,
} from './hook-context-budget.mjs'

/** What Cursor delivers for one event: every answer trimmed, then joined (its hooks carrier). */
const joined = (answers) => answers.map((answer) => answer.trim()).join(CURSOR_HOOK_CONTEXT_SEPARATOR)

describe("each hook's share of Cursor's ceiling", () => {
  it('lets every hook that can answer one event use its whole share and still be delivered', () => {
    for (let hooks = 1; hooks <= 12; hooks += 1) {
      const share = hookContextShare(hooks)
      const full = joined(Array.from({ length: hooks }, () => 'x'.repeat(share)))
      assert.ok(full.length <= CURSOR_HOOK_CONTEXT_MAX_CHARS, `${hooks} hooks join to ${full.length}`)
      const over = joined(Array.from({ length: hooks }, () => 'x'.repeat(share + 1)))
      assert.ok(over.length > CURSOR_HOOK_CONTEXT_MAX_CHARS, `${hooks} hooks: the share is the largest that fits`)
    }
  })

  it('gives the one sessionStart hook the whole ceiling, and each postToolUse hook its part', () => {
    assert.equal(SESSION_START_CONTEXT_SHARE, CURSOR_HOOK_CONTEXT_MAX_CHARS)
    assert.equal(POST_TOOL_CONTEXT_SHARE, hookContextShare(POST_TOOL_CONTEXT_HOOKS))
    const all = joined(Array.from({ length: POST_TOOL_CONTEXT_HOOKS }, () => 'y'.repeat(POST_TOOL_CONTEXT_SHARE)))
    assert.ok(all.length <= CURSOR_HOOK_CONTEXT_MAX_CHARS)
  })
})

describe('fitHookContext, the one way a hook hands context over', () => {
  const homes = []
  after(() => {
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  })
  const tempHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hook-context-'))
    homes.push(home)
    return home
  }

  it('hands a note that fits its share over as it is, and nothing for nothing', () => {
    assert.equal(fitHookContext('short note'), 'short note')
    assert.equal(fitHookContext('  '), null)
    assert.equal(postToolUseOutput(null), null)
    assert.deepEqual(postToolUseOutput('hi'), { additional_context: 'hi', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hi' } })
  })

  it('keeps a longer note whole in ~/.devspec/notes under a short id, and hands over a pointer within the share', () => {
    const home = tempHome()
    const text = `${'a long note '.repeat(1_000)}END`
    const pointer = fitHookContext(text, { home, what: 'A long note', lead: 'The short part.' })
    assert.ok(pointer.length <= POST_TOOL_CONTEXT_SHARE)
    assert.ok(pointer.startsWith('The short part.\n\nA long note is waiting for you whole in a file'))
    const id = pointer.match(/`cat ~\/\.devspec\/notes\/([0-9a-f]{16})\.md`/)[1]
    const file = path.join(home, '.devspec', 'notes', `${id}.md`)
    assert.equal(readNoteText(id, { home }), text)
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`\\n\\n— End of DevSpec note ${id}: part 1 of 1 · ${text.length} characters · sha256 [0-9a-f]{12} —\\n$`))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(writeNote(text, { home }).id, id, 'the same text is the same note')
  })

  it('has a pointer of one short, fixed shape, whatever the home folder is called', () => {
    const shortHome = tempHome()
    const longHome = path.join(tempHome(), ...Array(60).fill('a-very-long-home-folder-name'))
    const text = 'x'.repeat(POST_TOOL_CONTEXT_SHARE + 1)
    const a = fitHookContext(text, { home: shortHome, what: 'A note' })
    const b = fitHookContext(text, { home: longHome, what: 'A note' })
    assert.equal(a, b, 'the pointer names the note through ~, never the home folder')
    // The longest pointer the plugin gives (its longest description and addition) is
    // well inside the smallest share.
    const longest = notePointer(writeNote(text, { home: shortHome }), { what: 'w'.repeat(200), also: 'a'.repeat(300) })
    assert.ok(longest.length < POST_TOOL_CONTEXT_SHARE / 2, `${longest.length} characters`)
  })

  it('falls back to a fixed short notice when the pointer does not fit, and to nothing only below that', () => {
    const home = tempHome()
    const text = 'x'.repeat(500)
    const notice = fitHookContext(text, { home, share: 150 })
    assert.match(notice, /^DevSpec has more context waiting for you: run `cat ~\/\.devspec\/notes\/[0-9a-f]{16}\.md`, and every further part it names\.$/)
    assert.equal(fitHookContext(text, { home, share: 40 }), null)
  })

  it("splits a note over Cursor's Shell ceiling into parts that each reach the model whole, and chain to the next", () => {
    const home = tempHome()
    const text = Array.from({ length: 900 }, (_, i) => `rule ${i}: ${'keep it whole '.repeat(4)}`).join('\n') + '\nLAST-LINE'
    assert.ok(text.length > 2 * CURSOR_SHELL_OUTPUT_MAX_CHARS, `${text.length} characters`)
    const note = writeNote(text, { home })
    assert.equal(note.parts, noteParts(note.id, { home }))
    assert.ok(note.parts >= 3)
    const files = noteFiles(home, note.id)
    assert.equal(files.length, note.parts)
    let joinedBack = ''
    files.forEach((file, i) => {
      // What the agent's `cat` of this part prints, as the shell prints it.
      const printed = execFileSync('sh', ['-c', `cat ${file.replace(home, '~')}`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' })
      assert.ok(printed.length < CURSOR_SHELL_OUTPUT_MAX_CHARS, `part ${i + 1} prints ${printed.length} characters`)
      assert.ok(printed.length <= NOTE_PART_CHARS + 200)
      if (i < files.length - 1) assert.ok(printed.includes(`read on with \`cat ~/.devspec/notes/${note.id}.${i + 2}.md\``), 'names the next part')
      joinedBack += printed.slice(0, printed.lastIndexOf('\n\n— '))
    })
    assert.equal(joinedBack, text, 'the parts, joined, are the note')
    assert.equal(readNoteText(note.id, { home }), text)
  })

  it('counts a note read only when every part came back whole, in this conversation', () => {
    const home = tempHome()
    const note = writeNote('x'.repeat(NOTE_PART_CHARS * 2 + 10), { home })
    const [first, second, third] = noteFiles(home, note.id)
    assert.equal(note.parts, 3)
    assert.equal(noteReadThrough(catCall(home, first), note.id, { home }), false, 'one part of three')
    assert.equal(noteReadThrough(readCall(second), note.id, { home }), false, 'two of three, by Read')
    assert.equal(noteReadThrough({ conversation_id: 'two', ...catCall(home, third, { conversation: 'two' }) }, note.id, { home }), false, 'another conversation reading counts for that one')
    assert.equal(noteReadThrough(catCall(home, third, { tilde: false }), note.id, { home }), true, 'all three, the last by absolute path')
    assert.equal(noteReadThrough({ conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }, note.id, { home }), true, 'and stays read')
  })

  it('never counts a command that only mentions a note, or a read that did not come back whole', () => {
    const home = tempHome()
    const note = writeNote('the person asked you to tell them something', { home })
    const file = noteFiles(home, note.id)[0]
    const tilde = file.replace(home, '~')
    const ran = (command, output = '', exitCode = 0) => ({
      conversation_id: 'one', tool_name: 'Shell', tool_input: { command }, tool_output: JSON.stringify({ output, exitCode }),
    })
    const whole = fs.readFileSync(file, 'utf8')
    for (const call of [
      ran(`test -e ${tilde}`),
      ran(`ls ${tilde}`, `${file}\n`),
      ran(`grep -l person ${tilde}`, `${file}\n`),
      ran(`stat ${tilde}`, 'File: ...'),
      ran(`cat ${tilde} | head -1`, whole.split('\n')[0]),
      ran(`cat ${tilde} > /dev/null`),
      ran(`cat ${tilde}`, whole.slice(0, 20), 0),
      ran(`cat ${tilde}`, whole, 1),
      ran(`cat ${tilde}.bak`, whole),
      readCall(file, { contentLength: 5 }),
      { conversation_id: 'one', tool_name: 'Grep', tool_input: { path: file }, tool_output: JSON.stringify({ output: whole }) },
    ]) {
      assert.equal(noteReadThrough(call, note.id, { home }), false, JSON.stringify(call.tool_input))
    }
    // The plugin's own PATH line in front of an exact `cat` is fine.
    const prefixed = ran(`export PATH="/x/stand-in:$PATH" # devspec\ncat ${tilde}`, whole)
    assert.equal(noteReadThrough(prefixed, note.id, { home }), true)
  })

  /** Every part of note `id` as the real shell prints it, its closing line taken off, joined: bytes, not text. */
  function catBack(home, id) {
    const pieces = noteFiles(home, id).map((file) => {
      const printed = execFileSync('sh', ['-c', `cat ${file.replace(home, '~')}`], { env: { PATH: process.env.PATH, HOME: home } })
      const text = printed.toString('utf8')
      assert.ok(text.length < CURSOR_SHELL_OUTPUT_MAX_CHARS, `${file}: ${text.length} characters`)
      assert.ok(printed.length < CURSOR_SHELL_OUTPUT_MAX_BYTES, `${file}: ${printed.length} bytes`)
      return printed.subarray(0, printed.lastIndexOf(Buffer.from('\n\n— ')))
    })
    return Buffer.concat(pieces)
  }

  it('never cuts a character in two: every part, read back through the real shell, joins to the note byte for byte', () => {
    const home = tempHome()
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'
    const cases = {
      // An emoji whose two code units straddle where a plain cut at NOTE_PART_CHARS would fall.
      emojiAtTheBoundary: `${'a'.repeat(NOTE_PART_CHARS - 1)}\u{1F600}${'b'.repeat(NOTE_PART_CHARS)}`,
      // ZWJ sequences, skin tones and flags, with no line breaks to cut at.
      zwjFamilies: `${'x'.repeat(NOTE_PART_CHARS - 5)}${family}\u{1F44D}\u{1F3FD}\u{1F1EC}\u{1F1E7}`.repeat(3),
      // Letters with stacked combining marks.
      combiningMarks: 'e\u0301\u0323'.repeat(NOTE_PART_CHARS),
      // Three bytes a character: the byte rule, not the character rule, decides the parts.
      cjk: '\u4e2d\u6587\u5b57'.repeat(NOTE_PART_CHARS),
      // A room entry stored as a note, with an emoji across the old boundary.
      roomEntry: JSON.stringify({
        message_id: 'm-1',
        from: 'Ali Price',
        text: `${'z'.repeat(NOTE_PART_CHARS - 60)}\u{1F680} shipped`,
        attachments: Array.from({ length: 300 }, (_, i) => ({ resource_id: `id-${i}`, name: `\u5199\u771f-${i}-\u{1F4F7}.png` })),
      }, null, 2),
    }
    for (const [name, text] of Object.entries(cases)) {
      const note = writeNote(text, { home })
      assert.ok(note.parts > 1, `${name} is long enough to be split`)
      const back = catBack(home, note.id)
      assert.ok(back.equals(Buffer.from(text, 'utf8')), `${name}: the parts joined are the note, byte for byte`)
      assert.ok(!back.toString('utf8').includes('\uFFFD'), `${name}: no replacement characters`)
      assert.equal(readNoteText(note.id, { home }), text, name)
      for (const file of noteFiles(home, note.id)) {
        const content = fs.readFileSync(file, 'utf8')
        const body = content.slice(0, content.lastIndexOf('\n\n— '))
        assert.ok(body.length <= NOTE_PART_CHARS && Buffer.byteLength(body) <= NOTE_PART_BYTES, `${name}: a part within both budgets`)
      }
    }
  })

  it('cuts at a line end when one falls in the second half of a part, otherwise between whole characters', () => {
    const lines = Array.from({ length: 3_000 }, (_, i) => `line ${i} \u{1F600} ${'w'.repeat(10)}`).join('\n')
    for (const piece of splitText(lines).slice(0, -1)) assert.ok(piece.endsWith('\n'), 'each part but the last ends at a line end')
    const oneLine = '\u{1F600}'.repeat(NOTE_PART_CHARS)
    const pieces = splitText(oneLine)
    assert.equal(pieces.join(''), oneLine)
    for (const piece of pieces) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(piece), 'no surrogate pair cut')
  })

  /** A small seeded generator, so the property test is the same run every time. */
  function generator(seed) {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('always holds both limits and rejoins byte for byte: thousands of random mixes, fixed seed', () => {
    const random = generator(20261120)
    const pick = (list) => list[Math.floor(random() * list.length)]
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'
    const makers = [
      () => '\n'.repeat(1 + Math.floor(random() * 3)),
      () => 'plain words '.repeat(1 + Math.floor(random() * 20)),
      () => '\u4e2d\u6587'.repeat(1 + Math.floor(random() * 40)),
      () => '\u{1F600}'.repeat(1 + Math.floor(random() * 20)),
      () => family.repeat(1 + Math.floor(random() * 5)),
      () => '\u{1F44D}\u{1F3FD}\u{1F1EC}\u{1F1E7}',
      // Long runs of combining marks on one letter: one grapheme, often longer than a part.
      () => `e${'\u0301\u0323'.repeat(1 + Math.floor(random() * 300))}`,
      () => '\r\n',
    ]
    for (let run = 0; run < 3_000; run += 1) {
      let text = ''
      const pieces = 1 + Math.floor(random() * 30)
      for (let i = 0; i < pieces; i += 1) text += pick(makers)()
      const maxChars = 8 + Math.floor(random() * 400)
      const maxBytes = 8 + Math.floor(random() * 800)
      const parts = splitText(text, maxChars, maxBytes)
      for (const part of parts) {
        assert.ok(part.length <= maxChars && Buffer.byteLength(part) <= maxBytes, `run ${run}: a part of ${part.length} characters, ${Buffer.byteLength(part)} bytes over ${maxChars}/${maxBytes}`)
        assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part), `run ${run}: no surrogate pair cut`)
      }
      assert.ok(Buffer.from(parts.join(''), 'utf8').equals(Buffer.from(text, 'utf8')), `run ${run}: rejoined byte for byte`)
    }
  })

  it('holds the limits after a line-end cut that leaves text to carry, at the real part sizes', () => {
    // A line break, then text carried into the next part, then one grapheme of combining
    // marks long enough that carried text and grapheme together pass the limit.
    const text = `${'a'.repeat(NOTE_PART_CHARS - 8_000)}\n${'b'.repeat(5_000)}e${'\u0301'.repeat(NOTE_PART_CHARS - 1_001)}${'c'.repeat(100)}`
    const parts = splitText(text)
    for (const part of parts) assert.ok(part.length <= NOTE_PART_CHARS && Buffer.byteLength(part) <= NOTE_PART_BYTES, `${part.length} characters`)
    assert.equal(parts.join(''), text)
    const room = JSON.stringify({ text: `${'z'.repeat(NOTE_PART_CHARS - 10)}\n${'y'.repeat(3_000)}${'\u{1F600}'.repeat(9_000)}` })
    for (const part of splitText(room)) assert.ok(part.length <= NOTE_PART_CHARS && Buffer.byteLength(part) <= NOTE_PART_BYTES, `${part.length} characters`)
  })

  it('counts a part read only when the whole of it came back: a cut that keeps head and tail does not', () => {
    const home = tempHome()
    const note = writeNote(`${'head '.repeat(1_500)}${'middle '.repeat(300)}${'tail '.repeat(1_500)}`, { home })
    assert.equal(note.parts, 1)
    const file = noteFiles(home, note.id)[0]
    const whole = fs.readFileSync(file, 'utf8')
    assert.ok(whole.length > 2 * 3_000)
    // What Cursor does to a long output: the first and last part kept, the middle gone.
    const cut = `${whole.slice(0, 3_000)}\n... (output truncated) ...\n${whole.slice(-3_000)}`
    const call = (output) => ({ conversation_id: 'one', tool_name: 'Shell', tool_input: { command: `cat ${file.replace(home, '~')}` }, tool_output: JSON.stringify({ output, exitCode: 0 }) })
    assert.equal(noteReadThrough(call(cut), note.id, { home }), false, 'the closing line survived the cut, but the length and hash do not match')
    assert.equal(noteReadThrough(call(whole.replace('middle', 'muddle')), note.id, { home }), false, 'a changed body')
    assert.equal(noteReadThrough(call(`${'x'.repeat(CURSOR_SHELL_OUTPUT_MAX_CHARS)}${whole}`), note.id, { home }), false, 'an output over Cursor\'s ceiling was cut for the model')
    assert.equal(noteReadThrough(call(whole), note.id, { home }), true)
  })

  it('unseals only a whole body: the seal states its length and hash', () => {
    const sealed = seal('DevSpec room page 0123456789abcdef', 'line one\nline two \u{1F600}')
    assert.equal(unseal(sealed, 'DevSpec room page 0123456789abcdef'), 'line one\nline two \u{1F600}')
    assert.equal(unseal(sealed.slice(3), 'DevSpec room page 0123456789abcdef'), null, 'head cut off')
    assert.equal(unseal(sealed.replace('one', 'won'), 'DevSpec room page 0123456789abcdef'), null, 'changed')
    assert.equal(unseal(sealed, 'DevSpec room page fedcba9876543210'), null, 'another page')
  })
})
