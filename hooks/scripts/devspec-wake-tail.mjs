#!/usr/bin/env node
/**
 * The wake file's two readers, for Cursor Connect. The host follow
 * (devspec-remote-wait.mjs `--follow`) writes the wake file; this file only reads it.
 * Neither consumes the inbox. Do not pass --from-end.
 *
 * Maintainer notes: what Cursor does with a background command's notifications, as
 * measured live on Cursor CLI 2026.11.19-f005e9d, 21 November 2026 (DevSpec task
 * 7cbe5c32, a throwaway profile with no plugin, and then this tail and its reader):
 *
 * - A notification carries a title (the agent's `reason`), the pattern, a count and the
 *   matched text, and the path of the command's output file, never the line that was
 *   printed. With this tail's pattern the matched text is one word, such as
 *   `owner_message`.
 * - Batching. The first match notifies at once. Every later match waits: Cursor opens a
 *   5-second window at the first match after a notification and sends one notification
 *   for every match in it, saying how many there were and showing only the latest, for
 *   example "matched 3 more times since the previous notification ... Latest match:
 *   check_job" for two room commands and a check job 0.3 s apart. A lone match after the
 *   first also arrives 5 s late. The agent's `debounce_ms` can only lengthen the window
 *   (the Shell tool says the harness enforces at least 5,000 ms). Notifications that
 *   arrive while the agent is working wait until it is idle. So the agent never learns
 *   from a notification which wakes, or how many, arrived: on any notification from the
 *   tail it runs the reader, which prints everything unread (checked live: one read
 *   after that batched notification printed all three wakes whole).
 * - The limit. Cursor stops notifying after a fixed number of matches per command
 *   (`CURSOR_NOTIFY_MATCH_LIMIT`, devspec-wake-file.mjs: 1,000, set by Cursor's server),
 *   with a last notification telling the agent to read the output file itself. The
 *   command's exit is notified separately, even past the limit (titled with the Shell
 *   call's description, or the command when it has none; no detail). So a tail left
 *   running for a long session would go silent after about a thousand wakes, with
 *   nothing anywhere saying so; this tail hands over to a new one before then (3, below).
 * - Cursor holds what any one Shell output shows to 20,000 UTF-16 code units, keeping
 *   the first and last 10,000 (`CURSOR_SHELL_OUTPUT_MAX_CHARS`, hook-context-budget.mjs).
 *   So an agent that read the output file, or the wake file, itself could lose the
 *   middle of a command, or read again wakes it had already acted on: two prints that
 *   each fit can add up to a file that does not (DevSpec's final check on task 0dec37d4).
 *
 * 1. The background tail (the listener): `devspec-wake-tail.mjs --file <wake file>`. A
 *    process the host's Remote workflow runs as a notify-only background Shell
 *    (`listenerCommand`, with `REMOTE_WAKE_NOTIFY_PATTERN` and `LISTENER_REASON`). It
 *    never prints a wake. For each new whole wake its filter matches, it prints one
 *    short line (`notifyLine`): it matches the filter for the same wake types the wake
 *    itself does, and names the reader to run, so the output file holds nothing that
 *    could be cut. A wake for a connection that has ended (step-delivery.mjs
 *    `withoutEndedConnectionWakes`), or one the reader has already printed, raises no
 *    line.
 * 2. The reader: `devspec-wake-tail.mjs read --file <wake file>`, what the agent runs
 *    when a notification arrives. It prints exactly the wakes it has not read, oldest
 *    first, each whole, under one header line saying how many it printed and how many
 *    remain (`readerPage`). Its output always fits one Shell output (`fitsShellOutput`):
 *    as many whole wakes as fit it together (`wakesForOneOutput`), the rest left for
 *    the next call; a wake too long to go out whole beside the header goes whole into
 *    a note instead, with one short line pointing at it (`wakeInNote`), so nothing is
 *    ever cut. It keeps its own read position per connection, and moves it past what
 *    it printed only once the write to stdout has completed: a failed or partial print
 *    marks nothing read. It holds the connection's steps lock (step-delivery.mjs) from
 *    reading its position until that position is written, so two reads never both
 *    print, or both skip, the same wake, and no connection end comes between its check
 *    for one and its print.
 * 3. The hand-over. Only the agent can start a command Cursor notifies it about, so the
 *    tail asks the agent for its successor through the reader. Each tail keeps a lease
 *    per connection (`listenerLeasePath`): its process, the matches it has printed, and
 *    how far into the wake file it has announced. It counts every match of the pattern it
 *    prints, as Cursor does. From `LISTENER_RELIEF_AT` matches on, every read's header
 *    names the command to start a new tail (`listenerAdvice`, `replace`); at
 *    `LISTENER_MATCH_BUDGET`, one short of Cursor's limit, the tail stops before the
 *    line that would pass it and exits, and Cursor's exit notification sends the agent
 *    to the reader, whose header says the listener has stopped and how to start it.
 *    A new tail takes the lease under the steps lock and starts after everything the
 *    old one announced (it stayed under the limit, so Cursor notified all of it), or,
 *    from an old tail that was not handing over, after what the reader has printed. The
 *    old tail announces only under the same lock, after checking the lease is still its
 *    own, and stops at its next look once it is not. So one tail announces at a time,
 *    each wake is announced once across the switch, and one that arrives while no tail
 *    runs is announced by the next (or printed by a read first, and then not
 *    announced at all). The reader prints each wake once whatever the tails do. One
 *    case is announced twice on purpose: a new tail that starts after wakes an old one
 *    announced but the reader has not printed yet (the agent started it mid-backlog,
 *    or the session those notifications went to has gone) prints one line for the
 *    earliest of them (`again`), so the agent is sent to the reader at least once more
 *    and no unread wake is left with no notification in the current session.
 *    Checked live the same day: a tail given 1,000 room commands at once printed 999
 *    lines and exited, with no limit notification; the agent, sent to the reader by
 *    the first notification, started the next tail from the header's `listener`, and
 *    the two commands that came after reached it through the new one.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pidAlive } from './close-on-end.mjs'
import {
  CURSOR_NOTIFY_MATCH_LIMIT,
  ensureWakeFile,
  REMOTE_WAKE_NOTIFY_PATTERN,
  splitWakes,
  wakeFileConnectionId,
  wakeLines,
} from './devspec-wake-file.mjs'
import {
  clearPendingUnsavedRefusals,
  CURSOR_SHELL_OUTPUT_MAX_CHARS,
  fitShellDiagnostic,
  fitsShellOutput,
  formatDiagnosticStorePreflightError,
  hasPendingUnsavedRefusals,
  hasWritableDiagnosticNoteStore,
  peekPendingUnsavedRefusals,
  reserveDiagnosticNoteSlots,
  shellDiagnosticReserve,
  spoolUnsavedRefusal,
  wakeInNote,
  wakesForOneOutput,
} from './hook-context-budget.mjs'
import { isDirectRun } from './is-direct-run.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import {
  cleanupCompletedWakeNotesBefore,
  clearWakeInlineHold,
  connectionsDirFor,
  isWakeNoteCompleted,
  registerPendingWakeNote,
  setWakeInlineHold,
  withoutEndedConnectionWakes,
  withStepsLock,
  withStepsLockAsync,
} from './step-delivery.mjs'
import {
  clearWakeListenerNeeded,
  extractRoomCommandsFromWake,
  formatShellRefusalOmissionNotice,
  formatStructuredRefusalsFallback,
  markWakeListenerNeeded,
  readStartedCommandIds,
  startRoomCommands,
  structuredRefusalFromError,
} from './command-start.mjs'

/**
 * How often the tail looks for new wakes, and how long the reader waits to see whether
 * lines with no closing empty line are still being written (`unreadWakes`).
 */
