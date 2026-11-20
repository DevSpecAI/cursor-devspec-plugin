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
 * rewrites the whole file in place (truncating it first) without that line. In an
 * interactive turn that succeeds, Cursor runs the stop hook *before* it writes the
 * line; for an error or a stop, after it. Read from the CLI 2026.11.05 and 2026.11.19
 * bundles. The transcript is not an official Cursor interface.
 *
 * What a turn looks like, measured on 2026-11-20 (CLI 2026.11.19 live, every write
 * logged; and the 63 real transcripts on the measuring machine, CLI 2026.09.18 to
 * 2026.11.05):
 *  - A turn started by a prompt starts with a user row
 *    `<timestamp>Friday, Nov 20, 2026, 7:59 PM (UTC)</timestamp> <user_query>…`.
 *  - A turn started by a background command's output, which is how a room command's
 *    wake reaches the agent, also starts with a user row, of Cursor's own wording:
 *    `<timestamp>…</timestamp> <user_query>Briefly inform the user about the task result
 *    and perform any follow-up actions (if needed)…</user_query>` (25 seen). The time is
 *    to the minute, so two such turns in the same minute write byte-identical rows (seen).
 *  - Cursor's server adds user rows inside a turn when it resumes one: "Your previous
 *    response was interrupted. Continue from where you left off." (10 seen, up to three
 *    identical in a row; the text is not in the CLI, so it is the server's).
 *  - A turn that fails or is stopped at its very start writes `turn_ended` and no user
 *    row: four transcripts are that one line ("Model unavailable on Free…" twice, "User
 *    aborted/interrupted manually." twice).
 *  - The `turn_ended` line carries no id and no time.
 *  - A turn stopped with Ctrl+C has its `turn_ended` written twice, identical, 3 ms
 *    apart.
 *
 * So the user rows cannot say which turn a turn end belongs to: they repeat, appear
 * inside a turn, and are missing from a turn that failed at its start. The writing of a
 * `turn_ended` line can.
 *
 * ## Which turn a turn end belongs to
 *
 * The poller reports a turn end only for the turn it is tracking (the turn marker,
 * written as it hands a room command over), and it notes where the transcript was at
 * that moment (`recordTurnBaseline`):
 *  - **Between turns** (the final line is a `turn_ended`, or there is no transcript
 *    yet): Cursor writes the next `turn_ended` only when a turn that started after this
 *    ends, so any `turn_ended` written after tracking started (the file has changed
 *    since) is the end of a later turn: a prompt, a room command's wake, a resumed turn,
 *    a turn that failed at its start, or one during which Cursor summarised the
 *    conversation. The only rewrite of an ended turn's line (a stop, 3 ms apart) cannot
 *    fall on both sides of the baseline, because the baseline counts only a file that
 *    kept still for 25 ms (STABLE_READ_GAP_MS).
 *  - **In a turn** (the turn that connected, a prompt typed at the terminal, a turn
 *    whose stop hook is still running): the first `turn_ended` written after tracking
 *    started is that running turn's own end. It is never reported; it becomes the new
 *    starting point, and the rule above applies from there. The poller watches the
 *    file so it sees that end as Cursor writes it.
 *
 * A turn the poller did not start (a prompt typed at the terminal, which Cursor's
 * skipped `beforeSubmitPrompt` would have tracked) has no baseline and is never
 * reported here.
 *
 * A turn end's identity, which the stop hook and the poller both claim, is
 * `<conversation>#<number of user rows>#<digest of the last user row>`
 * (`turnEndIdentity`). The stop hook can work it out even when it runs before the
 * `turn_ended` line exists, because nothing is written between the stop hook and the
 * line but the line itself. A turn that wrote no user row of its own has the same
 * identity as the turn before it, so a claim made before the tracked turn started does
 * not count against it (`claimTurnEnd` `after`).
 *
 * ## Reported once
 *
 * Whichever of the stop hook and the poller reports a turn end first claims its
 * identity (`claimTurnEnd`, an exclusive file create in the connection's state folder);
 * the other finds the claim and reports nothing. A claim whose report did not reach
 * DevSpec is given back (`releaseTurnEnd`), so the other can still report it. The
 * poller's backstop for a turn whose marker the stop hook cleared does not report a
 * turn end the stop hook claimed either (`turnEndClaimed`).
 *
 * ## Failing safe
 *
 * Only a complete final line whose `type` is "turn_ended" and whose status is one of
 * the three above is a turn end, read whole whatever its length (`lastTurnEnd`), and only from a read of the whole transcript that did
 * not change while it was read (Cursor rewrites the file in place, so a read can catch
 * it half written: that read is retried, never used). With no baseline, an unreadable
 * transcript or a line it does not recognise, nothing is reported, and the turn ends as
 * it did before: Working until the agent's answer, a later command or the backstop. If
 * Cursor changes the format, the plugin stops noticing turn ends; it never reports a
 * turn that did not end.
 *
 * ## Known limits
 *
 *  - If the turn running when tracking started ends and the next turn rewrites the file
 *    before the poller sees that end, the next turn's end is taken for the running
 *    one's and not reported: a missed report, never a false one.
 *  - A prompt typed at the terminal after a room command was handed over, but before
 *    Cursor started the command's turn, ends first; its end is reported as the end of
 *    the tracked turn, as the stop hook would report it.
 *  - A headless (`-p`) run killed by a signal writes no `turn_ended` line, so its end
 *    is not noticed (CLI 2026.11.19, 2026-11-20). Stopping a turn in the terminal with
 *    Ctrl+C does write one: `{"type":"turn_ended","status":"aborted","error":"User
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
 * identifies this line (the file, where the line sits and what it says) and `atMs` is
 * the file's modification time.
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
  try {
    const { size, mtimeMs } = fs.fstatSync(fd)
    atMs = mtimeMs
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
    return { chunks, stamp: fileStampOf(before) }
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
 * Count the transcript's user rows, note the last one and read the final line, from one
 * read of the whole file that did not change while it was read. Returns
 * `{ turns, lastUser, end, stamp }`: `lastUser` is a digest of the last user row (null
 * with none), `end` the final line when it is a turn end, else null, and `stamp` the
 * file's size and modification time as read. `{ missing: true }` when there is no
 * transcript yet, or null when no clean read could be had.
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
    const parsed = scanTranscript(whole.chunks)
    if (parsed) return { ...parsed, stamp: whole.stamp }
  }
  return null
}

/**
 * Lines are split across chunks without decoding a partial character. A user row is a
 * line whose top-level `role` is "user"; the substring test only skips parsing lines
 * that cannot be one. Null when the file does not end in a complete line (it is being
 * written).
 */
function scanTranscript(chunks) {
  let turns = 0
  let lastUser = null
  let last = null
  let carry = Buffer.alloc(0)
  const take = (line) => {
    const text = line.toString('utf8').trim()
    if (!text) return
    last = text
    if (text.includes('"role":"user"')) {
      try {
        if (JSON.parse(text)?.role === 'user') {
          turns += 1
          lastUser = digest(text)
        }
      } catch {
        /* not a whole row */
      }
    }
  }
  for (const chunk of chunks) {
    let buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
    let start = 0
    let newline = buffer.indexOf(0x0a, start)
    while (newline >= 0) {
      take(buffer.subarray(start, newline))
      start = newline + 1
      newline = buffer.indexOf(0x0a, start)
    }
    carry = Buffer.from(buffer.subarray(start))
  }
  // Cursor ends every row with a newline: anything after the last one is half written.
  if (carry.toString('utf8').trim()) return null
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
  return { turns, lastUser, end }
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
  return `${conversation}#${read.turns}#${read.lastUser ?? 'none'}`
}

function parseIdentity(identity) {
  const match = /^(.+)#(\d+)#([0-9a-f]{16}|none)$/.exec(String(identity ?? ''))
  return match ? { conversation: match[1], turns: Number(match[2]), lastUser: match[3] === 'none' ? null : match[3] } : null
}

export function turnBaselinePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-baseline.json`)
}

/**
 * Note where the conversation's transcript was as the poller starts tracking a turn
 * (`turn`, the turn marker's `startedAt`): whether Cursor was between turns, and the
 * file as it stood, so that turn's end can be told from the end of one already running
 * or already ended (see the header). With no transcript yet the conversation is between
 * turns. A transcript that cannot be read cleanly leaves no baseline, and that turn's
 * end is then not reported from the transcript. Returns whether one was written.
 */
export function recordTurnBaseline(connectionId, { turn, conversationId, transcriptPath = null, dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return false
  const conversation = transcriptPath ? transcriptConversation(transcriptPath) : conversationId
  if (!conversation || (conversationId && conversation !== conversationId)) return false
  const read = transcriptPath ? readTranscriptTurns(transcriptPath) : { missing: true }
  if (!read) return false
  return writeBaseline(connectionId, dir, {
    turn,
    conversation,
    between: read.missing ? true : Boolean(read.end),
    stamp: read.missing ? MISSING_STAMP : read.stamp,
  })
}

/** The stamp of a transcript that did not exist yet: any later file differs from it. */
const MISSING_STAMP = 'missing'

function writeBaseline(connectionId, dir, { turn, conversation, between, stamp }) {
  try {
    writePrivateJson(turnBaselinePath(connectionId, dir), { v: 3, turn, conversation, between, stamp })
    return true
  } catch {
    return false
  }
}

/** The baseline noted for the turn that started at `turn`, or null. */
export function readTurnBaseline(connectionId, turn, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return null
  const value = readPrivateJson(turnBaselinePath(connectionId, dir))
  if (value?.v !== 3 || value.turn !== turn || typeof value.conversation !== 'string') return null
  if (typeof value.between !== 'boolean' || typeof value.stamp !== 'string' || !value.stamp) return null
  return { turn, conversation: value.conversation, between: value.between, stamp: value.stamp }
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

/**
 * Claim the report of one turn end. 'claimed': this caller reports it. 'taken': the
 * other path already did. 'failed': no claim could be written, so nothing says who
 * reports it. The claim is a file created only if it does not exist yet (a hard link of
 * a complete temporary file), so two processes claiming at once cannot both win. A
 * claim of the same identity made before `after` (the tracked turn's start) was the end
 * of an earlier turn that wrote no user row of its own: it is set aside, by a rename
 * only one process can make, and the claim made again. Earlier claims are removed: only
 * the newest turn end can be claimed again.
 */
export function claimTurnEnd(connectionId, identity, { by, after = null, dir = CONNECTIONS_DIR, now = Date.now() } = {}) {
  if (!connectionId || !parseIdentity(identity)) return 'failed'
  const target = claimPath(connectionId, identity, dir)
  const temporary = `${target}.tmp-${process.pid}-${now.toString(36)}`
  let outcome = 'failed'
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporary, `${JSON.stringify({ v: 1, turn: identity, by: by ?? null, at: new Date(now).toISOString() })}\n`, {
      mode: 0o600,
    })
    for (let attempt = 0; attempt < 2 && outcome === 'failed'; attempt++) {
      try {
        fs.linkSync(temporary, target)
        outcome = 'claimed'
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const claimedAt = Date.parse(readPrivateJson(target)?.at ?? '')
        if (typeof after !== 'number' || !(claimedAt < after) || attempt > 0) {
          outcome = 'taken'
          break
        }
        try {
          fs.renameSync(target, `${target}.earlier-${process.pid}-${now.toString(36)}`)
        } catch {
          /* another process set it aside first: try the link once more */
        }
      }
    }
  } catch {
    return 'failed'
  } finally {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* a stray temporary file claims nothing */
    }
  }
  if (outcome !== 'claimed') return outcome
  for (const file of claimFiles(connectionId, dir, { all: true })) {
    if (file === target) continue
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* an older claim left behind matches no newer turn end */
    }
  }
  return 'claimed'
}

/** Give back a claim whose report did not reach DevSpec, so the other path can report it. */
export function releaseTurnEnd(connectionId, identity, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || !parseIdentity(identity)) return
  try {
    fs.rmSync(claimPath(connectionId, identity, dir), { force: true })
  } catch {
    /* a claim that stays only means this turn end is not reported twice */
  }
}

/**
 * Whether the end of the turn `baseline` was noted for (a turn's readTurnBaseline) has
 * been claimed: a claim in that conversation made after the turn started.
 */
export function turnEndClaimed(connectionId, baseline, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || !baseline) return false
  for (const file of claimFiles(connectionId, dir)) {
    const record = readPrivateJson(file)
    const claimed = parseIdentity(record?.turn)
    if (claimed?.conversation === baseline.conversation && Date.parse(record?.at ?? '') >= baseline.turn) return true
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
 * The end of the turn `marker` tracks, when the transcript shows it (see the header for
 * every condition), else null: `{ identity, status, error, failure }`. `memo` (any object
 * the caller keeps) skips a transcript that has not changed since it was last decided.
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
  if (!baseline.between) {
    // The turn that was running when tracking started has ended. Never reported; any
    // turn end written after this one is a later turn's.
    writeBaseline(connectionId, dir, { ...baseline, between: true, stamp: read.stamp })
    return null
  }
  if (read.stamp === baseline.stamp) return null
  return {
    identity: identityOf(conversation, read),
    status: read.end.status,
    error: read.end.error,
    failure: turnEndFailure(read.end),
  }
}
