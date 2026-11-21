#!/usr/bin/env node
/**
 * The wake file's two readers, for Cursor Connect. The host follow
 * (devspec-remote-wait.mjs `--follow`) writes the wake file; this file only reads it.
 * Neither consumes the inbox. Do not pass --from-end.
 *
 * What Cursor does, as measured on Cursor CLI 2026.11.19: when a line a background
 * command prints matches the host's wake filter (`REMOTE_WAKE_NOTIFY_PATTERN`,
 * devspec-wake-file.mjs), Cursor raises a notification that carries only the matched
 * text, a title and the path of that command's output file, never what was printed.
 * Several matches while the agent is busy arrive as separate notifications in one
 * follow-up turn. The output file holds everything the command has printed since it
 * started, and Cursor cuts any one Shell output over 20,000 UTF-16 code units, keeping
 * the first and last 10,000 (`CURSOR_SHELL_OUTPUT_MAX_CHARS`, hook-context-budget.mjs).
 * So an agent that read the output file, or the wake file, itself could lose the middle
 * of a command, or read again wakes it had already acted on: two prints that each fit
 * can add up to a file that does not (DevSpec's final check on task 0dec37d4).
 *
 * 1. The background tail: `devspec-wake-tail.mjs --file <wake file>`. A never-exiting
 *    process the host's Remote workflow runs as a notify-only background Shell. It never
 *    prints a wake. For each new whole wake its filter matches, it prints one short line
 *    (`notifyLine`): it matches the filter for the same wake types the wake itself does,
 *    and names the reader to run, so the notification itself says what to do and the
 *    output file holds nothing that could be cut. A wake for a connection that has ended
 *    (step-delivery.mjs `withoutEndedConnectionWakes`), or one the reader has already
 *    printed, raises no line.
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
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureWakeFile, REMOTE_WAKE_NOTIFY_PATTERN, splitWakes, wakeFileConnectionId, wakeLines } from './devspec-wake-file.mjs'
import { fitsShellOutput, wakeInNote, wakesForOneOutput } from './hook-context-budget.mjs'
import { isDirectRun } from './is-direct-run.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { connectionsDirFor, withoutEndedConnectionWakes, withStepsLockAsync } from './step-delivery.mjs'

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

/**
 * The one command that reads `file`'s unread wakes. The script is named by the path the
 * tail was started with (on Windows, a space-free ProgramData junction), quoted all the
 * same; the connection is named only when the file's own name does not say it.
 */