const POLL_MS = 250

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const POSITION_VERSION = 1
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/
const NOTIFY_WORDS = REMOTE_WAKE_NOTIFY_PATTERN.split('|')

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * Whose read position and lock a wake file has: its connection (`connectionId`, else
 * the connection the file is named after), or, for a file named otherwise, a key of its
 * own.
 */
function readerKey(file, connectionId = null) {
  const id = (SAFE_ID.test(connectionId ?? '') ? connectionId : null) ?? wakeFileConnectionId(file)
  return id ?? `wake-${createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16)}`
}

/** Where the reader keeps how far it has printed `key`'s wake file. Not `.json`: nothing that lists connection states may take it for one. */
export function readPositionPath(key, dir) {
  return path.join(dir, `${key}.wake-position`)
}

/** The byte offset the reader has printed `file` up to, or 0 when it has printed none of this file. */
function readPosition(file, key, dir) {
  const kept = readPrivateJson(readPositionPath(key, dir))
  if (kept?.version !== POSITION_VERSION || kept.file !== path.resolve(file)) return 0
  return Number.isSafeInteger(kept.offset) && kept.offset >= 0 ? kept.offset : 0
}

/** `node <script> [read] --file <file>`, naming the connection only when the file's own name does not say it. */
function scriptCommand(mode, file, { scriptPath = SCRIPT_PATH, connectionId = null } = {}) {
  const named = wakeFileConnectionId(file)
  const extra = SAFE_ID.test(connectionId ?? '') && connectionId !== named ? ` --connection-id ${connectionId}` : ''
  return `node ${shellQuote(scriptPath)}${mode ? ` ${mode}` : ''} --file ${shellQuote(path.resolve(file))}${extra}`
}

/**
 * The one command that reads `file`'s unread wakes. The script is named by the path the
 * tail was started with (on Windows, a space-free ProgramData junction), quoted all the
 * same; the connection is named only when the file's own name does not say it.
 */
export function readerCommand(file, options = {}) {
  return scriptCommand('read', file, options)
}

/** The command that starts a tail (the listener) on `file`, named the same way. */
export function listenerCommand(file, options = {}) {
  return scriptCommand('', file, options)
}

// ---------------------------------------------------------------------------
// The listener's lease and hand-over
// ---------------------------------------------------------------------------

/**
 * The most matches of the notify pattern one tail prints: one short of Cursor's limit,
 * so Cursor's own last notification, which tells the agent to read the output file
 * itself, never comes. The tail stops before the line that would pass it.
 */
export const LISTENER_MATCH_BUDGET = CURSOR_NOTIFY_MATCH_LIMIT - 1

/**
 * From this many matches on, every read asks the agent to start a new tail, while this
 * one keeps announcing: an agent that misses one request has as many matches again
 * before this tail stops.
 */
export const LISTENER_RELIEF_AT = Math.floor(LISTENER_MATCH_BUDGET / 2)

/** The `reason` the listener's notify_on_output carries; Cursor shows it as each notification's title. */
export const LISTENER_REASON = 'DevSpec wakes'

const LEASE_VERSION = 1

/** Matches of the notify pattern in `text`, counted as Cursor counts them: every one, not every line. */
export function notifyMatches(text) {
  return (String(text ?? '').match(new RegExp(REMOTE_WAKE_NOTIFY_PATTERN, 'g')) ?? []).length
}

/** Where the tail running on `key`'s wake file keeps its lease. Not `.json`: nothing that lists connection states may take it for one. */
export function listenerLeasePath(key, dir) {
  return path.join(dir, `${key}.wake-listener`)
}

/**
 * The lease on `file`, or null when there is none, it is for another file, or it cannot
 * be read just now (written by rename, so never half-written). Read without the lock:
 * the tail checks it on every look.
 */
export function readListenerLease(file, key, dir) {
  let lease = null
  try {
    lease = JSON.parse(fs.readFileSync(listenerLeasePath(key, dir), 'utf8'))
  } catch {
    return null
  }
  if (lease?.version !== LEASE_VERSION || lease.file !== path.resolve(file) || !Number.isSafeInteger(lease.pid)) return null
  return lease
}

function writeListenerLease(key, dir, lease) {
  writePrivateJson(listenerLeasePath(key, dir), { version: LEASE_VERSION, ...lease, at: new Date().toISOString() })
}

/**
 * Where a tail starting on a file of `size` bytes begins (announcing what comes after),
 * given the lease it finds
 * (`lease`, or null) and the reader's position (`read`). After everything an earlier
 * tail announced when that tail was handing over (`relief`) or had stopped at its
 * budget (`retired`): it stayed under Cursor's limit, so Cursor notified all of it, and
 * none of it is announced twice. Otherwise after what the reader has printed: an
 * earlier tail that was not handing over may have been past what Cursor still notified
 * (a limit lower than measured), or the agent started a second one, and a wake
 * announced twice only sends the agent to a read that prints nothing new.
 */
export function startOffset(lease, read, size) {
  let at = read
  if ((lease?.state === 'relief' || lease?.state === 'retired') && Number.isSafeInteger(lease.announced_through)) {
    at = Math.max(at, lease.announced_through)
  }
  return at > size ? 0 : at
}

/** What the reader says when the listener has stopped. */
export const LISTENER_STOPPED_NOTE =
  'The background command that tells you when DevSpec wakes arrive has stopped, so nothing tells you about the next one. ' +
  'Start `start` now as a background Shell (block_until_ms 0) with exactly this notify_on_output, before you act on anything here.'

/** What the reader says when the listener is nearing Cursor's limit. */
export const LISTENER_REPLACE_NOTE =
  'The background command that tells you when DevSpec wakes arrive is nearing the number of notifications Cursor allows one command. ' +
  'Start `start` now as a background Shell (block_until_ms 0) with exactly this notify_on_output: it takes over, and the old one stops by itself.'

