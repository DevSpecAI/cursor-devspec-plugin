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
  fitsShellOutput,
  handOverLineMax,
  hookContextShare,
  noteCommand,
  noteNotice,
  noteStatusCommand,
  noteStatusText,
  NOTE_PART_BYTES,
  NOTE_PART_CHARS,
  noteParts,
  notePointer,
  deliveryReadThrough,
  handOver,
  handOverPrefix,
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

  it('counts a delivery read only when every part came back whole, and a new delivery of the same text must be read again', () => {
    const home = tempHome()
    const note = writeNote('x'.repeat(NOTE_PART_CHARS * 2 + 10), { home })
    const [first, second, third] = noteFiles(home, note.id)
    assert.equal(note.parts, 3)
    const record = path.join(home, 'delivery.json')
    const through = (input, generation = 1) => deliveryReadThrough(record, input, { note: note.id, generation }, { home })
    assert.equal(through(catCall(home, first)), false, 'one part of three')
    assert.equal(through(readCall(second)), false, 'two of three, by Read')
    assert.equal(through(catCall(home, third, { tilde: false })), true, 'all three, the last by absolute path')
    assert.equal(through({ conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }), true, 'and that delivery stays read')
    // The same text handed over again is a new delivery: the earlier reads do not count.
    assert.equal(through({ conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }, 2), false)
    for (const file of [first, second]) assert.equal(through(catCall(home, file), 2), false)
    assert.equal(through(catCall(home, third), 2), true)
  })

  it('hands over until read, and a message added while one is unread joins it in a new delivery', () => {
    const home = tempHome()
    const file = handOverPrefix('test', 'one')
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    const offer = (input, add = null) => handOver(file, input, { add, what: 'A note', home })
    assert.equal(offer(ls), null, 'nothing waiting')
    const first = offer(ls, 'first message')
    assert.match(first, /\n\n1 DevSpec note is waiting for you; it comes back after each step until you have read it whole\.$/)
    assert.equal(offer(ls), first, 'offered again until read')
    const joined = offer(ls, 'second message')
    const id = /notes\/([0-9a-f]{16})\.md/.exec(joined)[1]
    assert.equal(readNoteText(id, { home }), 'first message\n\n---\n\nsecond message')
    assert.equal(offer(catCall(home, noteFiles(home, id)[0])), null, 'read whole: done')
    assert.equal(offer(ls), null)
    // The first text again, after it was read inside the joined note: a new delivery, owed again.
    const again = offer(ls, 'first message')
    assert.ok(again)
    assert.equal(offer(ls), again)
    assert.equal(offer(catCall(home, noteFiles(home, /notes\/([0-9a-f]{16})\.md/.exec(again)[1])[0])), null)
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
      assert.equal(deliveryReadThrough(path.join(home, 'delivery.json'), call, { note: note.id, generation: 1 }, { home }), false, JSON.stringify(call.tool_input))
    }
    // The plugin's own PATH line in front of an exact `cat` is fine.
    const prefixed = ran(`export PATH="/x/stand-in:$PATH" # devspec\ncat ${tilde}`, whole)
    assert.equal(deliveryReadThrough(path.join(home, 'delivery.json'), prefixed, { note: note.id, generation: 1 }, { home }), true)
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
    const through = (input) => deliveryReadThrough(path.join(home, 'delivery.json'), input, { note: note.id, generation: 1 }, { home })
    assert.equal(through(call(cut)), false, 'the closing line survived the cut, but the length and hash do not match')
    assert.equal(through(call(whole.replace('middle', 'muddle'))), false, 'a changed body')
    assert.equal(through(call(`${'x'.repeat(CURSOR_SHELL_OUTPUT_MAX_CHARS)}${whole}`)), false, 'an output over Cursor\'s ceiling was cut for the model')
    assert.equal(through(call(whole)), true)
  })

  it('unseals only a whole body: the seal states its length and hash', () => {
    const sealed = seal('DevSpec room page 0123456789abcdef', 'line one\nline two \u{1F600}')
    assert.equal(unseal(sealed, 'DevSpec room page 0123456789abcdef'), 'line one\nline two \u{1F600}')
    assert.equal(unseal(sealed.slice(3), 'DevSpec room page 0123456789abcdef'), null, 'head cut off')
    assert.equal(unseal(sealed.replace('one', 'won'), 'DevSpec room page 0123456789abcdef'), null, 'changed')
    assert.equal(unseal(sealed, 'DevSpec room page fedcba9876543210'), null, 'another page')
  })

  /** Every delivery file waiting under a prefix, and the note each names. */
  const pendingNotes = (home, prefix) => {
    const dir = path.join(home, '.devspec', 'notes', 'pending')
    try {
      return fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).map((name) => /([0-9a-f]{16})\.json$/.exec(name)[1])
    } catch {
      return []
    }
  }
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

  it('never drops or replaces a waiting note because part of it cannot be read; says so, and how to retry', { skip: asRoot && 'root reads any file' }, () => {
    const home = tempHome()
    const prefix = handOverPrefix('test', 'one')
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    const offer = (input, add = null) => handOver(prefix, input, { add, what: 'A note', home })
    const first = offer(ls, `first ${'x'.repeat(NOTE_PART_CHARS)} first-end`)
    const firstId = /notes\/([0-9a-f]{16})\.md/.exec(first)[1]
    const [, part2] = noteFiles(home, firstId)
    fs.chmodSync(part2, 0o000)
    try {
      const both = offer(ls, 'second message')
      // Not joined (the first could not be read back), and not replaced: both wait.
      assert.deepEqual(pendingNotes(home, prefix).length, 2)
      assert.ok(both.includes(`cat ~/.devspec/notes/${firstId}.md`), 'the first is still offered')
      // The pointer only says that some parts could not be read; the details are in the status file.
      assert.ok(both.includes(`Some parts of it could not be read back just now; see \`cat ~/.devspec/notes/${firstId}.status.md\`.`))
      const status = fs.readFileSync(path.join(home, '.devspec', 'notes', `${firstId}.status.md`), 'utf8')
      assert.match(status, /1 of its 2 parts could not be read back from disk just now \(part 2\)/)
      assert.ok(status.includes(`Part 1 is \`cat ~/.devspec/notes/${firstId}.md\`, and part N is \`cat ~/.devspec/notes/${firstId}.N.md\``))
      assert.ok(pendingNotes(home, prefix).some((id) => id !== firstId && readNoteText(id, { home }) === 'second message'))
    } finally {
      fs.chmodSync(part2, 0o600)
    }
    for (const file of noteFiles(home, firstId)) offer(catCall(home, file))
    assert.equal(pendingNotes(home, prefix).length, 1, 'the first, read whole, is done; the second still waits')
    assert.equal(fs.existsSync(path.join(home, '.devspec', 'notes', `${firstId}.status.md`)), false, 'its status went with it')
    assert.match(offer(ls), /1 DevSpec note is waiting for you; it comes back/)
  })

  it('still offers a delivery whose record cannot be read, by the note its name gives', () => {
    const home = tempHome()
    const prefix = handOverPrefix('test', 'one')
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    const first = handOver(prefix, ls, { add: 'a message', what: 'A note', home })
    const id = /notes\/([0-9a-f]{16})\.md/.exec(first)[1]
    fs.writeFileSync(path.join(home, '.devspec', 'notes', 'pending', `${prefix}${id}.json`), '{ not json')
    assert.equal(handOver(prefix, ls, { what: 'A note', home }), first)
    assert.equal(handOver(prefix, catCall(home, noteFiles(home, id)[0]), { what: 'A note', home }), null, 'and a whole read still ends it')
  })

  it('offers every waiting note when they do not all fit: short notices and a count of the rest, none dropped', () => {
    const home = tempHome()
    const prefix = handOverPrefix('test', 'one')
    const dir = path.join(home, '.devspec', 'notes', 'pending')
    fs.mkdirSync(dir, { recursive: true })
    const ids = Array.from({ length: 30 }, (_, i) => writeNote(`message ${i}`, { home }).id)
    ids.forEach((id, i) => fs.writeFileSync(path.join(dir, `${prefix}${id}.json`), JSON.stringify({ note: id, generation: i + 1, parts: [] })))
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    const offered = handOver(prefix, ls, { what: 'A note', home })
    assert.ok(offered.length <= POST_TOOL_CONTEXT_SHARE, `${offered.length} characters`)
    const shown = ids.filter((id) => offered.includes(id))
    assert.ok(shown.length > 0 && shown.length < ids.length)
    assert.match(offered, new RegExp(`\\n${ids.length} DevSpec notes are waiting for you \\(${ids.length - shown.length} not listed here\\); they come back after each step until you have read each one whole\\.$`))
    // Reading the ones shown brings the rest forward; nothing is lost on the way.
    for (const id of shown) handOver(prefix, catCall(home, noteFiles(home, id)[0]), { what: 'A note', home })
    const next = handOver(prefix, ls, { what: 'A note', home })
    assert.ok(ids.filter((id) => !shown.includes(id)).every((id) => pendingNotes(home, prefix).includes(id)))
    assert.ok(ids.filter((id) => !shown.includes(id)).some((id) => next.includes(id)))
  })

  it('with eight waiting, several with many unreadable parts, every step still brings the count, as many fixed-size pointers as fit, and the readable notes first', () => {
    const home = tempHome()
    const prefix = handOverPrefix('test', 'one')
    const dir = path.join(home, '.devspec', 'notes', 'pending')
    fs.mkdirSync(dir, { recursive: true })
    // Oldest first, an unreadable one oldest of all. Each unreadable one is a 60-part
    // note with 50 parts gone: listed in the hook's output, as before, its retry
    // commands alone were longer than the hook's share, and nothing at all came out.
    const plan = ['broken', 'readable', 'broken', 'broken', 'readable', 'broken', 'readable', 'readable']
    const long = (i) => Array.from({ length: 60 * 18 }, (_, line) => `${i}:${line} ${'z'.repeat(990)}`).join('\n')
    const notes = plan.map((kind, i) => {
      const note = writeNote(kind === 'readable' ? `readable message ${i}` : long(i), { home })
      if (kind === 'broken') {
        assert.equal(note.parts, 60)
        for (const file of noteFiles(home, note.id).slice(1, 51)) fs.rmSync(file)
      }
      fs.writeFileSync(path.join(dir, `${prefix}${note.id}.json`), JSON.stringify({ note: note.id, generation: i + 1, parts: [], at: `2026-11-20T00:00:0${i}Z` }))
      return { kind, id: note.id }
    })
    const readable = notes.filter((note) => note.kind === 'readable')
    const broken = notes.filter((note) => note.kind === 'broken')
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    const lineMax = handOverLineMax({ what: 'A note', total: 8 })
    const readableLine = noteNotice({ command: noteCommand(readable[0].id) }).length
    const brokenLine = `${noteNotice({ command: noteCommand(broken[0].id) })} Some parts of it could not be read back just now; see \`${noteStatusCommand(broken[0].id)}\`.`.length
    const countLine = (shown) => new RegExp(`(^|\\n)8 DevSpec notes are waiting for you${shown < 8 ? ` \\(${8 - shown} not listed here\\)` : ''}; they come back after each step until you have read each one whole\\.$`)
    for (const share of [POST_TOOL_CONTEXT_SHARE, 1_000, 600, 300, 140]) {
      for (let step = 0; step < 3; step += 1) {
        const offered = handOver(prefix, ls, { what: 'A note', share, home })
        assert.ok(offered, `share ${share}: something always comes out`)
        assert.ok(offered.length <= share, `share ${share}: ${offered.length} characters`)
        const lines = offered.split('\n').filter(Boolean)
        for (const line of lines) assert.ok(line.length <= lineMax, `share ${share}: a ${line.length}-character line, over ${lineMax}`)
        const listed = notes
          .filter((note) => offered.includes(noteCommand(note.id)))
          .sort((a, b) => offered.indexOf(noteCommand(a.id)) - offered.indexOf(noteCommand(b.id)))
        assert.match(offered, countLine(listed.length), `share ${share}: the count line ends every step`)
        // Readable notes are offered before any unreadable one.
        assert.deepEqual(listed.map((note) => note.kind), plan.slice().sort((a, b) => (a === b ? 0 : a === 'readable' ? -1 : 1)).slice(0, listed.length))
        if (listed.length < 8) {
          // As many as fit: the next one in line would not have.
          const used = lines.slice(0, -1).reduce((sum, line) => sum + line.length + 1, 0)
          const next = listed.length < readable.length ? readableLine : brokenLine
          assert.ok(used + next + 1 + lines.at(-1).length > share, `share ${share}: ${listed.length} listed, but another would have fitted`)
        }
        if (share >= 1_000) assert.ok(readable.every((note) => offered.includes(noteCommand(note.id))), `share ${share}: every readable note is offered`)
      }
    }
    // An unreadable note's details are in its status file, which fits one Shell page.
    const status = fs.readFileSync(path.join(home, '.devspec', 'notes', `${broken[0].id}.status.md`), 'utf8')
    assert.ok(fitsShellOutput(status))
    assert.match(status, /50 of its 60 parts could not be read back from disk just now \(parts 2-51\)/)
    // The readable ones read, the unreadable ones come forward, still counted and still waiting.
    for (const note of readable) handOver(prefix, catCall(home, noteFiles(home, note.id)[0]), { what: 'A note', home })
    const after = handOver(prefix, ls, { what: 'A note', home })
    assert.ok(broken.every((note) => after.includes(noteCommand(note.id)) && after.includes(noteStatusCommand(note.id))))
    assert.match(after, /\n\n4 DevSpec notes are waiting for you; they come back after each step until you have read each one whole\.$/)
    assert.deepEqual(pendingNotes(home, prefix).sort(), broken.map((note) => note.id).sort())
  })

  it("keeps an unreadable note's status to one Shell page, however many parts are damaged", () => {
    const id = '0123456789abcdef'
    assert.match(noteStatusText(id, 12, [2, 3, 4, 7, 9, 10]), /6 of its 12 parts could not be read back from disk just now \(parts 2-4, 7, 9-10\)/)
    assert.match(noteStatusText(id, 0, [1]), /its first part could not be read back from disk just now, so how many parts it has is not known yet/)
    const every = Array.from({ length: 9_000 }, (_, i) => i + 1).filter((part) => part % 2 === 0)
    const status = noteStatusText(id, 9_000, every)
    assert.ok(fitsShellOutput(status), `${status.length} characters`)
    assert.match(status, /4500 of its 9000 parts could not be read back from disk just now \(too many to list here: the first is part 2 and the last part 9000\)/)
    assert.ok(status.includes(`part N is \`cat ~/.devspec/notes/${id}.N.md\``))
  })

  it('still says, in a line of the same fixed size, that parts could not be read when even the status cannot be written', { skip: asRoot && 'root writes anywhere' }, () => {
    const home = tempHome()
    const prefix = handOverPrefix('test', 'one')
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    const first = handOver(prefix, ls, { add: `start ${'x'.repeat(NOTE_PART_CHARS)} end`, what: 'A note', home })
    const id = /notes\/([0-9a-f]{16})\.md/.exec(first)[1]
    fs.rmSync(noteFiles(home, id)[1])
    const notes = path.join(home, '.devspec', 'notes')
    fs.chmodSync(notes, 0o500)
    try {
      const offered = handOver(prefix, ls, { what: 'A note', home })
      assert.ok(offered.includes(`\`cat ~/.devspec/notes/${id}.md\``))
      assert.ok(offered.includes('Some parts of it could not be read back just now, nor its status written; it comes back at the next step.'))
      for (const line of offered.split('\n')) assert.ok(line.length <= handOverLineMax({ what: 'A note' }))
    } finally {
      fs.chmodSync(notes, 0o700)
    }
    assert.ok(handOver(prefix, ls, { what: 'A note', home }).includes(noteStatusCommand(id)), 'and points at the status once it can be written')
  })

  it('loses nothing over a long random run of adds, reads, cut reads, unreadable parts and broken records', { skip: asRoot && 'root reads any file' }, () => {
    const random = generator(424242)
    const home = tempHome()
    const prefix = handOverPrefix('test', 'one')
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    const offer = (input, add = null) => handOver(prefix, input, { add, what: 'A note', home })
    const undelivered = new Set()
    const locked = new Set()
    for (let step = 0; step < 300; step += 1) {
      const roll = random()
      const waiting = pendingNotes(home, prefix)
      if (roll < 0.35) {
        const text = `message-${step} ${'y'.repeat(Math.floor(random() * 2 * NOTE_PART_CHARS))}`
        undelivered.add(`message-${step} `)
        offer(ls, text)
      } else if (roll < 0.6 && waiting.length) {
        // A whole read of one waiting delivery, part by part.
        const id = waiting[Math.floor(random() * waiting.length)]
        const files = noteFiles(home, id)
        if (files.some((file) => locked.has(file))) continue
        const text = readNoteText(id, { home })
        files.forEach((file) => offer(catCall(home, file)))
        if (!pendingNotes(home, prefix).includes(id)) for (const marker of undelivered) if (text.includes(marker)) undelivered.delete(marker)
      } else if (roll < 0.7 && waiting.length) {
        // A read Cursor cut: head and tail kept.
        const file = noteFiles(home, waiting[0])[0]
        if (locked.has(file)) continue
        const whole = fs.readFileSync(file, 'utf8')
        offer({ ...catCall(home, file), tool_output: JSON.stringify({ output: `${whole.slice(0, 50)}\n...\n${whole.slice(-150)}`, exitCode: 0 }) })
      } else if (roll < 0.85 && waiting.length) {
        // A part that cannot be read for a while.
        const files = noteFiles(home, waiting[Math.floor(random() * waiting.length)])
        const file = files[Math.floor(random() * files.length)]
        if (locked.has(file)) { fs.chmodSync(file, 0o600); locked.delete(file) } else { fs.chmodSync(file, 0o000); locked.add(file) }
      } else if (waiting.length) {
        // A delivery record broken on disk.
        fs.writeFileSync(path.join(home, '.devspec', 'notes', 'pending', `${prefix}${waiting[0]}.json`), 'broken')
      }
      // The invariant: whatever was handed over and not yet read whole is still in a waiting note.
      for (const file of locked) fs.chmodSync(file, 0o600)
      const kept = pendingNotes(home, prefix).map((id) => readNoteText(id, { home }) ?? '').join('\n')
      for (const file of locked) fs.chmodSync(file, 0o000)
      for (const marker of undelivered) assert.ok(kept.includes(marker), `step ${step}: ${marker} was lost`)
    }
    for (const file of locked) fs.chmodSync(file, 0o600)
  })

  it('loses nothing when hooks for parallel tool calls add to the same hand-over at once', async () => {
    const home = tempHome()
    const prefix = handOverPrefix('test', 'one')
    const module = new URL('./hook-context-budget.mjs', import.meta.url).href
    const ls = { conversation_id: 'one', tool_name: 'Shell', tool_input: { command: 'ls' } }
    handOver(prefix, ls, { add: 'already waiting', what: 'A note', home })
    const { spawn } = await import('node:child_process')
    const add = (text) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { handOver } = await import(${JSON.stringify(module)})
        handOver(${JSON.stringify(prefix)}, ${JSON.stringify(ls)}, { add: ${JSON.stringify(text)}, what: 'A note', home: ${JSON.stringify(home)} })
      `], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    })
    const texts = Array.from({ length: 12 }, (_, i) => `parallel message ${i}`)
    await Promise.all(texts.map(add))
    const kept = pendingNotes(home, prefix).map((id) => readNoteText(id, { home })).join('\n')
    for (const text of ['already waiting', ...texts]) assert.ok(kept.includes(text), `${text} was lost`)
  })
})
