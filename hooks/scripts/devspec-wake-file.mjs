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
 * Append one JSON object per line. Used by host follow so a surviving tail
 * can notify after Cursor `turn_ended`.
 * @param {string} file
 * @param {object[]} events
 */
export function appendWakeEvents(file, events) {
  if (!file || !Array.isArray(events) || events.length === 0) return
  const p = ensureWakeFile(file)
  const chunk = events.map((event) => JSON.stringify(event) + '\n').join('')
  fs.appendFileSync(p, chunk)
}
