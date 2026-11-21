/**
 * Space-free per-connection wake file for Cursor Connect host-owned follow.
 *
 * The inbox lives under ~/.devspec (often `C:\Users\Brandon Young\...` — a space).
 * Connect argv cannot quote-wrap that path (item dc3fb0f5). Wake lines go under
 * %ProgramData%\DevSpec\wakes\<connection-id>.jsonl on Windows, which has no
 * whitespace, so the model's background tail is one unquoted token.
 */
import fs from 'node:fs'
import path from 'node:path'

// The host-owned wake stream and its model notification must include the same events.
export const REMOTE_WAKE_NOTIFY_PATTERN = 'owner_message|system_notice|question_answer|question_dismissal|session_ended|automation_dispatch|check_job'

const CONNECTION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function pathHasWhitespace(p) {
  return /[\s]/.test(String(p ?? ''))
}

/**
 * @param {string} connectionId
 * @param {{ platform?: NodeJS.Platform, programData?: string, posixDir?: string }} [opts]
 * @returns {string}
 */
export function resolveSpaceFreeWakeFile(connectionId, opts = {}) {
  const id = String(connectionId ?? '').trim()
  if (!CONNECTION_ID_RE.test(id)) {
    throw new Error('resolveSpaceFreeWakeFile: invalid connection id')
  }
  const platform = opts.platform || process.platform
  const dir =
    platform === 'win32'
      ? path.join(
          String(opts.programData || process.env.ProgramData || 'C:\\ProgramData'),
          'DevSpec',
          'wakes',
        )
      : path.join(String(opts.posixDir || '/var/tmp/devspec-wakes'))
  const file = path.join(dir, `${id}.jsonl`)
  if (pathHasWhitespace(file)) {
    throw new Error(`resolveSpaceFreeWakeFile: path has whitespace: ${file}`)
  }
  return file
}

/**
 * Create an empty wake file so the model tail can open it before the first line.
 * @param {string} file
 * @returns {string}
 */
export function ensureWakeFile(file) {
  const p = path.resolve(String(file ?? ''))
  if (!p) throw new Error('ensureWakeFile: missing path')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (!fs.existsSync(p)) fs.writeFileSync(p, '', { mode: 0o600 })
  return p
}

/**
 * One wake's events as they are written to the wake file: one JSON object per line,
 * then an empty line that closes the wake. JSON never holds a raw line break, so an
 * empty line can only be that boundary, and the reader (devspec-wake-tail.mjs) can
 * hand Cursor whole wakes, never part of one (`splitWakes`). These are the bytes the
 * wake file gains for the wake, so what Cursor shows the agent for it.
 * @param {object[]} events
 * @returns {string}
 */
export function wakeLines(events) {
  return events.map((event) => JSON.stringify(event) + '\n').join('') + '\n'
}

/**
 * What a one-shot wait's result says when some of a delivery's wakes wait for the next
 * re-arm (devspec-remote-wait.mjs). A delivery is split over results only when room is
 * kept for this line (turn-recall.mjs), so a result that leaves wakes behind always
 * says so.
 * @param {number} left
 */
export function wakesWaitingEvent(left) {
  return { type: 'wakes_waiting', count: left, note: 'Re-arm the wait with --pending now to print the rest.' }
}

/**
 * The whole wakes at the start of `text` (wake-file text not yet printed), each as
 * written, and the text after them, which is a wake still being written. A wake ends at
 * the empty line `wakeLines` closes it with. Lines with no closing empty line, from a
 * wait older than that boundary, count as one whole wake once the file has stopped
 * growing (`settled`), so they are printed together as they always were.
 * @param {string} text
 * @param {{ settled?: boolean }} [opts]
 * @returns {{ wakes: string[], rest: string }}
 */
export function splitWakes(text, { settled = false } = {}) {
  const wakes = []
  let at = 0
  for (let end = text.indexOf('\n\n', at); end >= 0; end = text.indexOf('\n\n', at)) {
    wakes.push(text.slice(at, end + 2))
    at = end + 2
  }
  let rest = text.slice(at)
  // Stray empty lines between wakes are boundaries too, not wakes of their own.
  while (rest.startsWith('\n')) {
    if (wakes.length > 0) wakes[wakes.length - 1] += '\n'
    else wakes.push('\n')
    rest = rest.slice(1)
  }
  if (settled && rest.endsWith('\n')) {
    wakes.push(rest)
    rest = ''
  }
  return { wakes, rest }
}

/**
 * Append one JSON object per line. Used by host follow so a surviving tail
 * can notify after Cursor `turn_ended`.
 * @param {string} file
 * @param {object[]} events
 */
export function appendWakeEvents(file, events) {
  if (!file || !Array.isArray(events) || events.length === 0) return
  const p = ensureWakeFile(file)
  fs.appendFileSync(p, wakeLines(events))
}
