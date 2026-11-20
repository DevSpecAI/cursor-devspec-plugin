/**
 * Notice the end of a Cursor turn from the conversation's transcript, for when Cursor
 * does not run the plugin's end-of-turn (`stop`) hook (item cdf020cc).
 *
 * Maintainer notes: why this exists, how a turn end is recognised, and when it can go.
 *
 * ## Why
 *
 * Cursor's command-line agent runs a plugin's own `stop` hook only when the person also
 * has a hooks file of their own that declares `stop` (`~/.cursor/hooks.json`, or the
 * project's `.cursor/hooks.json`), and never in a headless (`-p`) run. Measured with
 * the real plugin on CLI 2026.10.22, 2026.11.05 and 2026.11.19 (task 659a015f). Cursor's
 * documentation says plugin hooks run like any other; Cursor's staff have confirmed the
 * gap as a known bug they are tracking, with no date:
 *
 *  - https://forum.cursor.com/t/cursor-cli-does-not-run-enterprise-or-team-beforesubmitprompt-hooks/173219
 *  - https://forum.cursor.com/t/cursor-cli-2026-11-05-macos-user-level-cursor-hooks-json-is-never-loaded-project-level-cursor-hooks-json-works/177989
 *  - https://forum.cursor.com/t/cursor-cli-omits-beforesubmitprompt-afteragentresponse-and-stop-hooks-loses-token-usage-and-emits-inconsistent-generation-id-values/169059
 *
 * The stop hook is what told DevSpec a turn had ended (mirror-turn.mjs `stop`). Without
 * it the room showed Working until the poller's one-hour backstop, and a turn that
 * errored or was stopped was never reported. Cursor's only workaround is an entry in
 * the person's own hooks file, and the plugin never changes the person's Cursor
 * settings. So the poller, already running while connected, notices the turn's end in
 * the transcript and reports it the way the stop hook would: it tells the room about an
 * error or a stop in Cursor's own words (turn-failure.mjs), names the room commands the
 * turn finished (turn-commands.mjs), clears Working and closes the requests the turn
 * finished (requests.mjs).
 *
 * Remove this, the poller's use of it and the claim in mirror-turn.mjs `stop`, once
 * Cursor runs a plugin's `stop` hook with no hooks file of the person's own, in the
 * terminal and headless: the stop hook then reports every turn end itself. The typed
 * prompt mirror and recall on typed prompts also wait on that fix (the same gate keeps
 * Cursor from running `beforeSubmitPrompt`); nothing here stands in for them.
 *
 * ## What Cursor writes
 *
 * The transcript is `~/.cursor/projects/<project>/agent-transcripts/<conversation>/
 * <conversation>.jsonl`: one JSON row per line, `{"role":"user"|"assistant","message":…}`.
 * When a turn ends Cursor writes `{"type":"turn_ended","status":"success"|"error"|
 * "aborted"}` (with `"error":"…"`) as the final line, and when the next turn starts it
 * rewrites the whole file in place (truncating it first) without that line, then adds
 * the new turn's rows. In an interactive turn that succeeds, Cursor runs the stop hook
 * *before* it writes the line; for an error or a stop, after it. Read from the CLI
 * 2026.11.05 and 2026.11.19 bundles. The transcript is not an official Cursor interface.
 *
 * What a turn looks like, measured on 2026-11-20 (CLI 2026.11.19 live, every write
 * logged; and the 63 real transcripts on the measuring machine, CLI 2026.09.18 to
 * 2026.11.05):
 *  - A turn started by a prompt typed at the terminal starts with a user row
 *    `<timestamp>Friday, Nov 20, 2026, 8:58 PM (UTC)</timestamp>\n<user_query>\n<the
 *    prompt>\n</user_query>`.
 *  - A turn started by a background command's output, which is how a room command's
 *    wake reaches the agent, starts with a user row of Cursor's own fixed wording
 *    (COMMAND_TURN_SENTENCES): `<timestamp>…</timestamp>\n\n<user_query>Briefly inform
 *    the user about the task result and perform any follow-up actions (if
 *    needed).</user_query>`. CLI 2026.11.19 writes that sentence; transcripts from
 *    1 November (25 such rows) add "If there's no follow-ups needed, don't explicitly say
 *    that.". The sentence is not in the CLI, so it is Cursor's server's, and it has
 *    changed once already. **It carries no id**: the background command's output, where
 *    the plugin's wake line is, arrives inside a `<system_notification>` /
 *    `<task_notification>` block that Cursor's transcript writer deletes before it
 *    writes the row (CLI 2026.11.05 bundle; four rows are a bare timestamp). The plugin
 *    cannot put an id there without printing markup that breaks out of Cursor's block,
 *    which it never does.
 *  - The time in those rows is to the minute, so two such turns in the same minute write
 *    byte-identical rows (seen).
 *  - Cursor's server adds user rows inside a turn when it resumes one
 *    (RESUMED_TURN_SENTENCE: "Your previous response was interrupted. Continue from where
 *    you left off.", 10 seen).
 *  - A turn that fails or is stopped at its very start writes `turn_ended` and no user
 *    row: four transcripts are that one line ("Model unavailable on Free…" twice, "User
 *    aborted/interrupted manually." twice).
 *  - The `turn_ended` line carries no id and no time.
 *  - A turn stopped with Ctrl+C has its `turn_ended` written twice, identical, 3 ms
 *    apart.
 *
 * ## Which turn a turn end belongs to
 *
 * Nothing Cursor writes names the room command a turn served, so a turn end is taken
 * for the tracked command's only on what the file shows beyond doubt, and otherwise the
 * room is told without answering anything. When the poller hands a room command over it
 * starts tracking a turn (the turn marker) and notes the transcript as it stands
 * (`recordTurnBaseline`): whether Cursor was between turns (the final line a
 * `turn_ended`, or no transcript yet), the bytes before that final line (the rows
 * Cursor keeps when the next turn starts), its length and its modification time.
 *
 * A final `turn_ended` line seen later counts at all only when it was written after
 * tracking started: the file has changed since, and was last written after the marker
 * (so a transcript restored with its old modification time never counts). It is then
 * **the tracked command's turn end** only when all three hold:
 *  - (a) Cursor was between turns when tracking started;
 *  - (b) its position: the rows noted at handover are still the file's first bytes,
 *    unchanged, and the turn end sits after rows written since. A file that shrank or was
 *    rewritten (a summary, a restore) fails this;
 *  - (c) the rows written since start with exactly one turn, and that turn's start row is
 *    the room-command sentence (COMMAND_TURN_SENTENCES, in exactly the form above); bare
 *    timestamp rows and Cursor's resume rows inside it are allowed, any other user row
 *    (a typed prompt, a second notification) fails it.
 * Then, as the stop hook would: a turn that ran names the commands that started it as
 * finished and clears Working; an error or a stop answers the tracked command in
 * Cursor's own words (turn-failure.mjs) and closes its request.
 *
 * Every other turn end that ended in an error or was stopped (tracking started in a
 * turn; a rewritten file; a typed turn; a turn that failed at its start with no user
 * row; a second turn) is told to the room in Cursor's words as a message of its own
 * (`turnFailureNotice`), which answers and closes nothing; Working clears. Every other
 * turn that ran ends as before this existed: Working until the agent's answer, the next
 * command or the backstop.
 *
 * If Cursor changes the sentence, nothing matches (c) and every error goes to the room
 * as a message of its own: the safe direction. Add a new wording to
 * COMMAND_TURN_SENTENCES only once it has been seen in a real transcript, with its CLI
 * version.
 *
 * A turn end's identity, which the stop hook and the poller both claim, is
 * `<conversation>#<number of user rows>#<digest of the last user row>`, and for an
 * error or a stop also `#<digest of the turn_ended line>@<its byte offset>`
 * (`turnEndIdentity`). The stop hook can work it out when it runs: before the line
 * exists for a turn that ran, after it for an error or a stop. A claim made before the
 * tracked turn started does not count against it (`claimTurnEnd` `after`).
 *
 * ## Reported once
 *
 * Whichever of the stop hook and the poller reports a turn end claims it first
 * (`claimTurnEnd`, an exclusive file create in the connection's state folder). The claim
 * is "reporting" until every step has reached DevSpec (the room told, the turn reported
 * finished, its requests closed), then "reported" (`settleTurnEnd`). A step that did not
 * land gives the claim back and keeps the turn's marker, so the other path, or the
 * poller's next try (`nextReportTry`), reports what is left; what already landed is
 * recorded on the claim (`noteTurnEndTold`, `noteTurnEndCompleted`) and never sent twice.
 * The other path leaves a claim being reported by a live process alone, and takes over
 * one given back or one whose owner process has gone.
 *
 * ## Every interleaving, and what happens (the tests carry these codes)
 *
 * "Attributed" is a turn end that meets (a), (b) and (c) above; "a notice" is the room
 * told in Cursor's words in a message of its own, answering and closing nothing.
 *
 * Tracking starts between turns:
 *  - A1 The command's turn (its start row the room-command sentence) runs and ends:
 *    attributed; its commands reported finished once, Working cleared.
 *  - A2 It ends in an error or is stopped: attributed; the command answered in Cursor's
 *    words and its request closed, once.
 *  - A3 A turn fails at its very start, writing no user row: not attributed (no start
 *    row); an error or a stop is a notice.
 *  - A4 The command's turn end is overwritten by the next turn before any lap: the rows
 *    since hold two turns, so it is not attributed; an error is a notice, a turn that ran
 *    ends as before.
 *  - A5 Cursor summarises or rewrites the conversation (fewer or different first rows):
 *    position unknown, not attributed; an error is a notice.
 *  - A6 A stopped turn's end is written twice as tracking starts: not a new end.
 *  - A7 The final line is not a turn end Cursor is known to write: nothing.
 *  - A8 Two command turns in one minute write identical rows: the second turn is its
 *    own, rows since tracking started, attributed.
 *  - A9 A prompt typed after the command was handed over runs first: its start row is
 *    the person's own text, so not attributed; an error is a notice, never the command's
 *    answer.
 *  - A10 No transcript yet: between turns, every row is new.
 *  - A11 Cursor's error is longer than any fixed read: read and quoted whole.
 *  - A12 An older transcript restored, with its old modification time: never counted.
 *  - A13 Cursor changes the room-command sentence: nothing matches; an error is a
 *    notice, a turn that ran ends as before.
 * Tracking starts in a turn:
 *  - B1 The running turn ends, or a later turn does: never attributed; a turn that ran
 *    ends as before.
 *  - B2 Any of them ends in an error or is stopped (a typed turn already running at
 *    handover among them): a notice, never the command's answer.
 *  - B3 An error dated before tracking started: nothing.
 * The stop hook (only where the person has a hooks file; it knows which request its turn
 * served, so it answers as it always has):
 *  - C1 A turn that runs: the hook runs before the line exists, reports, clears Working;
 *    the poller and its backstop add nothing.
 *  - C2 An error: the hook runs before the poller's lap and reports; the poller adds
 *    nothing.
 *  - C3 The poller reports first; the hook runs after: it adds nothing.
 *  - C4 The hook runs while the poller's post is in flight: it adds nothing.
 *  - C5 The poller's post fails before the hook runs: the hook reports it.
 *  - C6 The hook's own post fails: it gives the claim back and keeps the marker; the
 *    poller reports it from the transcript.
 *  - C7 The hook's completion fails on a turn that ran: the poller completes it once the
 *    line is written.
 *  - C8 An owner process is killed mid-report (a hook past Cursor's timeout, a poller
 *    restarted): the other path takes its claim over.
 *  - C9 The poller's post lands but a later step fails, then the hook runs: the hook
 *    finishes it without telling the room again.
 * No stop hook:
 *  - D1 The poller's post fails, with or without a hook running during it: the claim is
 *    given back, the marker kept, and the poller tries again REPORT_RETRY_MS later: told
 *    once.
 *  - D2 Every try fails: after REPORT_ATTEMPTS the poller stops; the turn ends as before.
 *  - D3 A request close fails: retried the same way, without telling the room again.
 *
 * ## Failing safe
 *
 * Only a complete final line whose `type` is "turn_ended" and whose status is one of
 * the three above is a turn end, read whole whatever its length (`lastTurnEnd`), and
 * only from a read of the whole transcript that did not change while it was read nor for
 * 25 ms after (Cursor rewrites the file in place, so a read can catch it half written:
 * that read is retried, never used). With no baseline, an unreadable transcript, a line
 * it does not recognise or a sentence it does not know, nothing is attributed; the
 * plugin never answers a command it cannot tie to the turn end beyond doubt.
 *
 * ## Known limits
 *
 *  - Any background command's output starts a turn with the same sentence, so a
 *    background job the agent itself started, finishing first, would pass (c). The
 *    request DevSpec has open for the connection is the one answered.
 *  - A turn that ran after tracking started in a turn, or after a rewrite, ends as
 *    before: Working until the agent's answer, the next command or the backstop.
 *  - A headless (`-p`) run killed by a signal writes no `turn_ended` line, so its end
 *    is not noticed (CLI 2026.11.19). Stopping a turn in the terminal with Ctrl+C does
 *    write one: `{"type":"turn_ended","status":"aborted","error":"User
 *    aborted/interrupted manually."}`.
 *  - A turn end is noticed within about a second while DevSpec's push channel is open
 *    (the poller's local check), otherwise at the poller's next poll.
 *  - The poller does the stop hook's request bookkeeping at a turn's end
 *    (requests.mjs `finishTurnRequests`), but without the host's list of background
 *    work: a request whose launched work has not woken the agent yet stays open until a
 *    later turn end closes it.
 *
 * Imports only Node built-ins and private-state.mjs, so every hook and the poller can
 * load it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/** The statuses Cursor writes on a `turn_ended` line. Any other is not a turn end. */
