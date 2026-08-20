import fs from 'node:fs'
import path from 'node:path'
import { normalizeRemoteIngressV1 } from './remote-ingress-v1.mjs'

const UUID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
const DATE = '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))'
const DATETIME = new RegExp(`^${DATE}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`)

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function uuid(value) { return typeof value === 'string' && UUID.test(value) }
function text(value) { return typeof value === 'string' && value.length > 0 }
function datetime(value) { return typeof value === 'string' && DATETIME.test(value) }
function nullableCursor(value) { return value === null || value === undefined || text(value) }

/** Strictly accept the one independent non-conversation dispatch type the server emits. */
export function validatePlaybookDispatch(dispatch, connectionId) {
  if (!exact(dispatch, [
    'id', 'kind', 'run_id', 'playbook_id', 'playbook_name', 'instruction', 'permission',
    'requester', 'original_target_connection_id', 'delivery_connection_id', 'queued_at', 'state',
  ])) return 'malformed playbook dispatch'
  if (dispatch.kind !== 'playbook_run' || !uuid(dispatch.id) || dispatch.run_id !== dispatch.id ||
      !uuid(dispatch.playbook_id) || !text(dispatch.playbook_name) || typeof dispatch.instruction !== 'string' ||
      !['look_only', 'can_commit', 'can_push'].includes(dispatch.permission) ||
      !exact(dispatch.requester, ['user_id']) || !uuid(dispatch.requester.user_id) ||
      !(dispatch.original_target_connection_id === null || uuid(dispatch.original_target_connection_id)) ||
      dispatch.delivery_connection_id !== connectionId || !datetime(dispatch.queued_at) ||
      !['queued', 'waiting_for_agent'].includes(dispatch.state)) return 'invalid playbook dispatch'
  return null
}

export function normalizePlaybookDispatches(input, connectionId) {
  if (!Array.isArray(input)) return { ok: false, error: 'missing playbook dispatch list' }
  const seen = new Set()
  for (const dispatch of input) {
    const error = validatePlaybookDispatch(dispatch, connectionId)
    if (error) return { ok: false, error }
    if (seen.has(dispatch.id)) return { ok: false, error: 'duplicate playbook dispatch id' }
    seen.add(dispatch.id)
  }
  return { ok: true, dispatches: input }
}

/**
 * Execute the negotiated response acceptance seam, without performing I/O.
 * Canonical conversation/context and explicit playbooks remain separate outputs.
 */
export function inspectPollResponseV1(response, connectionId) {
  if (!object(response)) return { ok: false, error: 'malformed poll response' }
  if (!nullableCursor(response.cursor) || !nullableCursor(response.cursor_v2) ||
      !nullableCursor(response.dispatch_cursor)) return { ok: false, error: 'malformed poll cursor metadata' }
  if (response.changed !== true) {
    return {
      ok: true,
      changed: false,
      envelope: null,
      canonicalWake: false,
      playbooks: [],
      liveCursorV2: response.cursor_v2 ?? null,
      legacyCursor: response.cursor ?? null,
      dispatchCursor: response.dispatch_cursor ?? null,
      catchUpCursor: null,
      control: null,
    }
  }
  const canonical = normalizeRemoteIngressV1(response, connectionId)
  if (!canonical.ok) return canonical
  const playbooks = normalizePlaybookDispatches(response.dispatches, connectionId)
  if (!playbooks.ok) return playbooks
  const envelope = canonical.envelope
  return {
    ok: true,
    changed: true,
    envelope,
    canonicalWake: canonical.wake,
    playbooks: playbooks.dispatches,
    liveCursorV2: response.cursor_v2 ?? null,
    legacyCursor: response.cursor ?? null,
    dispatchCursor: response.dispatch_cursor ?? null,
    catchUpCursor: envelope.window.has_more ? envelope.window.next_cursor : null,
    control: envelope.wake.kind === 'control' ? envelope.control : null,
  }
}

export function advancePollCursorState(current, accepted, { drainingCatchUp = false } = {}) {
  const liveCursorV2 = !drainingCatchUp && accepted.liveCursorV2
    ? accepted.liveCursorV2
    : current.liveCursorV2 ?? null
  const legacyCursor = !liveCursorV2 && accepted.legacyCursor
    ? accepted.legacyCursor
    : current.legacyCursor ?? null
  const catchUpCursor = accepted.changed
    ? accepted.catchUpCursor
    : drainingCatchUp
      ? null
      : current.catchUpCursor ?? null
  return {
    liveCursorV2,
    legacyCursor,
    catchUpCursor,
    dispatchCursor: accepted.dispatchCursor ?? current.dispatchCursor ?? null,
  }
}

