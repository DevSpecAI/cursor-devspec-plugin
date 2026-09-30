import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const LIMITS = Object.freeze({ minutes: 15, maxMinutes: 60, retentionMs: 24 * 60 * 60 * 1000, runs: 4, segmentBytes: 512 * 1024, events: 10000 })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const KINDS = new Set(['tool', 'mcp', 'connect', 'progress_failure', 'transcript', 'lifecycle'])
const PHASES = new Set(['start', 'end', 'observed', 'stopped'])
const OUTCOMES = new Set(['ok', 'error', 'timeout', 'owner_gone', 'unknown', 'skipped'])
const SOURCES = new Set(['cursor_hook', 'plugin_mcp', 'plugin_connect', 'progress_reporter', 'transcript_observer', 'collector'])
const CONNECT = new Set(['create_chat', 'expand_stamp', 'skip_stamp', 'write_stamp', 'agent_spawn', 'agent_resume', 'resolve_local_id', 'resolve_local', 'project_resolve', 'register_connection', 'attach_connection', 'write_state', 'ensure_poller', 'wait_armed'])
const SOURCE_NAMES = ['plugin_mcp', 'cursor_hooks', 'transcript', 'host_mcp_trace', 'schema_discovery', 'worker_log', 'poll_state']
const SOURCE_STATES = ['available', 'host_dependent', 'not_observed', 'unavailable', 'not_collected', 'present_not_imported']
const LIMITATIONS = ['Best-effort diagnostics, not an audit ledger; file contention or I/O errors can drop observations.', 'Unobserved intervals are unknown, not measured model thinking.', 'Raw state, worker logs, native traces and transcripts are not included in exports.', 'Pre-start activity cannot be reconstructed; host-owned MCP discovery requires existing host traces.']
const version = value => typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : 'unknown'
const REASONS = new Set(['activity_attempt_closed', 'missing_open_attempt', 'unknown_command_turn', 'trail_write_failed', 'timeout', 'owner_gone', 'network_failure', 'http_failure', 'unclassified_failure'])
export const isDiagnosticId = value => typeof value === 'string' && UUID.test(value)
export const diagnosticsRoot = () => path.join(os.homedir(), '.devspec', 'cursor-diagnostics')

function plain(file) {
  try { const s = fs.lstatSync(file); return s.isFile() && !s.isSymbolicLink() }
  catch { return false }
}
function readJson(file, maxBytes = 16384) {
  if (!plain(file) || fs.statSync(file).size > maxBytes) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) throw Error('Unsafe diagnostic directory')
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
}
function writePrivate(file, text) {
  if (fs.existsSync(file) && !plain(file)) throw Error('Unsafe diagnostic file')
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
  try { if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, text) } finally { fs.closeSync(fd) }
}
function store(file, data) { writePrivate(file, JSON.stringify(data)) }
function runDirs(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && isDiagnosticId(e.name))
    .map(e => ({ dir: path.join(root, e.name), meta: readJson(path.join(root, e.name, 'session.json')) }))
    .filter(x => x.meta && isDiagnosticId(x.meta.connectionId) && Number.isFinite(x.meta.startedAt))
}
function withLock(dir, fn) {
  const lock = path.join(dir, '.lock')
  try { fs.mkdirSync(lock, { mode: 0o700 }) } catch {
    // Recover a dead writer, never steal from a live process or follow a symlink.
    try {
      const stat = fs.lstatSync(lock)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
      const owner = readJson(path.join(lock, 'owner.json'))
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); return null } catch (e) { if (e.code !== 'ESRCH') return null }
      } else if (Date.now() - stat.mtimeMs < 30000) return null
      fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock, { mode: 0o700 })
    } catch { return null }
  }
  try {
    store(path.join(lock, 'owner.json'), { pid: process.pid })
    return fn()
  } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

/** No startup writes or background process. Disabled readers just return null.
 * Multiple hooks can share a run; short synchronous writes never wait for a lock.
 * Contended/unavailable diagnostics may be lost, explicitly not an audit ledger.
 */
