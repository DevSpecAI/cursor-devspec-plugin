/**
 * Register a terminal-typed Cursor turn as the connection's current request when
 * Cursor CLI skips the plugin's `beforeSubmitPrompt` hook (item da03801e).
 *
 * Cursor CLI does not invoke a plugin's `beforeSubmitPrompt` or `stop` hook unless
 * the person also declares them in their own hooks file (`transcript-turn-end.mjs`).
 * Cursor always writes the typed `<user_query>` row into the conversation's JSONL
 * transcript before invoking the model, and appends `turn_ended` when the turn ends.
 *
 * Both the continuous poller (on its local transcript tick) and `project-input.mjs`
 * (synchronously before DevSpec MCP writes, which Cursor CLI always runs) call
 * `syncTypedTurnFromTranscript`. A per-connection lock ensures at most one `typed_prompt`
 * request is opened per transcript turn, and a hook-opened `typed_prompt` (when the
 * person does have `beforeSubmitPrompt` active) is adopted rather than duplicated.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendRequestEvent,
  closeRequest,
  NO_REQUEST,
  notifiedKeys,
  openRequest,
  promptArrival,
  readRequestState,
  requestFinished,
  requestForWake,
  requestsWithWorkPending,
  rotateRequestLog,
  UNSTATED,
} from './requests.mjs'
import { activeTranscriptTurn, STABLE_READ_ATTEMPTS } from './transcript-turn-end.mjs'
import { localTurnScope, localTurnToComplete, startLocalTurn } from './local-turn.mjs'
import { completionArguments } from './turn-commands.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const DEFAULT_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/**
 * Total wall-clock budget for synchronous `preToolUse` typed-turn sync (`project-input.mjs`).
 * Enforced as one shared deadline across lock wait, `report_request`, and `report_pickup`
 * (including its single retry) so the entire sync stays safely inside `project-input.mjs`'s
 * 5-second fail-closed timeout in `hooks/hooks.json` with 1.5 s headroom for Node startup
 * and hook stdout flushing.
 */
export const TYPED_SYNC_HOOK_BUDGET_MS = 3_500

/**
 * Shared timeout for background typed-turn sync and idle request close calls
 * (`devspec-remote-poll.mjs`, `mark-explicit-reply.mjs`). Matches the plugin's
 * 5-second background MCP call budget (`commit-reports.mjs`, `step-delivery.mjs`
 * `CHECK_JOB_LOOKUP_MS`).
 */
export const TYPED_SYNC_BACKGROUND_TIMEOUT_MS = 5_000

/**
 * File-lock retry cadence, matching `private-state.mjs` and `step-delivery.mjs`
 * (`LOCK_RETRY_MS = 20`) so concurrent hook and poller writers settle quickly
 * without busy-spinning.
 */
export const TYPED_SYNC_LOCK_RETRY_MS = 20

/**
 * Maximum time a caller waits for the per-connection typed-sync lock. Bounded below
 * `TYPED_SYNC_HOOK_BUDGET_MS` (3.5 s) so a `preToolUse` hook waiting on a concurrent
 * sync cannot overrun its 5-second Cursor hook timeout.
 */
export const TYPED_SYNC_LOCK_WAIT_MS = 2_000

/**
 * Synthesise `sessionCrons` from the connection's own recorded schedules when the
 * caller does not receive a host schedule list (outside Cursor's `stop` hook).
 * Keeps requests whose scheduled wake is still recorded from being closed early.
 */