const TURN_END_STATUSES = new Set(['success', 'error', 'aborted'])

/**
 * The transcript's final line is read backwards in pieces this size until the newline
 * before it, so a line of any length is read whole and only that line is read: a step,
 * not a limit. Cursor's own transcript writer leaves out any row over 5 MB ("Oversize
 * transcript blob omitted", CLI 2026.11.05), so the final line stays a few megabytes at
 * most.
 */
const LINE_READ_CHUNK_BYTES = 64 * 1024

/** A whole-transcript read goes in pieces this size, so a long transcript is never held at once. */
const READ_CHUNK_BYTES = 1024 * 1024

/**
 * A read of the whole transcript counts only when the file has not changed while it was
 * read nor for STABLE_READ_GAP_MS after. Cursor rewrites the file in place at a turn's
 * start (Node's writeFile: truncate, then the content in pieces with a pause between
 * them), so a read can catch a prefix of it; the pieces follow each other far faster
 * than 25 ms, so a file that keeps still that long is whole. A read that does not count
 * is tried again, up to STABLE_READ_ATTEMPTS times, so a hook or a poller lap waits at
 * most about half a second.
 */
const STABLE_READ_ATTEMPTS = 8
const STABLE_READ_GAP_MS = 25

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The conversation a transcript belongs to: its file name, which is the conversation id. */
export function transcriptConversation(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null
  const name = path.basename(transcriptPath, '.jsonl')
  return name || null
}

