/**
 * Tell DevSpec when Cursor stops this agent for a usage limit (item f8672ca0). What
 * DevSpec does with the report, and for how long, is the served contract's
 * `semantics.check_job.usage_refusal` in devspec://product/remote-ingress-contract,
 * and the field's shape is `usage_refused_until` on heartbeat_connection and
 * poll_connection. This module decides only what to report and when.
 *
 * Maintainer notes: how a usage stop is recognised, and the limits of that.
 *
 * ## What Cursor gives a plugin
 *
 * No structured usage signal. The stop hook's `status` says only "error". Cursor's CLI
 * does classify its own usage errors (FREE_USER_USAGE_LIMIT, PRO_USER_USAGE_LIMIT,
 * FREE_ and PRO_USER_RATE_LIMIT_EXCEEDED, RATE_LIMITED, GENERIC_RATE_LIMIT_EXCEEDED,
 * read from the 2026.11.05 CLI bundle), but what reaches a plugin is only their text,
 * written as the last line of the conversation's agent transcript:
 *
 *   {"type":"turn_ended","status":"error","error":"You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more."}
 *
 * (Cursor CLI 2026.10.19 on 2026-10-31, turn-failure.mjs; the same text in transcripts
 * written up to CLI 2026.11.05.) That text comes from Cursor's servers, not the CLI, so
 * it can change without a CLI release. The transcript keeps one `turn_ended` line, for
 * the turn that ended last, as its final line, and `status` is "success", "error" or
 * "aborted": measured 2026-11-20 over 63 transcripts written by CLI 2026.09.18 to
 * 2026.11.05, every one with a turn end had exactly one, last, whatever its number of
 * prompts.
 *
 * ## What counts as a usage stop
 *
 * All of these, or nothing is reported:
 *  - the `turn_ended` line's status is "error". "aborted" is a person stopping the turn
 *    and "success" is a turn that ran;
 *  - its error text begins with Cursor's own usage-limit wording, CURSOR_USAGE_LIMIT,
 *    and nothing else. That wording is Cursor attributing the stop to the account's
 *    usage limit, which is what the served `semantics.check_job.usage_refusal` asks to
 *    be reported. Generic throttling text is not: "too many requests", "rate limit
 *    exceeded", RESOURCE_EXHAUSTED, "quota exceeded" or a 429 can come from a
 *    repository service, a tool or the disk ("Disk quota exceeded"), and reporting one
 *    would keep a capable agent from checks for no reason. Other errors seen in real
 *    transcripts, also not counted: "WritableIterable is closed" (Cursor's own stream
 *    error), "Model unavailable on Free …" and "Named models unavailable …" (the plan
 *    lacks that model; another model runs). Nor is a usage percentage, which the
 *    served parameter rules out;
 *  - it is the transcript's final line, because that is the only way to date it (below).
 *
 * Failing safe: if Cursor rewords its message, usage stops are simply no longer
 * reported and checks keep going to the agent, as they did before this existed. Nothing
 * else is ever reported as a usage stop. When that happens, add the new wording beside
 * CURSOR_USAGE_LIMIT only once it has been seen in a real transcript, with the Cursor
 * version it was seen on. A rate-limit stop Cursor words differently is not reported
 * until then.
 *
 * ## When it lifts
 *
 * The time the stop's text gives, when it gives one in a form that reads without
 * guessing (refusalLiftsAt): "try again in 2 hours", "resets in 3h 20m", "retry after
 * 90 seconds", "retry-after: 30", or "resets at" a full ISO time with its time zone.
 * That time is sent as stated, however far ahead: how far ahead DevSpec keeps it is
 * the server's to decide (the served `usage_refused_until` parameter), in one place.
 * Cursor's usage-limit text has given no time so far, and a time without a zone or date
 * ("resets 3pm", "on Dec 1") is not read, so the usual report is the cool-off
 * (USAGE_REFUSAL_COOL_OFF_MS).
 *
 * The line carries no timestamp, so the stop is dated by the transcript's modification
 * time: while the `turn_ended` line is the final line, nothing has been written since
 * it. A duration counts from then, and a stop whose time has already passed when it is
 * first seen is not reported.
 *
 * ## Where it is noticed
 *
 * The poller reads the conversation's transcript every lap (when it has changed) and
 * records each turn end once, in `<connection>.usage-refusal.json`. That does not depend
 * on Cursor running the stop hook, which Cursor skips on some of its own errors
 * (commit 2792b5b, "WritableIterable is closed") and may not run for a plugin at all on
 * some CLI versions (task 659a015f). When Cursor does run the stop hook, it records the
 * same turn end first and sends it on the turn's own heartbeat; whichever of the two
 * sees a turn end first records it, and the other finds it already recorded.
 *
 * The standing refusal rides every poll and the stop hook's heartbeats; once a turn
 * Cursor records as "success" ends, null is sent until a status update carrying it
 * reaches DevSpec. A refusal whose time has passed is no longer sent, since the served
 * parameter treats a past time as cleared.
 *
 * ## Known limits
 *
 *  - Only a conversation the connection is bonded to (`local_id`) is read. A connection
 *    with none reports nothing.
 *  - A stop Cursor does not write to the transcript is not seen.
 *  - An errored `turn_ended` that is no longer the final line (a newer prompt was
 *    written below it before it was read) cannot be dated and is not reported. The
 *    next turn the limit stops reports it again.
 *  - Cursor rewriting a transcript with no new turn (it rewrites the whole file at
 *    times) can make a recorded stop look new, which restarts its cool-off from that
 *    write. It never turns anything else into a usage stop.
 *  - A stop that outlasts its cool-off is reported again only when a later turn is
 *    stopped by it.
 *
 * Imports only private-state.mjs and Node built-ins, so every hook and the poller can
 * load it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/**
 * How long a stop that gave no time of its own is reported for: the "short bounded
 * cool-off when it gave none" the served `semantics.check_job.usage_refusal` asks for.
 * Long enough that a refused agent is not offered check after check it cannot rule;
 * short enough that an agent whose limit has lifted is not kept from checks for long
 * when no turn runs to clear it. A stop that outlasts it is reported again by the next
 * turn it stops. The same choice as the Claude Code and Antigravity plugins.
 */