/**
 * What the reader tells the agent about the tail on `file`, from its lease, or null when
 * nothing needs doing: `stopped` when that tail has stopped (at its budget, or its
 * process is gone), `replace` once a running one has reached `LISTENER_RELIEF_AT`. No
 * lease says nothing: no tail of this version has run on the file.
 */
export function listenerAdvice(lease, file, { scriptPath = SCRIPT_PATH, connectionId = null, isAlive = pidAlive } = {}) {
  if (!lease) return null
  const stopped = lease.state === 'retired' || !isAlive(lease.pid)
  if (!stopped && lease.state !== 'relief') return null
  return {
    status: stopped ? 'stopped' : 'replace',
    start: listenerCommand(file, { scriptPath, connectionId }),
    notify_on_output: { pattern: REMOTE_WAKE_NOTIFY_PATTERN, reason: LISTENER_REASON },
    note: stopped ? LISTENER_STOPPED_NOTE : LISTENER_REPLACE_NOTE,
  }
}

// ---------------------------------------------------------------------------
// The background tail
// ---------------------------------------------------------------------------

/** What the tail's line says, beside the reader it names. */
export const NOTIFY_NOTE =
  'A DevSpec wake is waiting for you. Run read_with now: it prints every wake you have not read, each whole. Never read this output or the wake file yourself.'

/**
 * The tail's one line for `wake` (one whole wake as the wake file holds it), or null
 * when the host's wake filter does not match the wake, exactly as it decided for the
 * wake's own lines before. `carries` names what woke it: the wake's event types, and
 * any its events say they carry or hold (`wake_in_note`, `held_for_step`), that the
 * filter names; failing those, whatever in the wake the filter matched. So the line
 * matches the filter for the same wake types, and only for them. `read_with` is the
 * reader (`readerCommand`).
 */
export function notifyLine(wake, readWith) {
  if (!new RegExp(REMOTE_WAKE_NOTIFY_PATTERN).test(wake)) return null
  const named = new Set()
  for (const line of wake.split('\n')) {
    let event = null
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const words = [event?.type, ...(Array.isArray(event?.carries) ? event.carries : []), ...(Array.isArray(event?.holds) ? event.holds : [])]
    for (const word of words) if (NOTIFY_WORDS.includes(word)) named.add(word)
  }
  if (named.size === 0) for (const match of wake.matchAll(new RegExp(REMOTE_WAKE_NOTIFY_PATTERN, 'g'))) named.add(match[0])
  return `${JSON.stringify({ type: 'unread_wake', carries: [...named], read_with: readWith, note: NOTIFY_NOTE })}\n`
}

/**
 * What one look of the tail prints for `text`, the wake-file text from byte `from` that
 * it has not looked at yet: one `notifyLine` per whole wake, none for a wake that ends at
 * or before `readThrough` (the reader has printed it already) or that is for a connection
 * that has ended. `read` is how many bytes of whole wakes it looked at; a wake still
 * being written waits for the next look. `wakes` has each whole wake's line (or null)
 * and the byte, counted from `from`, it ends at, so the tail can stop between two.
 */
export function notifyLines(text, { settled = false, readWith, from = 0, readThrough = 0, dir = connectionsDirFor(), write } = {}) {
  const split = splitWakes(text, { settled })
  const lines = []
  const wakes = []
  let read = 0
  for (const wake of split.wakes) {
    read += Buffer.byteLength(wake)
    let line = null
    if (from + read > readThrough && withoutEndedConnectionWakes(wake, { dir, ...(write ? { write } : {}) })) line = notifyLine(wake, readWith)
    if (line) lines.push(line)
    wakes.push({ line, end: read })
  }
  return { text: lines.join(''), read, wakes }
}

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

function readRange(file, from, to) {
  if (to <= from) return ''
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const got = fs.readSync(fd, buf, 0, buf.length, from)
    return buf.subarray(0, got).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The background tail (the listener), until a newer one takes its lease or it reaches
 * its budget (`LISTENER_MATCH_BUDGET`); then it stops looking and exits. Everything it
 * prints, on stdout and stderr, is counted against the budget as Cursor counts it.
 */
function tail({ file, connectionId, scriptPath }) {
  ensureWakeFile(file)
  const resolved = path.resolve(file)
  const dir = connectionsDirFor()
  const key = readerKey(file, connectionId)
  const readWith = readerCommand(file, { scriptPath, connectionId })
  const pid = process.pid
  let matches = 0
  let offset = 0
  let lastSize = -1
  let timer = null
  const say = (text) => {
    matches += notifyMatches(text)
    process.stderr.write(`devspec-wake-tail: ${text}\n`)
  }
  const lease = (state) => writeListenerLease(key, dir, { file: resolved, pid, state, matches, announced_through: offset })
  const replacedBy = (held) => (held && held.pid !== pid ? held.pid : null)
  const stop = (why) => {
    if (timer) clearInterval(timer)
    timer = null
    say(why)
    process.exitCode = 0
  }

  withStepsLock(key, dir, () => {
    const before = readListenerLease(file, key, dir)
    const read = readPosition(file, key, dir)
    // Wakes the reader has printed, or an earlier tail announced while handing over, need no notification.
    offset = startOffset(before, read, fileSize(file))
    say(`watching ${file}`)
    if (before && before.pid !== pid && before.state !== 'retired' && pidAlive(before.pid)) {
      say(`taking over from the listener in process ${before.pid}, which stops at its next look`)
    }
    // Announced by the earlier tail but not printed by the reader yet: one line for the earliest, so the agent reads them.
    if (offset > read) {
      const backlog = notifyLines(readRange(file, read, offset), { settled: true, readWith, from: read, readThrough: read, dir, write: () => {} })
      const first = backlog.wakes.find((wake) => wake.line)
      if (first) {
        const line = `${JSON.stringify({ ...JSON.parse(first.line), again: true })}\n`
        process.stdout.write(line)
        matches += notifyMatches(line)
      }
    }
    lease('listening')
    clearWakeListenerNeeded(key, dir)
  })

  /** One look's announcements, holding the steps lock: what to stop for, or null to carry on. */
  const announce = (size, settled) => {
    const holder = replacedBy(readListenerLease(file, key, dir))
    if (holder) return `the listener in process ${holder} has taken over; stopping`
    const out = notifyLines(readRange(file, offset, size), {
      settled,
      readWith,
      from: offset,
      readThrough: readPosition(file, key, dir),
      dir,
    })
    let text = ''
    let through = offset
    let full = false
    for (const wake of out.wakes) {
      if (wake.line) {
        const count = notifyMatches(wake.line)
        if (matches + count > LISTENER_MATCH_BUDGET) {
          full = true
          break
        }
        text += wake.line
        matches += count
      }
      through = offset + wake.end
    }
    if (text) process.stdout.write(text)
    offset = through
    lease(full ? 'retired' : matches >= LISTENER_RELIEF_AT ? 'relief' : 'listening')
    if (full) markWakeListenerNeeded(key, dir)
    return full
      ? `printed ${matches} notify matches; the next would reach Cursor's limit of ${CURSOR_NOTIFY_MATCH_LIMIT}, so stopping here. The wake reader tells the agent to start a new listener, which announces the rest.`
      : null
  }

  const poll = () => {
    const holder = replacedBy(readListenerLease(file, key, dir))
    if (holder) return stop(`the listener in process ${holder} has taken over; stopping`)
    const size = fileSize(file)
    if (size < offset) offset = 0
    // The file has stopped growing since the last poll: lines a wait older than the
    // wake boundary wrote are whole by now.
    const settled = size === lastSize
    lastSize = size
    if (size <= offset) return
    const why = withStepsLock(key, dir, () => announce(size, settled))
    if (why) stop(why)
  }

  timer = setInterval(poll, POLL_MS)
  poll()
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** What the reader's header says when there is nothing to print. */
export const NOTHING_UNREAD = 'Nothing unread.'

/**
 * The first line of every read: how many wakes it printed and how many remain for the
 * next call. Kept this short on purpose, and with no command in it: it shares the one
 * output with the wakes, and every character it takes is one a command near Cursor's
 * limit could not have inline. The agent already has the command (it just ran it, and
 * the tail's line names it); while `remaining` is above 0, it runs it again. Only when
 * the background tail must be started again does it carry that command, as `listener`
 * (`listenerAdvice`).
 */
export function readerHeader(returned, remaining, note = null, listener = null) {
  return `${JSON.stringify({ devspec_wakes: { returned, remaining }, ...(note ? { note } : {}), ...(listener ? { listener } : {}) })}\n`
}

/** What the header says when the next wake needs a note to go out whole, and the note cannot be written just now. */
function heldNote(error) {
  const why = error instanceof Error ? error.message : String(error)
  return `The next wake is too long for one output, and the note that would hand it to you whole could not be saved just now (${why}). Run this command again in a moment.`
}

/** A wake's lines as events, for keeping it whole in a note; a line that is not JSON is kept as it is. */
function eventsOf(wake) {
  return wake
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { type: 'unparsed_line', line }
      }
    })
}

