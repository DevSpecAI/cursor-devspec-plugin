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
export function typedTurnSyncPending({ transcriptPath, memo = null } = {}) {
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return false
  if (memo && memo.stamp === stamp && memo.synced === true) return false
  return true
}

/**
 * Record the connect turn's own typed prompt as already observed so `/devspec-remote`
 * itself does not open a stray `typed_prompt` request right as the connection starts.
 */
export function recordConnectTurnBaseline(connectionId, transcriptPath, { dir = DEFAULT_DIR, attempts = STABLE_READ_ATTEMPTS } = {}) {
  if (!connectionId || !transcriptPath) return false
  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active || active.kind !== 'typed' || active.ended || !active.key) return false
  const reqState = readRequestState(connectionId, { dir })
  if (reqState.seenTranscriptTurns.has(active.key)) return false
  return appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: null }, { dir })
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
 * a typed prompt added during it joins the turn rather than silently replacing it).
 */
function hasActiveRemoteCommandTurn(connectionId, reqState, dir) {
  if (!reqState?.current) return false
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

/**
 * Process-local retry cache for requests that DevSpec already opened (`status: 'open'`)
 * when local `appendRequestEvent` failed transiently. Keyed by resolved dir, connection
 * id, and transcript turn key so retries persist the already-opened server request
 * instead of opening a second orphaned request on DevSpec (requirement 3ea2b201).
 */
const pendingLocalOpens = new Map()
/**
 * Tracks the latest typed turn key whose registration failed/was refused per
 * `<resolvedDir>|<connectionId>`, so if the turn ends before a retry succeeds, the
 * poller retries registration rather than marking the ended transcript synced without
 * completing the refused work (requirement 3ea2b201).
 */
const failedTypedTurnKeys = new Map()

function pendingOpenKey(dir, connectionId, turnKey) {
  return `${path.resolve(dir)}|${connectionId}|${turnKey}`
}

function failedTurnKey(dir, connectionId) {
  return `${path.resolve(dir)}|${connectionId}`
}

function flushPendingLocalOpenEntry(connectionId, dir, pKey, entry) {
  const reqState = readRequestState(connectionId, { dir })
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
      joined: [...reqState.joined],
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
    }
    if (!fg.currentRestored) {
      if (reqState.current === entry.requestId || !reqState.started.has(entry.requestId)) {
        const restoredOk = appendRequestEvent(
          connectionId,
          {
            op: 'current',
            ref: fg.current,
            ...(fg.fromWake && fg.current !== null ? { from_wake: true } : {}),
          },
          { dir },
        )
        if (!restoredOk) return false
        fg.currentRestored = true
      } else {
        // A newer foreground turn already replaced `current` before retry;
        // do not overwrite it with older foreground state.
        delete entry.restoreForeground
      }
    }
    if (entry.restoreForeground) {
      for (const joinedId of fg.joined) {
        if (reqState.joined.has(joinedId) && reqState.current === fg.current) continue
        if (!appendRequestEvent(connectionId, { op: 'joined', id: joinedId }, { dir })) {
          return false
        }
      }
      delete entry.restoreForeground
    }
  }
  if (entry.turnKey && !reqState.seenTranscriptTurns.has(entry.turnKey)) {
    const boundOk = appendRequestEvent(
      connectionId,
      { op: 'transcript_turn', key: entry.turnKey, ref: entry.requestId },
      { dir },
    )
    if (!boundOk) return false
  }
  pendingLocalOpens.delete(pKey)
  return true
}

/**
 * Pending requests when the caller has NO host `background_tasks` or `session_crons`
 * list (e.g. poller idle cleanup or explicit-reply hook): preserves both recorded
 * schedules (`recordedSessionCrons`) AND recorded `Monitor` launches (`kind: 'monitor'`,
 * which emit event wakes without completion notices, `notifies: false`), so idle cleanup
 * never closes a request while its monitor or schedule can still wake the agent
 * (decision ce71a72b).
 */
export function pendingWorkWithoutHostLists(reqState) {
  const sessionCrons = recordedSessionCrons(reqState)
  const pending = requestsWithWorkPending(reqState, { sessionCrons })
  for (const launch of new Set(reqState.launches.values())) {
    if (launch.kind === 'monitor' && !launch.notified) {
      for (const id of [launch.request, ...(launch.also ?? [])]) {
        if (reqState.open.has(id)) pending.add(id)
      }
    }
  }
  return pending
}