export function activeDiagnostics(fields = {}, { root = diagnosticsRoot(), now = Date.now() } = {}) {
  try {
    const localId = fields.local_id || process.env.CURSOR_CONVERSATION_ID
    if (!isDiagnosticId(fields.connectionId) && !isDiagnosticId(localId) && !isDiagnosticId(fields.launch_id)) return null
    const matches = runDirs(root).filter(({ meta }) => !meta.stoppedAt && meta.expiresAt > now && meta.retainUntil > now && meta.count < LIMITS.events &&
      (isDiagnosticId(fields.connectionId) ? fields.connectionId === meta.connectionId :
        isDiagnosticId(localId) ? localId === meta.local_id : fields.launch_id === meta.launch_id))
    return matches.length === 1 ? matches[0] : null
  } catch { return null }
}

export function safeToolName(value) {
  // Identifiers only, never arbitrary descriptions, shell commands, URLs or keys.
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(value) &&
    !/(?:bearer|token|secret|password|api.?key|dvs_|sk-|ghp_|eyJ)/i.test(value) ? value : 'other'
}
export function normalizeDiagnostic(input) {
  if (!input || !KINDS.has(input.kind) || !PHASES.has(input.phase) || !SOURCES.has(input.source)) return null
  const out = { kind: input.kind, phase: input.phase, source: input.source }
  if (OUTCOMES.has(input.outcome)) out.outcome = input.outcome
  if (['shell', 'mcp', 'tool'].includes(input.channel)) out.channel = input.channel
  if (input.tool !== undefined) out.tool = input.channel === 'shell' ? 'shell' : safeToolName(input.tool)
  if (CONNECT.has(input.operation)) out.operation = input.operation
  if (input.method === 'tools/call') out.method = 'tools/call'
  if (input.server === 'devspec') out.server = 'devspec'
  if (REASONS.has(input.reason)) out.reason = input.reason
  if (['auth_validation_unavailable', 'invalid_api_token', 'invalid_connection_capability'].includes(input.serverCode)) out.serverCode = input.serverCode
  if (typeof input.retryable === 'boolean') out.retryable = input.retryable
  for (const key of ['invocationId', 'turn_id', 'sessionId', 'local_id', 'launch_id']) if (isDiagnosticId(input[key])) out[key] = input[key]
  for (const key of ['duration_ms', 'request_bytes', 'response_bytes', 'file_bytes', 'appended_bytes']) {
    if (Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= 1e12) out[key] = Math.round(input[key])
  }
  for (const key of ['started_at', 'ended_at']) {
    if (typeof input[key] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input[key]) && Number.isFinite(Date.parse(input[key]))) out[key] = input[key]
  }
  if (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) out.httpStatus = input.httpStatus
  if (typeof input.available === 'boolean') out.available = input.available
  return out
}

export function updateDiagnosticPending(run, key, entry) {
  try {
    return withLock(run.dir, () => {
      const file = path.join(run.dir, 'pending.json')
      const pending = readJson(file) || {}
      const previous = pending[key] || null
      if (entry) pending[key] = entry
      else delete pending[key]
      for (const k of Object.keys(pending).slice(0, Math.max(0, Object.keys(pending).length - 32))) delete pending[k]
      store(file, pending)
      return previous
    })
  } catch { return null }
}

export function appendDiagnostic(fields, event, options = {}) {
  try {
    const run = activeDiagnostics(fields, options)
    const data = normalizeDiagnostic(event)
    if (!run || !data || (options.runId && run.meta.runId !== options.runId)) return false
    const now = options.now ?? Date.now()
    return withLock(run.dir, () => {
      const meta = readJson(path.join(run.dir, 'session.json'))
      if (!meta || meta.stoppedAt || meta.expiresAt <= now || meta.count >= LIMITS.events) return false
      const elapsed = Math.max(meta.elapsed_ms || 0, now - meta.startedAt, 0)
      const record = { ...data, seq: meta.count + 1, at: new Date(now).toISOString(), elapsed_ms: elapsed, connectionId: meta.connectionId,
        ...(meta.local_id ? { local_id: meta.local_id } : {}), ...(meta.launch_id ? { launch_id: meta.launch_id } : {}), ...(meta.sessionId ? { sessionId: meta.sessionId } : {}) }
      const line = JSON.stringify(record) + '\n'
      const file = path.join(run.dir, 'events.jsonl'), archive = file + '.1'
      if ([file, archive].some(p => fs.existsSync(p) && !plain(p))) return false
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > LIMITS.segmentBytes) {
        fs.rmSync(archive, { force: true }); fs.renameSync(file, archive)
      }
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600)
      try { fs.writeSync(fd, line) } finally { fs.closeSync(fd) }
      store(path.join(run.dir, 'session.json'), { ...meta, count: record.seq, elapsed_ms: elapsed })
      return true
    }) === true
  } catch { return false }
}

