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
import { randomBytes } from 'node:crypto'
import {
  appendRequestEvent,
  closeRequest,
  openRequest,
  readRequestState,
  requestFinished,
  requestsWithWorkPending,
  rotateRequestLog,
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
 * `TYPED_SYNC_HOOK_TIMEOUT_MS` (2.5 s) so a `preToolUse` hook waiting on a concurrent
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
      sleepSync(TYPED_SYNC_LOCK_RETRY_MS)
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
 * has changed since the last check and may hold a new typed turn or turn end.
 */
export function typedTurnSyncPending({ transcriptPath, memo = null } = {}) {
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return false
  if (memo && memo.stamp === stamp) return false
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
function structuredRefusalFromError(error) {
  if (!error || typeof error !== 'object') {
    return { error: String(error ?? 'refused') }
  }
  const refusal = {
    error: error instanceof Error ? error.message : String(error.message ?? error),
  }
  for (const field of ['code', 'status', 'details', 'data', 'refusal', 'body']) {
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

  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active) return { action: 'unreadable' }
  if (memo) {
    memo.stamp = active.stamp
    memo.synced = false
  }
  if (active.ended || !active.key) {
    if (memo) memo.synced = true
    return { action: 'not_typed_live', active }
  }

  const initial = readRequestState(connectionId, { dir })
  if (initial.seenTranscriptTurns.has(active.key)) {
    if (memo) memo.synced = true
    return { action: 'already_synced', key: active.key, ref: initial.seenTranscriptTurns.get(active.key) }
  }

  // A live non-typed turn (timestamp-only wake or room command wake) must not inherit an
  // unrelated earlier typed_prompt if it arrived before idle cleanup — EXCEPT when that
  // typed_prompt has a pending background/scheduled continuation (decision ce71a72b / 2fcd26bd).
  if (active.kind !== 'typed') {
    const initialPending = requestsWithWorkPending(initial, { sessionCrons: recordedSessionCrons(initial) })
    const staleTypedCurrent =
      initial.current &&
      initial.open.get(initial.current)?.kind === 'typed_prompt' &&
      !initialPending.has(initial.current)
        ? initial.current
        : null
    if (!staleTypedCurrent) {
      if (memo) memo.synced = true
      return { action: 'not_typed_live', active }
    }
    const cleared = await withTypedSyncLock(
      connectionId,
      dir,
      async () => {
        const reqState = readRequestState(connectionId, { dir })
        if (reqState.seenTranscriptTurns.has(active.key)) {
          return { action: 'already_synced', key: active.key, ref: reqState.seenTranscriptTurns.get(active.key) }
        }
        const pending = requestsWithWorkPending(reqState, { sessionCrons: recordedSessionCrons(reqState) })
        if (
          reqState.current &&
          reqState.open.get(reqState.current)?.kind === 'typed_prompt' &&
          !pending.has(reqState.current)
        ) {
          if (!appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })) {
            return { action: 'binding_write_failed', key: active.key, active }
          }
        }
        if (!appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: null }, { dir })) {
          return { action: 'binding_write_failed', key: active.key, active }
        }
        return { action: 'cleared_for_wake', key: active.key, active }
      },
      { deadlineMs },
    )
    if (memo && cleared && (cleared.action === 'cleared_for_wake' || cleared.action === 'already_synced')) {
      memo.synced = true
    }
    return cleared ?? { action: 'lock_busy' }
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
      const existingTyped = unboundOpenTypedPrompt(reqState)
      let requestId = existingTyped
      let openedNow = false

      if (!requestId && connectionCapability && typeof effectiveCallRequest === 'function') {
        requestId = await openRequest({
          connectionId,
          kind: 'typed_prompt',
          call: effectiveCallRequest,
          dir,
        }).catch(() => null)
        if (requestId) {
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
      }

      if (requestId) {
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
            const saved = patchState({ local_turn: admission.admitted })
            if (saved === false) {
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
      return { action: 'cleared_stale', key: active.key }
    },
    { deadlineMs },
  )

  if (
    memo &&
    result &&
    (result.action === 'opened' || result.action === 'already_synced' || result.action === 'adopted_hook_request')
  ) {
    memo.synced = true
  }
  return result ?? { action: 'lock_busy' }
}

/**
 * When Cursor is between turns (`ended: true`), close the single finished request
 * belonging to the ended turn (if it has no pending background work or recorded
 * schedules) and complete any lingering `local_turn` admission. Covers Cursor CLI
 * where the plugin's `stop` hook does not fire, without iterating over a variable-length
 * set of database close calls (requirement c900f599).
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
} = {}) {
  if (!connectionId || !transcriptPath) return { closed: [], localCompleted: false }
  const reqState = readRequestState(connectionId, { dir })
  const sessionId = state?.session_id || null
  const localAttemptId = localTurnToComplete(state?.local_turn, sessionId)
  const sessionCrons = recordedSessionCrons(reqState)
  const pending = requestsWithWorkPending(reqState, { sessionCrons })
  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active || !active.ended) return { closed: [], localCompleted: false }

  // Identify the single request finished by this ended turn: either the request bound
  // to this transcript turn key, or the foreground current request when finished.
  const boundId = active.key ? reqState.seenTranscriptTurns.get(active.key) ?? null : null
  const candidateId =
    boundId && requestFinished(reqState, boundId, pending)
      ? boundId
      : reqState.current && requestFinished(reqState, reqState.current, pending)
        ? reqState.current
        : null

  if (!candidateId && !localAttemptId) return { closed: [], localCompleted: false }

  let localCompleted = false
  if (localAttemptId && typeof callComplete === 'function') {
    const [completeArgs] = completionArguments({ connectionId, commands: [], localAttemptId, reason: 'turn_end' })
    if (completeArgs) {
      try {
        await callComplete(completeArgs)
        localCompleted = true
        if (typeof patchState === 'function') patchState({ local_turn: null })
      } catch {
        /* leave local_turn in place so the next idle tick retries */
      }
    }
  }

  const closed = []
  if (candidateId && connectionCapability && typeof callRequest === 'function') {
    const ok = await closeRequest({
      connectionId,
      requestId: candidateId,
      call: callRequest,
      dir,
    }).catch(() => false)
    if (ok) {
      closed.push(candidateId)
      rotateRequestLog(connectionId, { dir })
    }
  }

  return { closed, localCompleted }
}
