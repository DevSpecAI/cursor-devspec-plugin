#!/usr/bin/env node
/**
 * The plugin's hooks share Cursor's one ceiling on the context hooks add to an event.
 * Run: node --test hooks/scripts/hook-context-budget.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CURSOR_HOOK_CONTEXT_MAX_CHARS,
  CURSOR_HOOK_CONTEXT_SEPARATOR,
  hookContextShare,
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