/**
 * The transcript's turn end, or null when its final line is not one: Cursor writes
 * `turn_ended` only as the final line and removes it when the next turn starts. The line
 * is read whole whatever its length, so Cursor's error text is never cut here. `key`
 * identifies this line (the file, where the line sits and what it says), `atMs` is the
 * file's modification time and `stamp` its size and modification time as read.
 */
export function lastTurnEnd(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  let fd
  try {
    fd = fs.openSync(transcriptPath, 'r')
  } catch {
    return null
  }
  let text
  let lineStart = 0
  let atMs
  let stamp
  try {
    const { size, mtimeMs } = fs.fstatSync(fd)
    atMs = mtimeMs
    stamp = fileStampOf({ size, mtimeMs })
    const pieces = []
    let position = size
    let ending = true
    while (position > 0) {
      const length = Math.min(LINE_READ_CHUNK_BYTES, position)
      position -= length
      let piece = Buffer.alloc(length)
      fs.readSync(fd, piece, 0, length, position)
      if (ending) {
        // The newline that ends the final line is not part of it.
        let end = piece.length
        while (end > 0 && (piece[end - 1] === 0x0a || piece[end - 1] === 0x0d)) end -= 1
        piece = piece.subarray(0, end)
        if (end === 0) continue
        ending = false
      }
      const newline = piece.lastIndexOf(0x0a)
      if (newline >= 0) {
        pieces.unshift(piece.subarray(newline + 1))
        lineStart = position + newline + 1
        break
      }
      pieces.unshift(piece)
      lineStart = position
    }
    text = Buffer.concat(pieces).toString('utf8').trim()
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* nothing to release */
    }
  }
  if (!text) return null
  let row = null
  try {
    row = JSON.parse(text)
  } catch {
    return null // a line still being written
  }
  if (row?.type !== 'turn_ended') return null
  return {
    key: `${transcriptPath}#${lineStart}#${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
    status: typeof row.status === 'string' ? row.status : null,
    error: typeof row.error === 'string' && row.error.trim() ? row.error.trim() : null,
    atMs,
    stamp,
  }
}

/** Whether a turn end from lastTurnEnd is one this module recognises (see the header). */
function recognisedEnd(end) {
  return Boolean(end && TURN_END_STATUSES.has(end.status))
}

/**
 * What the room is told about a turn end, in turn-failure.mjs's terms: an error with
 * Cursor's own text, a stop, or nothing for a turn that ran.
 */
export function turnEndFailure(end) {
  if (end?.status === 'error') return { status: 'error', text: end.error ?? null }
  if (end?.status === 'aborted') return { status: 'aborted', text: null }
  return null
}

/**
 * One whole read of the transcript, or why there is none: `missing`, or null when it
 * changed under the read. An empty file is Cursor's rewrite caught between truncating
 * it and writing it: Cursor never leaves a transcript empty.
 */
function readWholeOnce(transcriptPath) {
  let fd
  try {
    fd = fs.openSync(transcriptPath, 'r')
  } catch (error) {
    return error?.code === 'ENOENT' ? { missing: true } : null
  }
  try {
    const before = fs.fstatSync(fd)
    if (before.size === 0) return null
    const chunks = []
    let offset = 0
    while (offset < before.size) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, before.size - offset))
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset)
      if (read <= 0) break
      chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read))
      offset += read
    }
    const after = fs.fstatSync(fd)
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null
    return { chunks, stamp: fileStampOf(before), atMs: before.mtimeMs }
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* nothing to release */
    }
  }
}

/**
 * The start row of a turn Cursor begins for a background command's output, which is how
 * a room command's wake reaches the agent: Cursor's server's own fixed sentence, in a
 * `<user_query>` with no surrounding blank lines after a blank line under the timestamp
 * (a prompt typed at the terminal is laid out `<user_query>\n…\n</user_query>`). Exactly
 * these sentences, as seen in real transcripts (see the header); any other text is not
 * a room command's turn.
 */
export const COMMAND_TURN_SENTENCES = Object.freeze([
  // CLI 2026.11.19, 2026-11-20.
  'Briefly inform the user about the task result and perform any follow-up actions (if needed).',
  // Transcripts written 2026-11-01 (CLI 2026.10.x), 25 rows.
  "Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.",
])

/** The row Cursor's server adds inside a turn it resumes (10 seen); not a turn of its own. */
export const RESUMED_TURN_SENTENCE = 'Your previous response was interrupted. Continue from where you left off.'

const TIMESTAMP = '<timestamp>[^<\\n]*</timestamp>'

/** What a user row's text is: a room command's start row, a bare timestamp, a resume, or other. */
function userRowKind(text) {
  for (const sentence of COMMAND_TURN_SENTENCES) {
    if (text === sentence) continue // a start row always carries its timestamp
    const form = new RegExp(`^${TIMESTAMP}\\n\\n<user_query>${escapeRegExp(sentence)}</user_query>$`)
    if (form.test(text)) return 'command_turn'
  }
  if (new RegExp(`^${TIMESTAMP}$`).test(text)) return 'timestamp'
  if (text === RESUMED_TURN_SENTENCE) return 'resumed'
  return 'other'
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The text of a user row, as Cursor writes it: its message's text parts, joined. */
function userRowText(row) {
  const content = row?.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('') : ''
}

/**
 * Read the whole transcript, from one read that did not change while it was read.
 * Returns `{ bytes, size, stamp, atMs, turns, lastUser, end, lastLineStart,
 * lastLineDigest, userRows }`: `turns` the number of user rows, `lastUser` a digest of
 * the last one (null with none), `end` the final line when it is a turn end (else null),
 * `lastLineStart` the byte offset of the final line and `lastLineDigest` a digest of it,
 * and `userRows` each user row's byte offset and kind (userRowKind). `{ missing: true }`
 * when there is no transcript yet, or null when no clean read could be had.
 */
export function readTranscriptTurns(transcriptPath, { attempts = STABLE_READ_ATTEMPTS } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) sleepSync(STABLE_READ_GAP_MS)
    const whole = readWholeOnce(transcriptPath)
    if (whole?.missing) return { missing: true }
    if (!whole) continue
    // Still the same file a moment later: not a piece of a rewrite in progress.
    sleepSync(STABLE_READ_GAP_MS)
    if (fileStamp(transcriptPath) !== whole.stamp) continue
    const bytes = Buffer.concat(whole.chunks)
    const parsed = scanTranscript(bytes)
    if (parsed) return { ...parsed, bytes, size: bytes.length, stamp: whole.stamp, atMs: whole.atMs }
  }
  return null
}

/**
 * Null when the file does not end in a complete line (it is being written). A user row
 * is a line whose top-level `role` is "user"; the substring test only skips parsing lines
 * that cannot be one.
 */
function scanTranscript(bytes) {
  // Cursor ends every row with a newline: anything after the last one is half written.
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) return null
  let turns = 0
  let lastUser = null
  let last = null
  let lastStart = 0
  const userRows = []
  let start = 0
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start)
    const text = bytes.toString('utf8', start, newline).trim()
    if (text) {
      last = text
      lastStart = start
      if (text.includes('"role":"user"')) {
        let row = null
        try {
          row = JSON.parse(text)
        } catch {
          /* not a whole row */
        }
        if (row?.role === 'user') {
          turns += 1
          lastUser = digest(text)
          userRows.push({ start, kind: userRowKind(userRowText(row)) })
        }
      }
    }
    start = newline + 1
  }
  let end = null
  if (last) {
    let row = null
    try {
      row = JSON.parse(last)
    } catch {
      return null
    }
    if (row?.type === 'turn_ended' && TURN_END_STATUSES.has(row.status)) {
      end = {
        status: row.status,
        error: typeof row.error === 'string' && row.error.trim() ? row.error.trim() : null,
      }
    }
  }
  return { turns, lastUser, end, lastLineStart: lastStart, lastLineDigest: last ? digest(last) : null, userRows }
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * The identity of the turn that is ending or has just ended in this transcript, as the
 * stop hook and the poller both work it out (see the header), or null when it cannot be
 * read.
 */
export function turnEndIdentity(transcriptPath) {
  const conversation = transcriptConversation(transcriptPath)
  if (!conversation) return null
  const read = readTranscriptTurns(transcriptPath)
  if (!read || read.missing) return null
  return identityOf(conversation, read)
}

function identityOf(conversation, read) {
  const rows = `${conversation}#${read.turns}#${read.lastUser ?? 'none'}`
  // An error or a stop is written before the stop hook runs: its line tells two
  // failures with the same rows apart.
  return read.end && read.end.status !== 'success' ? `${rows}#${read.lastLineDigest}@${read.lastLineStart}` : rows
}

