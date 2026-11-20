/**
 * Cursor's ceiling on the context hooks add to one event, how the plugin's hooks
 * share it, and the one way every one of them hands context over, so nothing a hook
 * gives the agent is ever cut, and nothing that must arrive is lost unnoticed.
 *
 * Maintainer notes: what Cursor does with hook context, as measured.
 *
 * - The ceiling. On cursor-agent 2026.11.05-86047df, 20 November 2026 (DevSpec task
 *   8f940862, live check in a throwaway profile), a postToolUse `additional_context`
 *   of 9,900 characters reached the model whole; one of 12,000 was dropped whole, and
 *   nothing told the model. The CLI bundle's hooks carrier joins the answers of EVERY
 *   hook that answers one event (this plugin's, other plugins', the person's own),
 *   each trimmed and separated by "\n\n---\n\n", and drops the joined text whole once
 *   it is over 10,000 characters.
 * - No record of delivery. Cursor's agent transcript
 *   (~/.cursor/projects/<folder>/agent-transcripts/<chat>.jsonl) holds the person's
 *   prompts, the agent's text and its tool calls, never the context hooks added:
 *   checked 20 November 2026 with a hook answering a 21-character note (delivered:
 *   the stream showed it beside the tool result) and a 12,000-character one (dropped),
 *   neither of which is in the transcript. (Cursor's private chat store,
 *   ~/.cursor/chats/<hash>/<chat>/store.db, does hold the delivered one and not the
 *   dropped one, but it is an undocumented internal database, so nothing here reads it.)
 *
 * So the plugin cannot know whether a note it printed reached the agent: its own hooks
 * stay within the ceiling together, but another plugin's or the person's hooks on the
 * same step can push the total over it. How the plugin copes:
 *
 * - Every hook keeps to an equal share of the ceiling (`fitHookContext`), so the
 *   plugin's own notes never drop each other; anything longer goes whole to a file in
 *   ~/.devspec/notes/ named by a short id, and the note says how to read it. That
 *   pointer has a fixed shape and length, well within the smallest share, so it can
 *   always be handed over.
 * - What must reach the agent (the project's rules and repositories, a message the
 *   person has not heard, room messages it has not read) is never recorded as
 *   delivered because a hook printed it. Rules and the person's message are handed
 *   over as a note file, and the pointer comes back after every step until the agent
 *   is seen reading that file (`readsNote`); unread room messages are counted after
 *   every step until the agent reads them. A step whose notes Cursor dropped is
 *   followed by another that offers them again.
 * - One-off hints (a commit note, the edit reminder, a pin problem, the repository-link
 *   nudge) are offered once and not repeated: losing one costs a hint, never the rules,
 *   a person's message or the room, and saying it after every step would cost more.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
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

/** Where notes too long for a hook, or that must be seen read, are kept: one private folder. */
const NOTES_DIR = path.join('.devspec', 'notes')
const NOTE_ID = /^[0-9a-f]{16}$/

/**
 * Keep `text` whole as a note, readable only by its owner, and return its short id,
 * where it is and the one command that reads it. The id is the text's own digest, so
 * the same text is one note. The command names the folder through `~`, so every
 * pointer has the same short length whatever the home folder is called.
 */
export function writeNote(text, { home = os.homedir() } = {}) {
  const id = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const file = path.join(home, NOTES_DIR, `${id}.md`)
  // The same text is the same note: written once, then left as it is.
  if (!fs.existsSync(file)) writePrivateText(file, text)
  return { id, file, command: noteCommand(id) }
}

/** The command that prints note `id`. */
export function noteCommand(id) {
  return `cat ~/.devspec/notes/${id}.md`
}

/**
 * Whether this tool call read note `id`: Cursor's Read tool on its file, or a shell
 * command that names it (the pointer's own `cat`, or any other). Seeing the agent
 * read a note is the only sign the plugin has that what it says reached the agent.
 */
export function readsNote(input, id) {
  if (!NOTE_ID.test(String(id ?? ''))) return false
  const tail = `.devspec/notes/${id}.md`
  const tool = String(input?.tool_name ?? input?.toolName ?? '')
  let toolInput = input?.tool_input ?? input?.toolInput ?? {}
  if (typeof toolInput === 'string') {
    try {
      toolInput = JSON.parse(toolInput)
    } catch {
      toolInput = { command: toolInput }
    }
  }
  const values = [toolInput?.file_path, toolInput?.filePath, toolInput?.path, toolInput?.target_file, toolInput?.command, toolInput?.cmd]
    .filter((value) => typeof value === 'string')
    .map((value) => value.replaceAll('\\', '/'))
  if (/^(Shell|Bash|shell|bash)$/.test(tool)) return values.some((value) => value.includes(tail))
  return values.some((value) => value.endsWith(tail))
}

/** The shortest way to say a note is waiting: fixed text and a fixed-length command. */
export function noteNotice(note) {
  return `DevSpec has more context waiting for you: run \`${note.command}\` and read it whole.`
}

/**
 * A pointer to `note`: what it is, why it is in a file, and how to read it. Its parts
 * are fixed text, the caller's short `what` and `also`, and a fixed-length command.
 */
export function notePointer(note, { what = 'A note from the DevSpec plugin', also = '' } = {}) {
  return (
    `${what} is waiting for you whole in a file, because Cursor passes on at most ` +
    `${CURSOR_HOOK_CONTEXT_MAX_CHARS.toLocaleString('en-US')} characters from all the hooks answering one step together. ` +
    `Read it now: \`${note.command}\`.` +
    (also ? ` ${also}` : '')
  )
}

/**
 * `note` as one hook's context within `share`: its pointer, after `lead` when both fit,
 * or the fixed short notice when the pointer does not. Null only when not even that
 * fits, which no real share allows; the caller then hands over nothing and keeps the
 * content to offer again.
 */
export function pointToNote(note, { share = POST_TOOL_CONTEXT_SHARE, what, also = '', lead = null } = {}) {
  const pointer = notePointer(note, { what, also })
  if (typeof lead === 'string' && lead && lead.length + 2 + pointer.length <= share) return `${lead}\n\n${pointer}`
  if (pointer.length <= share) return pointer
  const notice = noteNotice(note)
  return notice.length <= share ? notice : null
}

/**
 * `text` as one hook's context: the text itself when it fits the hook's `share`;
 * otherwise it is kept whole as a note (`writeNote`) and the context is a pointer to
 * it (`pointToNote`). Null for nothing to say, or when not even the short notice fits
 * the share: the caller then hands over nothing and records nothing as said, since
 * Cursor would drop an over-long note whole, and every other hook's with it. A failed
 * write throws, for the same reason.
 */
export function fitHookContext(
  text,
  { share = POST_TOOL_CONTEXT_SHARE, what, lead = null, also = '', home = os.homedir() } = {},
) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  if (text.length <= share) return text
  return pointToNote(writeNote(text, { home }), { share, what, also, lead })
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