/** Build the next call without ever substituting an older-page cursor for the live cursor. */
export function buildPollCursorArgs({
  liveCursorV2 = null,
  legacyCursor = null,
  catchUpCursor = null,
  dispatchCursor = null,
  catchUp = false,
  controlAck = null,
} = {}) {
  return {
    ...(liveCursorV2 ? { cursor_v2: liveCursorV2 } : legacyCursor ? { cursor: legacyCursor } : {}),
    ...((catchUp || catchUpCursor) ? { catch_up: true } : {}),
    ...(catchUpCursor ? { catch_up_cursor: catchUpCursor } : {}),
    ...(dispatchCursor ? { dispatch_cursor: dispatchCursor } : {}),
    ...(controlAck ? { control_ack: controlAck } : {}),
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function acquireAcceptanceLock(file, io) {
  const lock = `${file}.accept.lock`
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      io.mkdirSync(lock)
      io.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`, { mode: 0o600 })
      return { ok: true, lock }
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, error: error instanceof Error ? error.message : String(error) }
      let owner = null
      try { owner = Number.parseInt(io.readFileSync(path.join(lock, 'owner'), 'utf8').trim(), 10) } catch { /* incomplete lock */ }
      let incompleteStale = false
      if (!owner) {
        try { incompleteStale = Date.now() - io.statSync(lock).mtimeMs > 1_000 } catch { /* retry */ }
      }
      if ((owner && !processAlive(owner)) || incompleteStale) {
        try { io.rmSync(lock, { recursive: true, force: true }) } catch { /* retry */ }
        continue
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return { ok: false, error: 'durable acceptance lock timed out' }
}

export function appendAcceptedJsonl(file, record, acceptanceKey, io = fs) {
  if (!text(file) || !text(acceptanceKey) || !object(record)) {
    return { ok: false, duplicate: false, error: 'invalid durable acceptance record' }
  }
  const acquired = acquireAcceptanceLock(file, io)
  if (!acquired.ok) return { ok: false, duplicate: false, error: acquired.error }
  try {
    if (io.existsSync(file)) {
      const existing = io.readFileSync(file, 'utf8')
      for (const line of existing.split('\n')) {
        if (!line.trim()) continue
        try {
          if (JSON.parse(line)?.acceptance_key === acceptanceKey) {
            return { ok: true, duplicate: true, error: null }
          }
        } catch {
          // A corrupt unrelated line is not authority to drop this accepted turn.
        }
      }
    }
    io.mkdirSync(path.dirname(file), { recursive: true })
    io.appendFileSync(file, JSON.stringify({ ...record, acceptance_key: acceptanceKey }) + '\n', { mode: 0o600 })
    return { ok: true, duplicate: false, error: null }
  } catch (error) {
    return { ok: false, duplicate: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    try { io.rmSync(acquired.lock, { recursive: true, force: true }) } catch { /* retry can recover a dead owner */ }
  }
}

export function playbookAcceptanceKey(dispatch) {
  return `playbook:${dispatch.run_id}`
}

export function playbookRunInstruction(dispatch) {
  const permission =
    dispatch.permission === 'can_push'
      ? 'You MAY edit, commit and push.'
      : dispatch.permission === 'can_commit'
        ? 'You MAY edit and commit locally, but MUST NOT push.'
        : 'This playbook is LOOK ONLY — investigate and report, do not edit, commit or push anything.'
  return [
    `▶️ Playbook run dispatched to this connection: "${dispatch.playbook_name}" (run ${dispatch.run_id}).`,
    '',
    'What to do:',
    `1. claim_playbook_run({ run_id: "${dispatch.run_id}", provider: "cursor" }) — always pass provider (and model if the playbook names one). If claimed:false the run was already taken by another of your agents, which is normal; stop there.`,
    '2. Do the work described below, in this repo.',
    '3. record_playbook_run — report status, a verdict for EACH acceptance criterion WITH evidence, and whatever the run produced as artifacts.',
    '',
    `Permission: ${permission}`,
    '',
    'The instruction:',
    dispatch.instruction || '(claim the run to read it)',
  ].join('\n')
}