export const USAGE_REFUSAL_COOL_OFF_MS = 15 * 60 * 1000

/**
 * How much of the transcript's end is read to find its `turn_ended` line. That line is
 * a few hundred bytes and is the final line, but the rows above it can be very large,
 * so this bounds the cost of a read on a file that grows without limit; it cuts no text
 * that is reported. A tail with no `turn_ended` line in it is "no turn end seen".
 */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024

/**
 * Cursor's own wording for a stop it attributes to the account's usage limit: the start
 * of the error text, since what follows it (here a plan upsell) says nothing about the
 * stop. Seen in real transcripts: "You've hit your usage limit Get Cursor Pro for more
 * Agent usage, unlimited Tab, and more." (CLI 2026.10.19 on 2026-10-31, and transcripts
 * written up to CLI 2026.11.05). The same words with a typographic apostrophe are
 * accepted too. Nothing else counts (see the header).
 */
const CURSOR_USAGE_LIMIT = /^You['’]ve hit your usage limit\b/

/** Whether a stop's error text is Cursor's usage-limit stop (CURSOR_USAGE_LIMIT). */
export function isUsageRefusalText(text) {
  return typeof text === 'string' && CURSOR_USAGE_LIMIT.test(text.trim())
}

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }

/** "3h 20m", "2 hours", "90 seconds", "1 day and 4 hours" → milliseconds, or null. */
function durationMs(text) {
  let total = 0
  let found = false
  for (const [, amount, unit] of text.matchAll(
    /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi,
  )) {
    total += Number(amount) * UNIT_MS[unit[0].toLowerCase()]
    found = true
  }
  return found ? total : null
}

/**
 * When the stop's text says it lifts, as epoch milliseconds, counting a duration from
 * `atMs` (when the stop happened); null when it says nothing that reads without a guess.
 */
export function refusalLiftsAt(text, atMs) {
  if (typeof text !== 'string') return null
  const absolute =
    /\b(?:resets?|retry|try again|available again)\s+(?:at|on|after)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text)
  if (absolute) {
    const ms = Date.parse(absolute[1])
    if (Number.isFinite(ms)) return ms
  }
  const relative =
    /\b(?:resets?|retry|try again|available again)\s+(?:in|after)\s+~?\s*((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text)
  if (relative) {
    const ms = durationMs(relative[1])
    if (ms !== null) return atMs + ms
  }
  const header = /\bretry-after\s*[:=]?\s*(\d+(?:\.\d+)?)\b/i.exec(text)
  if (header) return atMs + Number(header[1]) * 1_000
  return null
}

/**
 * The transcript's last turn end, or null when its tail holds none. `key` identifies
 * this turn end (the file, where the line sits and what it says), `final` is whether
 * nothing has been written below it, and `atMs` is the file's modification time.
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

/**
 * What a turn end means for the report, at `nowMs`: `{ refusedUntilMs }` for a usage
 * stop (see the header for every condition), `{ succeeded: true }` for a turn that
 * ran, null for anything else.
 */
