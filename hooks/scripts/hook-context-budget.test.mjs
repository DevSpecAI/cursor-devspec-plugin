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

import {
  CURSOR_HOOK_CONTEXT_MAX_CHARS,
  CURSOR_HOOK_CONTEXT_SEPARATOR,
  fitHookContext,
  hookContextShare,
  notePointer,
  postToolUseOutput,
  readsNote,
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
    assert.equal(fs.readFileSync(file, 'utf8'), text)
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
    const notice = fitHookContext(text, { home, share: 120 })
    assert.match(notice, /^DevSpec has more context waiting for you: run `cat ~\/\.devspec\/notes\/[0-9a-f]{16}\.md` and read it whole\.$/)
    assert.equal(fitHookContext(text, { home, share: 40 }), null)
  })

  it('knows a tool call that read a note, by Read or by a shell command, and nothing else', () => {
    const id = '0123456789abcdef'
    assert.equal(readsNote({ tool_name: 'Read', tool_input: { file_path: `/home/me/.devspec/notes/${id}.md` } }, id), true)
    assert.equal(readsNote({ tool_name: 'Read', tool_input: { file_path: `~/.devspec/notes/${id}.md` } }, id), true)
    assert.equal(readsNote({ tool_name: 'Shell', tool_input: { command: `cat ~/.devspec/notes/${id}.md` } }, id), true)
    assert.equal(readsNote({ tool_name: 'Shell', tool_input: { command: 'ls ~/.devspec/notes' } }, id), false)
    assert.equal(readsNote({ tool_name: 'Read', tool_input: { file_path: `/home/me/.devspec/notes/${id}.md.bak` } }, id), false)
    assert.equal(readsNote({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }, id), false)
    assert.equal(readsNote({ tool_name: 'Read', tool_input: { file_path: '/x/.devspec/notes/../../etc/passwd' } }, '../../etc'), false)
  })
})
