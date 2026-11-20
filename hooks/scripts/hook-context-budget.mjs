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
 *   to its project until the pin is fixed); and the repository-link nudge (the person
 *   must link the repository). Unread room messages are counted after every step until
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
 *     text becomes its own delivery and the pointer says which part failed and how to
 *     retry. [never drops or replaces a waiting note because part of it cannot be read]
 * 15. A write that fails: nothing is marked; the content stays at its source (a
 *     message is put back, a commit note stays in the state, a link reminder is not
 *     marked as said; a pin problem is raised again when the pin is next written).
 *     [keeps a commit note in the state when its hand-over cannot be written…; puts the
 *     message back when its hand-over cannot be written…]
 * 16. More waiting than fits a hook's share: short notices and a count of the rest,
 *     all offered again next step; none dropped. [offers every waiting note when they
 *     do not all fit…]
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
 * nothing read. Returns whether this delivery has been read through. A record that
 * cannot be read starts the delivery again (more reading, never less).
 */
export function deliveryReadThrough(file, input, key, { home = os.homedir() } = {}) {
  const kept = readPrivateJson(file)
  const same = kept && Object.entries(key).every(([field, value]) => kept[field] === value)
  const current = same ? kept : { ...key, parts: [] }
  const { record, done } = readThrough(current, input, { home })
  if (!same || (kept?.parts?.length ?? 0) !== record.parts.length) writePrivateJson(file, record)
  return done
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

/** Which parts of note `id` cannot be read back from disk just now. */
function unreadableParts(id, home) {
  const parts = noteParts(id, { home })
  if (parts === 0) return [1]
  const missing = []
  for (let part = 1; part <= parts; part += 1) if (notePartBody(id, part, parts, home) === null) missing.push(part)
  return missing
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
 * Returns what to offer at this step, or null when nothing is waiting: a pointer to
 * each waiting delivery, saying when part of one could not be read back and how to
 * retry. When they do not all fit `share`, shorter notices, and a count of the rest,
 * which come back at the next step.
 */
export function handOver(prefix, input, { add = null, what, also = '', share = POST_TOOL_CONTEXT_SHARE, home = os.homedir() } = {}) {
  let waiting = []
  for (const delivery of pendingDeliveries(prefix, home)) {
    const { record, done } = readThrough(delivery.record, input, { home })
    if (done) {
      fs.rmSync(delivery.file, { force: true })
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
  const again = 'This line comes back after each step until you have read it.'
  const pointers = waiting.map(({ record }) => {
    const note = { id: record.note, command: noteCommand(record.note) }
    const missing = unreadableParts(record.note, home)
    const retry = missing.length
      ? `Part ${missing.join(', ')} of it could not be read back just now; retry with ${missing.map((part) => `\`${noteCommand(record.note, part)}\``).join(', ')}.`
      : ''
    return { note, retry, text: pointToNote(note, { share, what, also: [also, retry, again].filter(Boolean).join(' ') }) }
  })
  const full = pointers.map((each) => each.text).join('\n\n')
  if (pointers.every((each) => each.text !== null) && full.length <= share) return full
  // Too many to describe in full: the short notice for each, as many as fit, and a
  // count of the rest. Nothing is dropped: every one is offered again next step.
  const notices = []
  for (const each of pointers) {
    const line = `${noteNotice(each.note)}${each.retry ? ` ${each.retry}` : ''}`
    const rest = pointers.length - notices.length - 1
    const tail = rest > 0 ? `\n${rest} more DevSpec note${rest === 1 ? ' is' : 's are'} waiting; they come back at the next step.` : ''
    if ([...notices, line].join('\n').length + tail.length > share) break
    notices.push(line)
  }
  const rest = pointers.length - notices.length
  if (notices.length === 0) return null
  return `${notices.join('\n')}${rest > 0 ? `\n${rest} more DevSpec note${rest === 1 ? ' is' : 's are'} waiting; they come back at the next step.` : ''}`
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
