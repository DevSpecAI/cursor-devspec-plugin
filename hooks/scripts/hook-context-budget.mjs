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
 *   always be handed over. A note longer than one Shell page is split into numbered
 *   parts, each short enough to reach the model whole through `cat` under both of
 *   Cursor's Shell rules (`NOTE_PART_CHARS`, `NOTE_PART_BYTES`), cut only between
 *   lines or whole characters, each closing with the command for the next.
 * - A note counts as read only on what came back: an exact `cat` of a part that exited
 *   0 with the part's closing line in its output, or Cursor's Read tool reporting the
 *   part's full length. Mentioning a note (`test -e`, `ls`, `grep -l`) is not reading it.
 * - What must reach the agent (the project's rules and repositories, a message the
 *   person has not heard, room messages it has not read) is never recorded as
 *   delivered because a hook printed it. Rules and the person's message are handed
 *   over as a note file, and the pointer comes back after every step until the agent
 *   is seen reading all of it (`noteReadThrough`); unread room messages are counted after
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

import { readPrivateJson, writePrivateJson, writePrivateText } from './private-state.mjs'

/** In UTF-16 code units: the CLI's hooks carrier compares the joined text's JavaScript `.length`. */
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

/**
 * How much of a Shell command's output Cursor hands the model, in UTF-16 code units
 * (JavaScript string length). Measured on cursor-agent 2026.11.05-86047df, 20 November
 * 2026: 20,000 ASCII characters arrived whole and 21,000 arrived as the first 10,000
 * and the last 10,000 under "Command output (truncated to 20000 characters)", on two
 * models (Gemini 4 Hydrogen and Composer 2.5). The unit: 10,160 CJK characters
 * (30,160 bytes) arrived whole, so it is not bytes; lines mixing emoji and ASCII,
 * 18,288 code points but 21,276 UTF-16 code units, were cut, so it is not code points.
 */
export const CURSOR_SHELL_OUTPUT_MAX_CHARS = 20_000

/**
 * The second rule on the same output, in UTF-8 bytes: past it Cursor shows the model
 * none of the output, only "Command output has been written to: <file> (44.2 KB, 15
 * lines)". Measured on the same day: 40,000 bytes were shown (cut to 20,000
 * characters, but not moved to a file), 30,160 bytes of CJK were shown whole, and
 * 45,240 bytes of CJK and 50,800 bytes of ASCII were moved to a file.
 */
export const CURSOR_SHELL_OUTPUT_MAX_BYTES = 40_000

/** Whether `text`, printed by one Shell command, reaches the model whole under both rules. */
export function fitsShellOutput(text) {
  return text.length <= CURSOR_SHELL_OUTPUT_MAX_CHARS && Buffer.byteLength(text) <= CURSOR_SHELL_OUTPUT_MAX_BYTES
}

/**
 * The longest part of a note, so `cat` of one part always reaches the model whole:
 * 2,000 characters under Cursor's Shell ceiling and 4,000 bytes under its move-to-a-file
 * rule, for the part's closing line and anything the shell itself prints into the same
 * output. Measured on 20 November 2026: `cat` of a 19,012-character file reached the
 * model whole, and the hook saw the whole output with exit code 0.
 */
export const NOTE_PART_CHARS = 18_000
export const NOTE_PART_BYTES = 36_000

/** Where notes too long for a hook, or that must be seen read, are kept: one private folder. */
const NOTES_DIR = path.join('.devspec', 'notes')
const NOTE_ID = /^[0-9a-f]{16}$/

function partName(id, part) {
  return part === 1 ? `${id}.md` : `${id}.${part}.md`
}

function partFile(id, part, home) {
  return path.join(home, NOTES_DIR, partName(id, part))
}

/** The command that prints part `part` of note `id` (the first part is the note's own name). */
export function noteCommand(id, part = 1) {
  return `cat ~/.devspec/notes/${partName(id, part)}`
}

/**
 * The line that closes each part: it says which part this is and how to read the next,
 * and the plugin counts a part as read only when the output the agent got carries it.
 */
function partEnd(id, part, parts) {
  return part < parts
    ? `— DevSpec note ${id}: part ${part} of ${parts}. Read on with \`${noteCommand(id, part + 1)}\` —`
    : `— End of DevSpec note ${id}${parts > 1 ? `: part ${parts} of ${parts}` : ''} —`
}

