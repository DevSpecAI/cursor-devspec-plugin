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
 * turn finished (turn-commands.mjs) and clears Working.
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
 * "aborted"}` (with `"error":"…"` for an error) as the final line, and when the next
 * turn starts it rewrites the file without that line. Every turn starts with a user
 * row, including one woken by a background task's output ("<user_query>Briefly inform
 * the user about the task result…"). Read from the CLI 2026.11.05 bundle's transcript
 * writer, and seen in every transcript on the measuring machine written by CLI
 * 2026.09.18 to 2026.11.05.
 *
 * In an interactive turn that succeeds, Cursor runs the stop hook *before* it writes
 * the line; for an error or a stop, after it (CLI 2026.11.05 bundle). The line has no
 * timestamp and no turn id. The transcript is not an official Cursor interface.
 *
 * ## Which turn a turn end belongs to
 *
 * A turn end's identity is its conversation and the number of user rows above it, the
 * turn's place in the conversation: `<conversation>#<turns>` (`turnEndIdentity`). The
 * stop hook can work it out even when it runs before the line exists, because no user
 * row is written between the stop hook and the line.
 *
 * The poller reports a turn end only for the turn it is tracking (the turn marker), and
 * only when the transcript has more user rows than it had when that turn started
 * (`recordTurnBaseline`, written by the poller as it starts the turn). That keeps out
 * the end of a turn already running when a room command arrived, which Cursor writes
 * after the poller has started tracking the command's turn: the turn that connected,
 * a prompt typed at the terminal, or a turn whose stop hook is still running. A turn the
 * poller did not start (a prompt typed at the terminal, which Cursor's skipped
 * `beforeSubmitPrompt` would have tracked) has no baseline and is never reported here.
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
 * the three above is a turn end, and only from a read of the whole transcript that did
 * not change while it was read (Cursor rewrites the file in place, so a read can catch
 * it half written: that read is retried, never used). With no baseline, an unreadable
 * transcript or a line it does not recognise, nothing is reported, and the turn ends as
 * it did before: Working until the agent's answer, a later command or the backstop. If
 * Cursor changes the format, the plugin stops noticing turn ends; it never reports a
 * turn that did not end.
 *
 * ## Known limits
 *
 *  - A turn during which Cursor summarises the conversation can leave fewer user rows
 *    than it started with; its end is not noticed.
 *  - A headless (`-p`) run killed by a signal writes no `turn_ended` line, so its end
 *    is not noticed (CLI 2026.11.19, 2026-11-20). Stopping a turn in the terminal with
 *    Ctrl+C does write one: `{"type":"turn_ended","status":"aborted","error":"User
 *    aborted/interrupted manually."}`.
 *  - A turn end is noticed within about a second while DevSpec's push channel is open
 *    (the poller's local check), otherwise at the poller's next poll.
 *  - The request bookkeeping the stop hook does at a turn's end (closing finished
 *    requests, noting background work that is gone) needs what Cursor hands the stop
 *    hook, so it still waits for a stop hook.
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
 * How much of the transcript's end is read to find its last `turn_ended` line. That line
 * is a few hundred bytes and is the final line, but the rows above it can be very large,
 * so this bounds the cost of a read on a file that grows without limit; it cuts no text
 * that is reported. A tail with no `turn_ended` line in it is "no turn end seen".
 */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024

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
 * The transcript's last turn end, or null when its tail holds none. `key` identifies
 * this turn end's line (the file, where the line sits and what it says), `final` is
 * whether nothing has been written below it, and `atMs` is the file's modification time.
 */
