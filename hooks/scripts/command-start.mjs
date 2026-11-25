/**
 * Honest room-command start and wake-listener readiness for the Cursor plugin
 * (DevSpec item 3d327b4a).
 *
 * A room command is started (`report_pickup`, `.turn` marker, Working trail,
 * request tracking) only once the Cursor agent has actually received and begun
 * handling it — never prematurely when the background poller fetches it from
 * DevSpec while the agent is idle or has no listener running.
 *
 * Callers:
 *  - `devspec-wake-tail.mjs read`: idle agent woke up and read the wake.
 *  - `step-delivery.mjs` (`readThrough`): mid-turn agent read the step note
 *    carrying a room message, or idle agent read a `held_for_step` note.
 *  - `devspec-remote-wait.mjs` (one-shot mode): wait printed the command to
 *    the agent's Shell stdout.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENT_NAME } from './agent-identity.mjs'
import { ensureCliTrailWatch } from './cli-trail-watch.mjs'
import { pidAlive } from './close-on-end.mjs'
import { REMOTE_WAKE_NOTIFY_PATTERN, resolveSpaceFreeWakeFile, wakeFileConnectionId } from './devspec-wake-file.mjs'
import { CURSOR_SHELL_OUTPUT_MAX_CHARS, fitsShellOutput, readNoteText } from './hook-context-budget.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { recordDeliveredBatchRequests } from './requests.mjs'
import { connectionCredential } from './resolve-mcp-auth.mjs'
import { seedWorkTrailForConnection } from './seed-work-trail.mjs'
import { recordTurnBaseline } from './transcript-turn-end.mjs'
import {
  attemptEndArguments,
  clearTurnCommands,
  commandsHandedOver,
  pickupArguments,
  readTurnCommands,
  recordTurnCommands,
} from './turn-commands.mjs'
import { readTurnActivity, turnActivityPath, turnIsLive, TURN_SILENCE_MS } from './turn-liveness.mjs'
import { resolveAgentTranscriptPath } from './work-trail.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WAKE_TAIL_SCRIPT = path.join(HERE, 'devspec-wake-tail.mjs')
const STARTED_VERSION = 1
/**
 * Per-connection ring of started room-command message ids kept for idempotent pickup
 * deduplication across concurrent readers. 200 ids (~9 KB JSON) comfortably spans any
 * single connection's unread/retry window while keeping state file reads sub-millisecond.
 */
export const MAX_STARTED_COMMAND_IDS = 200
/**
 * Shared wall-clock deadline across the entire `startRoomCommands` sequence
 * (stale-turn `report_complete`, single `report_pickup`, and `seedWorkTrailForConnection`).
 * Leaves 3 s headroom inside `hooks/hooks.json`'s 15 s `step-delivery.mjs` hook timeout
 * so the hook always finishes and emits stdout before Cursor kills it (requirements
 * 3c5147a7 / 91d7b47c).
 */
export const COMMAND_START_BUDGET_MS = 12_000
/** Back-compat alias for `COMMAND_START_BUDGET_MS`. */
export const COMMAND_START_TIMEOUT_MS = COMMAND_START_BUDGET_MS
const LEASE_VERSION = 1
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/

/** The `reason` the listener's notify_on_output carries; Cursor shows it as each notification's title. */
export const WAKE_LISTENER_REASON = 'DevSpec wakes'

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export function defaultConnectionsDir(home = os.homedir(), env = process.env) {
  const override =
    typeof env?.DEVSPEC_REMOTE_CONNECTIONS_DIR === 'string'
      ? env.DEVSPEC_REMOTE_CONNECTIONS_DIR.trim()
      : ''
  return override || path.join(home, '.devspec', 'remote-control', 'connections')
}

export function wakeNeededPath(connectionId, dir = defaultConnectionsDir()) {
  return path.join(dir, `${connectionId}.wake-needed`)
}