const GRAPHEMES = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/**
 * `text` as the units it may be cut between: grapheme clusters (an emoji with its
 * modifiers or ZWJ sequence, a letter with its combining marks), so no character is
 * ever cut in two. A cluster too long for a part on its own (no real text has one) is
 * cut between code points, never inside a surrogate pair.
 */
function cuttable(text, maxChars, maxBytes) {
  const units = GRAPHEMES ? Array.from(GRAPHEMES.segment(text), ({ segment }) => segment) : Array.from(text)
  return units.flatMap((unit) => (unit.length > maxChars || Buffer.byteLength(unit) > maxBytes ? Array.from(unit) : [unit]))
}

/**
 * `text` in pieces of at most `maxChars` UTF-16 code units and `maxBytes` UTF-8 bytes,
 * the two things Cursor's Shell rules count. A piece ends at a line end when one falls
 * in its second half, otherwise at a grapheme boundary. Joined, the pieces are the
 * text, byte for byte.
 */
export function splitText(text, maxChars = NOTE_PART_CHARS, maxBytes = NOTE_PART_BYTES) {
  const pieces = []
  let piece = []
  let chars = 0
  let bytes = 0
  let lineEnd = -1 // how many units of `piece` end with its last line break
  for (const unit of cuttable(text, maxChars, maxBytes)) {
    const unitChars = unit.length
    const unitBytes = Buffer.byteLength(unit)
    if (piece.length > 0 && (chars + unitChars > maxChars || bytes + unitBytes > maxBytes)) {
      const cut = lineEnd > 0 && lineEnd >= piece.length / 2 ? lineEnd : piece.length
      pieces.push(piece.slice(0, cut).join(''))
      piece = piece.slice(cut)
      const carried = piece.join('')
      chars = carried.length
      bytes = Buffer.byteLength(carried)
      lineEnd = -1
    }
    piece.push(unit)
    chars += unitChars
    bytes += unitBytes
    if (unit.includes('\n')) lineEnd = piece.length
  }
  pieces.push(piece.join(''))
  return pieces
}

/**
 * Keep `text` whole as a note, readable only by its owner, and return its short id,
 * where it starts, the one command that reads it and how many parts it has. The id is
 * the text's own digest, so the same text is one note. A note longer than one part
 * (`NOTE_PART_CHARS`, `NOTE_PART_BYTES`) is split into numbered parts (`splitText`), each closing with the command for
 * the next, so every part reaches the model whole through Cursor's Shell ceiling. The
 * command names the folder through `~`, so every pointer has the same short length
 * whatever the home folder is called.
 */
export function writeNote(text, { home = os.homedir() } = {}) {
  const id = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const pieces = splitText(text)
  const first = partFile(id, 1, home)
  // The same text is the same note: written once, the first part last, so a first
  // part on disk means every part is.
  if (!fs.existsSync(first)) {
    for (let part = pieces.length; part >= 1; part -= 1) {
      writePrivateText(partFile(id, part, home), `${pieces[part - 1]}\n\n${partEnd(id, part, pieces.length)}\n`)
    }
  }
  return { id, file: first, command: noteCommand(id), parts: pieces.length }
}

/** How many parts note `id` has, from its first part's closing line; 0 when there is no such note. */
export function noteParts(id, { home = os.homedir() } = {}) {
  if (!NOTE_ID.test(String(id ?? ''))) return 0
  let first
  try {
    first = fs.readFileSync(partFile(id, 1, home), 'utf8')
  } catch {
    return 0
  }
  const of = new RegExp(`— DevSpec note ${id}: part 1 of (\\d+)\\.`).exec(first)
  return of ? Number(of[1]) : 1
}

/** Note `id`'s text, its parts joined back without their closing lines; null when there is none. */
export function readNoteText(id, { home = os.homedir() } = {}) {
  const parts = noteParts(id, { home })
  if (parts === 0) return null
  let text = ''
  for (let part = 1; part <= parts; part += 1) {
    const content = fs.readFileSync(partFile(id, part, home), 'utf8')
    const close = `\n\n${partEnd(id, part, parts)}\n`
    if (!content.endsWith(close)) return null
    text += content.slice(0, content.length - close.length)
  }
  return text
}