/** Start requires an existing exact connection; never read/export its token. */
export function startDiagnostics(connectionId, { minutes = LIMITS.minutes, root = diagnosticsRoot(), now = Date.now(), home = os.homedir() } = {}) {
  if (!isDiagnosticId(connectionId)) throw Error('A connection UUID is required')
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.maxMinutes) throw Error('Duration must be 1–60 minutes')
  const connection = readJson(path.join(home, '.devspec', 'remote-control', 'connections', `${connectionId}.json`), 4 * 1024 * 1024)
  if (!connection || connection.enabled === false) throw Error('No enabled local connection found')
  privateDirectory(root)
  const result = withLock(root, () => {
    const existing = runDirs(root)
    for (const { dir, meta } of existing) {
      if (meta.retainUntil <= now) fs.rmSync(dir, { recursive: true, force: true })
      else if (meta.connectionId === connectionId && !meta.stoppedAt && meta.expiresAt > now) throw Error('Diagnostics already active; stop before starting another run')
    }
    const retained = runDirs(root).sort((a, b) => a.meta.startedAt - b.meta.startedAt)
    while (retained.length >= LIMITS.runs) {
      const i = retained.findIndex(r => r.meta.stoppedAt || r.meta.expiresAt <= now)
      if (i < 0) throw Error('Four diagnostic sessions are already active')
      fs.rmSync(retained.splice(i, 1)[0].dir, { recursive: true, force: true })
    }
    const runId = randomUUID(), dir = path.join(root, runId)
    privateDirectory(dir)
    let pluginVersion = 'unknown'
    try { pluginVersion = JSON.parse(fs.readFileSync(new URL('../../.cursor-plugin/plugin.json', import.meta.url), 'utf8')).version } catch {}
    const meta = { runId, connectionId, startedAt: now, expiresAt: now + minutes * 60000, retainUntil: now + LIMITS.retentionMs, stoppedAt: null,
      count: 0, elapsed_ms: 0, pluginVersion: version(pluginVersion), hostVersion: version(connection.host_version || process.env.CURSOR_VERSION),
      sources: { plugin_mcp: 'available', cursor_hooks: 'host_dependent', transcript: 'not_observed', host_mcp_trace: 'unavailable', schema_discovery: 'unavailable', worker_log: 'not_collected', poll_state: 'not_collected' },
      limitations: LIMITATIONS }
    if (isDiagnosticId(connection.local_id)) meta.local_id = connection.local_id
    const launchId = connection.launch_id || process.env.DEVSPEC_LAUNCH_ID
    if (isDiagnosticId(launchId)) meta.launch_id = launchId
    if (isDiagnosticId(connection.session_id)) meta.sessionId = connection.session_id
    store(path.join(dir, 'session.json'), meta)
    writePrivate(path.join(dir, 'events.jsonl'), '')
    return { dir, meta }
  })
  if (!result) throw Error('Diagnostics are busy; try again')
  return result
}

export function markDiagnosticSource(run, name, state) {
  try {
    if (!SOURCE_NAMES.includes(name) || !SOURCE_STATES.includes(state)) return false
    return withLock(run.dir, () => {
      const file = path.join(run.dir, 'session.json'), meta = readJson(file)
      if (!meta) return false
      store(file, { ...meta, sources: { ...meta.sources, [name]: state } })
      return true
    }) === true
  } catch { return false }
}