export function readerCommand(file, { scriptPath = SCRIPT_PATH, connectionId = null } = {}) {
  const named = wakeFileConnectionId(file)
  const extra = SAFE_ID.test(connectionId ?? '') && connectionId !== named ? ` --connection-id ${connectionId}` : ''
  return `node ${shellQuote(scriptPath)} read --file ${shellQuote(path.resolve(file))}${extra}`
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
 * being written waits for the next look.
 */
export function notifyLines(text, { settled = false, readWith, from = 0, readThrough = 0, dir = connectionsDirFor(), write } = {}) {
  const { wakes } = splitWakes(text, { settled })
  const lines = []
  let read = 0
  for (const wake of wakes) {
    read += Buffer.byteLength(wake)
    if (from + read <= readThrough) continue
    if (!withoutEndedConnectionWakes(wake, { dir, ...(write ? { write } : {}) })) continue
    const line = notifyLine(wake, readWith)
    if (line) lines.push(line)
  }
  return { text: lines.join(''), read }
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

function tail({ file, connectionId, scriptPath }) {
  ensureWakeFile(file)
  const dir = connectionsDirFor()
  const key = readerKey(file, connectionId)
  const readWith = readerCommand(file, { scriptPath, connectionId })
  // Wakes the reader has printed already need no notification.
  let offset = readPosition(file, key, dir)
  if (offset > fileSize(file)) offset = 0
  let lastSize = -1
  process.stderr.write(`devspec-wake-tail: watching ${file}\n`)

  const poll = () => {
    const size = fileSize(file)
    if (size < offset) offset = 0
    // The file has stopped growing since the last poll: lines a wait older than the
    // wake boundary wrote are whole by now.
    const settled = size === lastSize
    lastSize = size
    if (size <= offset) return
    const out = notifyLines(readRange(file, offset, size), {
      settled,
      readWith,
      from: offset,
      readThrough: readPosition(file, key, dir),
      dir,
    })
    offset += out.read
    if (out.text) process.stdout.write(out.text)
  }

  poll()
  setInterval(poll, POLL_MS)
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
 * the tail's line names it); while `remaining` is above 0, it runs it again.
 */
export function readerHeader(returned, remaining, note = null) {
  return `${JSON.stringify({ devspec_wakes: { returned, remaining }, ...(note ? { note } : {}) })}\n`
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
export function readerPage(wakes, { home = os.homedir(), skip = () => false } = {}) {
  const kept = []
  for (let i = 0; i < wakes.length; i += 1) if (wakes[i].trim() && !skip(wakes[i])) kept.push(i)
  const total = kept.length
  if (total === 0) return { text: readerHeader(0, 0, NOTHING_UNREAD), printed: 0, remaining: 0, through: wakes.length }
  const longest = readerHeader(total, total)
  const fitted = []
  let held = null
  for (const i of kept) {
    let wake = wakes[i]
    if (!fitsShellOutput(longest + wake)) {
      const out = wakeInNote(eventsOf(wake), { home })
      if (out.error) {
        held = out.error
        break
      }
      wake = wakeLines(out.events)
    }
    fitted.push(wake)
    // Nothing after this one can go out with it: no note is written for a wake that waits.
    if (!fitsShellOutput(longest + fitted.join(''))) break
  }
  const printed = wakesForOneOutput([longest, ...fitted]).count - 1
  const remaining = total - printed
  const through = printed < total ? kept[printed] : wakes.length
  if (printed === 0 && held) return { text: readerHeader(0, remaining, heldNote(held)), printed, remaining, through }
  return { text: readerHeader(printed, remaining) + fitted.slice(0, printed).join(''), printed, remaining, through }
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
 * print again next time; never fewer).
 */
export async function readWakes({
  file,
  connectionId = null,
  home = os.homedir(),
  dir = connectionsDirFor(home),
  write = writeStdout,
  settleMs = POLL_MS,
} = {}) {
  const resolved = path.resolve(String(file ?? ''))
  const key = readerKey(resolved, connectionId)
  return withStepsLockAsync(key, dir, async () => {
    const position = readPosition(resolved, key, dir)
    const { start, wakes } = await unreadWakes(resolved, position, { settleMs })
    const page = readerPage(
      wakes.map((wake) => wake.text),
      { home, skip: (wake) => withoutEndedConnectionWakes(wake, { dir, write: () => {} }) === '' },
    )
    await write(page.text)
    const through = page.through > 0 ? wakes[page.through - 1].end : start
    if (through === position) return { ...page, marked: true }
    try {
      writePrivateJson(readPositionPath(key, dir), { version: POSITION_VERSION, file: resolved, offset: through, at: new Date().toISOString() })
      return { ...page, marked: true }
    } catch (error) {
      return { ...page, marked: false, error }
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
    page = await readWakes({ file, connectionId: args.connectionId ?? null })
  } catch (error) {
    process.stderr.write(`devspec-wake-tail: the wakes could not be printed (${error instanceof Error ? error.message : String(error)}); none was marked read.\n`)
    process.exitCode = 1
    return
  }
  if (!page.marked) {
    // Said only when it keeps the output within what Cursor shows whole.
    const said = `devspec-wake-tail: the wakes above could not be marked read (${page.error?.message ?? 'unknown error'}); they print again next time.\n`
    if (fitsShellOutput(page.text + said)) process.stderr.write(said)
    process.exitCode = 1
  }
}

if (isDirectRun(import.meta.url)) {
  void main().catch((e) => {
    process.stderr.write(`devspec-wake-tail: ${e.message}\n`)
    process.exit(1)
  })
}