export function markWakeListenerNeeded(connectionId, dir = defaultConnectionsDir()) {
  if (!connectionId) return false
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(wakeNeededPath(connectionId, dir), `${new Date().toISOString()}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function clearWakeListenerNeeded(connectionId, dir = defaultConnectionsDir()) {
  if (!connectionId) return
  try {
    fs.rmSync(wakeNeededPath(connectionId, dir), { force: true })
  } catch {
    /* ignore */
  }
}

export function wakeListenerLeasePath(key, dir = defaultConnectionsDir()) {
  return path.join(dir, `${key}.wake-listener`)
}

export function wakeListenerCommand(file, { scriptPath = WAKE_TAIL_SCRIPT, connectionId = null } = {}) {
  const resolved = path.resolve(String(file))
  const named = wakeFileConnectionId(resolved)
  const extra = SAFE_ID.test(connectionId ?? '') && connectionId !== named ? ` --connection-id ${connectionId}` : ''
  return `node ${shellQuote(scriptPath)} --file ${shellQuote(resolved)}${extra}`
}

export function isWakeListenerActive(connectionId, { wakeFile = null, dir = defaultConnectionsDir(), isAlive = pidAlive } = {}) {
  if (!connectionId) return false
  const resolved = path.resolve(String(wakeFile || resolveSpaceFreeWakeFile(connectionId)))
  const lease = readPrivateJson(wakeListenerLeasePath(connectionId, dir))
  if (lease?.version !== LEASE_VERSION || lease.file !== resolved || !Number.isSafeInteger(lease.pid)) return false
  if (lease.state === 'retired') return false
  return Boolean(isAlive(lease.pid))
}

export function wakeListenerInfo(connectionId, { wakeFile = null, followPid = null, dir = defaultConnectionsDir(), scriptPath = WAKE_TAIL_SCRIPT, isAlive = pidAlive } = {}) {
  const resolved = path.resolve(String(wakeFile || resolveSpaceFreeWakeFile(connectionId)))
  const active = isWakeListenerActive(connectionId, { wakeFile: resolved, dir, isAlive })
  return {
    active,
    wake_file: resolved,
    ...(Number.isSafeInteger(followPid) ? { follow_pid: followPid } : {}),
    start: wakeListenerCommand(resolved, { scriptPath, connectionId }),
    notify_on_output: { pattern: REMOTE_WAKE_NOTIFY_PATTERN, reason: WAKE_LISTENER_REASON },
  }
}

export function wakeListenerReminder(connectionId, { wakeFile = null, dir = defaultConnectionsDir(), scriptPath = WAKE_TAIL_SCRIPT } = {}) {
  const resolved = path.resolve(String(wakeFile || resolveSpaceFreeWakeFile(connectionId)))
  const start = wakeListenerCommand(resolved, { scriptPath, connectionId })
  const notify = JSON.stringify({ pattern: REMOTE_WAKE_NOTIFY_PATTERN, reason: WAKE_LISTENER_REASON })
  return (
    'DevSpec wake listener is not running for this connection yet — without it, room messages sent while you are idle will not wake you. ' +
    `Start it now as a background Shell tool call with block_until_ms: 0 and notify_on_output: ${notify}:\n` +
    start
  )
}

function startedCommandsPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.started-commands.json`)
}

export function readStartedCommandIds(connectionId, dir = defaultConnectionsDir()) {
  const data = readPrivateJson(startedCommandsPath(connectionId, dir))
  return Array.isArray(data?.message_ids) ? data.message_ids.filter((id) => typeof id === 'string') : []
}

function recordStartedCommandIds(connectionId, ids, dir) {
  if (!connectionId || ids.length === 0) return
  const existing = readStartedCommandIds(connectionId, dir)
  const merged = [...existing]
  for (const id of ids) {
    if (!merged.includes(id)) merged.push(id)
  }
  const trimmed = merged.slice(-MAX_STARTED_COMMAND_IDS)
  try {
    writePrivateJson(startedCommandsPath(connectionId, dir), {
      version: STARTED_VERSION,
      message_ids: trimmed,
      updated_at: new Date().toISOString(),
    })
  } catch {
    /* ignore */
  }
}

function readTurnMarker(connectionId, dir) {
  return readPrivateJson(path.join(dir, `${connectionId}.turn`))
}

function writeTurnMarker(connectionId, dir, now = Date.now()) {
  const marker = { startedAt: now, connection_id: connectionId, pid: process.pid }
  try {
    writePrivateJson(path.join(dir, `${connectionId}.turn`), marker)
    return marker
  } catch {
    return null
  }
}

function clearTurnMarker(connectionId, dir) {
  try { fs.rmSync(path.join(dir, `${connectionId}.turn`), { force: true }) } catch { /* ignore */ }
  try { fs.rmSync(turnActivityPath(connectionId, dir), { force: true }) } catch { /* ignore */ }
  clearTurnCommands(connectionId, { dir })
}

const NOTE_ID_IN_READ_RE = /notes\/([0-9a-f]{16})\.md\b/

/**
 * Extract canonical room commands (`{ turnId, messageId }`) and raw messages from wake
 * JSONL text, expanding any `wake_in_note` pointer that carries `owner_message` so an
 * oversized command stored in a sealed note still triggers honest `report_pickup`
 * (requirement 3ea2b201).
 */
