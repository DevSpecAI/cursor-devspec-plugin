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
  postToolUseOutput,
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

  it('puts a longer note in a private file, whole, and hands over a pointer within the share', () => {
    const home = tempHome()
    const text = `${'a long note '.repeat(1_000)}END`
    const pointer = fitHookContext(text, { home, what: 'A long note', lead: 'The short part.' })
    assert.ok(pointer.length <= POST_TOOL_CONTEXT_SHARE)
    assert.ok(pointer.startsWith('The short part.\n\nA long note does not fit in one hook note'))
    const file = JSON.parse(pointer.match(/at ("[^"]+"): nothing in that file is cut/)[1])
    assert.ok(file.startsWith(path.join(home, '.devspec', 'cursor-hook-context')))
    assert.equal(fs.readFileSync(file, 'utf8'), text)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it('hands over nothing when not even the pointer fits, so Cursor never drops the other hooks\' notes', () => {
    assert.equal(fitHookContext('x'.repeat(500), { home: tempHome(), share: 100 }), null)
  })
})
