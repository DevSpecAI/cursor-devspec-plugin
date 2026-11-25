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
 * Shared MCP call timeout for `report_pickup` and stale-turn `report_complete` when
 * starting room commands. Matches `devspec-remote-wait.mjs` (`notifyWorkingEnded`, 15 s)
 * and `hooks/hooks.json` (`step-delivery.mjs` 15 s hook budget).
 */
export const COMMAND_START_TIMEOUT_MS = 15_000
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

function readStartedCommandIds(connectionId, dir) {
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

/** Extract canonical room commands (`{ turnId, messageId }`) and raw messages from wake JSONL text. */
export function extractRoomCommandsFromWake(wakeText) {
  const rawMessages = []
  let sessionId = null
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
      if (!sessionId && typeof event.session_id === 'string') sessionId = event.session_id
    }
  }
  return {
    commands: commandsHandedOver(rawMessages),
    messages: rawMessages,
    sessionId,
  }
}

/** Extract structured refusal details from a thrown MCP / transport error without flattening. */
function structuredRefusalFromError(error) {
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
 *  - finishes any stale abandoned working attempt with one `report_complete` call,
 *  - sends `report_pickup` naming each command, preserving any structured refusal details,
 *  - writes `.turn` marker, records `turn-commands` + transcript baseline when starting a turn,
 *  - seeds Working trail + starts CLI trail watcher when attached,
 *  - records delivered requests in `.requests.jsonl` when `batch` is provided.
 */
export async function startRoomCommands({
  connectionId,
  commands = null,
  batch = null,
  sessionId = null,
  dir = defaultConnectionsDir(),
  home = os.homedir(),
  state = null,
  startsTurn = null,
  fromWakeTurn = false,
  call = mcpToolsCall,
  seedFn = seedWorkTrailForConnection,
  ensureWatch = ensureCliTrailWatch,
  timeoutMs = COMMAND_START_TIMEOUT_MS,
  log = (line) => process.stderr.write(line),
} = {}) {
  if (!connectionId) return { ok: false, started: [], pickedUp: 0, refusals: [{ code: 'missing_connection_id', error: 'missing connectionId' }] }
  const resolvedState = state ?? readPrivateJson(path.join(dir, `${connectionId}.json`))
  const rawCommands = Array.isArray(commands)
    ? commands
    : Array.isArray(batch?.messages)
      ? commandsHandedOver(batch.messages)
      : []
  const already = new Set(readStartedCommandIds(connectionId, dir))
  const toStart = rawCommands.filter((cmd) => cmd?.turnId && cmd?.messageId && !already.has(cmd.messageId))
  if (toStart.length === 0) return { ok: true, started: [], pickedUp: 0, duplicate: true }

  const credential = resolvedState ? connectionCredential(resolvedState) : { ok: false }
  const token = credential.ok ? credential.token : (resolvedState?.token || resolvedState?.mcp_token || null)
  const mcpUrl = credential.mcp_url || resolvedState?.mcp_url || null
  const attachedSessionId = sessionId ?? batch?.session_id ?? resolvedState?.session_id ?? null

  // If a previous turn marker is stale (abandoned: no activity past TURN_SILENCE_MS,
  // or no longer live), finish the abandoned working attempt in one single report_complete
  // call (attemptEndArguments — never looping once per saved command, requirement c900f599).
  const prevMarker = readTurnMarker(connectionId, dir)
  const prevActivity = readTurnActivity(connectionId, dir)
  const staleBySilence =
    prevMarker &&
    typeof prevMarker.startedAt === 'number' &&
    Date.now() - prevMarker.startedAt >= TURN_SILENCE_MS &&
    !prevActivity
  const prevLive = !staleBySilence && turnIsLive(prevMarker, { activity: prevActivity })
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
    try {
      await call({
        mcpUrl,
        token,
        name: 'report_complete',
        arguments: completeArgs,
        timeoutMs,
      })
    } catch (error) {
      log(
        `command-start: stale-turn report_complete failed for ${connectionId}: ${JSON.stringify(structuredRefusalFromError(error))}\n`,
      )
    }
    clearTurnMarker(connectionId, dir)
  }

  const effectiveStartsTurn = typeof startsTurn === 'boolean' ? startsTurn : !prevLive

  if (batch) {
    try {
      recordDeliveredBatchRequests(connectionId, batch, { dir })
    } catch {
      /* ignore */
    }
  }

  // Report pickup by name to DevSpec BEFORE recording IDs as started (requirement 3ea2b201)
  // and preserve full structured refusal payloads if DevSpec refuses or throws (requirement 4e32d1a5).
  const succeeded = []
  const refusals = []
  if (!token || !mcpUrl) {
    const refusal = { code: 'missing_credentials', error: 'No DevSpec credentials available for report_pickup.' }
    refusals.push(refusal)
    log(`command-start: report_pickup skipped for ${connectionId}: ${JSON.stringify(refusal)}\n`)
  } else {
    for (const command of toStart) {
      try {
        const res = await call({
          mcpUrl,
          token,
          name: 'report_pickup',
          arguments: pickupArguments(connectionId, command),
          timeoutMs,
        })
        const refused = pickupRefusalFromResponse(res)
        if (refused) {
          const entry = { command_message_id: command.messageId, command_turn_id: command.turnId, refusal: refused }
          refusals.push(entry)
          log(`command-start: report_pickup refused for ${connectionId} (${command.messageId}): ${JSON.stringify(refused)}\n`)
        } else {
          succeeded.push(command)
        }
      } catch (error) {
        const structured = structuredRefusalFromError(error)
        const entry = { command_message_id: command.messageId, command_turn_id: command.turnId, refusal: structured }
        refusals.push(entry)
        log(`command-start: report_pickup failed for ${connectionId} (${command.messageId}): ${JSON.stringify(structured)}\n`)
      }
    }
  }

  // Advance started-command state ONLY for commands whose report_pickup actually succeeded.
  if (succeeded.length > 0) {
    recordStartedCommandIds(connectionId, succeeded.map((cmd) => cmd.messageId), dir)
    const marker = writeTurnMarker(connectionId, dir)
    if (effectiveStartsTurn) {
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
    if (attachedSessionId && token && mcpUrl) {
      try {
        await seedFn({
          connectionId,
          mcpUrl,
          token,
          agentName: resolvedState?.agent_name || AGENT_NAME,
        })
      } catch {
        /* ignore */
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

  return {
    ok: refusals.length === 0,
    started: succeeded,
    pickedUp: succeeded.length,
    startsTurn: effectiveStartsTurn,
    ...(refusals.length > 0 ? { refusals } : {}),
  }
}