function pendingOpensForConnection(dir, connectionId) {
  const prefix = `${path.resolve(dir)}|${connectionId}|`
  const matches = []
  for (const [key, entry] of pendingLocalOpens) {
    if (key.startsWith(prefix)) matches.push([key, entry])
  }
  return matches
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

  const stamp = fileStamp(transcriptPath)
  if (!stamp) return { action: 'none' }
  if (memo && memo.stamp === stamp && memo.synced) return { action: 'unchanged' }

  const active = activeTranscriptTurn(transcriptPath, { attempts, deadlineMs })
  if (active?.budgetExhausted) {
    log(`typed-turn-sync: transcript read budget (${budgetMs} ms) exhausted for ${connectionId}\n`)
    return { action: 'budget_exhausted', budget_ms: budgetMs }
  }
  if (!active) return { action: 'unreadable' }
  if (memo) {
    memo.stamp = active.stamp
    memo.synced = false
  }
  if (active.ended || !active.key) {
    const pendingEntries = pendingOpensForConnection(dir, connectionId)
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
          action: 'open_write_failed',
          requestId: pendingEntries[0][1].requestId,
          active,
        }
      }
    }
    const fKey = failedTurnKey(dir, connectionId)
    if (active.ended && active.kind === 'typed' && active.key && failedTypedTurnKeys.get(fKey) === active.key) {
      const reqState = readRequestState(connectionId, { dir })
      if (reqState.seenTranscriptTurns.has(active.key)) {
        failedTypedTurnKeys.delete(fKey)
      } else {
        if (!connectionCapability || typeof effectiveCallRequest !== 'function') {
          return { action: 'cleared_stale', key: active.key, ended: true }
        }
        const retryResult = await withTypedSyncLock(
          connectionId,
          dir,
          async () => {
            const lockedState = readRequestState(connectionId, { dir })
            if (lockedState.seenTranscriptTurns.has(active.key)) {
              failedTypedTurnKeys.delete(fKey)
              return {
                action: 'already_synced',
                key: active.key,
                ref: lockedState.seenTranscriptTurns.get(active.key),
              }
            }
            const deterministicId = deterministicTypedTurnRequestId(connectionId, active.key)
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
                  pendingLocalOpens.set(pendingOpenKey(dir, connectionId, active.key), {
                    requestId: opened.requestId,
                    requestedBy: opened.requestedBy ?? null,
                    turnKey: active.key,
                  })
                  failedTypedTurnKeys.delete(fKey)
                }
                log(
                  `typed-turn-sync: ended-turn local open_request persistence failed for ${connectionId} (${active.key}): ${JSON.stringify(opened.refusal)}\n`,
                )
                return {
                  action: 'open_write_failed',
                  requestId: opened.requestId,
                  key: active.key,
                  ended: true,
                  refusal: opened.refusal,
                }
              } else {
                log(
                  `typed-turn-sync: ended-turn open_request retry failed for ${connectionId} (${active.key}): ${JSON.stringify(opened.refusal)}\n`,
                )
                return {
                  action: 'cleared_stale',
                  key: active.key,
                  ended: true,
                  refusal: opened.refusal,
                }
              }
            }
            const pKey = pendingOpenKey(dir, connectionId, active.key)
            const entry = { requestId, requestedBy, turnKey: active.key }
            pendingLocalOpens.set(pKey, entry)
            const persisted = flushPendingLocalOpenEntry(connectionId, dir, pKey, entry)
            failedTypedTurnKeys.delete(fKey)
            if (!persisted) {
              return {
                action: 'open_write_failed',
                requestId,
                key: active.key,
                ended: true,
              }
            }
            return { action: 'opened', requestId, key: active.key, ended: true }
          },
          { deadlineMs },
        )
        if (!retryResult) return { action: 'lock_busy' }
        if (memo && (retryResult.action === 'opened' || retryResult.action === 'already_synced')) {
          memo.synced = true
        }
        return retryResult
      }
    }
    if (memo) memo.synced = true
    return { action: 'not_typed_live', active }
  }

  const initial = readRequestState(connectionId, { dir })
  if (initial.seenTranscriptTurns.has(active.key)) {
    if (memo) memo.synced = true
    return { action: 'already_synced', key: active.key, ref: initial.seenTranscriptTurns.get(active.key) }
  }

  // Resolve explicit host-injected `<task-notification>` wakes whose `<task-id>` /
  // `<tool-use-id>` / `owner_message` / `automation_run` positively matches a recorded
  // launch or command in `requests.mjs` (`requestForWake`, decision ce71a72b).
  // Never guess from pending launches when a generic `command_turn` row or ID-less
  // notification carries no matching job ID: leaving the requester unstated prevents
  // misattributing another person's or unrelated background work (decisions ce71a72b / 2fcd26bd).
  const resolveTranscriptWake = (reqState) => {
    if (active.kind === 'typed') return null
    const rawText = typeof active.rawText === 'string' ? active.rawText : ''
    if (!rawText) return null
    const taskMatch = requestForWake({ origin: 'task-notification', text: rawText, state: reqState })
    if (taskMatch.ref !== UNSTATED) return { origin: 'task-notification', text: rawText, match: taskMatch, direct: true }
    return null
  }

  if (resolveTranscriptWake(initial)) {
    const restored = await withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const reqState = readRequestState(connectionId, { dir })
        if (reqState.seenTranscriptTurns.has(active.key)) {
          return { action: 'already_synced', key: active.key, ref: reqState.seenTranscriptTurns.get(active.key) }
        }
        const wake = resolveTranscriptWake(reqState)
        if (!wake) return { action: 'not_a_wake' }
        const events = wake.direct
          ? promptArrival({
              fromAPerson: false,
              origin: wake.origin,
              text: wake.text,
              midTurn: false,
              state: reqState,
            }).events
          : [
              { op: 'current', ref: wake.match.ref, from_wake: true },
              ...wake.match.also.map((id) => ({ op: 'joined', id })),
            ]
        for (const event of events) {
          if (!appendRequestEvent(connectionId, event, { dir })) {
            return { action: 'binding_write_failed', key: active.key, active }
          }
        }
        const ref = wake.match.ref === UNSTATED ? null : wake.match.ref
        if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref }, { dir })) {
          return { action: 'binding_write_failed', requestId: ref, key: active.key, active }
        }
        return { action: 'restored_wake_request', requestId: ref, key: active.key, active }
      },
      { deadlineMs },
    )
    if (!restored) return { action: 'lock_busy' }
    if (restored.action !== 'not_a_wake') {
      if (memo && (restored.action === 'restored_wake_request' || restored.action === 'already_synced')) {
        memo.synced = true
      }
      return restored
    }
  }

  // A live non-typed turn (timestamp-only wake or command_turn wake) must not inherit an
  // unrelated earlier typed_prompt OR an already-answered room command restored by a prior
  // background wake — even if an unnotified background job or scheduled run exists — unless
  // this wake was explicitly restored by host promptArrival (`currentFromWake`) or carried
  // an explicit `<task-notification>` handled above (decisions 2fcd26bd / ce71a72b).
  const isClearableForUnrelatedWake = (reqState) => {
    if (!reqState?.current) return false
    const info = reqState.open.get(reqState.current)
    if (!info) return false
    return info.kind === 'typed_prompt' || (info.kind === 'command' && info.answered === true)
  }

  if (active.kind !== 'typed') {
    if (!isClearableForUnrelatedWake(initial)) {
      if (memo) memo.synced = true
      return { action: 'not_typed_live', active }
    }
    const outcome = await withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const reqState = readRequestState(connectionId, { dir })
        if (reqState.seenTranscriptTurns.has(active.key)) {
          return { action: 'already_synced', key: active.key, ref: reqState.seenTranscriptTurns.get(active.key) }
        }
        if (!isClearableForUnrelatedWake(reqState)) {
          return { action: 'not_typed_live', active }
        }
        if (reqState.currentFromWake) {
          // Preserve attribution ONLY for a wake explicitly restored via promptArrival.
          if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: reqState.current }, { dir })) {
            return { action: 'binding_write_failed', requestId: reqState.current, key: active.key, active }
          }
          return { action: 'preserved_wake_request', requestId: reqState.current, key: active.key, active }
        }
        if (!appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })) {
          return { action: 'binding_write_failed', key: active.key, active }
        }
        if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: null }, { dir })) {
          return { action: 'binding_write_failed', key: active.key, active }
        }
        return { action: 'cleared_for_wake', key: active.key, active }
      },
      { deadlineMs },
    )
    if (
      memo &&
      outcome &&
      (outcome.action === 'cleared_for_wake' ||
        outcome.action === 'preserved_wake_request' ||
        outcome.action === 'already_synced' ||
        outcome.action === 'not_typed_live')
    ) {
      memo.synced = true
    }
    return outcome ?? { action: 'lock_busy' }
  }

  const result = await withTypedSyncLock(
    connectionId,
    dir,
    async () => {
      const reqState = readRequestState(connectionId, { dir })
      if (reqState.seenTranscriptTurns.has(active.key)) {
        return { action: 'already_synced', key: active.key, ref: reqState.seenTranscriptTurns.get(active.key) }
      }

      const midTurn = hasActiveRemoteCommandTurn(connectionId, reqState, dir)
      const deterministicId = deterministicTypedTurnRequestId(connectionId, active.key)
      const alreadyOpenForTurn =
        reqState.open.get(deterministicId)?.kind === 'typed_prompt' ? deterministicId : null
      const existingTyped = unboundOpenTypedPrompt(reqState) ?? alreadyOpenForTurn
      let requestId = existingTyped
      let openedNow = false
      let openRefusal = null
      if (alreadyOpenForTurn && !unboundOpenTypedPrompt(reqState)) {
        const currentWritten = appendRequestEvent(
          connectionId,
          midTurn ? { op: 'joined', id: requestId } : { op: 'current', ref: requestId },
          { dir },
        )
        if (!currentWritten) {
          return { action: 'binding_write_failed', requestId, key: active.key, midTurn }
        }
      }
      const pKey = pendingOpenKey(dir, connectionId, active.key)
      const pendingOpen = !requestId ? pendingLocalOpens.get(pKey) ?? null : null

      if (pendingOpen) {
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
            key: active.key,
            midTurn,
            refusal: {
              code: 'local_open_persist_failed',
              error: 'DevSpec opened request but local open record failed to persist',
              request_id: pendingOpen.requestId,
            },
          }
        }
        pendingLocalOpens.delete(pKey)
        requestId = pendingOpen.requestId
        openedNow = true
        const currentWritten = appendRequestEvent(
          connectionId,
          midTurn ? { op: 'joined', id: requestId } : { op: 'current', ref: requestId },
          { dir },
        )
        if (!currentWritten) {
          return { action: 'binding_write_failed', requestId, key: active.key, midTurn }
        }
      }

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
          const currentWritten = appendRequestEvent(
            connectionId,
            midTurn ? { op: 'joined', id: requestId } : { op: 'current', ref: requestId },
            { dir },
          )
          if (!currentWritten) {
            return { action: 'binding_write_failed', requestId, key: active.key, midTurn }
          }
        } else if (opened.localPersistFailed) {
          if (opened.requestId) {
            pendingLocalOpens.set(pKey, {
              requestId: opened.requestId,
              requestedBy: opened.requestedBy ?? null,
              turnKey: active.key,
            })
          }
          log(
            `typed-turn-sync: local open_request persistence failed for ${connectionId} (${active.key}): ${JSON.stringify(opened.refusal)}\n`,
          )
          return {
            action: 'open_write_failed',
            requestId: opened.requestId,
            key: active.key,
            midTurn,
            refusal: opened.refusal,
          }
        } else {
          openRefusal = opened.refusal
          log(
            `typed-turn-sync: open_request failed for ${connectionId} (${active.key}): ${JSON.stringify(openRefusal)}\n`,
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
            key: active.key,
            midTurn,
          }
        }
        // Admit the terminal turn with the connection capability when attached, matching
        // `mirror-turn.mjs user_prompt` so claims and replies resolve to the owner at terminal.
        // Only mark the transcript turn synced once admission, state persistence, and binding
        // write all succeed; on refusal or write failure, preserve details and retry next tick.
        const sessionId = state?.session_id || null
        const scope =
          !midTurn && sessionId && connectionCapability && typeof effectiveCallPickup === 'function' && !state?.local_turn
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
              `typed-turn-sync: local turn admission failed for ${connectionId} (${active.key}): ${JSON.stringify(admission.refusal)}\n`,
            )
            return {
              action: 'admission_failed',
              requestId,
              key: active.key,
              midTurn,
              refusal: admission.refusal,
            }
          }
          if (typeof patchState === 'function') {
            let saved = false
            try {
              saved = patchState({ local_turn: admission.admitted }) === true
            } catch (error) {
              log(
                `typed-turn-sync: failed to persist local_turn state for ${connectionId} (${active.key}): ${error instanceof Error ? error.message : String(error)}\n`,
              )
              saved = false
            }
            if (!saved) {
              log(`typed-turn-sync: failed to persist local_turn state for ${connectionId} (${active.key})\n`)
              return {
                action: 'state_write_failed',
                requestId,
                key: active.key,
                midTurn,
              }
            }
          }
        }

        const bound = appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: requestId }, { dir })
        if (!bound) {
          return {
            action: 'binding_write_failed',
            requestId,
            key: active.key,
            midTurn,
          }
        }
        return {
          action: openedNow ? 'opened' : 'adopted_hook_request',
          requestId,
          key: active.key,
          midTurn,
        }
      }

      // Could not open a typed_prompt right now (offline / no capability / DevSpec refused):
      // still clear any stale foreground request so writes go out unstamped and DevSpec
      // resolves who asked from the connection rather than stamping a closed command.
      if (!midTurn && reqState.current !== null) {
        appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })
      }
      return {
        action: 'cleared_stale',
        key: active.key,
        ...(openRefusal ? { refusal: openRefusal } : {}),
      }
    },
    { deadlineMs },
  )

  const fKey = failedTurnKey(dir, connectionId)
  if (
    result &&
    (result.action === 'opened' || result.action === 'already_synced' || result.action === 'adopted_hook_request')
  ) {
    if (failedTypedTurnKeys.get(fKey) === active.key) failedTypedTurnKeys.delete(fKey)
    if (memo) memo.synced = true
  } else if (
    result &&
    (result.action === 'cleared_stale' ||
      result.action === 'admission_failed' ||
      result.action === 'state_write_failed' ||
      result.action === 'binding_write_failed')
  ) {
    failedTypedTurnKeys.set(fKey, active.key)
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

  // Also recover any server-accepted open whose local append previously failed so it is
  // closed on DevSpec even if the turn ended before a local write retry succeeded (req 3ea2b201).
  const pendingEntries = pendingOpensForConnection(dir, connectionId)
  const pendingFallback =
    !candidateId && pendingEntries.length > 0
      ? pendingEntries.find(([, entry]) => active.key && entry.turnKey === active.key) ?? pendingEntries[0]
      : null

  if (!candidateId && !pendingFallback && !localAttemptId) return { closed: [], localCompleted: false }

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
        } else {
          localCompleted = true
          if (typeof patchState === 'function') patchState({ local_turn: null })
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
  if (candidateId && connectionCapability && typeof callRequest === 'function') {
    let lastCloseResponse = null
    let lastCloseError = null
    const ok = await closeRequest({
      connectionId,
      requestId: candidateId,
      call: async (reqArgs) => {
        lastCloseResponse = null
        lastCloseError = null
        try {
          const res = await callRequest(reqArgs)
          lastCloseResponse = res
          return res
        } catch (err) {
          lastCloseError = err
          throw err
        }
      },
      dir,
    }).catch((err) => {
      lastCloseError = err
      return false
    })
    if (ok) {
      closed.push(candidateId)
      for (const [pKey, entry] of pendingEntries) {
        if (entry.requestId === candidateId) pendingLocalOpens.delete(pKey)
      }
      rotateRequestLog(connectionId, { dir })
    } else {
      closeRefusal =
        refusalFromResponse(lastCloseResponse) ??
        (lastCloseResponse && typeof lastCloseResponse === 'object' ? lastCloseResponse : null) ??
        (lastCloseError ? structuredRefusalFromError(lastCloseError) : { status: 'not_closed' })
      log(`typed-turn-sync: idle closeRequest refused/incomplete for ${connectionId} (${candidateId}): ${JSON.stringify(closeRefusal)}\n`)
    }
  } else if (pendingFallback && connectionCapability && typeof callRequest === 'function') {
    const [pendingKey, pendingEntry] = pendingFallback
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
      pendingLocalOpens.delete(pendingKey)
      // Best-effort close record if disk is writable again; request was never opened on disk.
      appendRequestEvent(connectionId, { op: 'close', id: pendingEntry.requestId }, { dir })
      closed.push(pendingEntry.requestId)
      rotateRequestLog(connectionId, { dir })
    } else {
      closeRefusal =
        refusalFromResponse(lastCloseResponse) ??
        (lastCloseResponse && typeof lastCloseResponse === 'object' ? lastCloseResponse : null) ??
        (lastCloseError ? structuredRefusalFromError(lastCloseError) : { status: 'not_closed' })
      log(`typed-turn-sync: idle pending-open close refused/incomplete for ${connectionId} (${pendingEntry.requestId}): ${JSON.stringify(closeRefusal)}\n`)
    }
  }

  return {
    closed,
    localCompleted,
    ...(closeRefusal ? { closeRefusal } : {}),
  }
}