function parsed(value) {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * The part of note `id` (of `parts`) this tool call handed the agent whole, or null.
 * Only two things count, and only on what came back, never on what was asked:
 * - a shell command that is exactly `cat` of one part (after the plugin's own PATH
 *   line, if any), that exited 0 and whose output carries that part's closing line;
 * - Cursor's Read tool on exactly one part's file, which reported reading as many
 *   characters as the part holds (Read gave a 30,012-character file to the model
 *   whole on 20 November 2026, and every part is far shorter).
 * Anything else that mentions a note (`test -e`, `ls`, `grep -l`, a `cat` piped on,
 * a failed or cut-short read) is not a read.
 */
function partReadBy(input, id, parts, home) {
  const tool = String(input?.tool_name ?? input?.toolName ?? '')
  const toolInput = parsed(input?.tool_input ?? input?.toolInput) ?? {}
  const output = parsed(input?.tool_output ?? input?.toolOutput) ?? {}
  const expand = (value) => {
    const raw = String(value ?? '').trim()
    const home_ = raw.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home)
    return path.isAbsolute(home_) ? path.normalize(home_) : null
  }
  const partAt = (file) => {
    if (!file) return null
    for (let part = 1; part <= parts; part += 1) if (file === partFile(id, part, home)) return part
    return null
  }
  if (/^(Shell|Bash|shell|bash)$/.test(tool)) {
    const lines = String(toolInput.command ?? toolInput.cmd ?? '').split('\n')
    if (lines.length > 1 && lines[0].startsWith('export PATH=')) lines.shift()
    if (lines.length !== 1) return null
    const cat = /^\s*cat\s+(['"]?)([^\s'"|;&<>`]+)\1\s*$/.exec(lines[0])
    const part = partAt(cat ? expand(cat[2]) : null)
    if (!part || output?.exitCode !== 0 || typeof output?.output !== 'string') return null
    return output.output.includes(partEnd(id, part, parts)) ? part : null
  }
  if (tool === 'Read') {
    const part = partAt(expand(toolInput.file_path ?? toolInput.path))
    if (!part) return null
    let content
    try {
      content = fs.readFileSync(partFile(id, part, home), 'utf8')
    } catch {
      return null
    }
    const length = Number(output?.content_length)
    return length === content.length || length === Buffer.byteLength(content) ? part : null
  }
  return null
}

/**
 * Whether the agent in this tool call's conversation has now read every part of note
 * `id`. A part this call handed over whole (`partReadBy`) is recorded for the
 * conversation, privately, beside the note. Seeing the agent read a note is the only
 * sign the plugin has that what it says reached the agent; a hook printing a pointer
 * to it proves nothing (see the notes at the top of this file).
 */
export function noteReadThrough(input, id, { home = os.homedir() } = {}) {
  const parts = noteParts(id, { home })
  if (parts === 0) return false
  const conversation = String(input?.conversation_id || input?.conversationId || input?.session_id || 'none')
  const record = path.join(home, NOTES_DIR, `${id}.read-${createHash('sha256').update(conversation).digest('hex').slice(0, 16)}.json`)
  let read = readPrivateJson(record)?.parts
  read = Array.isArray(read) ? read.filter((part) => Number.isInteger(part)) : []
  const part = partReadBy(input, id, parts, home)
  if (part && !read.includes(part)) {
    read = [...read, part]
    writePrivateJson(record, { parts: read })
  }
  for (let each = 1; each <= parts; each += 1) if (!read.includes(each)) return false
  return true
}

/** The shortest way to say a note is waiting: fixed text and a fixed-length command. */
export function noteNotice(note) {
  return `DevSpec has more context waiting for you: run \`${note.command}\`, and every further part it names.`
}

/**
 * A pointer to `note`: what it is, why it is in a file, and how to read it. Its parts
 * are fixed text, the caller's short `what` and `also`, and a fixed-length command.
 */
export function notePointer(note, { what = 'A note from the DevSpec plugin', also = '' } = {}) {
  return (
    `${what} is waiting for you whole in a file, because Cursor passes on at most ` +
    `${CURSOR_HOOK_CONTEXT_MAX_CHARS.toLocaleString('en-US')} characters from all the hooks answering one step together. ` +
    `Read it now: \`${note.command}\`, and every further part it names.` +
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