export function extractRoomCommandsFromWake(wakeText, { home = os.homedir(), visitedNotes = null } = {}) {
  const rawMessages = []
  const inlineMessages = []
  const deferredNoteCommands = []
  const unreadableNotes = []
  let sessionId = null
  const seenNotes = visitedNotes ?? new Set()
  for (const line of String(wakeText ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event = null
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event?.type === 'owner_message' && event.message && typeof event.message === 'object') {
      rawMessages.push(event.message)
      inlineMessages.push(event.message)
      if (!sessionId && typeof event.session_id === 'string') sessionId = event.session_id
    } else if (
      event?.type === 'wake_in_note' &&
      Array.isArray(event.carries) &&
      event.carries.includes('owner_message')
    ) {
      const match = NOTE_ID_IN_READ_RE.exec(String(event.read ?? ''))
      const noteId = match?.[1] ?? null
      if (!noteId) {
        unreadableNotes.push({
          code: 'invalid_command_note_ref',
          note_id: null,
          read: event.read ?? null,
          error: 'wake_in_note carries owner_message without a valid note id',
        })
      } else if (!seenNotes.has(noteId)) {
        seenNotes.add(noteId)
        try {
          const noteText = readNoteText(noteId, { home })
          if (noteText) {
            const nested = extractRoomCommandsFromWake(noteText, { home, visitedNotes: seenNotes })
            rawMessages.push(...nested.messages)
            unreadableNotes.push(...nested.unreadableNotes)
            if (!sessionId && nested.sessionId) sessionId = nested.sessionId
            if (nested.commands.length > 0) {
              deferredNoteCommands.push({
                noteId,
                read: event.read ?? null,
                commands: nested.commands,
                messages: nested.messages,
                sessionId: nested.sessionId ?? sessionId,
              })
            }
          } else {
            unreadableNotes.push({
              code: 'unreadable_command_note',
              note_id: noteId,
              read: event.read ?? null,
              error: 'command note is missing or empty',
            })
          }
        } catch (error) {
          unreadableNotes.push({
            code: 'unreadable_command_note',
            note_id: noteId,
            read: event.read ?? null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }
  return {
    commands: commandsHandedOver(rawMessages),
    messages: rawMessages,
    inlineCommands: commandsHandedOver(inlineMessages),
    inlineMessages,
    deferredNoteCommands,
    sessionId,
    unreadableNotes,
  }
}

function cloneJsonSafe(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) return value.map((item) => cloneJsonSafe(item))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'function' || k === 'stack') continue
      out[k] = cloneJsonSafe(v)
    }
    return out
  }
  return String(value)
}

function getAtPath(root, pathKeys) {
  let cur = root
  for (const key of pathKeys) cur = cur[key]
  return cur
}

function setAtPath(root, pathKeys, nextValue) {
  let cur = root
  for (let i = 0; i < pathKeys.length - 1; i += 1) cur = cur[pathKeys[i]]
  cur[pathKeys[pathKeys.length - 1]] = nextValue
}

function findLargestShrinkableString(node, minLength, currentPath = [], best = null) {
  if (typeof node === 'string') {
    if (node.length > minLength && (!best || node.length > best.length)) {
      return { path: currentPath, length: node.length }
    }
    return best
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      best = findLargestShrinkableString(node[i], minLength, [...currentPath, i], best)
    }
    return best
  }
  if (node && typeof node === 'object') {
    if (node.omitted_large_text === true) return best
    for (const [k, v] of Object.entries(node)) {
      best = findLargestShrinkableString(v, minLength, [...currentPath, k], best)
    }
  }
  return best
}

function findLargestRawArray(node, currentPath = [], best = null) {
  if (Array.isArray(node)) {
    const size = JSON.stringify(node).length
    if (node.length > 0 && (!best || size > best.size)) {
      best = { path: currentPath, size }
    }
    for (let i = 0; i < node.length; i += 1) {
      best = findLargestRawArray(node[i], [...currentPath, i], best)
    }
    return best
  }
  if (node && typeof node === 'object') {
    if (
      node.omitted_due_to_shell_limit === true ||
      (Array.isArray(node.items) && typeof node.total_count === 'number' && typeof node.omitted_count === 'number')
    ) {
      return best
    }
    for (const [k, v] of Object.entries(node)) {
      best = findLargestRawArray(v, [...currentPath, k], best)
    }
  }
  return best
}

/**
 * Budget-fitted structured refusal fallback when a pickup refusal payload exceeds
 * Cursor's Shell output ceiling AND `~/.devspec/notes` cannot be written
 * (requirements 4e32d1a5 / 3c5147a7 / 91d7b47c).
 *
 * Uses `fitsShellOutput` directly with zero arbitrary list/depth/length caps:
 *  1. Binary-searches the largest prefix of completely unmodified refusal objects that
 *     fits beside `stdoutText`, reporting `total_count`, `returned_count`, `omitted_count`,
 *     and `recovery`.
 *  2. When even the first refusal object exceeds remaining budget, preserves every
 *     structured field at every depth by replacing only the largest oversized string(s)
 *     with explicit omission metadata (only when that actually shrinks JSON) and
 *     binary-searching any oversized nested array to keep the maximum complete entries
 *     with `{ items, total_count, returned_count, omitted_count, omitted_due_to_shell_limit, recovery }`.
 *  3. Returns `null` if `stdoutText` itself leaves too little room even for a structured
 *     refusal envelope with counts and recovery (never flattening to a generic sentence).
 */
function shrinkObjectToFit(
  obj,
  buildCandidate,
  fits,
  limitChars,
  { requireNonEmptyArrays = false, compactArrays = false } = {},
) {
  const working = cloneJsonSafe(obj)
  const stringReplacement = (len) => ({
    omitted_large_text: true,
    actual_length: len,
  })
  const minShrinkableStringLen = JSON.stringify(stringReplacement(limitChars)).length

  while (!fits(buildCandidate(working))) {
    const bigStr = findLargestShrinkableString(working, minShrinkableStringLen)
    const bigArr = findLargestRawArray(working)
    if (bigStr && bigStr.path.length > 0 && (!bigArr || bigStr.length >= bigArr.size)) {
      setAtPath(working, bigStr.path, stringReplacement(bigStr.length))
      continue
    }
    if (bigArr && bigArr.path.length > 0) {
      const originalArr = getAtPath(working, bigArr.path)
      const makeBoundedArr = (count) => ({
        items: originalArr.slice(0, count),
        total_count: originalArr.length,
        returned_count: count,
        omitted_count: originalArr.length - count,
        ...(compactArrays ? {} : { omitted_due_to_shell_limit: true }),
      })
      const minCount = requireNonEmptyArrays && originalArr.length > 0 ? 1 : 0
      let alo = minCount
      let ahi = originalArr.length
      if (minCount > 0) {
        setAtPath(working, bigArr.path, makeBoundedArr(minCount))
        if (!fits(buildCandidate(working))) {
          // Keep 1 item in place so the next iteration can shrink any oversized string
          // inside that retained item without collapsing a non-empty array to `items: []`.
          continue
        }
      }
      while (alo < ahi) {
        const amid = Math.ceil((alo + ahi) / 2)
        setAtPath(working, bigArr.path, makeBoundedArr(amid))
        if (fits(buildCandidate(working))) {
          alo = amid
        } else {
          ahi = amid - 1
        }
      }
      setAtPath(working, bigArr.path, makeBoundedArr(alo))
      if (fits(buildCandidate(working))) break
      continue
    }
    if (bigStr && bigStr.path.length > 0) {
      setAtPath(working, bigStr.path, stringReplacement(bigStr.length))
      continue
    }
    break
  }

  const candidate = buildCandidate(working)
  return fits(candidate) ? candidate : null
}

