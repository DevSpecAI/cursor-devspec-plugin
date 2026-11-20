/**
 * Cursor's ceiling on the context hooks add to one event, how the plugin's hooks
 * share it, and the one way every one of them hands context over, so nothing a hook
 * gives the agent is ever cut or dropped.
 *
 * Measured on cursor-agent 2026.11.05-86047df, 20 November 2026 (DevSpec task
 * 8f940862, live check in a throwaway profile): a postToolUse `additional_context` of
 * 9,900 characters reached the model whole; one of 12,000 was dropped whole, and
 * nothing told the model. The CLI bundle does the same in its hooks carrier: it joins
 * the answers of every hook that answers one event, each trimmed and separated by
 * "\n\n---\n\n", and drops the joined text whole once it is over 10,000 characters.
 * So the plugin's hooks that can answer the same event share the one ceiling, and a
 * long answer from one of them would take every other hook's answer down with it.
 */
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { writePrivateText } from './private-state.mjs'

export const CURSOR_HOOK_CONTEXT_MAX_CHARS = 10_000

/** What Cursor puts between two hooks' answers to one event. */
export const CURSOR_HOOK_CONTEXT_SEPARATOR = '\n\n---\n\n'

/**
 * The plugin's postToolUse hooks that can add context to the same tool call:
 * project and repository context (repository-context.mjs), the commit note
 * (provenance-assistance.mjs), the repository-link nudge (repo-link-nudge.mjs), the
 * pin check (pin-check.mjs: its two entries match different tools, so one answers),
 * a message the person has not heard (mark-explicit-reply.mjs) and the room's
 * unread count (room-unread.mjs). Each hands its context over through
 * `fitHookContext`; adding another means counting it here.
 */
export const POST_TOOL_CONTEXT_HOOKS = 6

/**
 * One hook's share when `hooks` of the plugin's hooks can answer the same event: an
 * equal part of the ceiling once the separators between them are taken out, so their
 * joined answers can never pass it.
 */
export function hookContextShare(hooks) {
  const count = Math.max(1, Math.floor(hooks))
  return Math.floor((CURSOR_HOOK_CONTEXT_MAX_CHARS - (count - 1) * CURSOR_HOOK_CONTEXT_SEPARATOR.length) / count)
}

/** A postToolUse hook's share of Cursor's ceiling. */
export const POST_TOOL_CONTEXT_SHARE = hookContextShare(POST_TOOL_CONTEXT_HOOKS)

/** sessionStart has one plugin hook (repository-context.mjs start), so it has the whole ceiling. */
export const SESSION_START_CONTEXT_SHARE = hookContextShare(1)

/** Where a note too long for its share is kept, whole and readable only by its owner. */
export function hookContextFile(text, home = os.homedir()) {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 32)
  return path.join(home, '.devspec', 'cursor-hook-context', `${digest}.md`)
}

function quotedPath(file) {
  return JSON.stringify(file).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

/**
 * `text` as one hook's context: the text itself when it fits the hook's `share`;
 * otherwise the whole text goes to a private file (`spill(text)` returns where, by
 * default `hookContextFile`) and the agent is told to read it. `lead`, a shorter part
 * of the text, is kept in front of that pointer when both fit; `also` is added to the
 * pointer.
 *
 * Returns null when there is nothing to say, or when not even the pointer fits the
 * share (a home folder path longer than the share). The caller then hands over
 * nothing and records nothing as delivered: Cursor would drop an over-long note whole,
 * and every other hook's note with it. A failed write throws, for the same reason.
 */
export function fitHookContext(
  text,
  {
    share = POST_TOOL_CONTEXT_SHARE,
    what = 'A note from the DevSpec plugin',
    lead = null,
    also = '',
    home = os.homedir(),
    spill = null,
  } = {},
) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  if (text.length <= share) return text
  let file
  if (spill) {
    file = spill(text)
  } else {
    file = hookContextFile(text, home)
    writePrivateText(file, text)
  }
  const pointer =
    `${what} does not fit in one hook note: Cursor passes on at most ` +
    `${CURSOR_HOOK_CONTEXT_MAX_CHARS.toLocaleString('en-US')} characters from all of the DevSpec plugin's notes after a step together. ` +
    `Read it whole now, with the file-reading tool, at ${quotedPath(file)}: nothing in that file is cut.` +
    (also ? ` ${also}` : '')
  if (typeof lead === 'string' && lead && lead.length + 2 + pointer.length <= share) return `${lead}\n\n${pointer}`
  return pointer.length <= share ? pointer : null
}

/**
 * A postToolUse hook's output for `context`, already fitted with `fitHookContext`, in
 * both the field Cursor reads and the hook-specific shape; null for nothing to say.
 */
export function postToolUseOutput(context, extra = {}) {
  if (typeof context !== 'string' || context.length === 0) return null
  return {
    ...extra,
    additional_context: context,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  }
}