/**
 * One read of `wakes` (the whole wakes the reader has not printed, oldest first, each
 * as the wake file holds it): `text` to print, how many it holds (`printed`) and leaves
 * (`remaining`), and how many of `wakes` it reads through (`through`): the printed ones
 * and any skipped among and right after them. A wake `skip` says (one for a connection
 * that has ended), or an empty line between wakes, is read through but never printed
 * or counted.
 *
 * `text` always fits one Shell output (`fitsShellOutput`). The header is measured at its
 * longest, both counts at the total; a wake that does not fit beside it on its own goes
 * whole into a note (`wakeInNote`), and in its place a single short line points at it;
 * then as many whole wakes as fit together after the header go out
 * (`wakesForOneOutput`, the sizing the one-shot wait uses too), the rest are left for
 * the next read, and the header says how many. A wake that needs a note the reader
 * cannot write just now stops the read before it: the wakes before it go out, and when
 * it is the first, the header alone says so, so it is tried again on the next read.
 */
export function readerPage(wakes, { home = os.homedir(), skip = () => false, listener = null, reserve = '' } = {}) {
  const kept = []
  for (let i = 0; i < wakes.length; i += 1) if (wakes[i].trim() && !skip(wakes[i])) kept.push(i)
  const total = kept.length
  if (total === 0) return { text: readerHeader(0, 0, NOTHING_UNREAD, listener), printed: 0, remaining: 0, through: wakes.length }
  const longest = readerHeader(total, total, null, listener)
  const reservedHeader = longest + reserve
  const fitted = []
  let held = null
  for (const i of kept) {
    let wake = wakes[i]
    if (!fitsShellOutput(reservedHeader + wake)) {
      const out = wakeInNote(eventsOf(wake), { home })
      if (out.error) {
        held = out.error
        break
      }
      wake = wakeLines(out.events)
    }
    fitted.push(wake)
    // Nothing after this one can go out with it: no note is written for a wake that waits.
    if (!fitsShellOutput(reservedHeader + fitted.join(''))) break
  }
  const printed = wakesForOneOutput([reservedHeader, ...fitted]).count - 1
  const remaining = total - printed
  const through = printed < total ? kept[printed] : wakes.length
  const printedWakes = fitted.slice(0, printed).map((text, idx) => ({ text, sourceIndex: kept[idx] }))
  if (printed === 0 && held) {
    return { text: readerHeader(0, remaining, heldNote(held), listener), printed, remaining, through, printedWakes: [] }
  }
  return {
    text: readerHeader(printed, remaining, null, listener) + fitted.slice(0, printed).join(''),
    printed,
    remaining,
    through,
    printedWakes,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The whole wakes in `file` after byte `offset`, oldest first, each with the byte offset
 * it ends at. Lines with no closing empty line (from a wait older than the wake
 * boundary) count as one whole wake once the file is seen not to grow for `settleMs`,
 * as the tail decides it; until then they may be a wake still being written.
 */
async function unreadWakes(file, offset, { settleMs = POLL_MS } = {}) {
  const size = fileSize(file)
  const start = size < offset ? 0 : offset
  const text = readRange(file, start, size)
  const split = splitWakes(text)
  let wakes = split.wakes
  if (split.rest.endsWith('\n')) {
    await sleep(settleMs)
    if (fileSize(file) === size) wakes = splitWakes(text, { settled: true }).wakes
  }
  let at = start
  return {
    start,
    wakes: wakes.map((wake) => {
      at += Buffer.byteLength(wake)
      return { text: wake, end: at }
    }),
  }
}

/** Write `text` to stdout and resolve once the write has completed; reject when it fails (a closed pipe, for one). */
function writeStdout(text) {
  return new Promise((resolve, reject) => {
    process.stdout.on('error', reject)
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * One read: print the wakes of `file` not read yet (`readerPage`) with `write`, and
 * only once `write` has completed, mark them read. A `write` that throws or rejects
 * marks nothing; the error is thrown on. Returns the page, and `marked`: whether the
 * new read position was written (false only when that write failed, so the same wakes
 * print again next time; never fewer). When the background tail must be started again
 * (`listenerAdvice`, read from its lease under the same lock), the header says so and
 * names it by `scriptPath`, the copy this reader runs from.
 */
export function writeStderrChecked(text, stream = process.stderr) {
  return new Promise((resolve, reject) => {
    let settled = false
    const onError = (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    }
    const detachLater = () => {
      // Node.js Writable may emit 'error' on a later process.nextTick turn after
      // invoking the write callback (via errorOrDestroy); keep `onError` attached
      // until the setImmediate check phase so the emitted stream error is absorbed
      // instead of crashing the process before callers can handle the rejection
      // (reqs 3ea2b201 / 4e32d1a5 / 91d7b47c / 3c5147a7).
      const timer = setImmediate(() => stream.removeListener('error', onError))
      timer.unref?.()
    }
    stream.on('error', onError)
    try {
      stream.write(text, (error) => {
        if (error) {
          detachLater()
          if (!settled) {
            settled = true
            reject(error)
          }
          return
        }
        stream.removeListener('error', onError)
        if (!settled) {
          settled = true
          resolve()
        }
      })
    } catch (error) {
      detachLater()
      if (!settled) {
        settled = true
        reject(error)
      }
    }
  })
}

export async function readWakes({
  file,
  connectionId = null,
  home = os.homedir(),
  dir = connectionsDirFor(home),
  write = writeStdout,
  writeStderr = writeStderrChecked,
  settleMs = POLL_MS,
  scriptPath = SCRIPT_PATH,
  isAlive = pidAlive,
  startCommands = startRoomCommands,
} = {}) {
  const resolved = path.resolve(String(file ?? ''))
  const key = readerKey(resolved, connectionId)
  const resolvedConnectionId = (SAFE_ID.test(connectionId ?? '') ? connectionId : null) ?? wakeFileConnectionId(resolved)
  return withStepsLockAsync(key, dir, async () => {
    const position = readPosition(resolved, key, dir)
    const { start, wakes } = await unreadWakes(resolved, position, { settleMs })
    const listener = listenerAdvice(readListenerLease(resolved, key, dir), resolved, { scriptPath, connectionId, isAlive })
    const fallbackNoteDir = dir ? path.join(dir, 'diagnostic-notes') : null
    const pickupDiagnosticReserve = shellDiagnosticReserve('devspec-wake-tail', {
      home,
      fallbackDir: fallbackNoteDir,
    })
    const hasRoomCommands =
      Boolean(resolvedConnectionId) &&
      wakes.some((wake) => {
        const ex = extractRoomCommandsFromWake(wake.text, { home })
        return ex.commands.length > 0 || ex.unreadableNotes.length > 0
      })
    const spoolKey = dir ? path.resolve(dir) : path.resolve(home)
    const spoolOpts = { home, fallbackDir: fallbackNoteDir, backupDir: dir }
    const pendingSpoolEntries = peekPendingUnsavedRefusals(spoolKey, spoolOpts)
    const hasSpool = pendingSpoolEntries.length > 0
    const page = readerPage(
      wakes.map((wake) => wake.text),
      {
        home,
        listener,
        reserve: hasRoomCommands || hasSpool ? pickupDiagnosticReserve : '',
        skip: (wake) => withoutEndedConnectionWakes(wake, { dir, write: () => {} }) === '',
      },
    )
    let pickupRefusals = null
    let pickupNothingOpen = null
    let pickupDiagnosticNote = null
    let pickupDiagnosticWritten = false
    const pendingNoteReads = []
    const through = page.through > 0 ? wakes[page.through - 1].end : start
    let earliestDeferredStart = null
    let deferredEntries = []
    let inlineCommands = []
    let inlineCommandSpans = []
    let inlineMessages = []
    let noteRefusals = []
    let extractedSessionId = null
    if (resolvedConnectionId && page.printed > 0) {
      // Inspect each printed wake individually so every `wake_in_note` command AND every
      // inline room command records its OWN exact `[wakeStart, wakeEnd]` byte span instead
      // of the whole page's end offset: reading one note out of order or picking up only
      // the newest command on a multi-command page can never advance the cursor past an
      // unstarted or unread command (requirement 3ea2b201).
      const printedItems = Array.isArray(page.printedWakes)
        ? page.printedWakes
        : [{ text: page.text, sourceIndex: Math.max(0, page.through - 1) }]
      for (const item of printedItems) {
        const wakeStart = item.sourceIndex === 0 ? start : wakes[item.sourceIndex - 1].end
        const wakeEnd = wakes[item.sourceIndex]?.end ?? through
        const extracted = extractRoomCommandsFromWake(item.text, { home })
        if (!extractedSessionId && extracted.sessionId) extractedSessionId = extracted.sessionId
        inlineCommands.push(...extracted.inlineCommands)
        for (const cmd of extracted.inlineCommands) {
          inlineCommandSpans.push({ messageId: cmd.messageId, wakeStart, wakeEnd })
        }
        inlineMessages.push(...extracted.inlineMessages)
        for (const note of extracted.unreadableNotes) {
          noteRefusals.push({
            command_message_id: null,
            command_turn_id: null,
            refusal: note,
          })
        }
        for (const deferred of extracted.deferredNoteCommands) {
          if (isWakeNoteCompleted(resolvedConnectionId, deferred.noteId, { dir })) {
            continue
          }
          if (earliestDeferredStart === null || wakeStart < earliestDeferredStart) {
            earliestDeferredStart = wakeStart
          }
          deferredEntries.push({
            ...deferred,
            wakeStart,
            wakeThrough: wakeEnd,
          })
        }
      }
    }

    // If local note reads already failed before stdout (unreadable wake_in_note), refuse
    // without calling startCommands or marking anything started.
    if (noteRefusals.length > 0 && inlineCommands.length === 0) {
      pickupRefusals = noteRefusals
      const noteDiag = `devspec-wake-tail: report_pickup refused; wake position not advanced so next read retries: ${JSON.stringify(pickupRefusals)}\n`
      const fittedWithStdout = fitShellDiagnostic(page.text, noteDiag, {
        home,
        label: 'devspec-wake-tail',
        fallback: (noteError, savedNote) =>
          formatStructuredRefusalsFallback(pickupRefusals, {
            prefix: 'devspec-wake-tail: report_pickup refused (note write failed; structured refusal): ',
            stdoutText: page.text,
            noteError,
            savedNote,
            allowMinimalEnvelope: false,
          }),
        requireStructuredFallback: true,
        fallbackDir: fallbackNoteDir,
      })
      if (fittedWithStdout.text) {
        await write(page.text)
        pickupDiagnosticNote = fittedWithStdout.note
        const savedEarlyNote = Boolean(fittedWithStdout.note) || fitsShellOutput(page.text + noteDiag)
        spoolUnsavedRefusal(spoolKey, noteDiag, {
          ...spoolOpts,
          savedNote: fittedWithStdout.note,
        })
        await writeStderr(fittedWithStdout.text)
        pickupDiagnosticWritten = true
        if (savedEarlyNote) {
          clearPendingUnsavedRefusals(spoolKey, [noteDiag], spoolOpts)
        }
      } else {
        const fittedFullBudget = fitShellDiagnostic('', noteDiag, {
          home,
          label: 'devspec-wake-tail',
          fallback: (noteError, savedNote) =>
            formatStructuredRefusalsFallback(pickupRefusals, {
              prefix: 'devspec-wake-tail: report_pickup refused (note write failed; structured refusal): ',
              stdoutText: '',
              noteError,
              savedNote,
            }),
          requireStructuredFallback: true,
          fallbackDir: fallbackNoteDir,
        })
        pickupDiagnosticNote = fittedFullBudget.note
        const savedEarlyNote = Boolean(fittedFullBudget.note) || fitsShellOutput(noteDiag)
        const fallbackNotice =
          fittedFullBudget.text ||
          formatShellRefusalOmissionNotice(pickupRefusals, {
            label: 'devspec-wake-tail',
            stdoutText: '',
            actualChars: noteDiag.length,
            noteError: fittedFullBudget.noteError,
          })
        spoolUnsavedRefusal(spoolKey, noteDiag, {
          ...spoolOpts,
          savedNote: fittedFullBudget.note,
        })
        if (fallbackNotice) {
          await writeStderr(fallbackNotice)
          pickupDiagnosticWritten = true
          if (savedEarlyNote && fittedFullBudget.text) {
            clearPendingUnsavedRefusals(spoolKey, [noteDiag], spoolOpts)
          }
        }
      }
      return {
        ...page,
        marked: false,
        pickup_refusals: pickupRefusals,
        ...(pickupDiagnosticNote ? { pickup_diagnostic_note: pickupDiagnosticNote } : {}),
        pickup_diagnostic_written: pickupDiagnosticWritten,
        error: new Error(`report_pickup refused: ${JSON.stringify(pickupRefusals)}`),
      }
    }

    // Preview whether multiple unstarted inline commands sit on this page BEFORE writing
    // stdout so the header discloses queued pickup work upfront while strictly ensuring
    // `await write(pageText)` completes BEFORE calling `startCommands` (`report_pickup`,
    // started-command persistence, and `.turn` Working marker — requirement 3ea2b201).
    let pageText = page.text
    let effectiveRemaining = page.remaining
    if (resolvedConnectionId && page.printed > 0 && inlineCommands.length > 1) {
      const alreadyStarted = new Set(readStartedCommandIds(resolvedConnectionId, dir))
      const seen = new Set()
      const unstartedPreview = []
      for (const cmd of inlineCommands) {
        if (!cmd?.messageId || seen.has(cmd.messageId) || alreadyStarted.has(cmd.messageId)) continue
        seen.add(cmd.messageId)
        unstartedPreview.push(cmd)
      }
      if (unstartedPreview.length > 1) {
        const previewOlder = unstartedPreview.slice(0, -1)
        const previewOlderIds = new Set(previewOlder.map((cmd) => cmd.messageId))
        let earliestPreviewStart = null
        for (const span of inlineCommandSpans) {
          if (previewOlderIds.has(span.messageId)) {
            if (earliestPreviewStart === null || span.wakeStart < earliestPreviewStart) {
              earliestPreviewStart = span.wakeStart
            }
          }
        }
        const heldWakeCount = Math.max(
          1,
          Array.isArray(page.printedWakes)
            ? page.printedWakes.filter((item) => {
                const wStart = item.sourceIndex === 0 ? start : wakes[item.sourceIndex - 1].end
                return typeof earliestPreviewStart === 'number' && wStart >= earliestPreviewStart
              }).length
            : 1,
        )
        effectiveRemaining = page.remaining + heldWakeCount
        const nlIdx = pageText.indexOf('\n')
        if (nlIdx >= 0) {
          const body = pageText.slice(nlIdx + 1)
          const detailedNote = `${previewOlder.length} of ${inlineCommands.length} room command(s) remain queued for pickup (${previewOlder.map((cmd) => cmd.messageId).join(', ')}); run this wake reader again to pick up the rest.`
          const shortNote = `${previewOlder.length} older room command(s) remain queued for pickup; run this wake reader again.`
          const candidateDetailed = readerHeader(page.printed, effectiveRemaining, detailedNote, listener) + body
          const candidateShort = readerHeader(page.printed, effectiveRemaining, shortNote, listener) + body
          const candidateCounts = readerHeader(page.printed, effectiveRemaining, null, listener) + body
          if (fitsShellOutput(`${candidateDetailed}${pickupDiagnosticReserve}`)) pageText = candidateDetailed
          else if (fitsShellOutput(`${candidateShort}${pickupDiagnosticReserve}`)) pageText = candidateShort
          else if (fitsShellOutput(`${candidateCounts}${pickupDiagnosticReserve}`)) pageText = candidateCounts
        }
      }
    }

    // Pre-flight check: when this page carries inline room commands that will call
    // report_pickup, verify and pre-open a private diagnostic note slot BEFORE writing
    // stdout or calling report_pickup so an oversized refusal is still preserved whole on
    // disk with a Shell-bounded read command even if the last writable store loses
    // permissions or is removed during pickup (requirements 3c5147a7 / 4e32d1a5 / 91d7b47c).
    let reservedDiagnosticStore = null
    if (resolvedConnectionId && page.printed > 0 && (inlineCommands.length > 0 || noteRefusals.length > 0)) {
      const storeProbe = reserveDiagnosticNoteSlots({
        home,
        fallbackDir: fallbackNoteDir,
        backupDir: dir,
        spoolKey,
      })
      if (!storeProbe.ok) {
        const preflightErr = formatDiagnosticStorePreflightError('devspec-wake-tail', storeProbe.errors)
        if (preflightErr) await writeStderr(preflightErr)
        return {
          ...page,
          text: pageText,
          printed: 0,
          remaining: effectiveRemaining,
          marked: false,
          pickup_diagnostic_written: true,
          error: new Error(`no_writable_diagnostic_note_store: ${JSON.stringify(storeProbe.errors)}`),
        }
      }
      reservedDiagnosticStore = storeProbe
    }

    try {
    // Hand the wake over to stdout FIRST. If stdout fails (e.g. broken pipe / write error),
    // throw immediately with zero report_pickup calls, zero started-command writes, zero
    // Working marker writes, and zero wake-cursor movement (requirement 3ea2b201).
    await write(pageText)
    const printedStdout = pageText

    let rawDiag = ''
    let unstartedCommands = []
    if (resolvedConnectionId && page.printed > 0 && (inlineCommands.length > 0 || noteRefusals.length > 0)) {
      const capturedDiag = []
      let pickupResult = null
      if (inlineCommands.length > 0) {
        try {
          pickupResult = await startCommands({
            connectionId: resolvedConnectionId,
            commands: inlineCommands,
            batch: { type: 'owner_messages', session_id: extractedSessionId, messages: inlineMessages },
            sessionId: extractedSessionId,
            dir,
            home,
            fromWakeTurn: true,
            // Capture command-start stderr so ALL stderr for this Shell call passes
            // once through the shared Shell output ceiling (`fitShellDiagnostic`).
            log: (line) => capturedDiag.push(String(line ?? '')),
          })
        } catch (error) {
          pickupResult = {
            ok: false,
            outcome: 'refused',
            refusals: [structuredRefusalFromError(error)],
          }
        }
      }
      if (Array.isArray(pickupResult?.unstarted) && pickupResult.unstarted.length > 0) {
        unstartedCommands = pickupResult.unstarted
      }
      const unstartedNotice =
        unstartedCommands.length > 0
          ? `devspec-wake-tail: ${unstartedCommands.length} of ${inlineCommands.length} room command(s) remain queued for pickup (${unstartedCommands.map((cmd) => cmd?.messageId).filter(Boolean).join(', ')}); cursor held — run this wake reader again to pick up the rest.\n`
          : ''
      const combinedRefusals = [
        ...noteRefusals,
        ...(Array.isArray(pickupResult?.refusals) ? pickupResult.refusals : []),
      ]
      if (combinedRefusals.length > 0) {
        pickupRefusals = combinedRefusals
        rawDiag =
          `${capturedDiag.join('')}` +
          `devspec-wake-tail: report_pickup refused; wake position not advanced so next read retries: ${JSON.stringify(pickupRefusals)}\n` +
          unstartedNotice
      } else if (Array.isArray(pickupResult?.nothingOpen) && pickupResult.nothingOpen.length > 0) {
        pickupNothingOpen = pickupResult.nothingOpen
        rawDiag =
          `${capturedDiag.join('')}` +
          `devspec-wake-tail: report_pickup returned nothing_open: ${JSON.stringify(pickupNothingOpen)}\n` +
          unstartedNotice
      } else if (capturedDiag.length > 0 || unstartedNotice) {
        rawDiag = `${capturedDiag.join('')}${unstartedNotice}`
      }
    }

    const unstartedIds = new Set(unstartedCommands.map((cmd) => cmd?.messageId).filter(Boolean))
    let earliestUnstartedStart = null
    for (const span of inlineCommandSpans) {
      if (unstartedIds.has(span.messageId)) {
        if (earliestUnstartedStart === null || span.wakeStart < earliestUnstartedStart) {
          earliestUnstartedStart = span.wakeStart
        }
      }
    }

    const spooledPrefix =
      pendingSpoolEntries.length > 0
        ? `devspec-wake-tail: recovered previously unsaved pickup refusal(s):\n${pendingSpoolEntries.join('\n')}\n`
        : ''
    const effectiveRawDiag = spooledPrefix ? (rawDiag ? `${spooledPrefix}${rawDiag}` : spooledPrefix) : rawDiag

    let unsurfacedSpoolRemaining = false
    if (pickupRefusals && effectiveRawDiag) {
      const fittedWithStdout = fitShellDiagnostic(printedStdout, effectiveRawDiag, {
        home,
        label: 'devspec-wake-tail',
        fallback: (noteError, savedNote) =>
          formatStructuredRefusalsFallback(pickupRefusals, {
            prefix: 'devspec-wake-tail: report_pickup refused (note write failed; structured refusal): ',
            stdoutText: printedStdout,
            noteError,
            savedNote,
          }),
        requireStructuredFallback: true,
        fallbackDir: fallbackNoteDir,
        backupDir: dir,
        reservedStore: reservedDiagnosticStore,
        spoolKey,
      })
      pickupDiagnosticNote = fittedWithStdout.note
      const savedReadableNow =
        (Boolean(fittedWithStdout.note) &&
          !fittedWithStdout.note.pendingPermissionRecovery &&
          !fittedWithStdout.note.compressed &&
          !fittedWithStdout.note.enospcCompacted) ||
        fitsShellOutput(printedStdout + effectiveRawDiag)
      const diagText =
        fittedWithStdout.text ||
        formatShellRefusalOmissionNotice(pickupRefusals, {
          label: 'devspec-wake-tail',
          stdoutText: printedStdout,
          actualChars: effectiveRawDiag.length,
          noteError: fittedWithStdout.noteError,
        })
      // Write-ahead spool: persist any new live refusal BEFORE writing stderr so even a
      // fatal broken-pipe crash mid-write leaves the refusal durably queued for the next
      // pass, and clear it ONLY AFTER stderr flush completes (reqs 3ea2b201 / 4e32d1a5 /
      // 91d7b47c / 3c5147a7).
      const spooledLiveAhead = Boolean(rawDiag && !fittedWithStdout.note?.pendingPermissionRecovery)
      if (spooledLiveAhead) {
        spoolUnsavedRefusal(spoolKey, rawDiag, {
          ...spoolOpts,
          savedNote: fittedWithStdout.note,
          reservedStore: reservedDiagnosticStore,
        })
      }
      if (diagText) {
        await writeStderr(diagText)
        pickupDiagnosticWritten = true
      }
      if (savedReadableNow && fittedWithStdout.text && pickupDiagnosticWritten) {
        const toClear = spooledLiveAhead ? [...pendingSpoolEntries, rawDiag] : pendingSpoolEntries
        if (toClear.length > 0) {
          clearPendingUnsavedRefusals(spoolKey, toClear, spoolOpts)
        }
      }
    } else if (effectiveRawDiag) {
      const fitted = fitShellDiagnostic(printedStdout, effectiveRawDiag, {
        home,
        label: 'devspec-wake-tail',
        fallbackDir: fallbackNoteDir,
        backupDir: dir,
        reservedStore: reservedDiagnosticStore,
        spoolKey,
      })
      pickupDiagnosticNote = fitted.note
      const savedReadableNow =
        (Boolean(fitted.note) &&
          !fitted.note.pendingPermissionRecovery &&
          !fitted.note.compressed &&
          !fitted.note.enospcCompacted) ||
        fitsShellOutput(printedStdout + effectiveRawDiag)
      if (fitted.text) {
        await writeStderr(fitted.text)
        pickupDiagnosticWritten = true
        if (pendingSpoolEntries.length > 0 && savedReadableNow) {
          clearPendingUnsavedRefusals(spoolKey, pendingSpoolEntries, spoolOpts)
        }
      }
      if (pendingSpoolEntries.length > 0 && (!pickupDiagnosticWritten || !savedReadableNow)) {
        unsurfacedSpoolRemaining = true
      }
    }

    if (resolvedConnectionId && deferredEntries.length > 0 && !pickupRefusals) {
      for (const deferred of deferredEntries) {
        registerPendingWakeNote(
          resolvedConnectionId,
          {
            noteId: deferred.noteId,
            commands: deferred.commands,
            messages: deferred.messages,
            sessionId: deferred.sessionId,
            wakeFile: resolved,
            wakePositionPath: readPositionPath(key, dir),
            wakePositionVersion: POSITION_VERSION,
            wakeStart: deferred.wakeStart,
            wakeThrough: deferred.wakeThrough,
          },
          { dir },
        )
        pendingNoteReads.push(deferred.noteId)
      }
    }

    // Do not advance read position when report_pickup failed/refused: keep the wake queued
    // so the next read retries pickup and surfaces the structured refusal (req 3ea2b201 / 4e32d1a5).
    if (pickupRefusals || unsurfacedSpoolRemaining) {
      return {
        ...page,
        text: pageText,
        remaining: effectiveRemaining,
        marked: false,
        ...(pickupRefusals ? { pickup_refusals: pickupRefusals } : {}),
        ...(pendingNoteReads.length > 0 ? { pending_note_reads: pendingNoteReads } : {}),
        ...(pickupDiagnosticNote ? { pickup_diagnostic_note: pickupDiagnosticNote } : {}),
        pickup_diagnostic_written: pickupDiagnosticWritten,
        error: new Error(
          pickupRefusals
            ? `report_pickup refused: ${JSON.stringify(pickupRefusals)}`
            : 'pending unsaved pickup refusal could not be surfaced cleanly yet',
        ),
      }
    }
    // Never advance past either an unread deferred `wake_in_note` command OR an older
    // inline room command returned in `unstarted` because only the newest command on this
    // page received a `report_pickup` (requirement 3ea2b201). Completed wakes strictly
    // before the earliest held start may advance up to `holdAt`, leaving every unstarted
    // or unread command queued for the next read.
    const posFile = readPositionPath(key, dir)
    if (resolvedConnectionId) {
      if (typeof earliestUnstartedStart === 'number') {
        setWakeInlineHold(resolvedConnectionId, { wakePositionPath: posFile, holdOffset: earliestUnstartedStart }, { dir })
      } else {
        clearWakeInlineHold(resolvedConnectionId, { wakePositionPath: posFile }, { dir })
      }
    }
    if (pendingNoteReads.length > 0 || unstartedCommands.length > 0) {
      const holdCandidates = [earliestDeferredStart, earliestUnstartedStart].filter((n) => typeof n === 'number')
      const holdAt = holdCandidates.length > 0 ? Math.min(...holdCandidates) : null
      if (holdAt !== null && holdAt > position) {
        try {
          writePrivateJson(posFile, {
            version: POSITION_VERSION,
            file: resolved,
            offset: holdAt,
            at: new Date().toISOString(),
          })
          if (resolvedConnectionId) {
            cleanupCompletedWakeNotesBefore(resolvedConnectionId, { wakePositionPath: posFile, offset: holdAt }, { dir })
          }
        } catch {
          /* non-fatal: deferred/unstarted wakes stay queued from earlier offset */
        }
      }
      return {
        ...page,
        text: pageText,
        remaining: effectiveRemaining,
        marked: false,
        ...(pendingNoteReads.length > 0 ? { pending_note_reads: pendingNoteReads } : {}),
        ...(unstartedCommands.length > 0 ? { unstarted_commands: unstartedCommands } : {}),
        ...(pickupNothingOpen ? { pickup_nothing_open: pickupNothingOpen } : {}),
        ...(pickupDiagnosticNote ? { pickup_diagnostic_note: pickupDiagnosticNote } : {}),
        ...(pickupDiagnosticWritten ? { pickup_diagnostic_written: true } : {}),
      }
    }
    const extra = {
      ...(pickupNothingOpen ? { pickup_nothing_open: pickupNothingOpen } : {}),
      ...(pickupDiagnosticNote ? { pickup_diagnostic_note: pickupDiagnosticNote } : {}),
      ...(pickupDiagnosticWritten ? { pickup_diagnostic_written: true } : {}),
    }
    if (through === position) return { ...page, ...extra, marked: true }
    try {
      writePrivateJson(posFile, { version: POSITION_VERSION, file: resolved, offset: through, at: new Date().toISOString() })
      if (resolvedConnectionId) {
        cleanupCompletedWakeNotesBefore(resolvedConnectionId, { wakePositionPath: posFile, offset: through }, { dir })
      }
      return { ...page, ...extra, marked: true }
    } catch (error) {
      return { ...page, ...extra, marked: false, error }
    }
    } finally {
      reservedDiagnosticStore?.release()
    }
  })
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'read') out.read = true
    else if (a === '--file' || a === '--wake-file' || a === '--wake_file') out.file = argv[++i]
    else if (a === '--connection-id') out.connectionId = argv[++i]
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = args.file ? path.resolve(String(args.file)) : ''
  if (!file) {
    process.stderr.write('usage: devspec-wake-tail.mjs --file <wake file> | read --file <wake file> [--connection-id <id>]\n')
    process.exit(2)
  }
  if (!args.read) {
    // The path this process was started with, so the reader it names is the same copy.
    tail({ file, connectionId: args.connectionId ?? null, scriptPath: path.resolve(process.argv[1] ?? SCRIPT_PATH) })
    return
  }
  let page
  try {
    page = await readWakes({ file, connectionId: args.connectionId ?? null, scriptPath: path.resolve(process.argv[1] ?? SCRIPT_PATH) })
  } catch (error) {
    process.stderr.write(`devspec-wake-tail: the wakes could not be printed (${error instanceof Error ? error.message : String(error)}); none was marked read.\n`)
    process.exitCode = 1
    return
  }
  if (!page.marked) {
    // Said only when no pickup diagnostic was already emitted and it keeps output within Cursor's ceiling.
    if (!page.pickup_diagnostic_written) {
      let said = ''
      if (page.error) {
        said = `devspec-wake-tail: the wakes above could not be marked read (${page.error.message ?? 'unknown error'}); they print again next time.\n`
      } else if (Array.isArray(page.unstarted_commands) && page.unstarted_commands.length > 0) {
        said = `devspec-wake-tail: ${page.unstarted_commands.length} older room command(s) remain queued for pickup on the next read.\n`
      } else if (Array.isArray(page.pending_note_reads) && page.pending_note_reads.length > 0) {
        said = `devspec-wake-tail: ${page.pending_note_reads.length} wake note(s) remain pending read before advancing the cursor.\n`
      } else {
        said = 'devspec-wake-tail: the wakes above could not be marked read (unknown error); they print again next time.\n'
      }
      if (fitsShellOutput(page.text + said)) {
        process.stderr.write(said)
      } else {
        const fallbackSaid =
          Array.isArray(page.pickup_refusals) && page.pickup_refusals.length > 0
            ? formatShellRefusalOmissionNotice(page.pickup_refusals, {
                label: 'devspec-wake-tail',
                stdoutText: page.text,
                actualChars: said.length,
              })
            : 'devspec-wake-tail: wake read incomplete (error omitted for Shell limit); fix note permissions & re-run.\n'
        if (fallbackSaid && fitsShellOutput(page.text + fallbackSaid)) {
          process.stderr.write(fallbackSaid)
        }
      }
    }
    if (page.error || page.pickup_refusals) process.exitCode = 1
  }
}

if (isDirectRun(import.meta.url)) {
  void main().catch((e) => {
    process.stderr.write(`devspec-wake-tail: ${e.message}\n`)
    process.exit(1)
  })
}