const BLOCKING_DETAIL_KEYS = new Set([
  'blocking_turn_id',
  'blocking_attempt_id',
  'blocking_attempt',
  'blocking_items',
  'blocking',
  'conflicting_records',
  'conflicts',
  'details',
])

function hasNonEmptyBlockingValue(val) {
  if (val === undefined || val === null) return false
  if (typeof val === 'string') return val.length > 0
  if (typeof val === 'number' || typeof val === 'boolean') return true
  if (Array.isArray(val)) return val.length > 0
  if (typeof val === 'object') {
    if (Array.isArray(val.items) && typeof val.total_count === 'number') {
      return val.items.length > 0
    }
    return Object.keys(val).length > 0
  }
  return false
}

/**
 * Budget-fitted structured refusal fallback when a pickup refusal payload exceeds
 * Cursor's Shell output ceiling AND `~/.devspec/notes` cannot be written
 * (requirements 4e32d1a5 / 3c5147a7 / 91d7b47c).
 *
 * Uses `fitsShellOutput` / `maxChars` directly with ZERO arbitrary item or character caps
 * and ZERO silent field discarding inside retained objects:
 *  1. Binary-searches the largest prefix of completely unmodified refusal objects that
 *     fits beside `stdoutText`, reporting `total_count`, `returned_count`, `omitted_count`,
 *     `read` (when a fallback note was saved), and `recovery`.
 *  2. When even the first refusal object exceeds remaining budget, preserves every
 *     structured field at every depth by replacing only the largest oversized string(s)
 *     with explicit omission metadata (only when that actually shrinks JSON) and
 *     binary-searching any oversized nested array to keep the maximum COMPLETE items
 *     with `{ items, total_count, returned_count, omitted_count, omitted_due_to_shell_limit, recovery }`.
 *  3. Under tight budgets, uses a compact JSON envelope (no verbose prefix), keeping
 *     priority actionable fields greedily against `fits(...)` with explicit
 *     `omitted_field_count` whenever fields are omitted, and ALWAYS preserving `read`
 *     when `savedNote` succeeded.
 *  4. Returns `null` if the remaining budget cannot fit either `read` (when saved) or
 *     at least one actionable structured refusal detail — never emitting a generic
 *     omission count that drops both blocking details and the saved-note read command.
 */
