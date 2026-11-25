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
  finishTurnRequests,
  openRequest,
  readRequestState,
  requestFinished,
  requestsWithWorkPending,
} from './requests.mjs'
import { activeTranscriptTurn } from './transcript-turn-end.mjs'
import { localTurnScope, localTurnToComplete, startLocalTurn } from './local-turn.mjs'
import { completionArguments } from './turn-commands.mjs'

const DEFAULT_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
const LOCK_RETRY_MS = 20
const LOCK_TIMEOUT_MS = 2_000

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

async function withTypedSyncLock(connectionId, dir, work) {
  const target = lockPath(connectionId, dir)
  const mine = `${target}.${process.pid}-${randomBytes(4).toString('hex')}`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
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
      sleepSync(LOCK_RETRY_MS)
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
export function recordConnectTurnBaseline(connectionId, transcriptPath, { dir = DEFAULT_DIR, attempts = 2 } = {}) {
  if (!connectionId || !transcriptPath) return false
  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active || active.kind !== 'typed' || active.ended || !active.key) return false
  const reqState = readRequestState(connectionId, { dir })
  if (reqState.seenTranscriptTurns.has(active.key)) return false
  return appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: null }, { dir })
}

/**
 * Whether `reqState.current` is an open `typed_prompt` already opened by the
 * `beforeSubmitPrompt` hook for this turn (not yet bound to any older transcript turn).
 */
function hookOpenedTypedPrompt(reqState) {
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
 * Ensure a live terminal-typed turn in `transcriptPath` is recorded as a `typed_prompt`
 * request in `<connectionId>.requests.jsonl` (and admitted via `startLocalTurn` when
 * attached to a room). Fast-paths with zero network calls when unchanged or already synced.
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
  attempts = 3,
} = {}) {
  if (!connectionId || !transcriptPath) return { action: 'none' }
  const stamp = fileStamp(transcriptPath)
  if (!stamp) return { action: 'none' }
  if (memo && memo.stamp === stamp && memo.synced) return { action: 'unchanged' }

  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active) return { action: 'unreadable' }
  if (memo) {
    memo.stamp = active.stamp
    memo.synced = false
  }
  if (active.kind !== 'typed' || active.ended || !active.key) {
    if (memo) memo.synced = true
    return { action: 'not_typed_live', active }
  }

  const initial = readRequestState(connectionId, { dir })
  if (initial.seenTranscriptTurns.has(active.key)) {
    if (memo) memo.synced = true
    return { action: 'already_synced', key: active.key, ref: initial.seenTranscriptTurns.get(active.key) }
  }

  const result = await withTypedSyncLock(connectionId, dir, async () => {
    const reqState = readRequestState(connectionId, { dir })
    if (reqState.seenTranscriptTurns.has(active.key)) {
      return { action: 'already_synced', key: active.key, ref: reqState.seenTranscriptTurns.get(active.key) }
    }

    const fromHook = hookOpenedTypedPrompt(reqState)
    if (fromHook) {
      appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: fromHook }, { dir })
      return { action: 'adopted_hook_request', requestId: fromHook, key: active.key }
    }

    const midTurn = hasActiveRemoteCommandTurn(connectionId, reqState, dir)
    let requestId = null
    if (connectionCapability && typeof callRequest === 'function') {
      requestId = await openRequest({
        connectionId,
        kind: 'typed_prompt',
        call: callRequest,
        dir,
      }).catch(() => null)
    }

    if (requestId) {
      appendRequestEvent(
        connectionId,
        midTurn ? { op: 'joined', id: requestId } : { op: 'current', ref: requestId },
        { dir },
      )
      appendRequestEvent(connectionId, { op: 'transcript_turn', key: active.key, ref: requestId }, { dir })

      // Admit the terminal turn with the connection capability when attached, matching
      // `mirror-turn.mjs user_prompt` so claims and replies resolve to the owner at terminal.
      const sessionId = state?.session_id || null
      if (!midTurn && sessionId && connectionCapability && typeof callPickup === 'function' && !state?.local_turn) {
        const scope = localTurnScope({ ...state, connection_capability: connectionCapability }, sessionId)
        if (scope) {
          const admitted = await startLocalTurn({
            scope,
            previousAttemptId: state?.local_turn?.attempt_id ?? null,
            call: callPickup,
          }).catch(() => null)
          if (admitted && typeof patchState === 'function') patchState({ local_turn: admitted })
        }
      }
      return { action: 'opened', requestId, key: active.key, midTurn }
    }

    // Could not open a typed_prompt right now (offline / no capability / DevSpec refused):
    // still clear any stale foreground request so writes go out unstamped and DevSpec
    // resolves who asked from the connection rather than stamping a closed command.
    if (!midTurn && reqState.current !== null) {
      appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })
    }
    return { action: 'cleared_stale', key: active.key }
  })

  if (memo && result && (result.action === 'opened' || result.action === 'already_synced' || result.action === 'adopted_hook_request')) {
    memo.synced = true
  }
  return result ?? { action: 'lock_busy' }
}

/**
 * When Cursor is between turns (`ended: true`), close any finished open requests
 * (completed `typed_prompt` or answered room commands with no pending work) and
 * complete any lingering `local_turn` admission. Covers Cursor CLI where the plugin's
 * `stop` hook does not fire.
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
  attempts = 2,
} = {}) {
  if (!connectionId || !transcriptPath) return { closed: [], localCompleted: false }
  const reqState = readRequestState(connectionId, { dir })
  const sessionId = state?.session_id || null
  const localAttemptId = localTurnToComplete(state?.local_turn, sessionId)
  const pending = requestsWithWorkPending(reqState)
  const hasFinished = [...reqState.open.keys()].some((id) => requestFinished(reqState, id, pending))
  if (!hasFinished && !localAttemptId) return { closed: [], localCompleted: false }

  const active = activeTranscriptTurn(transcriptPath, { attempts })
  if (!active || !active.ended) return { closed: [], localCompleted: false }

  let localCompleted = false
  if (localAttemptId && typeof callComplete === 'function') {
    const calls = completionArguments({ connectionId, commands: [], localAttemptId, reason: 'turn_end' })
    let ok = true
    for (const args of calls) {
      try {
        await callComplete(args)
      } catch {
        ok = false
      }
    }
    if (ok) {
      localCompleted = true
      if (typeof patchState === 'function') patchState({ local_turn: null })
    }
  }

  let closed = []
  if (hasFinished && connectionCapability && typeof callRequest === 'function') {
    const res = await finishTurnRequests({ connectionId, call: callRequest, dir }).catch(() => ({ closed: [] }))
    closed = res.closed ?? []
  }

  return { closed, localCompleted }
}