function parseIdentity(identity) {
  const match = /^(.+?)#(\d+)#([0-9a-f]{16}|none)(?:#[0-9a-f]{16}@\d+)?$/.exec(String(identity ?? ''))
  return match ? { conversation: match[1], turns: Number(match[2]), lastUser: match[3] === 'none' ? null : match[3] } : null
}

export function turnBaselinePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-baseline.json`)
}

/**
 * Note the transcript as it stands as the poller starts tracking a turn (`turn`, the
 * turn marker's `startedAt`): whether Cursor was between turns, how many bytes it keeps
 * when the next turn starts (`kept`: all of it, or all but a final `turn_ended` line)
 * and their digest, and its stamp. With no transcript yet the conversation is between
 * turns with nothing kept. A transcript that cannot be read cleanly leaves no baseline,
 * and that turn's end is then not reported from the transcript. Returns whether one was
 * written.
 */
export function recordTurnBaseline(connectionId, { turn, conversationId, transcriptPath = null, dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return false
  const conversation = transcriptPath ? transcriptConversation(transcriptPath) : conversationId
  if (!conversation || (conversationId && conversation !== conversationId)) return false
  const read = transcriptPath ? readTranscriptTurns(transcriptPath) : { missing: true }
  if (!read) return false
  const between = read.missing ? true : Boolean(read.end)
  const kept = read.missing ? 0 : between ? read.lastLineStart : read.size
  try {
    writePrivateJson(turnBaselinePath(connectionId, dir), {
      v: 4,
      turn,
      conversation,
      between,
      kept,
      keptDigest: read.missing ? digest('') : digestBytes(read.bytes.subarray(0, kept)),
      stamp: read.missing ? MISSING_STAMP : read.stamp,
    })
    return true
  } catch {
    return false
  }
}

/** The stamp of a transcript that did not exist yet: any later file differs from it. */
const MISSING_STAMP = 'missing'

function digestBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/** The baseline noted for the turn that started at `turn`, or null. */
export function readTurnBaseline(connectionId, turn, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return null
  const value = readPrivateJson(turnBaselinePath(connectionId, dir))
  if (value?.v !== 4 || value.turn !== turn || typeof value.conversation !== 'string') return null
  if (typeof value.between !== 'boolean' || typeof value.stamp !== 'string' || !value.stamp) return null
  if (!Number.isInteger(value.kept) || value.kept < 0 || typeof value.keptDigest !== 'string') return null
  return { turn, conversation: value.conversation, between: value.between, kept: value.kept, keptDigest: value.keptDigest, stamp: value.stamp }
}

/**
 * Whether the turn end in `read` is the tracked command's beyond doubt: conditions (a),
 * (b) and (c) of the header.
 */
function attributable(baseline, read) {
  if (!baseline.between) return false // (a)
  if (read.size < baseline.kept || digestBytes(read.bytes.subarray(0, baseline.kept)) !== baseline.keptDigest) return false // (b)
  if (read.lastLineStart <= baseline.kept) return false // (b): no row written since
  // (c): exactly one turn since, started by the room-command sentence.
  const since = read.userRows.filter((row) => row.start >= baseline.kept)
  const starts = since.filter((row) => row.kind !== 'timestamp' && row.kind !== 'resumed')
  if (starts.length !== 1 || starts[0].kind !== 'command_turn') return false
  const firstStart = starts[0].start
  return since.every((row) => row.start >= firstStart ? row.kind !== 'other' : row.kind === 'timestamp')
}

const CLAIM_SUFFIX = '.claim'
const claimPrefix = (connectionId) => `${connectionId}.turn-end.`

function claimPath(connectionId, identity, dir) {
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return path.join(dir, `${claimPrefix(connectionId)}${digest}${CLAIM_SUFFIX}`)
}

function claimFiles(connectionId, dir, { all = false } = {}) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(claimPrefix(connectionId)) && (all || name.endsWith(CLAIM_SUFFIX)))
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** The version of a claim record; a record of any other shape (an older plugin's) is set aside. */
const CLAIM_VERSION = 2

function readClaim(file) {
  const record = readPrivateJson(file)
  return record?.v === CLAIM_VERSION && typeof record.turn === 'string' ? record : null
}

/** Whether the process that owns a claim is still running. */
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Claim the report of one turn end. Returns `{ outcome, told, completed }`:
 *  - 'claimed': this caller reports it. `told` and `completed` say an earlier owner
 *    whose other steps did not land already told the room or reported the turn
 *    finished, so neither is sent twice.
 *  - 'reporting': another live process is reporting it now. Leave it: that owner either
 *    settles it or gives it back for a retry (settleTurnEnd).
 *  - 'reported': it has been reported in full.
 *  - 'failed': no claim could be written, so nothing says who reports it.
 * The claim is a file created only if it does not exist yet (a hard link of a complete
 * temporary file), so two processes claiming at once cannot both win. A claim given back,
 * one whose owner process has gone, one of an older shape, and one made before `after`
 * (the tracked turn's start: an earlier turn that wrote no user row of its own) is set
 * aside by a rename only one process can make, and the claim made again. Earlier claims
 * are removed: only the newest turn end can be claimed again.
 */
export function claimTurnEnd(connectionId, identity, { by, after = null, dir = CONNECTIONS_DIR, now = Date.now(), pid = process.pid } = {}) {
  if (!connectionId || !parseIdentity(identity)) return { outcome: 'failed', told: false, completed: false }
  const target = claimPath(connectionId, identity, dir)
  let told = false
  let completed = false
  // Each pass either claims, finds the claim held, or sets a dead claim aside: two passes
  // after setting one aside settle every race between two claimers.
  for (let pass = 0; pass < 3; pass++) {
    const temporary = `${target}.tmp-${pid}-${now.toString(36)}-${pass}`
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const record = { v: CLAIM_VERSION, turn: identity, by: by ?? null, pid, at: new Date(now).toISOString(), state: 'reporting', told, completed }
      fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      try {
        fs.linkSync(temporary, target)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const existing = readClaim(target)
        const earlier = typeof after === 'number' && Date.parse(existing?.at ?? '') < after
        if (existing && !earlier) {
          if (existing.state === 'reported') return { outcome: 'reported', told: true, completed: true }
          if (existing.state === 'reporting' && ownerAlive(existing.pid)) {
            return { outcome: 'reporting', told: Boolean(existing.told), completed: Boolean(existing.completed) }
          }
          told = Boolean(existing.told)
          completed = Boolean(existing.completed)
        }
        try {
          fs.renameSync(target, `${target}.aside-${pid}-${now.toString(36)}-${pass}`)
        } catch {
          /* another claimer set it aside first: try the link again */
        }
        continue
      }
    } catch {
      return { outcome: 'failed', told: false, completed: false }
    } finally {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        /* a stray temporary file claims nothing */
      }
    }
    for (const file of claimFiles(connectionId, dir, { all: true })) {
      if (file === target) continue
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* an older claim left behind matches no newer turn end */
      }
    }
    return { outcome: 'claimed', told, completed }
  }
  return { outcome: 'reporting', told, completed }
}

/** Rewrite this process's own claim of `identity`, if it still holds it. */
function updateOwnClaim(connectionId, identity, dir, patch, pid = process.pid) {
  if (!connectionId || !parseIdentity(identity)) return false
  const target = claimPath(connectionId, identity, dir)
  const record = readClaim(target)
  if (!record || record.pid !== pid || record.turn !== identity) return false
  try {
    writePrivateJson(target, { ...record, ...patch })
    return true
  } catch {
    return false
  }
}

/** The room has been told about this turn end: a later owner does not post it again. */
export function noteTurnEndTold(connectionId, identity, { dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  return updateOwnClaim(connectionId, identity, dir, { told: true }, pid)
}

/** DevSpec has been told the turn finished: a later owner does not report it again. */
export function noteTurnEndCompleted(connectionId, identity, { dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  return updateOwnClaim(connectionId, identity, dir, { completed: true }, pid)
}

/**
 * Settle this process's claim: `reported` when every step reached DevSpec, else given
 * back so the other path, or the poller's next try, reports what is left.
 */
export function settleTurnEnd(connectionId, identity, { reported, dir = CONNECTIONS_DIR, pid = process.pid } = {}) {
  return updateOwnClaim(connectionId, identity, dir, { state: reported ? 'reported' : 'released' }, pid)
}

/**
 * How the poller tries again after a report of its own did not reach DevSpec: at most
 * REPORT_ATTEMPTS tries, REPORT_RETRY_MS apart. The spacing is the room post's own
 * 15-second timeout, so a try never overlaps the last; five tries ride out a dropped
 * connection or a DevSpec restart of about a minute, while a post DevSpec refuses is
 * not sent on every lap for ever. After the last try the turn ends as it did before
 * this existed: Working until the next command or the backstop.
 */
export const REPORT_ATTEMPTS = 5
export const REPORT_RETRY_MS = 15_000

/** When the next try is due after `attempts` failed tries, or null when there is none. */
export function nextReportTry(attempts, failedAtMs) {
  return attempts >= REPORT_ATTEMPTS ? null : failedAtMs + REPORT_RETRY_MS
}

/**
 * Whether the end of the turn `baseline` was noted for (a turn's readTurnBaseline) is
 * reported or being reported: a claim in that conversation made after the turn started,
 * reported in full or held by a live owner.
 */
export function turnEndClaimed(connectionId, baseline, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || !baseline) return false
  for (const file of claimFiles(connectionId, dir)) {
    const record = readClaim(file)
    const claimed = parseIdentity(record?.turn)
    if (claimed?.conversation !== baseline.conversation || !(Date.parse(record.at) >= baseline.turn)) continue
    if (record.state === 'reported' || (record.state === 'reporting' && ownerAlive(record.pid))) return true
  }
  return false
}

function fileStampOf({ size, mtimeMs }) {
  return `${size}:${mtimeMs}`
}

function fileStamp(transcriptPath) {
  try {
    return fileStampOf(fs.statSync(transcriptPath))
  } catch {
    return null
  }
}

/**
 * Cheap check, for the poller's once-a-second local check: whether the transcript of a
 * tracked turn has changed to end in a turn end since this was last asked. True once per
 * change; the poller's lap then decides with transcriptTurnEnd.
 */
export function turnEndPending({ marker, transcriptPath, memo = {} }) {
  if (typeof marker?.startedAt !== 'number' || !transcriptPath) return false
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return false
  const seen = `${marker.startedAt}|${transcriptPath}|${stamp}`
  if (memo.probed === seen) return false
  memo.probed = seen
  return recognisedEnd(lastTurnEnd(transcriptPath))
}

/**
 * The end of the turn `marker` tracks, when the transcript shows one written since
 * tracking started (see the header for every condition), else null:
 * `{ identity, status, error, failure, attributed }`. `attributed` says it is the
 * tracked command's turn end beyond doubt; when false the caller only tells the room
 * about an error or a stop. `memo` (any object the caller keeps) skips a transcript that
 * has not changed since it was last decided.
 */
export function transcriptTurnEnd({ connectionId, marker, transcriptPath, dir = CONNECTIONS_DIR, memo = {} }) {
  if (!connectionId || typeof marker?.startedAt !== 'number' || !transcriptPath) return null
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return null
  const seen = `${marker.startedAt}|${transcriptPath}|${stamp}`
  if (memo.decided === seen) return null
  if (!recognisedEnd(lastTurnEnd(transcriptPath))) {
    memo.decided = seen
    return null
  }
  const conversation = transcriptConversation(transcriptPath)
  const baseline = readTurnBaseline(connectionId, marker.startedAt, { dir })
  if (!baseline || baseline.conversation !== conversation) {
    memo.decided = seen
    return null
  }
  const read = readTranscriptTurns(transcriptPath)
  // Caught mid-write: decided on a later look, never from this one.
  if (!read || read.missing) return null
  memo.decided = seen
  if (!read.end) return null
  // Written since tracking started: the file changed since, and was last written after
  // the marker. A transcript put back with its old modification time is neither.
  if (read.stamp === baseline.stamp || read.atMs < marker.startedAt) return null
  const isAttributed = attributable(baseline, read)
  // A turn that ran is reported only when it is the tracked command's; otherwise it
  // ends as before this existed.
  if (!isAttributed && read.end.status === 'success') return null
  return {
    identity: identityOf(conversation, read),
    status: read.end.status,
    error: read.end.error,
    failure: turnEndFailure(read.end),
    attributed: isAttributed,
  }
}