export function formatStructuredRefusalsFallback(
  refusals,
  {
    prefix = 'report_pickup refused (note write failed; structured refusal): ',
    stdoutText = '',
    maxChars = null,
    noteError = null,
    savedNote = null,
    recovery = 'Fix write permissions on ~/.devspec/notes and retry so the complete structured refusal can be saved whole and read back.',
    allowMinimalEnvelope = true,
  } = {},
) {
  const list = Array.isArray(refusals) ? refusals.map((item) => cloneJsonSafe(item)) : []
  const why = noteError instanceof Error ? noteError.message : String(noteError ?? 'note write failed')
  const savedCmd = typeof savedNote?.command === 'string' && savedNote.command ? savedNote.command : null
  const effectiveRecovery = savedCmd
    ? `Read the complete original refusal with \`${savedCmd}\` (and any further parts it names); fix write permissions on ~/.devspec/notes.`
    : recovery
  const limitChars = typeof maxChars === 'number' && maxChars > 0 ? maxChars : CURSOR_SHELL_OUTPUT_MAX_CHARS
  const fits = (candidate) =>
    typeof maxChars === 'number' && maxChars > 0
      ? candidate.length <= maxChars
      : fitsShellOutput(`${stdoutText}${candidate}`)
  const wrap = (slice, extra = {}) =>
    `${prefix}${JSON.stringify({
      note_write_failed: true,
      note_write_error: why,
      shell_limit_chars: limitChars,
      total_count: list.length,
      returned_count: slice.length,
      omitted_count: list.length - slice.length,
      ...(savedCmd ? { read: savedCmd, ...(savedNote.parts > 1 ? { saved_parts: savedNote.parts } : {}) } : {}),
      refusals: slice,
      recovery: effectiveRecovery,
      ...extra,
    })}\n`

  if (list.length === 0) {
    const emptyLine = wrap([])
    return fits(emptyLine) ? emptyLine : null
  }

  // 1. Keep as many completely unmodified refusal objects as fit inside the budget.
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(wrap(list.slice(0, mid)))) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  if (lo > 0) return wrap(list.slice(0, lo))

  // 2. Single first refusal exceeds remaining budget: shrink only oversized string
  // leaves and/or binary-search oversized nested arrays while keeping every field and
  // retained item complete with explicit omission counts, saved pointer, and recovery.
  const singleFitted = shrinkObjectToFit(list[0], (item) => wrap([item]), fits, limitChars, {
    requireNonEmptyArrays: true,
  })
  if (singleFitted) return singleFitted

  if (!allowMinimalEnvelope) return null

  // 3. Compact JSON envelope (drops verbose text prefix) with the exact same zero-cap
  // budget-driven shrinker so every structured field and retained item stays complete.
  const compactRecovery = savedCmd
    ? 'Read full original via `read`; fix ~/.devspec/notes.'
    : 'Fix ~/.devspec/notes permissions and retry.'
  const compactWrap = (item) =>
    `${JSON.stringify({
      refused: 'report_pickup',
      note_write_failed: true,
      shell_limit_chars: limitChars,
      total_count: list.length,
      returned_count: 1,
      omitted_count: list.length - 1,
      ...(savedCmd ? { read: savedCmd, ...(savedNote.parts > 1 ? { saved_parts: savedNote.parts } : {}) } : {}),
      refusal: item,
      recovery: compactRecovery,
    })}\n`
  const compactFitted = shrinkObjectToFit(list[0], compactWrap, fits, limitChars, {
    requireNonEmptyArrays: true,
  })
  if (compactFitted) return compactFitted

  // 4. Tight budget envelope: greedily pack priority top-level structured refusal fields
  // directly against `fits(...)` (no hard-coded item/char caps; retained items are never
  // stripped silently; omitted top-level keys are disclosed via `omitted_field_count`),
  // ALWAYS keeping `read: savedCmd` when a fallback note was saved. When no note store
  // was writable (`savedCmd === null`) and the refusal carried blocking details, never
  // return a code-only or empty-blocking-items shell (requirement 4e32d1a5).
  const primaryEntry = list[0] && typeof list[0] === 'object' ? list[0] : {}
  const primaryInner =
    primaryEntry.refusal && typeof primaryEntry.refusal === 'object' ? primaryEntry.refusal : primaryEntry
  const hasOriginalBlockingDetails = [...BLOCKING_DETAIL_KEYS].some(
    (k) => k in primaryInner && hasNonEmptyBlockingValue(primaryInner[k]),
  )
  const priorityOrder = [
    'blocking_turn_id',
    'blocking_attempt_id',
    'blocking_attempt',
    'blocking_items',
    'blocking',
    'conflicting_records',
    'conflicts',
    'details',
    'code',
    'retryable',
    'status',
  ]
  const orderedKeys = [
    ...priorityOrder.filter((k) => k in primaryInner),
    ...Object.keys(primaryInner).filter((k) => !priorityOrder.includes(k)),
  ]
  const allCodes = list.map((r) => r?.refusal?.code ?? r?.code ?? null).filter(Boolean)
  const needTopLevelCodes = Boolean(savedCmd) || list.length > 1 || !('code' in primaryInner)
  const tightRecovery = savedCmd ? 'Read `read`; fix ~/.devspec/notes.' : 'Fix ~/.devspec/notes & retry.'
  const buildTight = (fieldsObj, omittedFieldsCount, codesSlice = []) =>
    `${JSON.stringify({
      refused: 'report_pickup',
      ...(needTopLevelCodes && codesSlice.length > 0 ? { codes: codesSlice } : {}),
      ...fieldsObj,
      ...(omittedFieldsCount > 0 ? { omitted_field_count: omittedFieldsCount } : {}),
      omitted_count: list.length,
      shell_limit_chars: limitChars,
      ...(savedCmd ? { read: savedCmd } : {}),
      recovery: tightRecovery,
    })}\n`

  let fittedCodes = []
  if (needTopLevelCodes && allCodes.length > 0) {
    let clo = 0
    let chi = allCodes.length
    while (clo < chi) {
      const cmid = Math.ceil((clo + chi) / 2)
      if (fits(buildTight({}, orderedKeys.length, allCodes.slice(0, cmid)))) {
        clo = cmid
      } else {
        chi = cmid - 1
      }
    }
    fittedCodes = allCodes.slice(0, clo)
  }

  const pickedFields = {}
  let pickedCount = 0
  for (const key of orderedKeys) {
    const val = primaryInner[key]
    if (val === undefined) continue
    const nextRemaining = Math.max(0, orderedKeys.length - (pickedCount + 1))
    const directCandidate = buildTight({ ...pickedFields, [key]: val }, nextRemaining, fittedCodes)
    if (fits(directCandidate)) {
      pickedFields[key] = val
      pickedCount += 1
      continue
    }
    if (val && typeof val === 'object') {
      const fittedSub = shrinkObjectToFit(
        { [key]: val },
        (sub) => buildTight({ ...pickedFields, ...sub }, nextRemaining, fittedCodes),
        fits,
        limitChars,
        { requireNonEmptyArrays: !savedCmd, compactArrays: true },
      )
      if (fittedSub) {
        const parsedSub = JSON.parse(fittedSub)
        if (key in parsedSub && (!BLOCKING_DETAIL_KEYS.has(key) || !savedCmd ? hasNonEmptyBlockingValue(parsedSub[key]) : true)) {
          pickedFields[key] = parsedSub[key]
          pickedCount += 1
        }
      }
    }
  }

  const omittedFieldsCount = Math.max(0, orderedKeys.length - pickedCount)
  if (savedCmd) {
    // When original was saved, ALWAYS preserve `read` (plus any structured fields that fit).
    const withRead = buildTight(pickedFields, omittedFieldsCount, fittedCodes)
    if (fits(withRead)) return withRead
    const readOnly = buildTight({}, orderedKeys.length, [])
    return fits(readOnly) ? readOnly : null
  }
  // When no fallback note could be saved AND the refusal carried blocking details, require
  // at least one non-empty blocking detail to survive rather than returning a code-only
  // shell or empty blocking list with no way to read the original blocker (req 4e32d1a5).
  if (hasOriginalBlockingDetails) {
    const keptBlocking = [...BLOCKING_DETAIL_KEYS].some(
      (k) => k in pickedFields && hasNonEmptyBlockingValue(pickedFields[k]),
    )
    if (!keptBlocking) return null
  }
  if (pickedCount === 0 && fittedCodes.length === 0) return null
  const withoutRead = buildTight(pickedFields, omittedFieldsCount, fittedCodes)
  return fits(withoutRead) ? withoutRead : null
}