export function lastTurnEnd(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  let buffer
  let base
  let atMs
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const { size, mtimeMs } = fs.fstatSync(fd)
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES)
      buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      base = size - length
      atMs = mtimeMs
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  let end = buffer.length
  let final = true
  while (end > 0) {
    const newline = buffer.lastIndexOf(0x0a, end - 1)
    const start = newline + 1
    // The first line of a tail that starts mid-file is partial: never read it.
    if (newline < 0 && base > 0) return null
    const text = buffer.toString('utf8', start, end).trim()
    end = newline < 0 ? 0 : newline
    if (!text) continue
    let row = null
    try {
      row = JSON.parse(text)
    } catch {
      /* not a row: a line still being written */
    }
    if (row?.type === 'turn_ended') {
      return {
        key: `${transcriptPath}#${base + start}#${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
        status: typeof row.status === 'string' ? row.status : null,
        error: typeof row.error === 'string' && row.error.trim() ? row.error.trim() : null,
        final,
        atMs,
      }
    }
    final = false
  }
  return null
}

/** Whether a turn end from lastTurnEnd is one this module recognises (see the header). */
function recognisedFinalEnd(end) {
  return Boolean(end?.final && TURN_END_STATUSES.has(end.status))
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
 * Count the transcript's user rows and read its final line, from one read of the whole
 * file that did not change while it was read. Returns `{ turns, end }` (`end` is the
 * final line when it is a turn end, else null), `{ missing: true }` when there is no
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
    if (parsed) return parsed
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
  let last = null
  let carry = Buffer.alloc(0)
  const take = (line) => {
    const text = line.toString('utf8').trim()
    if (!text) return
    last = text
    if (text.includes('"role":"user"')) {
      try {
        if (JSON.parse(text)?.role === 'user') turns += 1
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
  return { turns, end }
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
  return `${conversation}#${read.turns}`
}

function parseIdentity(identity) {
  const match = /^(.+)#(\d+)$/.exec(String(identity ?? ''))
  return match ? { conversation: match[1], turns: Number(match[2]) } : null
}

export function turnBaselinePath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.turn-baseline.json`)
}

/**
 * Note how far the conversation's transcript had got as the poller starts tracking a
 * turn (`turn`, the turn marker's `startedAt`), so that turn's end can be told from the
 * end of one already running. With no transcript yet the conversation has no turns. A
 * transcript that cannot be read cleanly leaves no baseline, and that turn's end is then
 * not reported from the transcript. Returns whether one was written.
 */
export function recordTurnBaseline(connectionId, { turn, conversationId, transcriptPath = null, dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return false
  const conversation = transcriptPath ? transcriptConversation(transcriptPath) : conversationId
  if (!conversation || (conversationId && conversation !== conversationId)) return false
  const read = transcriptPath ? readTranscriptTurns(transcriptPath) : { missing: true }
  if (!read) return false
  try {
    writePrivateJson(turnBaselinePath(connectionId, dir), {
      v: 1,
      turn,
      conversation,
      turns: read.missing ? 0 : read.turns,
    })
    return true
  } catch {
    return false
  }
}

/** The baseline noted for the turn that started at `turn`, or null. */
export function readTurnBaseline(connectionId, turn, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || typeof turn !== 'number') return null
  const value = readPrivateJson(turnBaselinePath(connectionId, dir))
  if (value?.v !== 1 || value.turn !== turn || typeof value.conversation !== 'string') return null
  if (!Number.isInteger(value.turns) || value.turns < 0) return null
  return { conversation: value.conversation, turns: value.turns }
}

const CLAIM_SUFFIX = '.claim'
const claimPrefix = (connectionId) => `${connectionId}.turn-end.`

function claimPath(connectionId, identity, dir) {
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return path.join(dir, `${claimPrefix(connectionId)}${digest}${CLAIM_SUFFIX}`)
}

function claimFiles(connectionId, dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(claimPrefix(connectionId)) && name.endsWith(CLAIM_SUFFIX))
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/**
 * Claim the report of one turn end. 'claimed': this caller reports it. 'taken': the
 * other path already did. 'failed': no claim could be written, so nothing says who
 * reports it. The claim is a file created only if it does not exist yet (a hard link of
 * a complete temporary file), so two processes claiming at once cannot both win.
 * Earlier claims are removed: only the newest turn end can be claimed again.
 */
export function claimTurnEnd(connectionId, identity, { by, dir = CONNECTIONS_DIR, now = Date.now() } = {}) {
  if (!connectionId || !parseIdentity(identity)) return 'failed'
  const target = claimPath(connectionId, identity, dir)
  const temporary = `${target}.tmp-${process.pid}-${now.toString(36)}`
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporary, `${JSON.stringify({ v: 1, turn: identity, by: by ?? null, at: new Date(now).toISOString() })}\n`, {
      mode: 0o600,
    })
    try {
      fs.linkSync(temporary, target)
    } catch (error) {
      if (error?.code === 'EEXIST') return 'taken'
      throw error
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
  for (const file of claimFiles(connectionId, dir)) {
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
 * Whether a turn end later than `baseline` (a turn's readTurnBaseline) has been claimed:
 * that turn's end was reported by whoever claimed it.
 */
export function turnEndClaimed(connectionId, baseline, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || !baseline) return false
  for (const file of claimFiles(connectionId, dir)) {
    const claimed = parseIdentity(readPrivateJson(file)?.turn)
    if (claimed && claimed.conversation === baseline.conversation && claimed.turns > baseline.turns) return true
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
  return recognisedFinalEnd(lastTurnEnd(transcriptPath))
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
  if (!recognisedFinalEnd(lastTurnEnd(transcriptPath))) {
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
  if (!read.end || read.turns <= baseline.turns) return null
  return {
    identity: `${conversation}#${read.turns}`,
    status: read.end.status,
    error: read.end.error,
    failure: turnEndFailure(read.end),
  }
}
