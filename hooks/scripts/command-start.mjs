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
import { readNoteText } from './hook-context-budget.mjs'
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

const NOTE_ID_IN_READ_RE = /notes\/([0-9a-f]{16})\.md\b/

/**
 * Extract canonical room commands (`{ turnId, messageId }`) and raw messages from wake
 * JSONL text, expanding any `wake_in_note` pointer that carries `owner_message` so an
 * oversized command stored in a sealed note still triggers honest `report_pickup`
 * (requirement 3ea2b201).
 */
export function extractRoomCommandsFromWake(wakeText, { home = os.homedir(), visitedNotes = null } = {}) {
  const rawMessages = []
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
      if (!sessionId && typeof event.session_id === 'string') sessionId = event.session_id
    } else if (
      event?.type === 'wake_in_note' &&
      Array.isArray(event.carries) &&
      event.carries.includes('owner_message')
    ) {
      const match = NOTE_ID_IN_READ_RE.exec(String(event.read ?? ''))
      const noteId = match?.[1] ?? null
      if (noteId && !seenNotes.has(noteId)) {
        seenNotes.add(noteId)
        try {
          const noteText = readNoteText(noteId, { home })
          if (noteText) {
            const nested = extractRoomCommandsFromWake(noteText, { home, visitedNotes: seenNotes })
            rawMessages.push(...nested.messages)
            if (!sessionId && nested.sessionId) sessionId = nested.sessionId
          }
        } catch {
          /* unreadable note: leave empty */
        }
      }
    }
  }
  return {
    commands: commandsHandedOver(rawMessages),
    messages: rawMessages,
    sessionId,
  }
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
  const resolvedState = state ?? readPrivateJson(path.join(dir, `${connectionId}.json`))
  const rawCommands = Array.isArray(commands)
    ? commands
    : Array.isArray(batch?.messages)
      ? commandsHandedOver(batch.messages)
      : []
  const already = new Set(readStartedCommandIds(connectionId, dir))
  const toStart = rawCommands.filter((cmd) => cmd?.turnId && cmd?.messageId && !already.has(cmd.messageId))
  if (toStart.length === 0) return { ok: true, outcome: 'duplicate', started: [], pickedUp: 0, duplicate: true }

  if (!resolvedState) {
    return { ok: true, skipped: true, reason: 'no_connection_state', started: [], pickedUp: 0 }
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
    if (completeTimeout > 0) {
      try {
        await call({
          mcpUrl,
          token,
          name: 'report_complete',
          arguments: completeArgs,
          timeoutMs: completeTimeout,
        })
      } catch (error) {
        log(
          `command-start: stale-turn report_complete failed for ${connectionId}: ${JSON.stringify(structuredRefusalFromError(error))}\n`,
        )
      }
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
    return {
      ok: false,
      outcome: 'nothing_open',
      started: [],
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