/** Extract structured refusal details from a thrown MCP / transport error without flattening. */
export function structuredRefusalFromError(error) {
  if (!error || typeof error !== 'object') {
    return { error: String(error ?? 'refused') }
  }
  const refusal = {
    error: error instanceof Error ? error.message : String(error.message ?? error),
  }
  for (const field of ['code', 'status', 'details', 'data', 'refusal', 'body', 'retryable']) {
    if (error[field] !== undefined) refusal[field] = error[field]
  }
  for (const [key, value] of Object.entries(error)) {
    if (key in refusal || typeof value === 'function' || key === 'stack') continue
    refusal[key] = value
  }
  if (error.cause && typeof error.cause === 'object') {
    refusal.cause = structuredRefusalFromError(error.cause)
  }
  return refusal
}

/** Whether a `report_pickup` response explicitly says DevSpec has no open attempt to start. */
function isNothingOpenResponse(res) {
  if (!res || typeof res !== 'object') return false
  return res.outcome === 'nothing_open' || res.status === 'nothing_open'
}

/** Whether a `report_pickup` response carries a refusal rather than a successful pickup. */
function pickupRefusalFromResponse(res) {
  if (!res || typeof res !== 'object') return null
  if (
    res.ok === false ||
    res.refused === true ||
    res.status === 'refused' ||
    res.outcome === 'refused' ||
    typeof res.error === 'string'
  ) {
    return res
  }
  return null
}

/**
 * Mark room commands as actually started by the agent:
 *  - deduplicates by `messageId` only after `report_pickup` succeeds (never before),
 *  - shares one wall-clock budget (`COMMAND_START_BUDGET_MS`) across stale-turn
 *    `report_complete`, single `report_pickup`, and `seedWorkTrailForConnection`,
 *  - issues at most ONE `report_pickup` call (never looping per command, req c900f599),
 *  - distinguishes `nothing_open` (no working attempt started, preserved verbatim) from
 *    refusals/errors (preserved verbatim so callers can surface & retry),
 *  - writes `.turn` marker, records `turn-commands` + transcript baseline when starting a turn,
 *  - seeds Working trail + starts CLI trail watcher when attached,
 *  - records delivered requests in `.requests.jsonl` when `batch` is provided.
 */