export function recordedSessionCrons(reqState) {
  if (!Array.isArray(reqState?.schedules) || reqState.schedules.length === 0) return []
  return reqState.schedules.map((schedule) => ({
    ...(schedule.id ? { id: schedule.id } : {}),
    ...(typeof schedule.prompt === 'string' ? { prompt: schedule.prompt } : {}),
  }))
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function lockPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.typed-sync.lock`)
}

async function withTypedSyncLock(connectionId, dir, work, { deadlineMs = null } = {}) {
  const target = lockPath(connectionId, dir)
  const mine = `${target}.${process.pid}-${randomBytes(4).toString('hex')}`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 })
  const maxDeadline = Date.now() + TYPED_SYNC_LOCK_WAIT_MS
  const deadline = typeof deadlineMs === 'number' ? Math.min(maxDeadline, deadlineMs) : maxDeadline
  let acquired = false
  try {
    while (Date.now() < deadline) {
      try {
        fs.linkSync(mine, target)
        acquired = true
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      let holder = null
      try {
        holder = Number(fs.readFileSync(target, 'utf8'))
      } catch {
        continue
      }
      if (Number.isSafeInteger(holder) && holder > 0 && !pidAlive(holder)) {
        fs.rmSync(target, { force: true })
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      sleepSync(Math.min(TYPED_SYNC_LOCK_RETRY_MS, remaining))
    }
  } finally {
    fs.rmSync(mine, { force: true })
  }
  if (!acquired) return null
  try {
    return await work()
  } finally {
    fs.rmSync(target, { force: true })
  }
}

function fileStamp(file) {
  if (typeof file !== 'string' || !file) return null
  try {
    const stat = fs.statSync(file)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * Cheap stat check for the poller's `shouldWakeImmediately`: true when the transcript
 * has changed since the last completed sync OR when the previous sync attempt did not
 * finish cleanly (`memo.synced !== true`, e.g. refused open/admission/write — req 3ea2b201).
 */
export function typedTurnSyncPending({ transcriptPath, memo = null, connectionId = null, dir = DEFAULT_DIR } = {}) {
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return false
  const reqFile = connectionId ? path.join(dir, `${connectionId}.requests.jsonl`) : memo?.reqFile ?? null
  const reqStamp = reqFile ? (fileStamp(reqFile) ?? '') : (memo?.reqStamp ?? '')
  if (memo && memo.stamp === stamp && (memo.reqStamp ?? '') === reqStamp && memo.synced === true) return false
  return true
}

/**
 * Record the connect turn's own typed prompt (and any pre-connect typed turns already
 * present in the transcript) as observed so `/devspec-remote` and historical pre-connect
 * turns do not open stray `typed_prompt` requests right as the connection starts.
 */
export function recordConnectTurnBaseline(connectionId, transcriptPath, { dir = DEFAULT_DIR, attempts = STABLE_READ_ATTEMPTS } = {}) {
  if (!connectionId || !transcriptPath) return false
  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active) return false
  const keys =
    Array.isArray(active.typedTurnKeys) && active.typedTurnKeys.length > 0
      ? active.typedTurnKeys
      : active.kind === 'typed' && active.key
        ? [active.key]
        : []
  if (keys.length === 0) return false
  const reqState = readRequestState(connectionId, { dir })
  if (reqState.readError) return false
  let wrote = false
  for (const key of keys) {
    if (reqState.seenTranscriptTurns.has(key)) continue
    if (appendRequestEvent(connectionId, { op: 'transcript_turn', key, ref: null }, { dir })) {
      wrote = true
    }
  }
  return wrote
}

/**
 * Whether `reqState.current` is an open `typed_prompt` not yet bound to any earlier
 * transcript turn (either opened by the `beforeSubmitPrompt` hook or opened on an
 * earlier attempt whose room admission has not yet succeeded).
 */
function unboundOpenTypedPrompt(reqState) {
  if (!reqState?.current) return null
  const info = reqState.open.get(reqState.current)
  if (!info || info.kind !== 'typed_prompt') return null
  for (const boundRef of reqState.seenTranscriptTurns.values()) {
    if (boundRef === reqState.current) return null
  }
  return reqState.current
}

/**
 * Whether a live, unanswered room command owns the currently running turn (in which case
 * a typed prompt or wake added during it joins the turn rather than silently replacing it).
 * Once the transcript has positively recorded `turn_ended` before the current turn started,
 * a lingering `.turn` marker from that ended room command never makes the new turn look
 * like part of the ended room command (decision ce71a72b).
 */
function hasActiveRemoteCommandTurn(connectionId, reqState, dir, active = null) {
  if (!reqState?.current || active?.precededByTurnEnded || active?.liveTurnPrecededByTurnEnded) return false
  const info = reqState.open.get(reqState.current)
  if (!info || info.kind !== 'command' || info.answered) return false
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, `${connectionId}.turn`), 'utf8'))
    return marker?.remoteTurn === true
  } catch {
    return false
  }
}

/**
 * Whether a live terminal-typed turn (not already separated by `turn_ended` and not
 * restored from a prior wake) owns the currently running turn so a mid-turn background
 * completion joins it rather than replacing it and erasing two-person attribution
 * (decision ce71a72b).
 */
function hasActiveTypedTurn(reqState, active) {
  if (!reqState?.current || active?.precededByTurnEnded) return false
  if (active?.liveTurnPrecededByTurnEnded && !active?.liveTurnTypedKey) return false
  if (reqState.currentFromWake || reqState.currentBoundByWake) return false
  return reqState.open.get(reqState.current)?.kind === 'typed_prompt'
}

/**
 * Extract structured refusal details from a thrown MCP / transport error without
 * flattening them to a plain sentence (requirement 4e32d1a5).
 */
export function structuredRefusalFromError(error) {
  if (!error || typeof error !== 'object') {
    return { error: String(error ?? 'refused') }
  }
  const refusal = {
    error: error instanceof Error ? error.message : String(error.message ?? error),
  }
  for (const field of ['code', 'serverCode', 'status', 'retryable', 'credentialType', 'details', 'data', 'refusal', 'notices', 'body']) {
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

/** Whether an MCP tool result object carries a structured refusal rather than success. */
export function refusalFromResponse(res) {
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

const CONFIRMED_COMPLETE_OUTCOMES = new Set(['completed', 'stopped', 'already_finalized', 'nothing_open'])
const CONFIRMED_CLOSED_AS = new Set(['completed', 'stopped', 'done'])

/**
 * Whether a `report_complete` reply positively confirms DevSpec closed (or had already
 * finalized) the attempt (requirement 3ea2b201). Rejects empty, bare `{ ok: true }`,
 * or unexpected replies so idle cleanup keeps local_turn queued for retry instead of
 * erasing retry state and closing the request.
 */
function isConfirmedCompleteResponse(res) {
  if (!res || typeof res !== 'object') return false
  if (res.phase === 'done') return true
  if (res.already_finalized === true) return true
  if (typeof res.closed_as === 'string' && CONFIRMED_CLOSED_AS.has(res.closed_as)) return true
  if (typeof res.outcome === 'string' && CONFIRMED_COMPLETE_OUTCOMES.has(res.outcome)) return true
  return false
}

/**
 * Process-local retry cache for requests that DevSpec already opened (`status: 'open'`)
 * when local `appendRequestEvent` failed transiently. Keyed by resolved dir, connection
 * id, and transcript turn key so retries persist the already-opened server request
 * instead of opening a second orphaned request on DevSpec (requirement 3ea2b201).
 */
const pendingLocalOpens = new Map()
/**
 * Tracks all typed turn keys whose registration failed/was refused per
 * `<resolvedDir>|<connectionId>` in FIFO order, so neither turn_ended nor a
 * subsequent successful typed turn ever drops an earlier failed turn or marks
 * the transcript synced before every failed turn has been retried and completed
 * (requirement 3ea2b201).
 */
const failedTypedTurnKeys = new Map()

function pendingOpenKey(dir, connectionId, turnKey) {
  return `${path.resolve(dir)}|${connectionId}|${turnKey}`
}

function pendingOpensSidecarPath(dir, connectionId) {
  return path.join(dir, `${connectionId}.pending-opens.json`)
}

function pendingOpensFallbackPath(dir, connectionId) {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  const digest = createHash('sha256').update(`${path.resolve(dir)}|${connectionId}`).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `devspec-pending-opens-${uid}`, `${digest}.json`)
}

function readPendingOpensFileDetailed(filePath, { verifyOwnerDir = false } = {}) {
  try {
    if (verifyOwnerDir) {
      let dirStat
      try {
        dirStat = fs.lstatSync(path.dirname(filePath))
      } catch (dirErr) {
        return dirErr?.code === 'ENOENT' ? { entries: {}, readError: null } : { entries: {}, readError: dirErr }
      }
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { entries: {}, readError: null }
      if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) return { entries: {}, readError: null }
    }
    let raw
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch (readErr) {
      return readErr?.code === 'ENOENT' ? { entries: {}, readError: null } : { entries: {}, readError: readErr }
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { entries: {}, readError: new Error(`invalid pending-opens JSON at ${filePath}`) }
    }
    return { entries: parsed, readError: null }
  } catch (error) {
    return { entries: {}, readError: error }
  }
}

function readPendingOpensFile(filePath, { verifyOwnerDir = false } = {}) {
  return readPendingOpensFileDetailed(filePath, { verifyOwnerDir }).entries
}

function writePendingOpensFile(filePath, entriesObj, { verifyOwnerDir = false } = {}) {
  const keys = Object.keys(entriesObj)
  if (keys.length === 0) {
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
      return !fs.existsSync(filePath)
    } catch {
      return false
    }
  }
  try {
    if (verifyOwnerDir) {
      const baseDir = path.dirname(filePath)
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
      try {
        fs.chmodSync(baseDir, 0o700)
      } catch {
        /* ignore on platforms without POSIX modes */
      }
      const dirStat = fs.lstatSync(baseDir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return false
      if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) return false
    }
    writePrivateJson(filePath, entriesObj)
    return true
  } catch {
    return false
  }
}

/**
 * Persist a server-opened typed request whose local `requests.jsonl` append failed so
 * even a separate OS process (such as a fresh poller starting after `turn_ended`) sees
 * and flushes the open record instead of marking the transcript synced (req 3ea2b201).
 */
function savePendingLocalOpen(dir, connectionId, entry) {
  if (!entry?.requestId || !entry?.turnKey) return
  const pKey = pendingOpenKey(dir, connectionId, entry.turnKey)
  pendingLocalOpens.set(pKey, entry)
  const primaryPath = pendingOpensSidecarPath(dir, connectionId)
  const fallbackPath = pendingOpensFallbackPath(dir, connectionId)
  const merged = {
    ...readPendingOpensFile(fallbackPath, { verifyOwnerDir: true }),
    ...readPendingOpensFile(primaryPath),
    [entry.turnKey]: entry,
  }
  if (!writePendingOpensFile(primaryPath, merged)) {
    writePendingOpensFile(fallbackPath, merged, { verifyOwnerDir: true })
  }
}

function deletePendingLocalOpen(dir, connectionId, pKey, turnKey = null, requestId = null) {
  let ok = true
  let error = null
  for (const [filePath, verifyOwnerDir] of [
    [pendingOpensSidecarPath(dir, connectionId), false],
    [pendingOpensFallbackPath(dir, connectionId), true],
  ]) {
    const detailed = readPendingOpensFileDetailed(filePath, { verifyOwnerDir })
    if (detailed.readError) {
      ok = false
      error ??= detailed.readError
      continue
    }
    const existing = detailed.entries
    let changed = false
    for (const [k, v] of Object.entries(existing)) {
      if ((turnKey && k === turnKey) || (requestId && v?.requestId === requestId)) {
        delete existing[k]
        changed = true
      }
    }
    if (changed) {
      const wrote = writePendingOpensFile(filePath, existing, { verifyOwnerDir })
      if (!wrote) {
        ok = false
        error ??= new Error(`failed to remove pending-open entry from ${filePath}`)
      }
    }
  }
  if (ok) {
    if (pKey) pendingLocalOpens.delete(pKey)
    if (turnKey) pendingLocalOpens.delete(pendingOpenKey(dir, connectionId, turnKey))
  }
  return { ok, ...(error ? { error } : {}) }
}

function getPendingLocalOpen(dir, connectionId, turnKey) {
  const pKey = pendingOpenKey(dir, connectionId, turnKey)
  const mem = pendingLocalOpens.get(pKey)
  if (mem) return mem
  const persisted =
    readPendingOpensFile(pendingOpensSidecarPath(dir, connectionId))[turnKey] ??
    readPendingOpensFile(pendingOpensFallbackPath(dir, connectionId), { verifyOwnerDir: true })[turnKey] ??
    null
  if (persisted?.requestId && persisted?.turnKey) {
    pendingLocalOpens.set(pKey, persisted)
    return persisted
  }
  return null
}

function failedTurnKey(dir, connectionId) {
  return `${path.resolve(dir)}|${connectionId}`
}

function recordFailedTypedTurn(dir, connectionId, turnKey) {
  if (!turnKey) return
  const fKey = failedTurnKey(dir, connectionId)
  let set = failedTypedTurnKeys.get(fKey)
  if (!set) {
    set = new Set()
    failedTypedTurnKeys.set(fKey, set)
  }
  set.add(turnKey)
  // Persist the failed typed turn key in the shared per-connection request log so
  // separate processes (e.g. a refused preToolUse hook followed by the continuous poller
  // after turn_ended) still see and retry the refused turn (requirement 3ea2b201).
  const reqState = readRequestState(connectionId, { dir })
  if (!reqState.seenTranscriptTurns.has(turnKey) && !reqState.failedTranscriptTurns.has(turnKey)) {
    appendRequestEvent(connectionId, { op: 'typed_turn_failed', key: turnKey }, { dir })
  }
}

function clearFailedTypedTurn(dir, connectionId, turnKey) {
  const fKey = failedTurnKey(dir, connectionId)
  const set = failedTypedTurnKeys.get(fKey)
  if (!set) return
  set.delete(turnKey)
  if (set.size === 0) failedTypedTurnKeys.delete(fKey)
}

function allPendingFailedTypedTurnsDetailed(dir, connectionId) {
  const combined = new Set()
  const reqState = readRequestState(connectionId, { dir })
  const readError = reqState.readError ?? null
  for (const key of reqState.failedTranscriptTurns) {
    if (!reqState.seenTranscriptTurns.has(key)) combined.add(key)
  }
  const mem = failedTypedTurnKeys.get(failedTurnKey(dir, connectionId))
  if (mem) {
    for (const key of mem) {
      if (!reqState.seenTranscriptTurns.has(key)) combined.add(key)
    }
  }
  return { keys: combined, readError }
}

function allPendingFailedTypedTurns(dir, connectionId) {
  return allPendingFailedTypedTurnsDetailed(dir, connectionId).keys
}

function hasPendingFailedTypedTurns(dir, connectionId) {
  const detailed = allPendingFailedTypedTurnsDetailed(dir, connectionId)
  return Boolean(detailed.readError) || detailed.keys.size > 0
}

function nextQueuedFailedTypedTurnDetailed(dir, connectionId, excludeKey = null) {
  const detailed = allPendingFailedTypedTurnsDetailed(dir, connectionId)
  if (detailed.readError) {
    return { key: null, readError: detailed.readError }
  }
  for (const key of detailed.keys) {
    if (key !== excludeKey) return { key, readError: null }
  }
  return { key: null, readError: null }
}

function isFailedTurnDeterministicId(dir, connectionId, requestId, excludeKey) {
  const detailed = allPendingFailedTypedTurnsDetailed(dir, connectionId)
  if (detailed.readError) return true
  for (const key of detailed.keys) {
    if (key !== excludeKey && deterministicTypedTurnRequestId(connectionId, key) === requestId) {
      return true
    }
  }
  return false
}

function flushPendingLocalOpenEntry(connectionId, dir, pKey, entry) {
  const reqState = readRequestState(connectionId, { dir })
  // Never treat a transient read failure (e.g. write-only/EACCES/EBUSY) as an empty
  // request log here, or restoring `fg.current = null` would wipe a live room command
  // from another person and mark the older turn synced (3ea2b201 / ce71a72b).
  if (reqState.readError) return false
  // If this recovered request was ALREADY recorded closed in `.requests.jsonl` (for example
  // because an earlier idle sweep closed it on DevSpec and locally, then failed to remove
  // the on-disk `.pending-opens.json` entry), NEVER re-open the closed request into `open`:
  // retry removing the stale recovery entry instead (requirement 3ea2b201).
  if (reqState.closed?.has(entry.requestId)) {
    const removed = deletePendingLocalOpen(dir, connectionId, pKey, entry.turnKey, entry.requestId)
    if (!removed.ok) return false
    clearFailedTypedTurn(dir, connectionId, entry.turnKey)
    return true
  }
  if (!reqState.open.has(entry.requestId)) {
    const ok = appendRequestEvent(
      connectionId,
      {
        op: 'open',
        id: entry.requestId,
        kind: 'typed_prompt',
        ...(entry.requestedBy ? { requested_by: entry.requestedBy } : {}),
      },
      { dir },
    )
    if (!ok) return false
  }
  // Mark the recovered open request as started without leaving it as foreground
  // current (and preserving any unrelated foreground request) so finishIdleRequests
  // recognises it via requestFinished() and closes it on DevSpec (req 3ea2b201).
  // Persist restoreForeground on the pending entry so if a disk error interrupts
  // after marking started, retry still restores the prior foreground state before
  // completing sync.
  if (!reqState.started.has(entry.requestId) || entry.restoreForeground) {
    const fg = entry.restoreForeground ?? {
      current: reqState.current,
      fromWake: reqState.currentFromWake,
      boundByWake: reqState.currentBoundByWake,
      wakeNotifiedKeys: [...(reqState.currentWakeNotifiedKeys ?? [])],
      joined: [...reqState.joined],
      chosen: Boolean(reqState.chosen),
      currentRestored: false,
    }
    if (!reqState.started.has(entry.requestId)) {
      const startedOk = appendRequestEvent(
        connectionId,
        { op: 'current', ref: entry.requestId },
        { dir },
      )
      if (!startedOk) return false
      entry.restoreForeground = fg
      savePendingLocalOpen(dir, connectionId, entry)
    }
    if (!fg.currentRestored) {
      if (reqState.current === entry.requestId || !reqState.started.has(entry.requestId)) {
        const restoredOk = appendRequestEvent(
          connectionId,
          {
            op: 'current',
            ref: fg.current,
            ...(fg.fromWake && fg.current !== null ? { from_wake: true } : {}),
            ...(fg.boundByWake && fg.current !== null ? { bound_by_wake: true } : {}),
            ...(fg.fromWake && fg.current !== null && Array.isArray(fg.wakeNotifiedKeys) && fg.wakeNotifiedKeys.length > 0
              ? { wake_notified_keys: fg.wakeNotifiedKeys }
              : {}),
          },
          { dir },
        )
        if (!restoredOk) return false
        fg.currentRestored = true
        savePendingLocalOpen(dir, connectionId, entry)
      } else {
        // A newer foreground turn already replaced `current` before retry;
        // do not overwrite it with older foreground state.
        delete entry.restoreForeground
      }
    }
    if (entry.restoreForeground) {
      // Re-read the request log AFTER `{ op: 'current', ... }` (which resets `joined`
      // and `chosen`), never comparing against the stale pre-flush snapshot, and ONLY
      // restore `joined` / `serve` when `fg.current` is STILL the active foreground
      // request. If recovery was interrupted after `currentRestored: true` and a
      // different live turn replaced `current` before retry, NEVER reapply the older
      // turn's `joined` or `serve` selection onto the new turn (decision ce71a72b).
      const afterRestore = readRequestState(connectionId, { dir })
      if (afterRestore.readError) return false
      const stillSameForeground =
        afterRestore.current === fg.current &&
        (fg.current === null ||
          fg.current === NO_REQUEST ||
          (afterRestore.open.has(fg.current) && !afterRestore.open.get(fg.current)?.answered))
      if (stillSameForeground) {
        for (const joinedId of fg.joined) {
          if (afterRestore.joined.has(joinedId)) continue
          if (
            joinedId !== NO_REQUEST &&
            joinedId !== UNSTATED &&
            (!afterRestore.open.has(joinedId) || afterRestore.open.get(joinedId)?.answered)
          ) {
            continue
          }
          if (!appendRequestEvent(connectionId, { op: 'joined', id: joinedId }, { dir })) {
            return false
          }
        }
        if (fg.chosen && !afterRestore.chosen) {
          const serveRef = fg.current === null ? UNSTATED : fg.current
          if (!appendRequestEvent(connectionId, { op: 'serve', ref: serveRef }, { dir })) {
            return false
          }
        }
      }
      delete entry.restoreForeground
      savePendingLocalOpen(dir, connectionId, entry)
    }
  }
  const removed = deletePendingLocalOpen(dir, connectionId, pKey, entry.turnKey, entry.requestId)
  if (!removed.ok) return false
  if (entry.turnKey && !reqState.seenTranscriptTurns.has(entry.turnKey)) {
    const boundOk = appendRequestEvent(
      connectionId,
      { op: 'transcript_turn', key: entry.turnKey, ref: entry.requestId },
      { dir },
    )
    if (!boundOk) {
      savePendingLocalOpen(dir, connectionId, entry)
      return false
    }
  }
  clearFailedTypedTurn(dir, connectionId, entry.turnKey)
  return true
}

/**
 * Pending requests when the caller has NO host `background_tasks` or `session_crons`
 * list (e.g. poller idle cleanup or explicit-reply hook): preserves both recorded
 * schedules (`recordedSessionCrons`) AND recorded `Monitor` launches (`kind: 'monitor'`,
 * which emit recurring event wakes without a terminal completion notice, `notifies: false`),
 * so idle cleanup never closes a request after a monitor's first event while the monitor
 * can still fire again (decision ce71a72b).
 */
export function pendingWorkWithoutHostLists(reqState) {
  const sessionCrons = recordedSessionCrons(reqState)
  const pending = requestsWithWorkPending(reqState, { sessionCrons })
  for (const launch of new Set(reqState.launches.values())) {
    if (launch.kind === 'monitor') {
      for (const id of [launch.request, ...(launch.also ?? [])]) {
        if (reqState.open.has(id)) pending.add(id)
      }
    }
  }
  return pending
}

function pendingOpensForConnectionDetailed(dir, connectionId) {
  const prefix = `${path.resolve(dir)}|${connectionId}|`
  const byKey = new Map()
  let readError = null
  for (const [filePath, verifyOwnerDir] of [
    [pendingOpensFallbackPath(dir, connectionId), true],
    [pendingOpensSidecarPath(dir, connectionId), false],
  ]) {
    const detailed = readPendingOpensFileDetailed(filePath, { verifyOwnerDir })
    if (detailed.readError && !readError) readError = detailed.readError
    for (const [turnKey, entry] of Object.entries(detailed.entries)) {
      if (entry?.requestId && (entry?.turnKey || turnKey)) {
        const normalized = { ...entry, turnKey: entry.turnKey || turnKey }
        byKey.set(pendingOpenKey(dir, connectionId, normalized.turnKey), normalized)
      }
    }
  }
  for (const [key, entry] of pendingLocalOpens) {
    if (key.startsWith(prefix)) byKey.set(key, entry)
  }
  return { entries: [...byKey.entries()], readError }
}

function pendingOpensForConnection(dir, connectionId) {
  return pendingOpensForConnectionDetailed(dir, connectionId).entries
}

/**
 * Deterministic RFC-4122 UUID derived from `(connectionId, turnKey)` so even a
 * cross-process retry after a transient local persistence failure re-sends the same
 * `request_id` to DevSpec rather than opening a second server request (req 3ea2b201).
 */
export function deterministicTypedTurnRequestId(connectionId, turnKey) {
  const hash = createHash('sha256').update(`devspec:typed_prompt:${connectionId}:${turnKey}`).digest()
  hash[6] = (hash[6] & 0x0f) | 0x40
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Open a `typed_prompt` request while preserving any structured refusal payload from
 * `report_request` — whether returned as a non-open object or thrown as an MCP/HTTP
 * error (requirement 4e32d1a5). Distinguishes local persistence failure after DevSpec
 * accepted the open so callers never mark the turn synced (requirement 3ea2b201).
 */
async function openTypedRequestPreservingRefusal({ connectionId, callRequest, dir, id = undefined }) {
  let lastResponse = null
  let lastError = null
  const wrappedCall = async (args) => {
    lastResponse = null
    lastError = null
    try {
      const res = await callRequest(args)
      lastResponse = res
      return res
    } catch (error) {
      lastError = error
      throw error
    }
  }
  const requestId = await openRequest({
    connectionId,
    kind: 'typed_prompt',
    call: wrappedCall,
    dir,
    ...(id ? { id } : {}),
  })
  if (requestId) return { ok: true, requestId, refusal: null, localPersistFailed: false }
  if (lastResponse && typeof lastResponse === 'object' && lastResponse.status === 'open') {
    return {
      ok: false,
      requestId: lastResponse.request_id ?? null,
      requestedBy: typeof lastResponse.requested_by_user_id === 'string' ? lastResponse.requested_by_user_id : null,
      localPersistFailed: true,
      refusal: {
        code: 'local_open_persist_failed',
        error: 'DevSpec opened request but local open record failed to persist',
        request_id: lastResponse.request_id ?? null,
      },
    }
  }
  const refusal =
    lastResponse && typeof lastResponse === 'object'
      ? lastResponse
      : lastError !== null
        ? structuredRefusalFromError(lastError)
        : { status: 'refused' }
  return { ok: false, requestId: null, requestedBy: null, refusal, localPersistFailed: false }
}

/**
 * Admit the terminal turn while preserving any structured refusal payload from
 * `report_pickup` — whether returned normally or thrown as a structured MCP error
 * (never flattening refusals to null or plain sentences).
 */
async function admitLocalTurnPreservingRefusal({ scope, previousAttemptId, callPickup }) {
  let lastResponse = null
  let lastError = null
  const wrappedCall = async (args) => {
    // Clear prior attempt state on every call so a retry refusal (returned or thrown)
    // is never shadowed by an earlier attempt's response (requirement 4e32d1a5).
    lastResponse = null
    lastError = null
    try {
      const res = await callPickup(args)
      lastResponse = res
      return res
    } catch (error) {
      lastError = error
      throw error
    }
  }
  const admitted = await startLocalTurn({
    scope,
    previousAttemptId,
    call: wrappedCall,
  })
  if (admitted) return { ok: true, admitted, refusal: null }
  const refusal =
    lastResponse && typeof lastResponse === 'object'
      ? lastResponse
      : lastError !== null
        ? structuredRefusalFromError(lastError)
        : { status: 'refused' }
  return { ok: false, admitted: null, refusal }
}

/**
 * Ensure a live terminal-typed turn in `transcriptPath` is recorded as a `typed_prompt`
 * request in `<connectionId>.requests.jsonl` (and admitted via `startLocalTurn` when
 * attached to a room). Advances `seenTranscriptTurns` and `memo.synced` only after
 * request opening, room admission (when required), state persistence, and binding write
 * all succeed. Also clears any lingering unrelated `typed_prompt` from foreground
 * `current` on a non-typed wake (preserving any `typed_prompt` with pending background
 * or scheduled-wake continuations).
 */
export async function syncTypedTurnFromTranscript({
  connectionId,
  transcriptPath,
  state = null,
  connectionCapability = null,
  callRequest = null,
  callPickup = null,
  patchState = null,
  dir = DEFAULT_DIR,
  memo = null,
  attempts = STABLE_READ_ATTEMPTS,
  budgetMs = null,
  log = (line) => process.stderr.write(line),
} = {}) {
  if (!connectionId || !transcriptPath) return { action: 'none' }
  const deadlineMs = typeof budgetMs === 'number' && budgetMs > 0 ? Date.now() + budgetMs : null
  const remainingMs = () => (deadlineMs === null ? null : deadlineMs - Date.now())
  const boundedCall = (fn) => {
    if (typeof fn !== 'function') return null
    if (deadlineMs === null) return fn
    return async (args) => {
      const rem = remainingMs()
      if (rem <= 0) {
        throw Object.assign(new Error('typed-turn sync budget exhausted'), { code: 'sync_budget_exhausted', budget_ms: budgetMs })
      }
      return fn(args, rem)
    }
  }
  const effectiveCallRequest = boundedCall(callRequest)
  const effectiveCallPickup = boundedCall(callPickup)

  let sawRequestLogReadError = false
  const isBlockingReadError = (err) => {
    if (!err) return false
    sawRequestLogReadError = true
    return true
  }
  const canMarkSynced = () => {
    if (sawRequestLogReadError) return false
    const failedLookup = allPendingFailedTypedTurnsDetailed(dir, connectionId)
    if (failedLookup.readError) {
      sawRequestLogReadError = true
      return false
    }
    if (failedLookup.keys.size > 0) return false
    const pendingLookup = pendingOpensForConnectionDetailed(dir, connectionId)
    if (pendingLookup.readError) {
      sawRequestLogReadError = true
      return false
    }
    if (pendingLookup.entries.length > 0) return false
    if (readRequestState(connectionId, { dir }).readError) {
      sawRequestLogReadError = true
      return false
    }
    return true
  }

  const retryQueuedFailedTurn = async ({ excludeKey = null } = {}) => {
    const pendingLookup = pendingOpensForConnectionDetailed(dir, connectionId)
    const pendingEntries = pendingLookup.entries.filter(
      ([, entry]) => !excludeKey || entry.turnKey !== excludeKey,
    )
    if (pendingEntries.length > 0) {
      const flushed = await withTypedSyncLock(
        connectionId,
        dir,
        async () => {
          let allPersisted = true
          for (const [pKey, entry] of pendingEntries) {
            if (!flushPendingLocalOpenEntry(connectionId, dir, pKey, entry)) {
              allPersisted = false
            }
          }
          return allPersisted
        },
        { deadlineMs },
      )
      if (!flushed) {
        return {
          ran: true,
          ok: false,
          result: {
            action: 'open_write_failed',
            requestId: pendingEntries[0][1].requestId,
            key: pendingEntries[0][1].turnKey ?? null,
          },
        }
      }
    }
    if (pendingLookup.readError) {
      sawRequestLogReadError = true
      log(
        `typed-turn-sync: pending-opens retry queue unreadable for ${connectionId}: ${pendingLookup.readError?.message ?? 'read failed'}\n`,
      )
      return {
        ran: true,
        ok: false,
        result: {
          action: 'pending_opens_unreadable',
          error: pendingLookup.readError?.message ?? 'read failed',
        },
      }
    }

    const queuedLookup = nextQueuedFailedTypedTurnDetailed(dir, connectionId, excludeKey)
    if (queuedLookup.readError) {
      sawRequestLogReadError = true
      log(
        `typed-turn-sync: failed-turn retry index unreadable for ${connectionId}: ${queuedLookup.readError?.message ?? 'read failed'}\n`,
      )
      return {
        ran: true,
        ok: false,
        result: {
          action: 'request_log_unreadable',
          error: queuedLookup.readError?.message ?? 'read failed',
        },
      }
    }
    const queuedKey = queuedLookup.key
    if (!queuedKey) return { ran: false, ok: canMarkSynced(), result: null }

    const reqState = readRequestState(connectionId, { dir })
    if (isBlockingReadError(reqState.readError)) {
      log(
        `typed-turn-sync: request log unreadable during retry for ${connectionId} (${queuedKey}): ${reqState.readError?.message ?? 'read failed'}\n`,
      )
      return {
        ran: true,
        ok: false,
        result: {
          action: 'request_log_unreadable',
          key: queuedKey,
          error: reqState.readError?.message ?? 'read failed',
        },
      }
    }
    if (reqState.seenTranscriptTurns.has(queuedKey)) {
      clearFailedTypedTurn(dir, connectionId, queuedKey)
      return {
        ran: true,
        ok: canMarkSynced(),
        result: {
          action: 'already_synced',
          key: queuedKey,
          ref: reqState.seenTranscriptTurns.get(queuedKey),
        },
      }
    }
    if (!connectionCapability || typeof effectiveCallRequest !== 'function') {
      return {
        ran: true,
        ok: false,
        result: { action: 'cleared_stale', key: queuedKey },
      }
    }
    const retryResult = await withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const lockedState = readRequestState(connectionId, { dir })
        if (isBlockingReadError(lockedState.readError)) {
          return { action: 'request_log_unreadable', key: queuedKey }
        }
        if (lockedState.seenTranscriptTurns.has(queuedKey)) {
          clearFailedTypedTurn(dir, connectionId, queuedKey)
          return {
            action: 'already_synced',
            key: queuedKey,
            ref: lockedState.seenTranscriptTurns.get(queuedKey),
          }
        }
        const deterministicId = deterministicTypedTurnRequestId(connectionId, queuedKey)
        let requestId =
          lockedState.open.get(deterministicId)?.kind === 'typed_prompt' ? deterministicId : null
        let requestedBy = null
        if (!requestId) {
          const opened = await openTypedRequestPreservingRefusal({
            connectionId,
            callRequest: effectiveCallRequest,
            dir,
            id: deterministicId,
          })
          if (opened.ok) {
            requestId = opened.requestId
            requestedBy = opened.requestedBy ?? null
          } else if (opened.localPersistFailed) {
            if (opened.requestId) {
              savePendingLocalOpen(dir, connectionId, {
                requestId: opened.requestId,
                requestedBy: opened.requestedBy ?? null,
                turnKey: queuedKey,
              })
              clearFailedTypedTurn(dir, connectionId, queuedKey)
            }
            log(
              `typed-turn-sync: queued local open_request persistence failed for ${connectionId} (${queuedKey}): ${JSON.stringify(opened.refusal)}\n`,
            )
            return {
              action: 'open_write_failed',
              requestId: opened.requestId,
              key: queuedKey,
              refusal: opened.refusal,
            }
          } else {
            log(
              `typed-turn-sync: queued open_request retry failed for ${connectionId} (${queuedKey}): ${JSON.stringify(opened.refusal)}\n`,
            )
            return {
              action: 'cleared_stale',
              key: queuedKey,
              refusal: opened.refusal,
            }
          }
        }
        const pKey = pendingOpenKey(dir, connectionId, queuedKey)
        const entry = { requestId, requestedBy, turnKey: queuedKey }
        savePendingLocalOpen(dir, connectionId, entry)
        const persisted = flushPendingLocalOpenEntry(connectionId, dir, pKey, entry)
        if (!persisted) {
          return {
            action: 'open_write_failed',
            requestId,
            key: queuedKey,
          }
        }
        clearFailedTypedTurn(dir, connectionId, queuedKey)
        return { action: 'opened', requestId, key: queuedKey }
      },
      { deadlineMs },
    )
    if (!retryResult) {
      return { ran: true, ok: false, result: { action: 'lock_busy', key: queuedKey } }
    }
    const succeeded = retryResult.action === 'opened' || retryResult.action === 'already_synced'
    return { ran: true, ok: succeeded && canMarkSynced(), result: retryResult }
  }

  const stamp = fileStamp(transcriptPath)
  if (!stamp) return { action: 'none' }
  const reqFile = path.join(dir, `${connectionId}.requests.jsonl`)
  const currentReqStamp = () => fileStamp(reqFile) ?? ''
  const reqStampAtStart = currentReqStamp()
  if (memo && memo.stamp === stamp && (memo.reqStamp ?? '') === reqStampAtStart && memo.synced && canMarkSynced()) {
    return { action: 'unchanged' }
  }

  const active = activeTranscriptTurn(transcriptPath, { attempts, deadlineMs })
  if (active?.budgetExhausted) {
    log(`typed-turn-sync: transcript read budget (${budgetMs} ms) exhausted for ${connectionId}\n`)
    return { action: 'budget_exhausted', budget_ms: budgetMs }
  }
  if (!active) return { action: 'unreadable' }
  const resolveWakeForText = (rawText, reqState) => {
    if (typeof rawText !== 'string' || !rawText) return null
    const taskMatch = requestForWake({ origin: 'task-notification', text: rawText, state: reqState })
    if (taskMatch.ref !== UNSTATED) return { origin: 'task-notification', text: rawText, match: taskMatch, direct: true }
    return null
  }

  const sameTurnWakeRows = Array.isArray(active.sameTurnWakes) ? active.sameTurnWakes : []
  const liveWakeKeySet = new Set(sameTurnWakeRows.map((w) => w?.key).filter(Boolean))
  const historicalWakeRows = (Array.isArray(active.notificationWakes) ? active.notificationWakes : []).filter(
    (w) => w?.key && (active.ended || !liveWakeKeySet.has(w.key)),
  )

  const hasUnseenMatchableNotification = (reqState) => {
    for (const wakeRow of historicalWakeRows) {
      if (!wakeRow?.key || reqState.seenTranscriptTurns.has(wakeRow.key)) continue
      if (resolveWakeForText(wakeRow.rawText, reqState)) return true
    }
    if (!active.ended && active.kind !== 'typed') {
      for (const wakeRow of sameTurnWakeRows) {
        if (!wakeRow?.key || reqState.seenTranscriptTurns.has(wakeRow.key)) continue
        if (resolveWakeForText(wakeRow.rawText, reqState)) return true
      }
      if (active.key && !reqState.seenTranscriptTurns.has(active.key) && resolveWakeForText(active.rawText, reqState)) {
        return true
      }
    }
    return false
  }

  const markMemoSynced = () => {
    if (!memo) return
    // Capture the request-log stamp BEFORE reading `.requests.jsonl` to confirm no
    // previously unmatched `<task-notification>` now matches a launch appended while
    // this pass awaited an earlier request/admission, and NEVER advance `memo.synced`
    // if reading `.requests.jsonl` failed transiently (requirement 3ea2b201).
    const verifiedReqStamp = currentReqStamp()
    const verifyState = readRequestState(connectionId, { dir })
    if (sawRequestLogReadError || verifyState.readError || hasUnseenMatchableNotification(verifyState) || !canMarkSynced()) {
      memo.stamp = active.stamp
      memo.reqFile = reqFile
      memo.reqStamp = reqStampAtStart
      memo.synced = false
      return
    }
    memo.stamp = active.stamp
    memo.reqFile = reqFile
    memo.reqStamp = verifiedReqStamp
    memo.synced = true
  }
  if (memo) {
    memo.stamp = active.stamp
    memo.reqFile = reqFile
    memo.reqStamp = reqStampAtStart
    memo.synced = false
  }
  // Never treat a transient `.requests.jsonl` read failure (e.g. EACCES/EBUSY/EIO)
  // as an empty log or mark the transcript checked (requirement 3ea2b201).
  const startReqState = readRequestState(connectionId, { dir })
  if (isBlockingReadError(startReqState.readError)) {
    log(
      `typed-turn-sync: request log unreadable for ${connectionId}: ${startReqState.readError?.message ?? 'read failed'}\n`,
    )
    return {
      action: 'request_log_unreadable',
      error: startReqState.readError?.message ?? 'read failed',
    }
  }
  const enqueueUnseenTypedTurns = (excludeLiveKey = null) => {
    const typedKeys =
      Array.isArray(active.typedTurnKeys) && active.typedTurnKeys.length > 0
        ? active.typedTurnKeys
        : active.kind === 'typed' && active.key
          ? [active.key]
          : []
    if (typedKeys.length === 0) return { ok: true }
    const reqState = readRequestState(connectionId, { dir })
    if (isBlockingReadError(reqState.readError)) {
      log(
        `typed-turn-sync: request log unreadable while scanning unseen typed turns for ${connectionId}: ${reqState.readError?.message ?? 'read failed'}\n`,
      )
      return { ok: false, action: 'request_log_unreadable', error: reqState.readError?.message ?? 'read failed' }
    }
    const pendingLookup = pendingOpensForConnectionDetailed(dir, connectionId)
    if (pendingLookup.readError) {
      sawRequestLogReadError = true
      log(
        `typed-turn-sync: pending-opens retry queue unreadable while scanning unseen typed turns for ${connectionId}: ${pendingLookup.readError?.message ?? 'read failed'}\n`,
      )
      return { ok: false, action: 'pending_opens_unreadable', error: pendingLookup.readError?.message ?? 'read failed' }
    }
    const pendingByTurnKey = new Set(pendingLookup.entries.map(([, e]) => e.turnKey))
    const unseen = typedKeys.filter(
      (key) =>
        key !== excludeLiveKey &&
        !reqState.seenTranscriptTurns.has(key) &&
        !pendingByTurnKey.has(key),
    )
    if (unseen.length === 0) return { ok: true }
    const boundRefs = new Set(reqState.seenTranscriptTurns.values())
    const pendingIds = new Set(pendingLookup.entries.map(([, e]) => e.requestId))
    const unboundHookIds = []
    for (const [id, info] of reqState.open) {
      if (
        info.kind === 'typed_prompt' &&
        !boundRefs.has(id) &&
        !pendingIds.has(id) &&
        !isFailedTurnDeterministicId(dir, connectionId, id, null) &&
        (!excludeLiveKey || id !== deterministicTypedTurnRequestId(connectionId, excludeLiveKey))
      ) {
        unboundHookIds.push(id)
      }
    }
    const reservedForLive = excludeLiveKey ? unboundOpenTypedPrompt(reqState) : null
    const priorHookIds = reservedForLive
      ? unboundHookIds.filter((id) => id !== reservedForLive)
      : unboundHookIds
    // Hook-created unbound typed_prompt requests cover the NEWEST unseen typed prompts
    // (oldest-to-newest pairing against the tail of `unseen`), never skipping an earlier
    // unregistered typed prompt. Bind each covered prompt explicitly to its hook request
    // and queue every earlier unseen prompt for registration (requirement 3ea2b201).
    const pairCount = Math.min(priorHookIds.length, unseen.length)
    const earlierUnseen = unseen.slice(0, unseen.length - pairCount)
    const coveredUnseen = unseen.slice(unseen.length - pairCount)
    const matchedHooks = priorHookIds.slice(priorHookIds.length - pairCount)
    for (const key of earlierUnseen) {
      recordFailedTypedTurn(dir, connectionId, key)
    }
    for (let i = 0; i < pairCount; i += 1) {
      if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: coveredUnseen[i], ref: matchedHooks[i], historical: true, mark_started: true }, { dir })) {
        return { ok: false, action: 'binding_write_failed' }
      }
    }
    return { ok: true }
  }

  const syncLiveTypedTurn = async (turnKey) =>
    withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const reqState = readRequestState(connectionId, { dir })
        if (isBlockingReadError(reqState.readError)) {
          return { action: 'request_log_unreadable', key: turnKey }
        }
        const midTurn = hasActiveRemoteCommandTurn(connectionId, reqState, dir, active)
        const pKey = pendingOpenKey(dir, connectionId, turnKey)
        const pendingLookup = pendingOpensForConnectionDetailed(dir, connectionId)
        if (pendingLookup.readError) {
          sawRequestLogReadError = true
          log(
            `typed-turn-sync: pending-opens retry queue unreadable in live sync for ${connectionId} (${turnKey}): ${pendingLookup.readError?.message ?? 'read failed'}\n`,
          )
          return {
            action: 'pending_opens_unreadable',
            key: turnKey,
            error: pendingLookup.readError?.message ?? 'read failed',
          }
        }
        const pendingOpen =
          pendingLookup.entries.find(([, entry]) => entry?.turnKey === turnKey)?.[1] ??
          getPendingLocalOpen(dir, connectionId, turnKey)
        const failPendingOpenCleanup = (entry, error) => {
          const errRefusal = structuredRefusalFromError(error)
          const refusal = {
            ...errRefusal,
            ...(errRefusal.code ? { cause_code: errRefusal.code } : {}),
            code: 'pending_open_cleanup_failed',
            retryable: true,
            request_id: entry.requestId,
          }
          log(
            `typed-turn-sync: failed to remove pending local open for ${connectionId} (${turnKey}): ${JSON.stringify(refusal)}\n`,
          )
          return {
            action: 'pending_open_cleanup_failed',
            requestId: entry.requestId,
            key: turnKey,
            midTurn,
            refusal,
          }
        }
        if (reqState.seenTranscriptTurns.has(turnKey)) {
          if (pendingOpen) {
            const removed = deletePendingLocalOpen(dir, connectionId, pKey, turnKey, pendingOpen.requestId)
            if (!removed.ok) return failPendingOpenCleanup(pendingOpen, removed.error)
          }
          return { action: 'already_synced', key: turnKey, ref: reqState.seenTranscriptTurns.get(turnKey) }
        }

        const deterministicId = deterministicTypedTurnRequestId(connectionId, turnKey)
        const alreadyOpenForTurn =
          reqState.open.get(deterministicId)?.kind === 'typed_prompt' ? deterministicId : null
        const unboundHook = unboundOpenTypedPrompt(reqState)
        const safeUnboundHook =
          unboundHook && !isFailedTurnDeterministicId(dir, connectionId, unboundHook, turnKey)
            ? unboundHook
            : null
        const existingTyped = safeUnboundHook ?? alreadyOpenForTurn
        let requestId = existingTyped
        let openedNow = false
        let openRefusal = null
        const hasOtherLiveJoined = (rState, targetId) =>
          [...(rState?.joined ?? [])].some(
            (id) => id !== targetId && rState.open.has(id) && !rState.open.get(id)?.answered,
          )
        if (alreadyOpenForTurn && !safeUnboundHook && reqState.current !== requestId) {
          const currentWritten = appendRequestEvent(
            connectionId,
            midTurn
              ? { op: 'joined', id: requestId }
              : {
                  op: 'current',
                  ref: requestId,
                  ...(hasOtherLiveJoined(reqState, requestId) ? { preserve_joined: true } : {}),
                },
            { dir },
          )
          if (!currentWritten) {
            return { action: 'binding_write_failed', requestId, key: turnKey, midTurn }
          }
        }

        if (pendingOpen) {
          if (reqState.closed?.has(pendingOpen.requestId)) {
            const removed = deletePendingLocalOpen(dir, connectionId, pKey, turnKey, pendingOpen.requestId)
            if (!removed.ok) return failPendingOpenCleanup(pendingOpen, removed.error)
          } else {
            if (!reqState.open.has(pendingOpen.requestId)) {
              const persisted = appendRequestEvent(
                connectionId,
                {
                  op: 'open',
                  id: pendingOpen.requestId,
                  kind: 'typed_prompt',
                  ...(pendingOpen.requestedBy ? { requested_by: pendingOpen.requestedBy } : {}),
                },
                { dir },
              )
              if (!persisted) {
                return {
                  action: 'open_write_failed',
                  requestId: pendingOpen.requestId,
                  key: turnKey,
                  midTurn,
                  refusal: {
                    code: 'local_open_persist_failed',
                    error: 'DevSpec opened request but local open record failed to persist',
                    request_id: pendingOpen.requestId,
                  },
                }
              }
              openedNow = true
            }
            const needsBinding = midTurn
              ? reqState.current !== pendingOpen.requestId && !reqState.joined.has(pendingOpen.requestId)
              : reqState.current !== pendingOpen.requestId
            if (needsBinding) {
              const currentWritten = appendRequestEvent(
                connectionId,
                midTurn
                  ? { op: 'joined', id: pendingOpen.requestId }
                  : {
                      op: 'current',
                      ref: pendingOpen.requestId,
                      ...(hasOtherLiveJoined(reqState, pendingOpen.requestId) ? { preserve_joined: true } : {}),
                    },
                { dir },
              )
              if (!currentWritten) {
                return { action: 'binding_write_failed', requestId: pendingOpen.requestId, key: turnKey, midTurn }
              }
            }
            const removed = deletePendingLocalOpen(dir, connectionId, pKey, turnKey, pendingOpen.requestId)
            if (!removed.ok) return failPendingOpenCleanup(pendingOpen, removed.error)
            requestId = pendingOpen.requestId
            openedNow = true
          }
        }

        let supersededByNewerTurn = false
        let effectiveMidTurn = midTurn
        if (!requestId && connectionCapability && typeof effectiveCallRequest === 'function') {
          const opened = await openTypedRequestPreservingRefusal({
            connectionId,
            callRequest: effectiveCallRequest,
            dir,
            id: deterministicId,
          })
          if (opened.ok) {
            requestId = opened.requestId
            openedNow = true
            // Re-read the transcript FIRST, then `.requests.jsonl` immediately after,
            // AFTER awaiting DevSpec's open reply so an older terminal open NEVER
            // replaces a newer live room command (or newer turn) that became `current`
            // while the open was in flight OR while re-reading the transcript (decision ce71a72b).
            const postOpenActive = activeTranscriptTurn(transcriptPath, { attempts, deadlineMs })
            if (postOpenActive?.budgetExhausted) {
              return { action: 'budget_exhausted', budget_ms: budgetMs }
            }
            if (!postOpenActive) {
              log(
                `typed-turn-sync: transcript unreadable after open_request for ${connectionId} (${turnKey}); deferring current binding and leaving turn unsynced\n`,
              )
              return { action: 'unreadable', requestId, key: turnKey, midTurn: effectiveMidTurn }
            }
            const postOpenState = readRequestState(connectionId, { dir })
            if (isBlockingReadError(postOpenState.readError)) {
              return { action: 'request_log_unreadable', requestId, key: turnKey, midTurn: effectiveMidTurn }
            }
            const newerCurrentLanded =
              postOpenState.current !== reqState.current &&
              postOpenState.current !== null &&
              postOpenState.current !== requestId &&
              (postOpenState.current === NO_REQUEST ||
                (postOpenState.open.has(postOpenState.current) && !postOpenState.open.get(postOpenState.current)?.answered))
            const transcriptMovedOn = Boolean(
              postOpenActive &&
                (postOpenActive.ended ||
                  (postOpenActive.key !== turnKey && postOpenActive.liveTurnTypedKey !== turnKey)),
            )
            effectiveMidTurn = hasActiveRemoteCommandTurn(connectionId, postOpenState, dir, postOpenActive ?? active)
            supersededByNewerTurn = newerCurrentLanded || transcriptMovedOn
            if (!supersededByNewerTurn) {
              const preserveJoined = hasOtherLiveJoined(postOpenState, requestId)
              const currentWritten = appendRequestEvent(
                connectionId,
                effectiveMidTurn
                  ? { op: 'joined', id: requestId }
                  : {
                      op: 'current',
                      ref: requestId,
                      ...(preserveJoined ? { preserve_joined: true } : {}),
                    },
                { dir },
              )
              if (!currentWritten) {
                return { action: 'binding_write_failed', requestId, key: turnKey, midTurn: effectiveMidTurn }
              }
            }
          } else if (opened.localPersistFailed) {
            if (opened.requestId) {
              savePendingLocalOpen(dir, connectionId, {
                requestId: opened.requestId,
                requestedBy: opened.requestedBy ?? null,
                turnKey,
              })
            }
            log(
              `typed-turn-sync: local open_request persistence failed for ${connectionId} (${turnKey}): ${JSON.stringify(opened.refusal)}\n`,
            )
            return {
              action: 'open_write_failed',
              requestId: opened.requestId,
              key: turnKey,
              midTurn,
              refusal: opened.refusal,
            }
          } else {
            openRefusal = opened.refusal
            log(
              `typed-turn-sync: open_request failed for ${connectionId} (${turnKey}): ${JSON.stringify(openRefusal)}\n`,
            )
          }
        }

        if (requestId) {
          // Verify the request actually exists in local open state before admitting or
          // binding the transcript turn (requirement 3ea2b201).
          if (!readRequestState(connectionId, { dir }).open.has(requestId)) {
            return {
              action: 'open_write_failed',
              requestId,
              key: turnKey,
              midTurn,
            }
          }
          // Admit the terminal turn with the connection capability when attached, matching
          // `mirror-turn.mjs user_prompt` so claims and replies resolve to the owner at terminal.
          // Only mark the transcript turn synced once admission, state persistence, and binding
          // write all succeed; on refusal or write failure, preserve details and retry next tick.
          const sessionId = state?.session_id || null
          const alreadyAdmittedForThisTurn =
            Boolean(state?.local_turn) &&
            (state.local_turn.turn_key === turnKey ||
              (!openedNow && existingTyped === safeUnboundHook && !state.local_turn.turn_key))
          const scope =
            !effectiveMidTurn &&
            !supersededByNewerTurn &&
            sessionId &&
            connectionCapability &&
            typeof effectiveCallPickup === 'function' &&
            !alreadyAdmittedForThisTurn
              ? localTurnScope({ ...state, connection_capability: connectionCapability }, sessionId)
              : null

          if (scope) {
            const admission = await admitLocalTurnPreservingRefusal({
              scope,
              previousAttemptId: state?.local_turn?.attempt_id ?? null,
              callPickup: effectiveCallPickup,
            })
            if (!admission.ok) {
              log(
                `typed-turn-sync: local turn admission failed for ${connectionId} (${turnKey}): ${JSON.stringify(admission.refusal)}\n`,
              )
              return {
                action: 'admission_failed',
                requestId,
                key: turnKey,
                midTurn: effectiveMidTurn,
                refusal: admission.refusal,
              }
            }
            if (typeof patchState === 'function') {
              let saved = false
              try {
                saved = patchState({ local_turn: { ...admission.admitted, turn_key: turnKey } }) === true
              } catch (error) {
                log(
                  `typed-turn-sync: failed to persist local_turn state for ${connectionId} (${turnKey}): ${error instanceof Error ? error.message : String(error)}\n`,
                )
                saved = false
              }
              if (!saved) {
                log(`typed-turn-sync: failed to persist local_turn state for ${connectionId} (${turnKey})\n`)
                return {
                  action: 'state_write_failed',
                  requestId,
                  key: turnKey,
                  midTurn: effectiveMidTurn,
                }
              }
            }
          }

          const bound = appendRequestEvent(
            connectionId,
            supersededByNewerTurn
              ? { op: 'transcript_turn', key: turnKey, ref: requestId, historical: true, mark_started: true }
              : { op: 'transcript_turn', key: turnKey, ref: requestId },
            { dir },
          )
          if (!bound) {
            return {
              action: 'binding_write_failed',
              requestId,
              key: turnKey,
              midTurn: effectiveMidTurn,
            }
          }
          return {
            action: openedNow ? 'opened' : 'adopted_hook_request',
            requestId,
            key: turnKey,
            midTurn: effectiveMidTurn,
            ...(supersededByNewerTurn ? { superseded: true } : {}),
          }
        }

        // Could not open a typed_prompt right now (offline / no capability / DevSpec refused):
        // still clear any stale foreground request so writes go out unstamped and DevSpec
        // resolves who asked from the connection rather than stamping a closed command —
        // re-reading first so we NEVER clear a newer live request that arrived mid-wait.
        const latestBeforeClear = readRequestState(connectionId, { dir })
        if (
          !latestBeforeClear.readError &&
          !effectiveMidTurn &&
          !hasActiveRemoteCommandTurn(connectionId, latestBeforeClear, dir, active) &&
          latestBeforeClear.current !== null &&
          latestBeforeClear.current === reqState.current
        ) {
          appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })
        }
        return {
          action: 'cleared_stale',
          key: turnKey,
          ...(openRefusal ? { refusal: openRefusal } : {}),
        }
      },
      { deadlineMs },
    )

  // Live typed prompt key owned by the currently running turn: either `active.key` itself
  // (when `active.kind === 'typed'`) or `active.liveTurnTypedKey` (when a mid-turn
  // `<task-notification>` arrived in the SAME live turn without an intervening `turn_ended`).
  const liveTypedKey =
    !active.ended && active.kind === 'typed'
      ? active.key
      : !active.ended && active.liveTurnTypedKey
        ? active.liveTurnTypedKey
        : null

  // Queue every previously unseen ENDED/historical typed turn (not covered by an open
  // hook-created typed_prompt and not `liveTypedKey` for this live turn) BEFORE
  // advancing sync state so two (or more) typed turns that finish between poller
  // reads are never skipped or marked synced prematurely (requirement 3ea2b201).
  const enqueued = enqueueUnseenTypedTurns(liveTypedKey)
  if (!enqueued.ok) {
    return {
      action: enqueued.action ?? 'binding_write_failed',
      key: active.key,
      active,
      ...(enqueued.error ? { error: enqueued.error } : {}),
    }
  }

  // Reconcile any unseen historical/ended `<task-notification>` rows BEFORE returning on
  // an ended turn or setting `memo.synced = true`, marking completed launches `notified`
  // without altering live turn foreground state (requirement 3ea2b201).
  for (const wakeRow of historicalWakeRows) {
    const preState = readRequestState(connectionId, { dir })
    if (preState.readError) {
      sawRequestLogReadError = true
      log(
        `typed-turn-sync: request log unreadable while reconciling historical wake for ${connectionId}: ${preState.readError?.message ?? 'read failed'}\n`,
      )
      return { action: 'request_log_unreadable', key: wakeRow.key, error: preState.readError?.message ?? 'read failed' }
    }
    if (preState.seenTranscriptTurns.has(wakeRow.key)) continue
    if (!resolveWakeForText(wakeRow.rawText, preState)) continue
    const histRes = await withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const reqState = readRequestState(connectionId, { dir })
        if (reqState.readError) {
          sawRequestLogReadError = true
          log(
            `typed-turn-sync: request log unreadable while reconciling historical wake for ${connectionId}: ${reqState.readError?.message ?? 'read failed'}\n`,
          )
          return { action: 'request_log_unreadable', key: wakeRow.key, error: reqState.readError?.message ?? 'read failed' }
        }
        if (reqState.seenTranscriptTurns.has(wakeRow.key)) {
          return { action: 'already_synced', key: wakeRow.key }
        }
        const wake = resolveWakeForText(wakeRow.rawText, reqState)
        if (!wake) return { action: 'not_a_wake', key: wakeRow.key }
        // Only consume `currentFromWake` -> `currentBoundByWake` on THIS historical row
        // when the prompt hook actually restored `current` for THIS specific background
        // notification (its notified launch key is in `reqState.currentWakeNotifiedKeys`).
        // Otherwise a newer scheduled wake (or another completion) for the SAME request
        // would lose its provenance (decision ce71a72b).
        const rowNotifiedKeys = notifiedKeys(wakeRow.rawText)
        const wakeRef = wake.match.ref === UNSTATED ? null : wake.match.ref
        const consumesWakeCurrent =
          reqState.currentFromWake &&
          wakeRef !== null &&
          reqState.current === wakeRef &&
          rowNotifiedKeys.some((key) => reqState.currentWakeNotifiedKeys?.has(key))
        const notifiedEvents = promptArrival({
          fromAPerson: false,
          origin: wake.origin,
          text: wake.text,
          midTurn: true,
          state: reqState,
        }).events.filter((event) => event.op === 'notified')
        for (const event of notifiedEvents) {
          if (!appendRequestEvent(connectionId, { ...event, historical: true }, { dir })) {
            return { action: 'binding_write_failed', key: wakeRow.key, active }
          }
        }
        if (
          !appendRequestEvent(
            connectionId,
            consumesWakeCurrent
              ? { op: 'transcript_turn', key: wakeRow.key, ref: wakeRef }
              : { op: 'transcript_turn', key: wakeRow.key, ref: null, historical: true },
            { dir },
          )
        ) {
          return { action: 'binding_write_failed', key: wakeRow.key, active }
        }
        return { action: 'reconciled_historical_wake', key: wakeRow.key }
      },
      { deadlineMs },
    )
    if (!histRes) return { action: 'lock_busy', key: wakeRow.key }
    if (histRes.action === 'binding_write_failed' || histRes.action === 'request_log_unreadable') return histRes
  }

  if (active.ended || !active.key) {
    const flush = await retryQueuedFailedTurn({ excludeKey: null })
    if (flush.ran) {
      if (memo && flush.ok && canMarkSynced()) markMemoSynced()
      return {
        ...flush.result,
        ...(active.ended ? { ended: true } : {}),
        active,
      }
    }
    if (memo && canMarkSynced()) markMemoSynced()
    return { action: 'not_typed_live', active }
  }

  // If a mid-turn non-typed row (e.g. a `<task-notification>`) arrived in the SAME live
  // turn as an unseen or admission-pending terminal prompt (`active.liveTurnTypedKey`),
  // run full live typed-turn registration + room admission for `liveTypedKey` FIRST so:
  //  - a newly typed prompt becomes `current` BEFORE the background wake joins it
  //    (keeping both requesters distinct rather than stamping the wake's requester alone — ce71a72b), and
  //  - a previously refused room admission is retried cleanly rather than sent through
  //    historical recovery and marked synced without admission (requirement 3ea2b201).
  let sameTurnTypedOutcome = null
  if (active.kind !== 'typed' && liveTypedKey) {
    const liveTypedCheck = readRequestState(connectionId, { dir })
    if (isBlockingReadError(liveTypedCheck.readError)) {
      return { action: 'request_log_unreadable', key: liveTypedKey }
    }
    if (!liveTypedCheck.seenTranscriptTurns.has(liveTypedKey)) {
    sameTurnTypedOutcome = await syncLiveTypedTurn(liveTypedKey)
    if (!sameTurnTypedOutcome) return { action: 'lock_busy', key: liveTypedKey }
    if (
      sameTurnTypedOutcome.action === 'opened' ||
      sameTurnTypedOutcome.action === 'already_synced' ||
      sameTurnTypedOutcome.action === 'adopted_hook_request'
    ) {
      clearFailedTypedTurn(dir, connectionId, liveTypedKey)
    } else {
      if (
        sameTurnTypedOutcome.action === 'cleared_stale' ||
        sameTurnTypedOutcome.action === 'admission_failed' ||
        sameTurnTypedOutcome.action === 'state_write_failed' ||
        sameTurnTypedOutcome.action === 'binding_write_failed'
      ) {
        recordFailedTypedTurn(dir, connectionId, liveTypedKey)
      }
      // If the live terminal prompt could NOT even be opened/retained locally, do not
      // allow a same-turn background notification to overwrite foreground current with
      // another requester alone; keep the turn unsynced and return the failure for retry.
      const stateAfterLive = readRequestState(connectionId, { dir })
      const liveRequestActive =
        sameTurnTypedOutcome.requestId &&
        stateAfterLive.open.has(sameTurnTypedOutcome.requestId) &&
        stateAfterLive.current === sameTurnTypedOutcome.requestId
      if (!liveRequestActive) {
        return sameTurnTypedOutcome
      }
    }
    }
  }

  const applyTranscriptWakeRow = async (wakeRow) =>
    withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const reqState = readRequestState(connectionId, { dir })
        if (reqState.readError) {
          return { action: 'request_log_unreadable', key: wakeRow.key }
        }
        if (reqState.seenTranscriptTurns.has(wakeRow.key)) {
          return { action: 'already_synced', key: wakeRow.key, ref: reqState.seenTranscriptTurns.get(wakeRow.key) }
        }
        const wake = resolveWakeForText(wakeRow.rawText, reqState)
        if (!wake) return { action: 'not_a_wake' }
        const wakeRef = wake.match.ref === UNSTATED ? null : wake.match.ref
        const alsoList = Array.isArray(wake.match.also) ? wake.match.also : []
        const allAlsoCarried = alsoList.every((id) => reqState.current === id || reqState.joined.has(id))
        const alreadyCarried =
          wakeRef !== null &&
          reqState.current !== null &&
          allAlsoCarried &&
          (reqState.joined.has(wakeRef) ||
            (reqState.current === wakeRef && (reqState.joined.size > 0 || reqState.chosen)))
        if (alreadyCarried) {
          // Prompt hook (or an explicit serve choice) already carried this wake into the
          // running turn: preserve current, joined, and chosen intact so two people's
          // requests stay distinct rather than replacing a live room command (ce71a72b),
          // while still recording `notified` for any newly completed launch on that request.
          if (wake.direct) {
            const notifiedEvents = promptArrival({
              fromAPerson: false,
              origin: wake.origin,
              text: wake.text,
              midTurn: true,
              state: reqState,
            }).events.filter((event) => event.op === 'notified')
            for (const event of notifiedEvents) {
              if (!appendRequestEvent(connectionId, event, { dir })) {
                return { action: 'binding_write_failed', requestId: reqState.current, key: wakeRow.key, active }
              }
            }
          }
          if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: wakeRow.key, ref: reqState.current }, { dir })) {
            return { action: 'binding_write_failed', requestId: reqState.current, key: wakeRow.key, active }
          }
          return { action: 'already_carried_wake', requestId: reqState.current, key: wakeRow.key, active }
        }
        const wakeRowNotifiedKeys = notifiedKeys(wakeRow.rawText)
        const promptHookOwnedByThisWake =
          reqState.currentFromWake &&
          wakeRowNotifiedKeys.some((key) => reqState.currentWakeNotifiedKeys?.has(key))
        const wakeRowIndex = sameTurnWakeRows.findIndex((row) => row?.key === wakeRow.key)
        const hasEarlierSameTurnWake = wakeRowIndex > 0
        const hasActiveSameTurnWake =
          reqState.current !== null &&
          (reqState.current === NO_REQUEST || reqState.open.has(reqState.current)) &&
          (sameTurnWakeRows.some((other) => other.key !== wakeRow.key && reqState.seenTranscriptTurns.has(other.key)) ||
            (hasEarlierSameTurnWake && (reqState.currentFromWake || reqState.currentBoundByWake)) ||
            (!active.precededByTurnEnded && reqState.currentFromWake && !promptHookOwnedByThisWake))
        const midTurn =
          hasActiveRemoteCommandTurn(connectionId, reqState, dir, active) ||
          hasActiveTypedTurn(reqState, active) ||
          hasActiveSameTurnWake
        const events = wake.direct
          ? promptArrival({
              fromAPerson: false,
              origin: wake.origin,
              text: wake.text,
              midTurn,
              state: reqState,
            }).events
          : midTurn
            ? [wake.match.ref, ...wake.match.also].map((id) => ({ op: 'joined', id }))
            : [
                { op: 'current', ref: wake.match.ref, from_wake: true },
                ...wake.match.also.map((id) => ({ op: 'joined', id })),
              ]
        for (const event of events) {
          if (!appendRequestEvent(connectionId, event, { dir })) {
            return { action: 'binding_write_failed', key: wakeRow.key, active }
          }
        }
        const ref = midTurn ? reqState.current : wakeRef
        if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: wakeRow.key, ref }, { dir })) {
          return { action: 'binding_write_failed', requestId: ref, key: wakeRow.key, active }
        }
        return {
          action: 'restored_wake_request',
          requestId: ref,
          key: wakeRow.key,
          active,
          ...(midTurn ? { midTurn: true } : {}),
        }
      },
      { deadlineMs },
    )

  // Process EVERY unseen earlier same-turn background notification in chronological order
  // BEFORE `active.key` or setting `memo.synced = true` — including a single background
  // notification followed by a Cursor `summary` row — so every notification marks its
  // launch notified and joins/restores attribution (requirements 3ea2b201 / ce71a72b).
  let lastSameTurnWakeOutcome = null
  if (active.kind !== 'typed' && sameTurnWakeRows.length > 0) {
    for (const wakeRow of sameTurnWakeRows) {
      if (!wakeRow?.key || wakeRow.key === active.key) continue
      const currentState = readRequestState(connectionId, { dir })
      if (currentState.readError) return { action: 'request_log_unreadable', key: wakeRow.key }
      if (currentState.seenTranscriptTurns.has(wakeRow.key)) continue
      if (!resolveWakeForText(wakeRow.rawText, currentState)) continue
      const earlier = await applyTranscriptWakeRow(wakeRow)
      if (!earlier) return { action: 'lock_busy', key: wakeRow.key }
      if (earlier.action === 'binding_write_failed' || earlier.action === 'request_log_unreadable') return earlier
      if (earlier.action === 'restored_wake_request' || earlier.action === 'already_carried_wake') {
        lastSameTurnWakeOutcome = earlier
      }
    }
  }

  const initial = readRequestState(connectionId, { dir })
  if (isBlockingReadError(initial.readError)) {
    return { action: 'request_log_unreadable' }
  }
  if (initial.seenTranscriptTurns.has(active.key)) {
    const flush = await retryQueuedFailedTurn({ excludeKey: liveTypedKey })
    if (flush.ran) {
      if (memo && flush.ok && canMarkSynced()) markMemoSynced()
      return flush.result
    }
    if (memo && canMarkSynced()) markMemoSynced()
    if (lastSameTurnWakeOutcome) {
      return lastSameTurnWakeOutcome
    }
    if (sameTurnTypedOutcome && sameTurnTypedOutcome.action !== 'already_synced') {
      return sameTurnTypedOutcome
    }
    return { action: 'already_synced', key: active.key, ref: initial.seenTranscriptTurns.get(active.key) }
  }

  const resolveTranscriptWake = (reqState) => {
    if (active.kind === 'typed') return null
    return resolveWakeForText(active.rawText, reqState)
  }

  if (resolveTranscriptWake(initial)) {
    const restored = await applyTranscriptWakeRow({ key: active.key, rawText: active.rawText })
    if (!restored) return { action: 'lock_busy' }
    if (restored.action !== 'not_a_wake') {
      if (
        restored.action === 'restored_wake_request' ||
        restored.action === 'already_carried_wake' ||
        restored.action === 'already_synced'
      ) {
        const flush = await retryQueuedFailedTurn({ excludeKey: liveTypedKey ?? active.key })
        if (memo && flush.ok && canMarkSynced()) markMemoSynced()
        if (flush.ran) return { ...restored, retriedFailedTurn: flush.result }
      }
      return restored
    }
  }

  // A live non-typed turn (timestamp-only wake or command_turn wake) must not inherit an
  // unrelated earlier typed_prompt OR a room command (answered OR unanswered) restored by
  // a prior background wake — even if an unnotified background job or scheduled run exists —
  // unless this wake was explicitly restored by host promptArrival (`currentFromWake`) or
  // carried an explicit `<task-notification>` handled above (decisions 2fcd26bd / ce71a72b).
  const hasPendingUnmatchedNotificationId =
    active.kind === 'other' && notifiedKeys(active.rawText).length > 0
  const isClearableForUnrelatedWake = (reqState) => {
    if (!reqState?.current) return false
    // A mid-turn Cursor `summary` row inside an active terminal prompt OR a turn whose
    // own background wake bound `reqState.current` (with no intervening `turn_ended`) is
    // housekeeping, NOT an unrelated wake: preserve the live turn's attribution while
    // still clearing an ended prior turn's `typed_prompt` when an unrelated `other` row +
    // `summary` arrives after `turn_ended` (ce71a72b).
    const hasSameTurnBoundWake = sameTurnWakeRows.some(
      (wakeRow) => wakeRow?.key && reqState.seenTranscriptTurns.get(wakeRow.key) === reqState.current,
    )
    if (
      active.kind === 'summary' &&
      !active.precededByTurnEnded &&
      (active.liveTurnTypedKey || hasSameTurnBoundWake)
    ) {
      return false
    }
    if (reqState.current === NO_REQUEST) return true
    if (reqState.currentFromWake || reqState.currentBoundByWake) return true
    const info = reqState.open.get(reqState.current)
    if (!info) return false
    if (info.kind === 'typed_prompt') {
      // Preserve a live terminal-typed turn when a mid-turn row (such as an unmatched
      // `<task-notification>` whose launch record has not landed yet) arrives in the
      // SAME live turn without an intervening `turn_ended`, so once the launch lands
      // the notification joins the typed turn instead of replacing it (ce71a72b).
      if (!active.precededByTurnEnded && active.liveTurnTypedKey) {
        return false
      }
      return true
    }
    return info.kind === 'command' && info.answered === true
  }

  if (active.kind !== 'typed') {
    if (!isClearableForUnrelatedWake(initial)) {
      const flush = await retryQueuedFailedTurn({ excludeKey: liveTypedKey ?? active.key })
      if (memo && flush.ok && canMarkSynced()) markMemoSynced()
      const preservedResult =
        lastSameTurnWakeOutcome ??
        (sameTurnTypedOutcome &&
        sameTurnTypedOutcome.action !== 'already_synced' &&
        sameTurnTypedOutcome.action !== 'opened' &&
        sameTurnTypedOutcome.action !== 'adopted_hook_request'
          ? sameTurnTypedOutcome
          : { action: 'not_typed_live', active })
      if (flush.ran) return { ...preservedResult, retriedFailedTurn: flush.result }
      return preservedResult
    }
    const outcome = await withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const reqState = readRequestState(connectionId, { dir })
        if (reqState.readError) {
          return { action: 'request_log_unreadable', key: active.key }
        }
        if (reqState.seenTranscriptTurns.has(active.key)) {
          return { action: 'already_synced', key: active.key, ref: reqState.seenTranscriptTurns.get(active.key) }
        }
        if (!isClearableForUnrelatedWake(reqState)) {
          return { action: 'not_typed_live', active }
        }
        // If this unmatched `other` row carries an explicit `<task-id>` / `<tool-use-id>`
        // whose launch record has not yet landed in `.requests.jsonl`, leave `active.key`
        // out of `seenTranscriptTurns` (both when preserving a foreground wake AND when
        // clearing stale foreground state) so appending the launch record later re-runs
        // sync (via `reqStamp`) and reconciles + joins the notification (3ea2b201 / ce71a72b).
        if (reqState.currentFromWake) {
          // Preserve attribution ONLY for a wake explicitly restored via promptArrival.
          if (hasPendingUnmatchedNotificationId) {
            return { action: 'preserved_wake_request', requestId: reqState.current, key: active.key, active }
          }
          if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: reqState.current }, { dir })) {
            return { action: 'binding_write_failed', requestId: reqState.current, key: active.key, active }
          }
          return { action: 'preserved_wake_request', requestId: reqState.current, key: active.key, active }
        }
        if (!appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })) {
          return { action: 'binding_write_failed', key: active.key, active }
        }
        if (
          !hasPendingUnmatchedNotificationId &&
          !appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: null }, { dir })
        ) {
          return { action: 'binding_write_failed', key: active.key, active }
        }
        return { action: 'cleared_for_wake', key: active.key, active }
      },
      { deadlineMs },
    )
    if (
      outcome &&
      (outcome.action === 'cleared_for_wake' ||
        outcome.action === 'preserved_wake_request' ||
        outcome.action === 'already_synced' ||
        outcome.action === 'not_typed_live')
    ) {
      const flush = await retryQueuedFailedTurn({ excludeKey: liveTypedKey ?? active.key })
      if (memo && flush.ok && canMarkSynced()) markMemoSynced()
      if (flush.ran) return { ...outcome, retriedFailedTurn: flush.result }
    }
    return outcome ?? { action: 'lock_busy' }
  }

  const result = await syncLiveTypedTurn(active.key)

  if (
    result &&
    (result.action === 'opened' || result.action === 'already_synced' || result.action === 'adopted_hook_request')
  ) {
    clearFailedTypedTurn(dir, connectionId, active.key)
    const flush = await retryQueuedFailedTurn({ excludeKey: active.key })
    if (memo && flush.ok && canMarkSynced()) markMemoSynced()
    if (flush.ran) return { ...result, retriedFailedTurn: flush.result }
  } else if (
    result &&
    (result.action === 'cleared_stale' ||
      result.action === 'admission_failed' ||
      result.action === 'state_write_failed' ||
      result.action === 'binding_write_failed')
  ) {
    recordFailedTypedTurn(dir, connectionId, active.key)
  }
  return result ?? { action: 'lock_busy' }
}

/**
 * When Cursor is between turns (`ended: true`), close the single finished request
 * belonging to the ended turn (if it has no pending background work, monitors, or
 * recorded schedules) and complete any lingering `local_turn` admission. Covers Cursor
 * CLI where the plugin's `stop` hook does not fire, without iterating over a
 * variable-length set of database close calls (requirement c900f599).
 */
export async function finishIdleRequests({
  connectionId,
  transcriptPath,
  state = null,
  connectionCapability = null,
  callRequest = null,
  callComplete = null,
  patchState = null,
  dir = DEFAULT_DIR,
  attempts = STABLE_READ_ATTEMPTS,
  log = (line) => process.stderr.write(line),
} = {}) {
  if (!connectionId || !transcriptPath) return { closed: [], localCompleted: false }
  const reqState = readRequestState(connectionId, { dir })
  if (reqState.readError) {
    const closeRefusal = {
      code: 'request_log_unreadable',
      error: reqState.readError?.message ?? 'request log unreadable',
    }
    log(`typed-turn-sync: idle cleanup skipped because request log is unreadable for ${connectionId}: ${JSON.stringify(closeRefusal)}\n`)
    return { closed: [], localCompleted: false, closeRefusal }
  }
  const sessionId = state?.session_id || null
  const localAttemptId = localTurnToComplete(state?.local_turn, sessionId)
  const pending = pendingWorkWithoutHostLists(reqState)
  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active || !active.ended) return { closed: [], localCompleted: false }

  // Identify the single request finished by this ended turn: either the request bound
  // to this transcript turn key, the foreground current request, or (when an explicit
  // reply already cleared `current` before `closeRequest` failed) the first finished open
  // request so one idle lap retries it without issuing a loop of close calls.
  const boundId = active.key ? reqState.seenTranscriptTurns.get(active.key) ?? null : null
  const candidateId =
    boundId && requestFinished(reqState, boundId, pending)
      ? boundId
      : reqState.current && requestFinished(reqState, reqState.current, pending)
        ? reqState.current
        : ([...reqState.open.keys()].find((id) => requestFinished(reqState, id, pending)) ?? null)

  const hasPendingWorkForRequest = (rState, requestId) => {
    if (!rState || !requestId) return false
    const pendingSet = pendingWorkWithoutHostLists(rState)
    if (pendingSet.has(requestId)) return true
    if (rState.open.has(requestId) && !requestFinished(rState, requestId, pendingSet)) return true
    for (const launch of new Set(rState.launches.values())) {
      const namesIt = launch.request === requestId || (Array.isArray(launch.also) && launch.also.includes(requestId))
      if (namesIt && (launch.kind === 'monitor' || (launch.notifies !== false && !launch.notified))) {
        return true
      }
    }
    for (const sched of rState.schedules) {
      if (sched.request === requestId || (Array.isArray(sched.also) && sched.also.includes(requestId))) {
        return true
      }
    }
    return false
  }

  // Also recover any server-accepted open whose local append previously failed so it is
  // closed on DevSpec even if the turn ended before a local write retry succeeded (req 3ea2b201),
  // NEVER closing a recovered request that has pending launches/monitors/schedules (ce71a72b),
  // and NEVER treating a transient `.pending-opens.json` read error as an empty queue (3ea2b201).
  const initialPendingLookup = pendingOpensForConnectionDetailed(dir, connectionId)
  const pendingEntries = initialPendingLookup.entries
  const closeablePendingEntries = pendingEntries.filter(([, entry]) => !hasPendingWorkForRequest(reqState, entry.requestId))
  const pendingFallback =
    !candidateId && closeablePendingEntries.length > 0
      ? closeablePendingEntries.find(([, entry]) => active.key && entry.turnKey === active.key) ?? closeablePendingEntries[0]
      : null

  const initialCurrent = reqState.current
  const initialJoined = new Set(reqState.joined)
  const initialStamp = active.stamp
  const clearEndedForeground = async () => {
    if (!initialCurrent) return
    await withTypedSyncLock(connectionId, dir, async () => {
      // Re-verify the transcript FIRST, then `.requests.jsonl` immediately after, so a
      // new live typed turn OR room command arriving while reading the transcript is
      // NEVER cleared (ce71a72b).
      const latestActive = activeTranscriptTurn(transcriptPath, { attempts })
      if (!latestActive || !latestActive.ended || latestActive.stamp !== initialStamp) return
      const curState = readRequestState(connectionId, { dir })
      if (curState.readError) return
      if (!curState.current || curState.current !== initialCurrent) return
      const curInfo = curState.open.get(curState.current)
      const shouldClear =
        curState.currentFromWake ||
        curState.currentBoundByWake ||
        curInfo?.kind === 'typed_prompt'
      if (shouldClear) {
        appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })
      }
    })
  }

  if (!candidateId && !pendingFallback && !localAttemptId) {
    if (initialPendingLookup.readError) {
      const errRefusal = structuredRefusalFromError(initialPendingLookup.readError)
      const closeRefusal = {
        ...errRefusal,
        ...(errRefusal.code ? { cause_code: errRefusal.code } : {}),
        code: 'pending_opens_unreadable',
        retryable: true,
      }
      log(
        `typed-turn-sync: idle cleanup could not read pending-opens recovery queue for ${connectionId}: ${JSON.stringify(closeRefusal)}\n`,
      )
      return { closed: [], localCompleted: false, closeRefusal }
    }
    await clearEndedForeground()
    return { closed: [], localCompleted: false }
  }

  let localCompleted = false
  let localCompleteRefusal = null
  if (localAttemptId && typeof callComplete === 'function') {
    const [completeArgs] = completionArguments({ connectionId, commands: [], localAttemptId, reason: 'turn_end' })
    if (completeArgs) {
      try {
        const res = await callComplete(completeArgs)
        const refused = refusalFromResponse(res)
        if (refused) {
          localCompleteRefusal = refused
          log(`typed-turn-sync: idle report_complete refused for ${connectionId}: ${JSON.stringify(refused)}\n`)
        } else if (!isConfirmedCompleteResponse(res)) {
          localCompleteRefusal = {
            code: 'unrecognized_complete_response',
            retryable: true,
            error: 'report_complete returned an unrecognized response without a completion confirmation.',
            response: res ?? null,
          }
          log(`typed-turn-sync: idle report_complete returned unrecognized response for ${connectionId}: ${JSON.stringify(localCompleteRefusal)}\n`)
        } else if (typeof patchState === 'function') {
          // Guard clearing `local_turn` under `withTypedSyncLock` and re-check BOTH
          // persisted + in-memory `local_turn.attempt_id` and the transcript so a valid
          // receipt for the previous turn NEVER erases a newer turn's saved attempt
          // admitted while `await callComplete` was in flight (requirement 3ea2b201).
          const clearOutcome = await withTypedSyncLock(connectionId, dir, async () => {
            const latestActive = activeTranscriptTurn(transcriptPath, { attempts })
            if (!latestActive || latestActive.budgetExhausted) {
              return {
                status: 'transcript_unreadable',
                refusal: {
                  code: latestActive?.budgetExhausted ? 'budget_exhausted' : 'transcript_unreadable',
                  retryable: true,
                  error: 'Could not re-read transcript after idle report_complete to verify local_turn is still safe to clear.',
                },
              }
            }
            const stateFile = path.join(dir, `${connectionId}.json`)
            let diskState = null
            try {
              const rawState = fs.readFileSync(stateFile, 'utf8')
              diskState = JSON.parse(rawState)
            } catch (err) {
              if (err?.code !== 'ENOENT') {
                const errRefusal = structuredRefusalFromError(err)
                return {
                  status: 'state_unreadable',
                  refusal: {
                    ...errRefusal,
                    ...(errRefusal.code ? { cause_code: errRefusal.code } : {}),
                    code: 'state_unreadable',
                    retryable: true,
                    error:
                      err?.message ??
                      'Could not read connection state file after idle report_complete to verify local_turn.',
                  },
                }
              }
            }
            const diskAttemptId = diskState?.local_turn?.attempt_id ?? null
            const memAttemptId = state?.local_turn?.attempt_id ?? null
            const supersededByAttempt =
              (diskAttemptId && diskAttemptId !== localAttemptId) ||
              (memAttemptId && memAttemptId !== localAttemptId)
            const transcriptAdvanced = !latestActive.ended || latestActive.stamp !== initialStamp
            if (supersededByAttempt || transcriptAdvanced) {
              return { status: 'superseded' }
            }
            let saved = false
            try {
              saved = patchState({ local_turn: null }) === true
            } catch (error) {
              log(
                `typed-turn-sync: failed to persist cleared local_turn for ${connectionId}: ${error instanceof Error ? error.message : String(error)}\n`,
              )
              saved = false
            }
            return { status: saved ? 'cleared' : 'write_failed' }
          })
          if (
            !clearOutcome ||
            clearOutcome.status === 'write_failed' ||
            clearOutcome.status === 'state_unreadable' ||
            clearOutcome.status === 'transcript_unreadable'
          ) {
            localCompleteRefusal = clearOutcome?.refusal ?? {
              code: !clearOutcome ? 'lock_busy' : 'state_write_failed',
              retryable: true,
              error: !clearOutcome
                ? 'Could not acquire typed-sync lock to persist cleared local_turn after idle report_complete.'
                : 'Failed to persist cleared local_turn after idle report_complete.',
            }
            log(
              `typed-turn-sync: failed to verify or persist cleared local_turn for ${connectionId}: ${JSON.stringify(localCompleteRefusal)}\n`,
            )
          } else {
            localCompleted = true
          }
        } else {
          localCompleted = true
        }
      } catch (error) {
        localCompleteRefusal = structuredRefusalFromError(error)
        log(`typed-turn-sync: idle report_complete failed for ${connectionId}: ${JSON.stringify(localCompleteRefusal)}\n`)
      }
    }
  }
  // Surface structured local-turn completion refusals directly rather than dropping them
  // and proceeding with request cleanup (requirement 4e32d1a5).
  if (localCompleteRefusal) {
    return { closed: [], localCompleted: false, localCompleteRefusal }
  }

  const closed = []
  let closeRefusal = null
  let abortedClose = false
  const maybeRotateLog = () => {
    const remainingPending = pendingOpensForConnectionDetailed(dir, connectionId)
    if (!remainingPending.readError && remainingPending.entries.length === 0) {
      rotateRequestLog(connectionId, { dir })
    }
  }
  // Persist a server-acknowledged close locally ONLY under the sync lock after
  // re-verifying that no pending launch/monitor/schedule was recorded for the request
  // while `await callRequest` was in flight (decision ce71a72b) AND only mark the close
  // complete / delete `.pending-opens.json` recovery state once the local close event
  // actually persists (requirement 3ea2b201).
  const commitServerClose = async (targetRequestId, { isCandidate = false, pendingKey = null, pendingEntry = null } = {}) => {
    let commitOutcome = null
    try {
      commitOutcome = await withTypedSyncLock(connectionId, dir, async () => {
        // Re-read the transcript FIRST, then `.requests.jsonl` immediately after. If the
        // transcript cannot be re-read after the close reply, FAIL CLOSED instead of
        // recording a local close or reporting success without verification (req 3ea2b201).
        const postCloseActive = activeTranscriptTurn(transcriptPath, { attempts })
        if (!postCloseActive || postCloseActive.budgetExhausted) {
          return {
            status: 'refused',
            refusal: {
              code: postCloseActive?.budgetExhausted ? 'budget_exhausted' : 'transcript_unreadable',
              retryable: true,
              request_id: targetRequestId,
              error: 'Could not re-read transcript after close reply to verify request is still safe to close',
            },
          }
        }
        const postCloseState = readRequestState(connectionId, { dir })
        if (postCloseState.readError) {
          return {
            status: 'refused',
            refusal: {
              code: 'request_log_unreadable',
              error: postCloseState.readError?.message ?? 'request log unreadable after close reply',
            },
          }
        }
        const postCloseStillIdle = Boolean(
          postCloseActive.ended && postCloseActive.stamp === initialStamp,
        )
        const newlyCarried =
          (postCloseState.current === targetRequestId && initialCurrent !== targetRequestId) ||
          (postCloseState.joined.has(targetRequestId) && !initialJoined.has(targetRequestId))
        const targetCarriedByLiveTurn =
          (!postCloseStillIdle &&
            (postCloseState.current === targetRequestId || postCloseState.joined.has(targetRequestId))) ||
          newlyCarried
        if (targetCarriedByLiveTurn || hasPendingWorkForRequest(postCloseState, targetRequestId)) {
          return { status: 'aborted_pending_work' }
        }
        if (isCandidate && postCloseState.open.has(targetRequestId)) {
          const postPending = pendingWorkWithoutHostLists(postCloseState)
          if (!requestFinished(postCloseState, targetRequestId, postPending)) {
            return { status: 'aborted_pending_work' }
          }
        }
        const alreadyClosedLocally =
          !postCloseState.open.has(targetRequestId) && Boolean(postCloseState.closed?.has(targetRequestId))
        const localClosed = alreadyClosedLocally
          ? true
          : appendRequestEvent(connectionId, { op: 'close', id: targetRequestId }, { dir })
        if (!localClosed) {
          return {
            status: 'refused',
            refusal: {
              code: 'local_close_persist_failed',
              retryable: true,
              request_id: targetRequestId,
              error: 'DevSpec acknowledged close but local close record failed to persist',
            },
          }
        }
        // Remove matching `.pending-opens.json` recovery entry ONLY once local close is
        // persisted, re-reading `.pending-opens.json` under the lock so a transient read
        // error is NEVER treated as an empty queue and any failure to inspect or remove
        // the recovery entry fails closed (requirement 3ea2b201).
        let cleanupFailed = null
        const postPendingLookup = pendingOpensForConnectionDetailed(dir, connectionId)
        if (postPendingLookup.readError) {
          cleanupFailed = postPendingLookup.readError
        } else if (pendingEntry) {
          const removed = deletePendingLocalOpen(dir, connectionId, pendingKey, pendingEntry.turnKey, pendingEntry.requestId)
          if (!removed.ok) cleanupFailed = removed.error ?? new Error('failed to remove pending-open recovery entry')
        } else {
          for (const [pKey, entry] of postPendingLookup.entries) {
            if (entry.requestId === targetRequestId) {
              const removed = deletePendingLocalOpen(dir, connectionId, pKey, entry.turnKey, entry.requestId)
              if (!removed.ok) cleanupFailed ??= removed.error ?? new Error('failed to remove pending-open recovery entry')
            }
          }
        }
        if (cleanupFailed) {
          const errRefusal = structuredRefusalFromError(cleanupFailed)
          return {
            status: 'refused',
            refusal: {
              ...errRefusal,
              ...(errRefusal.code ? { cause_code: errRefusal.code } : {}),
              code: 'pending_open_cleanup_failed',
              retryable: true,
              request_id: targetRequestId,
            },
          }
        }
        return { status: 'closed' }
      })
    } catch (lockErr) {
      commitOutcome = {
        status: 'refused',
        refusal: {
          code: 'local_close_persist_failed',
          retryable: true,
          request_id: targetRequestId,
          ...structuredRefusalFromError(lockErr),
        },
      }
    }
    if (!commitOutcome) {
      commitOutcome = {
        status: 'refused',
        refusal: {
          code: 'lock_busy',
          retryable: true,
          request_id: targetRequestId,
          error: 'Could not acquire typed-sync lock to persist close',
        },
      }
    }
    if (commitOutcome.status === 'closed') {
      closed.push(targetRequestId)
      maybeRotateLog()
    } else if (commitOutcome.status === 'aborted_pending_work') {
      abortedClose = true
    } else {
      closeRefusal = commitOutcome.refusal
      log(
        `typed-turn-sync: idle local close failed for ${connectionId} (${targetRequestId}): ${JSON.stringify(closeRefusal)}\n`,
      )
    }
  }
  if (candidateId && connectionCapability && typeof callRequest === 'function') {
    // Re-read transcript FIRST, then `.requests.jsonl`, AFTER awaiting `callComplete` so
    // a background launch, schedule, or new turn recorded during that wait is NEVER closed
    // prematurely, and an unreadable transcript fails closed instead of silently skipping
    // verification (requirements 3ea2b201 / ce71a72b).
    const preCloseActive = activeTranscriptTurn(transcriptPath, { attempts })
    if (!preCloseActive || preCloseActive.budgetExhausted) {
      closeRefusal = {
        code: preCloseActive?.budgetExhausted ? 'budget_exhausted' : 'transcript_unreadable',
        retryable: true,
        request_id: candidateId,
        error: 'Could not re-read transcript before close to verify turn is still idle',
      }
      log(`typed-turn-sync: idle close skipped because transcript is unreadable for ${connectionId} (${candidateId}): ${JSON.stringify(closeRefusal)}\n`)
    } else {
      const preCloseState = readRequestState(connectionId, { dir })
      if (preCloseState.readError) {
        closeRefusal = {
          code: 'request_log_unreadable',
          error: preCloseState.readError?.message ?? 'request log unreadable before close',
        }
        log(`typed-turn-sync: idle close skipped because request log is unreadable for ${connectionId} (${candidateId}): ${JSON.stringify(closeRefusal)}\n`)
      } else {
        const preCloseStillIdle = Boolean(preCloseActive.ended && preCloseActive.stamp === initialStamp)
        const preClosePending = preCloseStillIdle ? pendingWorkWithoutHostLists(preCloseState) : null
        const stillFinished =
          preCloseStillIdle && requestFinished(preCloseState, candidateId, preClosePending)
        if (stillFinished) {
          let lastCloseResponse = null
          let lastCloseError = null
          let serverClosed = false
          try {
            const res = await callRequest({
              connection_id: connectionId,
              action: 'close',
              request_id: candidateId,
              reason: 'host_finished',
            })
            lastCloseResponse = res
            serverClosed = res?.status === 'closed'
          } catch (err) {
            lastCloseError = err
            serverClosed = /unknown request/i.test(String(err?.message ?? err))
          }
          if (serverClosed) {
            await commitServerClose(candidateId, { isCandidate: true })
          } else {
            closeRefusal =
              refusalFromResponse(lastCloseResponse) ??
              (lastCloseResponse && typeof lastCloseResponse === 'object' ? lastCloseResponse : null) ??
              (lastCloseError ? structuredRefusalFromError(lastCloseError) : { status: 'not_closed' })
            log(`typed-turn-sync: idle closeRequest refused/incomplete for ${connectionId} (${candidateId}): ${JSON.stringify(closeRefusal)}\n`)
          }
        }
      }
    }
  } else if (pendingFallback && connectionCapability && typeof callRequest === 'function') {
    const [pendingKey, pendingEntry] = pendingFallback
    const preCloseActive = activeTranscriptTurn(transcriptPath, { attempts })
    if (!preCloseActive || preCloseActive.budgetExhausted) {
      closeRefusal = {
        code: preCloseActive?.budgetExhausted ? 'budget_exhausted' : 'transcript_unreadable',
        retryable: true,
        request_id: pendingEntry.requestId,
        error: 'Could not re-read transcript before fallback close to verify turn is still idle',
      }
      log(`typed-turn-sync: idle pending-open close skipped because transcript is unreadable for ${connectionId} (${pendingEntry.requestId}): ${JSON.stringify(closeRefusal)}\n`)
    } else {
      const preCloseState = readRequestState(connectionId, { dir })
      if (preCloseState.readError) {
        closeRefusal = {
          code: 'request_log_unreadable',
          error: preCloseState.readError?.message ?? 'request log unreadable before fallback close',
        }
        log(`typed-turn-sync: idle pending-open close skipped because request log is unreadable for ${connectionId} (${pendingEntry.requestId}): ${JSON.stringify(closeRefusal)}\n`)
      } else {
        const preCloseStillIdle =
          Boolean(preCloseActive.ended && preCloseActive.stamp === initialStamp) &&
          !hasPendingWorkForRequest(preCloseState, pendingEntry.requestId)
        if (preCloseStillIdle) {
          let lastCloseResponse = null
          let lastCloseError = null
          let serverClosed = false
          try {
            const res = await callRequest({
              connection_id: connectionId,
              action: 'close',
              request_id: pendingEntry.requestId,
              reason: 'host_finished',
            })
            lastCloseResponse = res
            serverClosed = res?.status === 'closed'
          } catch (err) {
            lastCloseError = err
            serverClosed = /unknown request/i.test(String(err?.message ?? err))
          }
          if (serverClosed) {
            await commitServerClose(pendingEntry.requestId, { isCandidate: false, pendingKey, pendingEntry })
          } else {
            closeRefusal =
              refusalFromResponse(lastCloseResponse) ??
              (lastCloseResponse && typeof lastCloseResponse === 'object' ? lastCloseResponse : null) ??
              (lastCloseError ? structuredRefusalFromError(lastCloseError) : { status: 'not_closed' })
            log(`typed-turn-sync: idle pending-open close refused/incomplete for ${connectionId} (${pendingEntry.requestId}): ${JSON.stringify(closeRefusal)}\n`)
          }
        }
      }
    }
  } else if (initialPendingLookup.readError) {
    const errRefusal = structuredRefusalFromError(initialPendingLookup.readError)
    closeRefusal = {
      ...errRefusal,
      ...(errRefusal.code ? { cause_code: errRefusal.code } : {}),
      code: 'pending_opens_unreadable',
      retryable: true,
    }
    log(
      `typed-turn-sync: idle cleanup could not read pending-opens recovery queue for ${connectionId}: ${JSON.stringify(closeRefusal)}\n`,
    )
  }

  if (!closeRefusal && !abortedClose) await clearEndedForeground()

  return {
    closed,
    localCompleted,
    ...(closeRefusal ? { closeRefusal } : {}),
  }
}
