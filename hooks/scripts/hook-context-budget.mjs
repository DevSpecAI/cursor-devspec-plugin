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
 *   0, whose output (as Cursor gave it to the hook) is within the Shell rules and
 *   carries the whole part by its seal (length and hash), or Cursor's Read tool
 *   reporting the part's full length. Mentioning a note (`test -e`, `ls`, `grep -l`) or
 *   a cut that kept its head and tail is not reading it.
 * - What must reach the agent is never recorded as delivered because a hook printed
 *   it. It is handed over as a note, and the pointer comes back after every step until
 *   the agent is seen reading all of that delivery (`deliveryReadThrough`, `handOver`).
 *   A read belongs to one delivery, never to the text: rules changed and changed back,
 *   or a message left again, must be read again. This covers the project's rules and
 *   repositories; a message the person has not heard; a commit note (a commit that
 *   went untracked, and what to do about it); a pin problem (the folder is not linked
 *   to its project until the pin is fixed); the repository-link nudge (the person
 *   must link the repository); and the check jobs and notices DevSpec sent while the
 *   agent was working (step-delivery.mjs keeps its own delivery record; between turns
 *   the idle wake points at the same kind of note, and an item stays until its note
 *   is read whole). Unread room messages are counted after every step until
 *   the reader's output has come back whole. A step whose notes Cursor dropped is
 *   followed by another that offers them again.
 * - Two hints are offered once: the note that a reference was added to a commit (the
 *   commit is right whether or not the agent hears it), and the edit reminder to claim
 *   a task (the same advice reaches the agent where it matters, at the commit: in the
 *   git stand-in's own output, or in the commit note above).
 *
 * THE INVARIANT, and every path that could break it. Pending content is cleared only by
 * a proven whole read (`readThrough`: every part, by its seal, in the current delivery).
 * Each path below either keeps to it or only ever errs towards offering again; each has
 * a test (named in brackets, in the test file beside the module).
 *
 * Kinds of content:
 *  1. Rules and repositories (repository-context.mjs): a delivery is keyed by the
 *     note, the change generation, the session count and the Cursor process; the
 *     pointer is offered until that key's delivery is read whole. [rules always go to
 *     a note…; A, then B, then A…]
 *  2. A message the person has not heard (mark-explicit-reply.mjs): taken from its
 *     queue only into a hand-over, and put back if the hand-over cannot be written.
 *     [hands the message over whole in a note…]
 *  3. A commit note (provenance-assistance.mjs): kept in the state, never pruned by
 *     age, until it is in a hand-over; every waiting note is taken in, not only the
 *     current call's, so one whose command failed after committing still arrives.
 *     [offers a commit note after every step…; takes in a commit note whose own command
 *     never reported back…]
 *  4. A pin problem (pin-check.mjs) and 5. the repository-link reminder
 *     (repo-link-nudge.mjs): hand-overs; their hooks run while one waits. A link
 *     reminder is marked as said only once it is in a hand-over. [offers it after
 *     every step…; is found once per conversation…; the hooks.json filters…]
 *  6. Room messages (room-unread.mjs): read only when the reader's page came back
 *     whole, or, for one kept as a note, when every part of that note did; the read
 *     record, not the pending files, is the truth, so losing a pending file only means
 *     the reader shows a message again. [marks nothing read when what came back is not
 *     the whole page…; hands over a message with a huge attachment list…]
 *
 * Receipts and read records:
 *  7. A read counts for one delivery only: the same text handed over again starts
 *     with nothing read. [counts a delivery read only when every part came back whole…]
 *  8. A record that cannot be read starts its delivery again, never ends it; a
 *     hand-over whose record is broken is still offered, by the note its file name
 *     gives. [still offers a delivery whose record cannot be read]
 *  9. A cut read (Cursor kept head and tail), a changed body, a failed command, an
 *     output over the Shell rules, or a command that only mentions a note never counts.
 *     [never counts a command that only mentions a note…; counts a part read only when
 *     the whole of it came back…]
 *
 * Sessions:
 * 10. Session start (a new or resumed chat): a new rules delivery. [full facts and
 *     rules…: the session start's pointer]
 * 11. Resume without sessionStart (an installed plugin's sessionStart did not run in
 *     terminal sessions, 20 Nov): a new Cursor process is a new rules delivery
 *     (`hostSession`; not available on Windows, where 10 and 12 still apply). [a
 *     resumed chat…]
 * 12. Compaction: the preCompact hook begins a new rules delivery. [the preCompact
 *     hook, run as Cursor runs it…]
 * 13. New chat: a new conversation, with deliveries of its own; what waits for an
 *     earlier chat stays waiting there, offered when that chat runs again. A helper
 *     agent's tool calls are its own conversation, so its reads never count for its
 *     parent. Rules are owed again per session because they are standing instructions;
 *     messages, notes and room messages are owed once, until read once.
 *
 * Failures:
 * 14. A part that cannot be read back: nothing is joined, replaced or dropped; the new
 *     text becomes its own delivery. The pointer gains one fixed-length sentence naming
 *     the note's status file, which says which parts failed and how to retry; the
 *     details never go in the hook's output, so they cannot make it too long. The
 *     status itself fits one Shell page; one that cannot be written leaves a fixed
 *     sentence saying so, and the note comes back next step. [never drops or replaces
 *     a waiting note because part of it cannot be read; keeps an unreadable note's
 *     status to one Shell page…; still says, in a line of the same fixed size…]
 * 15. A write that fails: nothing is marked; the content stays at its source (a
 *     message is put back, a commit note stays in the state, a link reminder is not
 *     marked as said; a pin problem is raised again when the pin is next written).
 *     [keeps a commit note in the state when its hand-over cannot be written…; puts the
 *     message back when its hand-over cannot be written…]
 * 16. More waiting than fits a hook's share: every line of a hand-over has a fixed
 *     largest size whatever the notes hold (`handOverLineMax`); room for the count line
 *     is kept before any pointer is laid out, so it always arrives; readable deliveries
 *     are listed before ones with unreadable parts, so those never crowd out the rest;
 *     short notices stand for each when not all pointers fit, and the count line says
 *     how many are not listed. All are offered again next step; none dropped. [offers
 *     every waiting note when they do not all fit…; with eight waiting, several with
 *     many unreadable parts, every step still brings the count…]
 * 17. Any mix of the above over time. [loses nothing over a long random run…]
 *
 * Concurrency:
 * 18. Hooks for parallel tool calls can update the same records. Notes are written once
 *     and never changed (named by their own content); every record is replaced whole,
 *     atomically; a joined hand-over is written before the one it replaces is removed.
 *     So a lost update can only lose read progress (the note is offered again), or
 *     leave content offered twice, never remove content that was not read. A page the
 *     reader printed twice in parallel confirms only the last one; the other's
 *     messages are shown again. [loses nothing when hooks for parallel tool calls add
 *     to the same hand-over at once; loses nothing over a long random run…]
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { wakeLines } from './devspec-wake-file.mjs'
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
 * a message the person has not heard (mark-explicit-reply.mjs), the room's unread
 * count (room-unread.mjs) and what DevSpec sent the agent while it was working
 * (step-delivery.mjs). Each hands its context over through this module, within its
 * share; adding another means counting it here. The plugin's other postToolUse hooks
 * add none and are not counted: the recall-note read watcher (turn-recall.mjs
 * `post-tool`, which only observes), the work trail and timing (mirror-turn.mjs,
 * turn-tool-timing.mjs, trail-turn.mjs), the commit observers (commit-observation.mjs,
 * commit-reports.mjs) and turn liveness (turn-liveness.mjs).
 */
export const POST_TOOL_CONTEXT_HOOKS = 7

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

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

/**
 * `body` sealed for handing over through Cursor's Shell: a closing line naming it
 * (`label`), how many characters it has and a short hash of it, and any `after` text
 * (such as the command for the next part). The seal is what lets the plugin tell, from
 * the output Cursor hands back, that the whole of it came back: Cursor keeps the first
 * and last 10,000 characters of an over-long output, so a closing line alone survives
 * a cut, but a length and hash do not match a cut body.
 */
export function seal(label, body, after = '') {
  return `${body}\n\n— ${label} · ${body.length} characters · sha256 ${digest(body)}${after ? ` · ${after}` : ''} —\n`
}

/**
 * The body sealed under `label` in `output` when the whole of it is there: as many
 * characters as the seal says, with the hash the seal says; null otherwise (cut,
 * changed, or not there at all). It looks only at what it is given, so a hook checks
 * exactly the output Cursor handed it.
 */
export function unseal(output, label) {
  if (typeof output !== 'string') return null
  const marker = `\n\n— ${label} · `
  const at = output.lastIndexOf(marker)
  if (at < 0) return null
  const tail = /^(\d+) characters · sha256 ([0-9a-f]{12})(?: · [^\n]*)? —(?:\n|$)/.exec(output.slice(at + marker.length))
  if (!tail) return null
  const length = Number(tail[1])
  if (at - length < 0) return null
  const body = output.slice(at - length, at)
  return digest(body) === tail[2] ? body : null
}

/** The label that seals part `part` of note `id`'s `parts`. */
function partLabel(id, part, parts) {
  return `${part === parts ? 'End of DevSpec note' : 'DevSpec note'} ${id}: part ${part} of ${parts}`
}

/** Part `part` of a note as it is kept: the piece, sealed, and the way to the next part. */
function partContent(id, part, parts, piece) {
  return seal(partLabel(id, part, parts), piece, part < parts ? `read on with \`${noteCommand(id, part + 1)}\`` : '')
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

/** Whether `piece` is within both limits. */
function within(piece, maxChars, maxBytes) {
  return piece.length <= maxChars && Buffer.byteLength(piece) <= maxBytes
}

/**
 * `text` in pieces of at most `maxChars` UTF-16 code units and `maxBytes` UTF-8 bytes,
 * the two things Cursor's Shell rules count. A piece ends at a line end when one falls
 * in its second half, otherwise at a grapheme boundary. Joined, the pieces are the
 * text, byte for byte.
 *
 * The limits are a post-condition, not something each branch tries to respect: before
 * a unit joins a piece, pieces are cut off for as long as the piece and the unit
 * together would pass a limit, and every piece is checked against both on its way out
 * (a piece that is not within them throws rather than being handed over).
 */
export function splitText(text, maxChars = NOTE_PART_CHARS, maxBytes = NOTE_PART_BYTES) {
  const pieces = []
  const emit = (units) => {
    const piece = units.join('')
    if (!within(piece, maxChars, maxBytes)) throw new Error(`splitText: a piece of ${piece.length} characters passed its limits`)
    pieces.push(piece)
  }
  let piece = []
  let chars = 0
  let bytes = 0
  let lineEnd = -1 // how many units of `piece` end with its last line break, or -1
  for (const unit of cuttable(text, maxChars, maxBytes)) {
    const unitChars = unit.length
    const unitBytes = Buffer.byteLength(unit)
    while (piece.length > 0 && (chars + unitChars > maxChars || bytes + unitBytes > maxBytes)) {
      const cut = lineEnd > 0 && lineEnd >= piece.length / 2 ? lineEnd : piece.length
      emit(piece.slice(0, cut))
      piece = piece.slice(cut)
      const carried = piece.join('')
      chars = carried.length
      bytes = Buffer.byteLength(carried)
      // What is carried follows the last line break, so it holds none: the next pass,
      // if the unit still does not fit, cuts all of it off.
      lineEnd = -1
    }
    piece.push(unit)
    chars += unitChars
    bytes += unitBytes
    if (unit.includes('\n')) lineEnd = piece.length
  }
  if (piece.length > 0 || pieces.length === 0) emit(piece)
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
      writePrivateText(partFile(id, part, home), partContent(id, part, pieces.length, pieces[part - 1]))
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
  const of = new RegExp(`— (?:End of )?DevSpec note ${id}: part 1 of (\\d+) · `).exec(first)
  return of ? Number(of[1]) : 0
}

/** The piece part `part` of note `id` holds, checked against its own seal; null when it is missing or damaged. */
function notePartBody(id, part, parts, home) {
  try {
    return unseal(fs.readFileSync(partFile(id, part, home), 'utf8'), partLabel(id, part, parts))
  } catch {
    return null
  }
}

/** Note `id`'s text, its parts joined back without their closing lines; null when there is none. */
export function readNoteText(id, { home = os.homedir() } = {}) {
  const parts = noteParts(id, { home })
  if (parts === 0) return null
  let text = ''
  for (let part = 1; part <= parts; part += 1) {
    const body = notePartBody(id, part, parts, home)
    if (body === null) return null
    text += body
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
 *   line, if any), that exited 0, whose output as Cursor gave it to the hook is within
 *   Cursor's Shell rules, and whose seal (`unseal`: length and hash) shows the whole
 *   part came back, so a cut that kept the head and the tail does not count;
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
    // The output as Cursor handed it to the hook must be within both of Cursor's
    // Shell rules (so the model was shown all of it), and carry the whole part: the
    // body its seal describes, matching the part on disk.
    if (!fitsShellOutput(output.output)) return null
    const body = unseal(output.output, partLabel(id, part, parts))
    return body !== null && body === notePartBody(id, part, parts, home) ? part : null
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
 * One delivery of a note, and what has come back of it: `{ note, generation, parts }`.
 * The record belongs to one delivery, never to the note's content: the same text
 * handed over again (rules changed and changed back, a message left twice) is a new
 * delivery with nothing read, so a read of an earlier delivery never stands for it.
 * Returns the record with any part this tool call handed over whole (`partReadBy`)
 * added, and whether every part of this delivery has now come back whole.
 */
export function readThrough(record, input, { home = os.homedir() } = {}) {
  const parts = noteParts(record?.note, { home })
  const read = Array.isArray(record?.parts) ? record.parts.filter((part) => Number.isInteger(part)) : []
  if (parts === 0) return { record: { ...record, parts: read }, done: false }
  const part = partReadBy(input, record.note, parts, home)
  const next = part && !read.includes(part) ? [...read, part] : read
  let done = true
  for (let each = 1; each <= parts; each += 1) if (!next.includes(each)) done = false
  return { record: { ...record, parts: next }, done }
}

/**
 * The delivery kept at `file`, identified by `key` (its note and whatever else marks
 * this delivery: a change counter, the session, the host process), brought up to date
 * with this tool call. A key that differs in anything starts a new delivery with
 * nothing read. Returns `{ done, readParts, nextPart }` when `details` is true, or
 * boolean `done` by default. A record that cannot be read starts the delivery again
 * (more reading, never less).
 */
export function deliveryReadThrough(file, input, key, { home = os.homedir(), details = false } = {}) {
  const kept = readPrivateJson(file)
  const same = kept && Object.entries(key).every(([field, value]) => kept[field] === value)
  const current = same ? kept : { ...key, parts: [] }
  const { record, done } = readThrough(current, input, { home })
  if (!same || (kept?.parts?.length ?? 0) !== record.parts.length) writePrivateJson(file, record)
  if (!details) return done
  const totalParts = noteParts(record.note, { home })
  let nextPart = 1
  for (let p = 1; p <= totalParts; p += 1) {
    if (!record.parts.includes(p)) {
      nextPart = p
      break
    }
  }
  return { done, readParts: record.parts, nextPart, totalParts }
}

const PENDING_DIR = path.join(NOTES_DIR, 'pending')

/** The file-name prefix of one hook's (`kind`) hand-overs for one conversation. */
export function handOverPrefix(kind, conversation) {
  return `${kind}-${createHash('sha256').update(String(conversation || 'none')).digest('hex').slice(0, 16)}-`
}

/** The deliveries waiting under `prefix`, oldest first; a record that cannot be read is still a delivery of the note its name gives. */
function pendingDeliveries(prefix, home) {
  const dir = path.join(home, PENDING_DIR)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const deliveries = []
  for (const name of names) {
    const match = name.startsWith(prefix) ? /-([0-9a-f]{16})\.json$/.exec(name) : null
    if (!match || name.slice(prefix.length).length !== match[0].length - 1) continue
    const file = path.join(dir, name)
    const kept = readPrivateJson(file)
    deliveries.push({
      file,
      record: {
        note: match[1],
        generation: Number.isInteger(kept?.generation) ? kept.generation : 0,
        parts: Array.isArray(kept?.parts) ? kept.parts : [],
        at: typeof kept?.at === 'string' ? kept.at : '',
      },
    })
  }
  return deliveries.sort((a, b) => a.record.generation - b.record.generation || a.record.at.localeCompare(b.record.at))
}

/** How many parts note `id` has, and which of them cannot be read back from disk just now. */
function unreadableParts(id, home) {
  const parts = noteParts(id, { home })
  if (parts === 0) return { parts, missing: [1] }
  const missing = []
  for (let part = 1; part <= parts; part += 1) if (notePartBody(id, part, parts, home) === null) missing.push(part)
  return { parts, missing }
}

/** The status file of note `id`: which of its parts could not be read back, and how to retry. */
export function noteStatusCommand(id) {
  return `cat ~/.devspec/notes/${id}.status.md`
}

function noteStatusFile(id, home) {
  return path.join(home, NOTES_DIR, `${id}.status.md`)
}

/** `[1, 2, 3, 7, 9, 10]` as `1-3, 7, 9-10`. */
function partRanges(list) {
  const ranges = []
  for (const part of list) {
    const last = ranges.at(-1)
    if (last && part === last[1] + 1) last[1] = part
    else ranges.push([part, part])
  }
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ')
}

/**
 * What note `id`'s status file says when `missing` of its `parts` cannot be read back:
 * which parts, and the command for each, so the pointer itself only ever says that
 * some could not, in a line of fixed length. The list of parts is given whole while
 * the status still fits one Shell page (`fitsShellOutput`); for a note with thousands
 * of damaged parts it gives how many, and the first and the last, and says the rest
 * are too many to list.
 */
export function noteStatusText(id, parts, missing) {
  const retry =
    `Part 1 is \`${noteCommand(id)}\`` + (parts > 1 ? `, and part N is \`${noteCommand(id, 'N')}\`, with N the part's number` : '')
  const status = (which) =>
    (parts > 0
      ? `DevSpec note ${id}: ${missing.length} of its ${parts} parts could not be read back from disk just now (${which}).\n`
      : `DevSpec note ${id}: its first part could not be read back from disk just now, so how many parts it has is not known yet.\n`) +
    `Retry each one: ${retry}.\n` +
    'The plugin offers this note again after each step until every part of it has been read whole. ' +
    'If a part still cannot be read, tell the person that a DevSpec note could not be read, and give them its id.\n'
  const text = status(`part${missing.length === 1 ? '' : 's'} ${partRanges(missing)}`)
  return fitsShellOutput(text) ? text : status(`too many to list here: the first is part ${missing[0]} and the last part ${missing.at(-1)}`)
}

/**
 * Keeps note `id`'s status file (`noteStatusText`) beside it while any part cannot be
 * read back: written only when it changes, removed once every part can be read again.
 * Returns whether the status file is there to read.
 */
function writeNoteStatus(id, { parts, missing }, home) {
  const file = noteStatusFile(id, home)
  if (missing.length === 0) {
    fs.rmSync(file, { force: true })
    return false
  }
  const text = noteStatusText(id, parts, missing)
  try {
    if (fs.readFileSync(file, 'utf8') === text) return true
  } catch {
    // not written yet, or unreadable: write it
  }
  try {
    writePrivateText(file, text)
    return true
  } catch {
    return false
  }
}

/**
 * Text that must reach the agent in one conversation, handed over as a note and
 * offered after every step until that delivery has been read whole. Each delivery is
 * its own file under ~/.devspec/notes/pending, named by `prefix` and its note, and only
 * a proven whole read of it removes it (`readThrough`); nothing else does.
 *
 * `add` is new text. It joins the newest unread delivery in a new note when that one's
 * text can be read back, and the old delivery is removed only once the joined one is
 * written. When it cannot be read back, nothing is joined or replaced: the new text is
 * a delivery of its own, and both wait. A failed write throws, so the caller can keep
 * what it was adding.
 *
 * Returns what to offer at this step, or null when nothing is waiting. Every line of
 * it has a fixed largest size, whatever the notes hold (`handOverLineMax`): a pointer
 * is fixed text, the caller's fixed `what` and `also`, and a fixed-length command; a
 * delivery with parts that cannot be read back adds one fixed-length sentence pointing
 * at that note's status file (`noteStatusCommand`), which holds the details. Room for
 * the count line is kept before any pointer is laid out, so the count of waiting notes
 * always arrives. Readable deliveries are offered before ones with unreadable parts,
 * oldest first within each, so a note that cannot be read never crowds out one that
 * can. When not every pointer fits `share`, the short notice stands for each, as many
 * as fit, and the count line says how many are not listed; all come back next step.
 */
export function handOver(prefix, input, { add = null, what, also = '', share = POST_TOOL_CONTEXT_SHARE, home = os.homedir() } = {}) {
  let waiting = []
  for (const delivery of pendingDeliveries(prefix, home)) {
    const { record, done } = readThrough(delivery.record, input, { home })
    if (done) {
      fs.rmSync(delivery.file, { force: true })
      fs.rmSync(noteStatusFile(record.note, home), { force: true })
      continue
    }
    if (record.parts.length !== delivery.record.parts.length) writePrivateJson(delivery.file, record)
    waiting.push({ file: delivery.file, record })
  }
  if (typeof add === 'string' && add.trim()) {
    const newest = waiting.at(-1)
    const earlier = newest ? readNoteText(newest.record.note, { home }) : null
    const note = writeNote(earlier !== null ? `${earlier}\n\n---\n\n${add}` : add, { home })
    const record = {
      note: note.id,
      generation: Math.max(0, ...waiting.map((each) => each.record.generation)) + 1,
      parts: [],
      at: new Date().toISOString(),
    }
    const file = path.join(home, PENDING_DIR, `${prefix}${note.id}.json`)
    writePrivateJson(file, record)
    if (earlier !== null && newest.file !== file) {
      fs.rmSync(newest.file, { force: true })
      waiting = waiting.slice(0, -1)
    }
    waiting = [...waiting.filter((each) => each.file !== file), { file, record }]
  }
  if (waiting.length === 0) return null
  const offers = waiting.map(({ record }) => {
    const note = { id: record.note, command: noteCommand(record.note) }
    const status = unreadableParts(record.note, home)
    const unreadable = status.missing.length > 0
    return { note, unreadable, said: unreadableSentence(note.id, unreadable, writeNoteStatus(note.id, status, home)) }
  })
  // Readable first, so one that cannot be read never crowds out one that can.
  const order = [...offers.filter((each) => !each.unreadable), ...offers.filter((each) => each.unreadable)]
  const total = order.length
  // The count line's room is kept first: it is the one line that always arrives.
  const room = share - countLine(total, 0).length
  if (room < 0) return null
  const full = order.map((each) => notePointer(each.note, { what, also: [also, each.said].filter(Boolean).join(' ') }))
  if (full.join('\n\n').length + 2 <= room) return `${full.join('\n\n')}\n\n${countLine(total, total)}`
  const lines = []
  let used = 0
  for (const each of order) {
    const line = [noteNotice(each.note), each.said].filter(Boolean).join(' ')
    if (used + line.length + 1 > room) break
    lines.push(line)
    used += line.length + 1
  }
  return [...lines, countLine(total, lines.length)].join('\n')
}

/**
 * The fixed-length sentence a pointer carries when part of its note cannot be read
 * back: it names the note's status file, or, when even that could not be written,
 * says the note comes back at the next step.
 */
function unreadableSentence(id, unreadable, statusWritten) {
  if (!unreadable) return ''
  return statusWritten
    ? `Some parts of it could not be read back just now; see \`${noteStatusCommand(id)}\`.`
    : 'Some parts of it could not be read back just now, nor its status written; it comes back at the next step.'
}

/** The line that always ends a hand-over: how many notes wait, how many are not listed above, and that they come back. */
function countLine(total, shown) {
  const one = total === 1
  const unlisted = total - shown
  return (
    `${total} DevSpec note${one ? ' is' : 's are'} waiting for you` +
    (unlisted > 0 ? ` (${unlisted} not listed here)` : '') +
    `; ${one ? 'it comes' : 'they come'} back after each step until you have read ${one ? 'it' : 'each one'} whole.`
  )
}

/**
 * The longest line `handOver` can emit for a caller's fixed `what` and `also`, for
 * `total` waiting notes: no note's content changes it.
 */
export function handOverLineMax({ what, also = '', total = 1 } = {}) {
  const note = { id: '0'.repeat(16), command: noteCommand('0'.repeat(16)) }
  const said = [unreadableSentence(note.id, true, true), unreadableSentence(note.id, true, false)]
  return Math.max(
    countLine(total, 0).length,
    ...said.map((each) => notePointer(note, { what, also: [also, each].filter(Boolean).join(' ') }).length),
    ...said.map((each) => `${noteNotice(note)} ${each}`.length),
  )
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

/**
 * The one way anything that prints wakes for Cursor sizes what it prints as one output:
 * the wake file's reader (devspec-wake-tail.mjs `read`, which puts its header line
 * first) and the one-shot wait, each of whose output is one Shell result
 * (devspec-remote-wait.mjs). Of `wakes` (whole wakes
 * waiting, oldest first, each as `wakeLines` wrote it), as many as fit Cursor's rules
 * on one output together (`fitsShellOutput`), never part of one. Optional `reserve`
 * keeps room for stderr diagnostics emitted in the same Shell invocation so combined
 * `stdout + stderr` stays inside Cursor's Shell ceiling (requirements 3c5147a7 / 91d7b47c).
 * When some are left and `waiting(left)` is given, the line it returns goes after them,
 * and room is kept for it; it is left out only when the first wake alone leaves no room
 * for it. The first wake always goes, so a single wake over the rules on its own is
 * printed as it always was.
 * @param {string[]} wakes
 * @param {{ waiting?: (left: number) => string, reserve?: string }} [opts]
 * @returns {{ count: number, text: string }}
 */
export function wakesForOneOutput(wakes, { waiting = null, reserve = '' } = {}) {
  const pad = typeof reserve === 'string' ? reserve : ''
  let count = 0
  let text = ''
  for (const wake of wakes) {
    if (count > 0 && !fitsShellOutput(pad + text + wake)) break
    text += wake
    count += 1
  }
  if (count === wakes.length || typeof waiting !== 'function') return { count, text }
  // Some are left: make room for the line that says so, giving back wakes (never the first).
  while (count > 1 && !fitsShellOutput(pad + wakes.slice(0, count).join('') + waiting(wakes.length - count))) count -= 1
  const taken = wakes.slice(0, count).join('')
  const line = waiting(wakes.length - count)
  return { count, text: fitsShellOutput(pad + taken + line) ? taken + line : taken }
}

/** Fixed-shape stderr pointer emitted when a Shell diagnostic would push stdout + stderr past Cursor's Shell ceiling. */
export function shellDiagnosticPointer(label, command) {
  return `${label}: full details saved whole — run \`${command}\` (and any further parts).\n`
}

/**
 * Minimum stderr headroom (in UTF-16 code units) reserved inside Cursor's 20,000-char
 * Shell ceiling whenever a Shell command may emit a structured pickup refusal after
 * stdout has already been written (`shellDiagnosticReserve`).
 *
 * Logical justification (requirements 3c5147a7 / 91d7b47c / 4e32d1a5 / 3ea2b201):
 *   - When either note store (`~/.devspec/notes` or private `os.tmpdir()`) is writable,
 *     a `shellDiagnosticPointer` (`cat ...`) requires ~110–160 characters.
 *   - When neither note store is writable, `formatStructuredRefusalsFallback` must still
 *     fit an inline structured refusal envelope carrying `refused`, `code`, at least one
 *     real blocking item (`blocking_items` / `blocking_turn_id`), `omitted_count`,
 *     `shell_limit_chars`, and `recovery` (~350–550 characters).
 *   - Reserving 600 characters (3% of Cursor's 20,000-character Shell ceiling) at this
 *     single shared boundary guarantees room for either a saved-note pointer OR a
 *     structured refusal fallback with blocking details without silently dropping output.
 */
export const SHELL_DIAGNOSTIC_FALLBACK_RESERVE_CHARS = 600

/**
 * Build one reserve string whose UTF-16 character length AND UTF-8 byte length are EACH
 * at least as large as every candidate in `candidates` (and at least `minChars`).
 * Ensures `fitsShellOutput` (which enforces BOTH 20,000 UTF-16 code units AND 40,000 UTF-8
 * bytes) leaves enough room for whichever diagnostic pointer is emitted, even when one
 * unavailable store has a longer ASCII path and a writable store has a shorter multibyte
 * UTF-8 path (requirements 3c5147a7 / 4e32d1a5 / 91d7b47c).
 */
export function maxShellReserve(candidates, minChars = 0) {
  let maxChars = Math.max(0, minChars)
  let maxByteCandidate = ''
  let maxBytes = 0
  for (const raw of candidates) {
    const text = String(raw ?? '')
    if (text.length > maxChars) maxChars = text.length
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > maxBytes) {
      maxBytes = bytes
      maxByteCandidate = text
    }
  }
  return maxByteCandidate.length >= maxChars
    ? maxByteCandidate
    : maxByteCandidate + ' '.repeat(maxChars - maxByteCandidate.length)
}

/**
 * Exact ceiling reservation for Shell post-stdout diagnostics, derived at one shared
 * boundary from the worst-case UTF-16 length and UTF-8 byte length across all note stores
 * (`~/.devspec/notes`, `os.tmpdir()`, and `fallbackDir`) and `SHELL_DIAGNOSTIC_FALLBACK_RESERVE_CHARS`
 * so `stdout + stderr` always fits `fitsShellOutput` (reqs 3c5147a7 / 91d7b47c / 4e32d1a5).
 */
export function shellDiagnosticReserve(label = 'devspec-wake-tail', { fallbackDir = null } = {}) {
  const notePtr = shellDiagnosticPointer(label, noteCommand('0'.repeat(16)))
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  const fallbackSampleFile = path.join(os.tmpdir(), `devspec-notes-${uid}`, `${'0'.repeat(16)}.md`)
  const fallbackPtr = shellDiagnosticPointer(label, `cat ${shellQuotePath(fallbackSampleFile)}`)
  const fallbackHeadPtr = shellDiagnosticPointer(label, `head -c 40000 ${shellQuotePath(fallbackSampleFile)}`)
  const candidates = [notePtr, fallbackPtr, fallbackHeadPtr]
  if (fallbackDir) {
    const dirSampleFile = path.join(fallbackDir, `${'0'.repeat(16)}.md`)
    candidates.push(shellDiagnosticPointer(label, `cat ${shellQuotePath(dirSampleFile)}`))
    candidates.push(shellDiagnosticPointer(label, `head -c 40000 ${shellQuotePath(dirSampleFile)}`))
  }
  return maxShellReserve(candidates, SHELL_DIAGNOSTIC_FALLBACK_RESERVE_CHARS)
}

function shellQuotePath(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * Probe whether at least one diagnostic note store (`~/.devspec/notes`, private
 * `os.tmpdir()/devspec-notes-<uid>`, or `fallbackDir`) can write a file right now.
 * Used before printing a room-command wake to stdout so a near-limit Shell command
 * never emits stdout when NO store is available to save an oversized pickup refusal
 * whole for retrieval (requirements 3c5147a7 / 91d7b47c / 4e32d1a5 / 3ea2b201).
 */
export function hasWritableDiagnosticNoteStore({ home = os.homedir(), fallbackDir = null } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  const candidates = [
    { store: 'home_notes', dir: path.join(home, NOTES_DIR) },
    { store: 'tmp_notes', dir: path.join(os.tmpdir(), `devspec-notes-${uid}`) },
    ...(fallbackDir ? [{ store: 'connections_diagnostic_notes', dir: fallbackDir }] : []),
  ]
  const errors = []
  for (const candidate of candidates) {
    const probe = path.join(candidate.dir, `.probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`)
    try {
      fs.mkdirSync(candidate.dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(probe, '', { mode: 0o600 })
      try { fs.rmSync(probe, { force: true }) } catch { /* ignore cleanup */ }
      return { ok: true, store: candidate.store, dir: candidate.dir }
    } catch (error) {
      try { fs.rmSync(probe, { force: true }) } catch { /* ignore cleanup */ }
      errors.push({
        store: candidate.store,
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'write_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { ok: false, errors }
}

/**
 * Preflight-reserve private diagnostic note file descriptors BEFORE printing a near-ceiling
 * wake or calling `report_pickup` (requirements 3c5147a7 / 4e32d1a5 / 91d7b47c).
 *
 * - Preflight passes (`ok: true`) only when at least one of the three diagnostic note stores
 *   (`~/.devspec/notes`, `TMPDIR/devspec-notes-<uid>`, or `fallbackDir`) accepts a new
 *   private `0o600` file, keeping that open `fd` across `startCommands` so even a mid-pickup
 *   `chmod 0o500`/`0o000` on the store directory still allows writing the unabridged original
 *   refusal via POSIX `writeSync(fd, ...)`.
 * - When `backupDir` (e.g. the connections dir holding the wake lock) is distinct and writable,
 *   also opens a backup slot (`d-<14hex>.md`, 19 chars — never longer than `0000000000000000.md`
 *   in `shellDiagnosticReserve`) so even if the primary diagnostic store directory is deleted and
 *   replaced mid-pickup, the exact original refusal is still saved on disk with a Shell-bounded
 *   `cat` read command.
 * - `release()` closes all fds and unlinks every unused slot so the happy path leaves zero files.
 */
export function reserveDiagnosticNoteSlots({ home = os.homedir(), fallbackDir = null, backupDir = null } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  const primaryCandidates = [
    { store: 'home_notes', dir: path.join(home, NOTES_DIR), prefix: '' },
    { store: 'tmp_notes', dir: path.join(os.tmpdir(), `devspec-notes-${uid}`), prefix: '' },
    ...(fallbackDir ? [{ store: 'connections_diagnostic_notes', dir: fallbackDir, prefix: '' }] : []),
  ]
  const errors = []
  const slots = []
  const openSlotIn = (candidate) => {
    const hex = randomBytes(8).toString('hex')
    const fileName = candidate.prefix ? `${candidate.prefix}${hex.slice(0, 16 - candidate.prefix.length)}.md` : `${hex}.md`
    const filePath = path.join(candidate.dir, fileName)
    fs.mkdirSync(candidate.dir, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(filePath, 'wx', 0o600)
    try {
      const st = fs.fstatSync(fd)
      return {
        store: candidate.store,
        dir: candidate.dir,
        filePath,
        fd,
        ino: st.ino,
        used: false,
      }
    } catch (error) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
      try { fs.rmSync(filePath, { force: true }) } catch { /* ignore */ }
      throw error
    }
  }
  for (const candidate of primaryCandidates) {
    try {
      slots.push(openSlotIn(candidate))
      break
    } catch (error) {
      errors.push({
        store: candidate.store,
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'write_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (slots.length === 0) {
    return {
      ok: false,
      errors,
      slots: [],
      write: () => null,
      release: () => {},
    }
  }
  if (backupDir && path.resolve(backupDir) !== path.resolve(slots[0].dir)) {
    try {
      slots.push(openSlotIn({ store: 'connections_backup_slot', dir: backupDir, prefix: 'd-' }))
    } catch {
      /* optional backup slot: primary slot already passed preflight */
    }
  }
  const slotStillLinked = (slot) => {
    try {
      const st = fs.lstatSync(slot.filePath)
      return st.ino === slot.ino
    } catch (error) {
      // EACCES means the parent directory was chmod'd to 0o000 while the file remains linked
      // at `slot.filePath` and will be readable verbatim once permissions are restored.
      if (error && typeof error === 'object' && error.code === 'EACCES') return true
      return false
    }
  }
  return {
    ok: true,
    store: slots[0].store,
    dir: slots[0].dir,
    slots,
    write(text) {
      const raw = String(text ?? '')
      const id = createHash('sha256').update(raw).digest('hex').slice(0, 16)
      for (const slot of slots) {
        if (slot.fd === null || !slotStillLinked(slot)) continue
        try {
          const quoted = shellQuotePath(slot.filePath)
          const fitsOneRead = raw.length <= NOTE_PART_CHARS && Buffer.byteLength(raw) <= NOTE_PART_BYTES
          if (fitsOneRead) {
            fs.ftruncateSync(slot.fd, 0)
            fs.writeSync(slot.fd, raw, 0, 'utf8')
            fs.fsyncSync(slot.fd)
            slot.used = true
            return {
              id,
              file: slot.filePath,
              command: `cat ${quoted}`,
              parts: 1,
              fallback: true,
              reserved: true,
            }
          }
          // Multi-part content inside a single pre-opened file: subtract the worst-case
          // continuation footer (including the full quoted file path) from Cursor's Shell
          // output ceiling BEFORE splitting so EVERY page + footer fits `fitsShellOutput`
          // even under deep directory paths (requirements 3c5147a7 / 4e32d1a5 / 91d7b47c).
          const totalChars = raw.length
          const worstFooter = `\n\n--- part 99999/99999 (${totalChars} chars total) · next part (99999/99999): tail -c +999999999999 ${quoted} | head -c 999999 ---\n`
          const pageMaxChars = Math.min(NOTE_PART_CHARS, CURSOR_SHELL_OUTPUT_MAX_CHARS - worstFooter.length)
          const pageMaxBytes = Math.min(NOTE_PART_BYTES, CURSOR_SHELL_OUTPUT_MAX_BYTES - Buffer.byteLength(worstFooter, 'utf8'))
          if (pageMaxChars <= 0 || pageMaxBytes <= 0) continue
          const pieces = splitText(raw, pageMaxChars, pageMaxBytes)
          const totalParts = pieces.length
          const nextLens = new Array(totalParts).fill(0)
          const starts1 = new Array(totalParts).fill(1)
          let pages = []
          for (let pass = 0; pass < 4; pass += 1) {
            const built = new Array(totalParts)
            for (let i = totalParts - 1; i >= 0; i -= 1) {
              const footer =
                i + 1 < totalParts
                  ? `\n\n--- part ${i + 1}/${totalParts} (${totalChars} chars total) · next part (${i + 2}/${totalParts}): tail -c +${starts1[i + 1]} ${quoted} | head -c ${nextLens[i + 1]} ---\n`
                  : `\n\n--- part ${totalParts}/${totalParts} (end of ${totalChars} chars) ---\n`
              built[i] = Buffer.from(`${pieces[i]}${footer}`, 'utf8')
              nextLens[i] = built[i].length
            }
            let offset = 1
            let changed = false
            for (let i = 0; i < totalParts; i += 1) {
              if (starts1[i] !== offset) {
                starts1[i] = offset
                changed = true
              }
              offset += built[i].length
            }
            pages = built
            if (!changed && pass > 0) break
          }
          if (!pages.every((buf) => fitsShellOutput(buf.toString('utf8')))) continue
          const contentBuf = Buffer.concat(pages)
          fs.ftruncateSync(slot.fd, 0)
          fs.writeSync(slot.fd, contentBuf, 0, contentBuf.length, 0)
          fs.fsyncSync(slot.fd)
          slot.used = true
          return {
            id,
            file: slot.filePath,
            command: `head -c ${pages[0].length} ${quoted}`,
            parts: totalParts,
            fallback: true,
            reserved: true,
          }
        } catch {
          /* try next reserved slot */
        }
      }
      return null
    },
    release() {
      for (const slot of slots) {
        if (slot.fd !== null) {
          try { fs.closeSync(slot.fd) } catch { /* ignore */ }
          slot.fd = null
        }
        if (!slot.used) {
          try { fs.rmSync(slot.filePath, { force: true }) } catch { /* ignore */ }
        }
      }
    },
  }
}

/**
 * Private fallback note store under `os.tmpdir()` used only when `~/.devspec/notes`
 * cannot be written, so the exact original oversized refusal/diagnostic is still saved
 * whole in Shell-sized parts on disk and can be read back with `cat` without making a
 * new request whose response might differ (requirements 3c5147a7 / 91d7b47c / 4e32d1a5).
 */
export function writeFallbackDiagnosticNote(text, { baseDir = null } = {}) {
  const raw = String(text ?? '')
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  const dir = baseDir ?? path.join(os.tmpdir(), `devspec-notes-${uid}`)
  const partPath = (part) => path.join(dir, part === 1 ? `${id}.md` : `${id}-part-${part}.md`)
  const worstNextCmd = `\n\n--- next part (99999/99999): cat ${shellQuotePath(partPath(99999))} ---\n`
  const pageMaxChars = Math.min(NOTE_PART_CHARS, CURSOR_SHELL_OUTPUT_MAX_CHARS - worstNextCmd.length)
  const pageMaxBytes = Math.min(NOTE_PART_BYTES, CURSOR_SHELL_OUTPUT_MAX_BYTES - Buffer.byteLength(worstNextCmd, 'utf8'))
  if (pageMaxChars <= 0 || pageMaxBytes <= 0) {
    throw new Error(`fallback diagnostic path exceeds Shell output limit (${dir.length} chars)`)
  }
  const pieces = splitText(raw, pageMaxChars, pageMaxBytes)
  const firstFile = partPath(1)
  if (!fs.existsSync(firstFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (let part = pieces.length; part >= 1; part -= 1) {
      const nextCmd = part < pieces.length ? `\n\n--- next part (${part + 1}/${pieces.length}): cat ${shellQuotePath(partPath(part + 1))} ---\n` : '\n'
      writePrivateText(partPath(part), `${pieces[part - 1]}${nextCmd}`)
    }
  }
  return {
    id,
    file: firstFile,
    command: `cat ${shellQuotePath(firstFile)}`,
    parts: pieces.length,
    fallback: true,
  }
}

/**
 * Enforce Cursor's combined Shell output ceiling (`fitsShellOutput`, stdout + stderr)
 * at one shared boundary for stderr diagnostics (requirements 3c5147a7 / 91d7b47c).
 * Returns the diagnostic verbatim when `stdoutText + diagnosticText` fits; otherwise
 * saves the full diagnostic whole in a sealed note (`writeNote`) and returns the
 * fixed-shape pointer. If `~/.devspec/notes` cannot be written, saves the exact original
 * content whole to a private fallback note in `os.tmpdir()` (`writeFallbackDiagnosticNote`)
 * so callers can read the original response without retrying a network request.
 */
export function fitShellDiagnostic(
  stdoutText,
  diagnosticText,
  {
    home = os.homedir(),
    label = 'devspec-wake-tail',
    fallback = null,
    requireStructuredFallback = false,
    fallbackDir = null,
    reservedStore = null,
  } = {},
) {
  const stdout = String(stdoutText ?? '')
  const diag = String(diagnosticText ?? '')
  if (!diag) return { text: '', note: null }
  if (fitsShellOutput(stdout + diag)) {
    return { text: diag, note: null }
  }
  const resolveFallback = (error, savedFallbackNote = null) => {
    const candidate = typeof fallback === 'function' ? fallback(error, savedFallbackNote) : fallback
    return typeof candidate === 'string' && candidate ? candidate : null
  }
  let noteError = null
  try {
    const note = writeNote(diag, { home })
    const pointer = shellDiagnosticPointer(label, note.command)
    if (fitsShellOutput(stdout + pointer)) {
      return { text: pointer, note }
    }
    const fb = resolveFallback(null, note)
    if (fb && fitsShellOutput(stdout + fb)) {
      return { text: fb, note, overflow: true, usedFallback: true }
    }
    return { text: '', note, overflow: true }
  } catch (error) {
    noteError = error
  }
  let fallbackNote = null
  const fallbackBaseDirs = [null, ...(fallbackDir ? [fallbackDir] : [])]
  for (const baseDir of fallbackBaseDirs) {
    try {
      fallbackNote = writeFallbackDiagnosticNote(diag, { baseDir })
      if (fallbackNote) break
    } catch {
      fallbackNote = null
    }
  }
  if (!fallbackNote && reservedStore && typeof reservedStore.write === 'function') {
    try {
      fallbackNote = reservedStore.write(diag)
    } catch {
      fallbackNote = null
    }
  }
  const fb = resolveFallback(noteError, fallbackNote)
  if (fb && fitsShellOutput(stdout + fb)) {
    return { text: fb, note: fallbackNote, noteError, usedFallback: true }
  }
  if (fallbackNote) {
    const fallbackPointer = shellDiagnosticPointer(label, fallbackNote.command)
    if (fitsShellOutput(stdout + fallbackPointer)) {
      return { text: fallbackPointer, note: fallbackNote, noteError }
    }
  }
  if (requireStructuredFallback) {
    return { text: '', note: fallbackNote, noteError, overflow: true }
  }
  const why = noteError instanceof Error ? noteError.message : String(noteError ?? 'note write failed')
  const readHint = fallbackNote ? ` Read original: \`${fallbackNote.command}\`.` : ''
  const short = `${label}: diagnostic omitted (${diag.length} chars; could not save note: ${why}).${readHint}\n`
  if (fitsShellOutput(stdout + short)) {
    return { text: short, note: fallbackNote, noteError }
  }
  const bare = `${label}: diagnostic omitted (note write failed).${readHint}\n`
  return { text: fitsShellOutput(stdout + bare) ? bare : '', note: fallbackNote, noteError }
}

/** What a wake kept whole in a note says about itself: one fixed sentence. */
export const WAKE_IN_NOTE =
  "This wake is longer than Cursor shows whole, so all of it is in a file: read it, and every further part it names, before you act on anything in it."

/**
 * One wake as it goes out (`wakeLines`), never longer than Cursor shows from one
 * output (`fitsShellOutput`): `events` themselves when they fit; otherwise the whole
 * wake kept whole and sealed in one note (`writeNote`, in parts that each reach the
 * agent whole), and in its place a single short line that says so, names what the wake
 * carries (`carries`: its events' types, which the reader's notification pattern
 * matches) and gives the command that reads it. Each wake has its own note, named by
 * its own content. Returns `{ events, note }`, `note` null when the wake goes out as it
 * is. When the note cannot be written, `{ events, note: null, error }`: the wake needs
 * the note to arrive whole, so the caller holds it (devspec-remote-wait.mjs) rather
 * than send it to be cut.
 */
export function wakeWithin(events, { home = os.homedir() } = {}) {
  if (fitsShellOutput(wakeLines(events))) return { events, note: null }
  return wakeInNote(events, { home })
}

/**
 * `events` kept whole and sealed in one note, whatever their size, with the single short
 * `wake_in_note` line in their place (`wakeWithin` uses it for a wake too long to show
 * whole); `say` is that line's sentence. When the note cannot be written,
 * `{ events, note: null, error }`, for the caller to hold.
 */
export function wakeInNote(events, { home = os.homedir(), say = WAKE_IN_NOTE } = {}) {
  let note
  try {
    note = writeNote(wakeLines(events), { home })
  } catch (error) {
    return { events, note: null, error }
  }
  const carries = [...new Set(events.map((event) => String(event?.type ?? '')).filter(Boolean))]
  return { events: [{ type: 'wake_in_note', carries, read: note.command, note: say }], note }
}