export async function startRoomCommands({
  connectionId,
  commands = null,
  batch = null,
  sessionId = undefined,
  dir = defaultConnectionsDir(),
  home = os.homedir(),
  state = null,
  startsTurn = null,
  fromWakeTurn = false,
  call = mcpToolsCall,
  seedFn = seedWorkTrailForConnection,
  ensureWatch = ensureCliTrailWatch,
  timeoutMs = COMMAND_START_BUDGET_MS,
  now = Date.now,
  log = (line) => process.stderr.write(line),
} = {}) {
  if (!connectionId) {
    return {
      ok: false,
      outcome: 'refused',
      started: [],
      pickedUp: 0,
      refusals: [{ code: 'missing_connection_id', error: 'missing connectionId' }],
    }
  }
  const rawCommands = Array.isArray(commands)
    ? commands
    : Array.isArray(batch?.messages)
      ? commandsHandedOver(batch.messages)
      : []
  const already = new Set(readStartedCommandIds(connectionId, dir))
  const toStart = rawCommands.filter((cmd) => cmd?.turnId && cmd?.messageId && !already.has(cmd.messageId))
  if (toStart.length === 0) return { ok: true, outcome: 'duplicate', started: [], pickedUp: 0, duplicate: true }

  let stateReadError = null
  let resolvedState = state
  if (!resolvedState) {
    const statePath = path.join(dir, `${connectionId}.json`)
    try {
      resolvedState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } catch (error) {
      stateReadError = error
      resolvedState = null
    }
  }
  if (!resolvedState || typeof resolvedState !== 'object') {
    const errCode =
      stateReadError && typeof stateReadError === 'object' && 'code' in stateReadError
        ? String(stateReadError.code)
        : 'unreadable_state'
    const errMsg =
      stateReadError instanceof Error ? stateReadError.message : 'connection state could not be read'
    const refusal = {
      code: errCode === 'ENOENT' ? 'missing_connection_state' : 'unreadable_connection_state',
      error_code: errCode,
      retryable: true,
      error: `Cannot start room command pickup because connection state could not be read (${errMsg}).`,
    }
    const primaryPending = toStart[toStart.length - 1]
    log(`command-start: connection state unreadable for ${connectionId}: ${JSON.stringify(refusal)}\n`)
    return {
      ok: false,
      outcome: 'refused',
      skipped: true,
      reason: 'no_connection_state',
      started: [],
      unstarted: toStart,
      pickedUp: 0,
      startsTurn: false,
      refusals: [
        {
          command_message_id: primaryPending.messageId,
          command_turn_id: primaryPending.turnId,
          refusal,
        },
      ],
    }
  }

  const credential = connectionCredential(resolvedState)
  const token = credential.ok ? credential.token : (resolvedState?.token || resolvedState?.mcp_token || null)
  const mcpUrl = credential.mcp_url || resolvedState?.mcp_url || null
  const attachedSessionId =
    sessionId !== undefined
      ? sessionId
      : batch && Object.hasOwn(batch, 'session_id')
        ? batch.session_id
        : (resolvedState?.session_id ?? null)

  // One shared wall-clock deadline across every network step in this command start
  // (stale-turn report_complete, report_pickup, and seedWorkTrailForConnection).
  const deadline = now() + timeoutMs
  const remainingBudgetMs = () => Math.max(0, deadline - now())

  // If a previous turn marker is stale (abandoned: no activity past TURN_SILENCE_MS,
  // or no longer live), finish the abandoned working attempt in one single report_complete
  // call (attemptEndArguments — never looping once per saved command, requirement c900f599).
  const prevMarker = readTurnMarker(connectionId, dir)
  const prevActivity = readTurnActivity(connectionId, dir)
  const staleBySilence =
    prevMarker &&
    typeof prevMarker.startedAt === 'number' &&
    now() - prevMarker.startedAt >= TURN_SILENCE_MS &&
    !prevActivity
  const prevLive = !staleBySilence && turnIsLive(prevMarker, { activity: prevActivity })
  const staleCompleteRefusals = []
  if (prevMarker && !prevLive && token && mcpUrl) {
    const staleCommands = readTurnCommands(connectionId, { dir })
    const completeArgs =
      staleCommands.length === 1
        ? {
            connection_id: connectionId,
            command_turn_id: staleCommands[0].turnId,
            command_message_id: staleCommands[0].messageId,
            reason: 'max_turn_ms',
          }
        : attemptEndArguments({ connectionId, reason: 'max_turn_ms' })
    const completeTimeout = remainingBudgetMs()
    let staleCompleteCleared = false
    if (completeTimeout > 0) {
      try {
        const completeRes = await call({
          mcpUrl,
          token,
          name: 'report_complete',
          arguments: completeArgs,
          timeoutMs: completeTimeout,
        })
        const completeRefused = pickupRefusalFromResponse(completeRes)
        if (completeRefused) {
          staleCompleteRefusals.push({
            step: 'stale_turn_report_complete',
            ...completeArgs,
            refusal: completeRefused,
          })
          log(
            `command-start: stale-turn report_complete refused for ${connectionId}: ${JSON.stringify(completeRefused)}\n`,
          )
        } else {
          staleCompleteCleared = true
        }
      } catch (error) {
        const structured = structuredRefusalFromError(error)
        staleCompleteRefusals.push({
          step: 'stale_turn_report_complete',
          ...completeArgs,
          refusal: structured,
        })
        log(
          `command-start: stale-turn report_complete failed for ${connectionId}: ${JSON.stringify(structured)}\n`,
        )
      }
    } else {
      const budgetRefusal = {
        code: 'budget_exhausted',
        retryable: true,
        budget_ms: timeoutMs,
        error: 'Command start hook budget exhausted before stale-turn report_complete.',
      }
      staleCompleteRefusals.push({
        step: 'stale_turn_report_complete',
        ...completeArgs,
        refusal: budgetRefusal,
      })
      log(
        `command-start: stale-turn report_complete budget exhausted for ${connectionId}: ${JSON.stringify(budgetRefusal)}\n`,
      )
    }
    if (staleCompleteCleared) {
      clearTurnMarker(connectionId, dir)
    }
  }

  if (staleCompleteRefusals.length > 0) {
    return {
      ok: false,
      outcome: 'refused',
      started: [],
      pickedUp: 0,
      startsTurn: false,
      refusals: staleCompleteRefusals,
    }
  }

  const effectiveStartsTurn = typeof startsTurn === 'boolean' ? startsTurn : !prevLive

  if (batch) {
    try {
      recordDeliveredBatchRequests(connectionId, batch, { dir })
    } catch {
      /* ignore */
    }
  }

  // Pick up the single primary (latest) command in one single report_pickup call — never
  // looping one database-backed pickup per accumulated command (requirement c900f599).
  // Advance started-command state ONLY for the exact command DevSpec picked up — never
  // marking older still-waiting commands in the batch as started (requirement 3ea2b201) —
  // and preserve full structured refusal / nothing_open payloads verbatim (req 4e32d1a5).
  const primary = toStart[toStart.length - 1]
  const unstarted = toStart.slice(0, -1)
  const succeeded = []
  const refusals = []
  const nothingOpen = []
  let pickupResponse = null

  if (!token || !mcpUrl) {
    const refusal = { code: 'missing_credentials', error: 'No DevSpec credentials available for report_pickup.' }
    refusals.push({ command_message_id: primary.messageId, command_turn_id: primary.turnId, refusal })
    log(`command-start: report_pickup skipped for ${connectionId}: ${JSON.stringify(refusal)}\n`)
  } else {
    const pickupTimeout = remainingBudgetMs()
    if (pickupTimeout <= 0) {
      const refusal = {
        code: 'budget_exhausted',
        retryable: true,
        budget_ms: timeoutMs,
        error: 'Command start hook budget exhausted before report_pickup.',
      }
      refusals.push({ command_message_id: primary.messageId, command_turn_id: primary.turnId, refusal })
      log(`command-start: report_pickup budget exhausted for ${connectionId} (${primary.messageId}): ${JSON.stringify(refusal)}\n`)
    } else {
      try {
        const res = await call({
          mcpUrl,
          token,
          name: 'report_pickup',
          arguments: pickupArguments(connectionId, primary),
          timeoutMs: pickupTimeout,
        })
        pickupResponse = res
        const refused = pickupRefusalFromResponse(res)
        if (refused) {
          const entry = { command_message_id: primary.messageId, command_turn_id: primary.turnId, refusal: refused }
          refusals.push(entry)
          log(`command-start: report_pickup refused for ${connectionId} (${primary.messageId}): ${JSON.stringify(refused)}\n`)
        } else if (isNothingOpenResponse(res)) {
          const entry = { command_message_id: primary.messageId, command_turn_id: primary.turnId, response: res }
          nothingOpen.push(entry)
          log(`command-start: report_pickup nothing_open for ${connectionId} (${primary.messageId}): ${JSON.stringify(res)}\n`)
        } else {
          succeeded.push(primary)
        }
      } catch (error) {
        const structured = structuredRefusalFromError(error)
        const entry = { command_message_id: primary.messageId, command_turn_id: primary.turnId, refusal: structured }
        refusals.push(entry)
        log(`command-start: report_pickup failed for ${connectionId} (${primary.messageId}): ${JSON.stringify(structured)}\n`)
      }
    }
  }

  // Advance started-command state ONLY when report_pickup genuinely started an attempt.
  if (succeeded.length > 0) {
    recordStartedCommandIds(connectionId, succeeded.map((cmd) => cmd.messageId), dir)
    if (effectiveStartsTurn) {
      const marker = writeTurnMarker(connectionId, dir, now())
      recordTurnCommands(connectionId, succeeded, { dir })
      const conversationId = resolvedState?.local_id || null
      if (conversationId && marker?.startedAt) {
        const transcriptPath = resolveAgentTranscriptPath(conversationId, { home })
        recordTurnBaseline(connectionId, {
          turn: marker.startedAt,
          conversationId,
          transcriptPath,
          dir,
          beforeCurrentCommandTurn: fromWakeTurn,
        })
      }
    }
    const seedTimeout = remainingBudgetMs()
    if (attachedSessionId && token && mcpUrl && seedTimeout > 0) {
      try {
        await seedFn({
          connectionId,
          mcpUrl,
          token,
          agentName: resolvedState?.agent_name || AGENT_NAME,
          timeoutMs: seedTimeout,
        })
      } catch (error) {
        log(`command-start: seedWorkTrailForConnection failed for ${connectionId}: ${JSON.stringify(structuredRefusalFromError(error))}\n`)
      }
    }
    if (attachedSessionId) {
      try {
        ensureWatch({ connectionId })
      } catch {
        /* ignore */
      }
    }
  }

  if (nothingOpen.length > 0) {
    // Record the checked `nothing_open` command id so a subsequent read retries any
    // older `unstarted` command(s) rather than looping forever on the closed newest one
    // (requirements 3ea2b201 / 3c5147a7 / 91d7b47c).
    recordStartedCommandIds(connectionId, [primary.messageId], dir)
    return {
      ok: false,
      outcome: 'nothing_open',
      started: [],
      ...(unstarted.length > 0 ? { unstarted } : {}),
      pickedUp: 0,
      startsTurn: false,
      nothingOpen,
      response: pickupResponse,
    }
  }

  return {
    ok: refusals.length === 0,
    outcome: refusals.length === 0 ? (pickupResponse?.outcome ?? 'picked_up') : 'refused',
    started: succeeded,
    ...(succeeded.length > 0 && unstarted.length > 0 ? { unstarted } : {}),
    pickedUp: succeeded.length > 0 ? 1 : 0,
    startsTurn: succeeded.length > 0 ? effectiveStartsTurn : false,
    ...(pickupResponse && refusals.length === 0 ? { response: pickupResponse } : {}),
    ...(refusals.length > 0 ? { refusals } : {}),
  }
}