export function diagnosticStatus(connectionId, { root = diagnosticsRoot(), now = Date.now() } = {}) {
  if (!isDiagnosticId(connectionId)) throw Error('A connection UUID is required')
  const run = runDirs(root).filter(r => r.meta.connectionId === connectionId && r.meta.retainUntil > now).sort((a, b) => b.meta.startedAt - a.meta.startedAt)[0]
  return run ? { ...run, active: !run.meta.stoppedAt && run.meta.expiresAt > now && run.meta.count < LIMITS.events } : { active: false, dir: null, meta: null }
}
export function stopDiagnostics(connectionId, options = {}) {
  const status = diagnosticStatus(connectionId, options)
  if (!status.meta) return status
  const stopped = withLock(status.dir, () => {
    const meta = readJson(path.join(status.dir, 'session.json'))
    store(path.join(status.dir, 'session.json'), { ...meta, stoppedAt: options.now ?? Date.now() })
    fs.rmSync(path.join(status.dir, 'pending.json'), { force: true })
    return true
  })
  if (!stopped) throw Error('Diagnostics are busy; try again')
  return diagnosticStatus(connectionId, options)
}

/** Explicit export is a second sanitization pass, not an archive of private files. */
export function exportDiagnostics(connectionId, options = {}) {
  const status = diagnosticStatus(connectionId, options)
  if (!status.meta) throw Error('No retained diagnostic run found')
  const result = withLock(status.dir, () => {
    const events = []
    for (const suffix of ['events.jsonl.1', 'events.jsonl']) {
      const file = path.join(status.dir, suffix)
      if (!plain(file) || fs.statSync(file).size > LIMITS.segmentBytes) continue
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const raw = JSON.parse(line), safe = normalizeDiagnostic(raw)
          if (safe && Number.isSafeInteger(raw.seq) && raw.seq > 0 && typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at))) {
            events.push({ ...safe, seq: raw.seq, at: new Date(raw.at).toISOString(), connectionId,
              ...(Number.isFinite(raw.elapsed_ms) && raw.elapsed_ms >= 0 && raw.elapsed_ms <= 86400000 ? { elapsed_ms: raw.elapsed_ms } : {}) })
          }
        } catch {}
      }
    }
    const meta = status.meta
    const bundle = { version: 1, connectionId, runId: path.basename(status.dir),
      ...(isDiagnosticId(meta.local_id) ? { local_id: meta.local_id } : {}), ...(isDiagnosticId(meta.launch_id) ? { launch_id: meta.launch_id } : {}),
      ...(isDiagnosticId(meta.sessionId) ? { sessionId: meta.sessionId } : {}), startedAt: new Date(meta.startedAt).toISOString(), expiresAt: new Date(meta.expiresAt).toISOString(),
      pluginVersion: version(meta.pluginVersion), hostVersion: version(meta.hostVersion),
      sources: Object.fromEntries(SOURCE_NAMES.map(name => [name, SOURCE_STATES.includes(meta.sources?.[name]) ? meta.sources[name] : 'unavailable'])), limitations: LIMITATIONS,
      retainedEvents: events.length, totalObservedEvents: Number.isSafeInteger(meta.count) ? meta.count : 0, truncated: events.length < meta.count,
      events: events.sort((a, b) => a.seq - b.seq) }
    const file = path.join(status.dir, 'export.json')
    // Normalized export is bounded even if a local file was manually tampered with.
    const text = JSON.stringify(bundle)
    if (Buffer.byteLength(text) > LIMITS.segmentBytes * 3) throw Error('Export exceeds diagnostic budget')
    writePrivate(file, text)
    return file
  })
  if (!result) throw Error('Diagnostics are busy; try again')
  return result
}

export function pruneDiagnostics({ root = diagnosticsRoot(), now = Date.now() } = {}) {
  try {
    if (!fs.existsSync(root)) return
    withLock(root, () => { for (const { dir, meta } of runDirs(root)) if (meta.retainUntil <= now) fs.rmSync(dir, { recursive: true, force: true }) })
  } catch {}
}
