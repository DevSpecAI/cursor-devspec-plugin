import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MAX_DIAGNOSTIC_BYTES = 128 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SERVER_CODES = new Set(['auth_validation_unavailable', 'invalid_api_token', 'invalid_connection_capability'])

/** Never persist raw stderr: MCP error strings can contain SQL, tokens or content.
 * Unknown failures remain unknown. Server refusal diagnostics provide the other
 * half of the timeline; this file is not a transcript or credential export.
 */
export function classifyProgressFailure(error) {
  const message = typeof error?.message === 'string' ? error.message.slice(0, 8192) : ''
  let reason = 'unclassified_failure'
  if (/\bactivity_attempt_closed\b/.test(message)) reason = 'activity_attempt_closed'
  else if (/requires an exact open activity attempt/.test(message)) reason = 'missing_open_attempt'
  else if (/^command_turn_id is unknown/.test(message)) reason = 'unknown_command_turn'
  else if (/^Failed to write work trail:/.test(message)) reason = 'trail_write_failed'
  else if (error?.code === 'timeout') reason = 'timeout'
  else if (error?.code === 'owner_gone') reason = 'owner_gone'
  else if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error?.cause?.code)) reason = 'network_failure'
  else if (Number.isInteger(error?.status)) reason = 'http_failure'
  const detail = { reason }
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) detail.httpStatus = error.status
  if (SERVER_CODES.has(error?.serverCode)) detail.serverCode = error.serverCode
  if (typeof error?.retryable === 'boolean') detail.retryable = error.retryable
  return detail
}

export function progressDiagnosticPath(connectionId, dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')) {
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) return null
  return path.join(dir, `${connectionId}.progress-diagnostics.jsonl`)
}

function regularOrMissing(file) {
  try { return fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink() }
  catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

/** Single reporter writer, one archive, <=256 KiB total. Diagnostic I/O can never
 * change retry, poll, posting or exit semantics. On Windows permissions inherit
 * the user's private profile ACL; mode 0600 also restricts Unix installations.
 */
export function recordProgressFailure(connectionId, error, { dir, now = Date.now(), source = 'trail_watch' } = {}) {
  const file = progressDiagnosticPath(connectionId, dir)
  if (!file || !['trail_watch', 'trail_hook', 'watch_exit'].includes(source)) return false
  const record = { at: new Date(now).toISOString(), connectionId, source, phase: 'trail', ...classifyProgressFailure(error) }
  const line = JSON.stringify(record) + '\n'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    if (!regularOrMissing(file) || !regularOrMissing(file + '.1')) return false
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size + Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES) {
      fs.rmSync(file + '.1', { force: true })
      // A pre-existing oversized file is not retained as an oversized archive.
      if (size <= MAX_DIAGNOSTIC_BYTES) fs.renameSync(file, file + '.1')
      else fs.rmSync(file)
    }
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600)
    try {
      if (!fs.fstatSync(fd).isFile()) return false
      fs.fchmodSync(fd, 0o600)
      fs.writeSync(fd, line)
    } finally { fs.closeSync(fd) }
    return true
  } catch { return false }
}