export function turnEndOutcome(turnEnd, nowMs) {
  if (!turnEnd) return null
  if (turnEnd.status === 'success') return { succeeded: true }
  if (turnEnd.status !== 'error' || !turnEnd.final || !isUsageRefusalText(turnEnd.error)) return null
  const at = Math.min(turnEnd.atMs, nowMs)
  const stated = refusalLiftsAt(turnEnd.error, at)
  // A stated time is sent as stated. Only one past what a date can hold (a garbled
  // number) is no time at all.
  const readable = stated !== null && Number.isFinite(new Date(stated).getTime())
  return { refusedUntilMs: readable ? stated : at + USAGE_REFUSAL_COOL_OFF_MS }
}

export function usageRefusalPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.usage-refusal.json`)
}

/**
 * The record: `seen` is the last turn end recorded; `until` is the standing refusal (an
 * ISO time), null while a clear has not reached DevSpec, and absent when there is
 * nothing to say.
 */
function readRecord(connectionId, dir) {
  const value = readPrivateJson(usageRefusalPath(connectionId, dir))
  if (!value || value.v !== 1) return { v: 1, seen: null }
  const record = { v: 1, seen: typeof value.seen === 'string' ? value.seen : null }
  if (value.until === null) record.until = null
  else if (typeof value.until === 'string' && Number.isFinite(Date.parse(value.until))) record.until = value.until
  return record
}

function writeRecord(connectionId, dir, record) {
  try {
    writePrivateJson(usageRefusalPath(connectionId, dir), record)
  } catch {
    /* the report is best effort: an unrecorded stop is simply not reported */
  }
}

/**
 * Record what the transcript's last turn end means, once per turn end. A usage stop
 * whose time is ahead stands; a turn that ran clears a refusal that still stands; any
 * other end leaves the record as it was. `memo` (any object the caller keeps) skips
 * re-reading a transcript that has not changed since the last call.
 */
export function observeTurnEnd(connectionId, transcriptPath, { dir = CONNECTIONS_DIR, nowMs = Date.now(), memo = null } = {}) {
  if (!connectionId || !transcriptPath) return
  if (memo) {
    let stamp
    try {
      const { size, mtimeMs } = fs.statSync(transcriptPath)
      stamp = `${transcriptPath}:${size}:${mtimeMs}`
    } catch {
      return
    }
    if (memo.stamp === stamp) return
    memo.stamp = stamp
  }
  const turnEnd = lastTurnEnd(transcriptPath)
  if (!turnEnd) return
  const record = readRecord(connectionId, dir)
  if (record.seen === turnEnd.key) return
  const outcome = turnEndOutcome(turnEnd, nowMs)
  const next = { v: 1, seen: turnEnd.key }
  if (outcome?.refusedUntilMs > nowMs) {
    next.until = new Date(outcome.refusedUntilMs).toISOString()
  } else if (outcome?.succeeded) {
    if (record.until === null || (record.until && Date.parse(record.until) > nowMs)) next.until = null
  } else if ('until' in record) {
    next.until = record.until
  }
  writeRecord(connectionId, dir, next)
}

/**
 * What a status update carries: `{ usage_refused_until: <time> }` while a refusal
 * stands, `{ usage_refused_until: null }` while a clear has not reached DevSpec, and
 * nothing otherwise, which leaves DevSpec's record as it is.
 */
export function usageRefusalArgument(connectionId, { dir = CONNECTIONS_DIR, nowMs = Date.now() } = {}) {
  if (!connectionId) return {}
  const record = readRecord(connectionId, dir)
  if (record.until === null) return { usage_refused_until: null }
  if (record.until && Date.parse(record.until) > nowMs) return { usage_refused_until: record.until }
  return {}
}

/** After a status update DevSpec accepted: a clear it carried is done with. */
export function noteUsageRefusalSent(connectionId, args, { dir = CONNECTIONS_DIR } = {}) {
  if (!connectionId || !args || args.usage_refused_until !== null) return
  const record = readRecord(connectionId, dir)
  if (record.until !== null) return
  writeRecord(connectionId, dir, { v: 1, seen: record.seen })
}

/** The transcript a hook's stdin points to, or null. */
export function hookTranscriptPath(raw) {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
    return typeof data?.transcript_path === 'string' && data.transcript_path ? data.transcript_path : null
  } catch {
    return null
  }
}
