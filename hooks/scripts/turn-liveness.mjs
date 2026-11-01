#!/usr/bin/env node
/**
 * Is this conversation's DevSpec turn still live? (item 2b840556, parity with 9e8dda57)
 *
 * The turn marker (`<cid>.turn`, written at a command's pickup or a typed prompt,
 * cleared when the turn ends) is what the poller re-asserts Working from. It used to
 * expire one hour after the turn STARTED (fixed MAX_TURN_MS wall-clock cap). Since a
 * command stays open while its subagents, tool calls, and background jobs run, long
 * commands reached that hour mid-work: DevSpec closed the open bubble empty and the
 * agent's real answer arrived later as a separate message.
 *
 * Liveness now comes from what Cursor shows, not from a fixed clock started at pickup:
 *
 * - **Held** (`held: true` on the marker, written when a Stop keeps the command open
 *   for this command's own background work): live until the next Stop rewrites or
 *   clears the marker.
 * - **Running**: live while Cursor keeps showing signs of life for this turn. Every
 *   tool call (`postToolUse`, `trail-turn.mjs`) or transcript growth (`cli-trail-watch.mjs`)
 *   records a sign of life in `<cid>.turn-activity.json`.
 * - A running turn with no sign of life for `NO_SIGN_OF_LIFE_MS` (1 hour of inactivity)
 *   is over: its end was never reported.
 *
 * The activity record is a separate file, never a rewrite of the marker: a tool call
 * finishing beside the Stop that clears the marker must not bring it back. It names
 * the turn it belongs to (the marker's `startedAt`), so a previous turn's activity
 * never counts for the next one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { CONVERSATION_ID_ENV_VARS, LOCAL_ID_OVERRIDE_ENV_VAR } from './agent-identity.mjs'
import { ownConnectionId } from './own-connection.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

/**
 * How long a running turn may go with no sign of life before its end is taken as
 * unreported (1 hour of inactivity).
 */
export const NO_SIGN_OF_LIFE_MS = 60 * 60 * 1000

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function connectionsDir(home = os.homedir()) {
  return path.join(home, '.devspec', 'remote-control', 'connections')
}

export function bondPath(home = os.homedir(), conversationId) {
  return path.join(home, '.devspec', 'remote-control', 'local', 'cursor', `${conversationId}.json`)
}

export function turnMarkerFile(connectionId, dir = connectionsDir()) {
  return path.join(dir, `${connectionId}.turn`)
}

export function turnActivityPath(connectionId, dir = connectionsDir()) {
  return path.join(dir, `${connectionId}.turn-activity.json`)
}

/** The newest sign of life for `marker`'s turn: its start, or later activity of that same turn. */
export function lastSignOfLife(marker, activity) {
  const started = marker.startedAt
  const seen = activity?.turn === started && Number.isFinite(activity.at) ? activity.at : started
  return Math.max(started, seen)
}

/** Whether the turn `marker` describes is still live (see the file header). */
export function turnIsLive(marker, { activity = null, now = Date.now() } = {}) {
  if (!marker || typeof marker.startedAt !== 'number') return false
  if (marker.held === true) return true
  return now - lastSignOfLife(marker, activity) < NO_SIGN_OF_LIFE_MS
}

export function readTurnActivity(connectionId, dir = connectionsDir()) {
  try {
    const activity = readPrivateJson(turnActivityPath(connectionId, dir))
    return typeof activity?.turn === 'number' && typeof activity.at === 'number' ? activity : null
  } catch {
    return null
  }
}

/**
 * Record a sign of life for this connection's open turn. Reads the marker, never
 * writes it: with no turn open there is nothing to keep alive, and a turn that just
 * ended stays ended.
 */
export function recordTurnActivity(connectionId, { dir = connectionsDir(), now = Date.now() } = {}) {
  if (!SAFE_ID.test(connectionId ?? '')) return false
  let marker = null
  try {
    marker = readPrivateJson(turnMarkerFile(connectionId, dir))
  } catch {
    return false
  }
  if (typeof marker?.startedAt !== 'number') return false
  try {
    writePrivateJson(turnActivityPath(connectionId, dir), { turn: marker.startedAt, at: now })
    return true
  } catch {
    return false
  }
}

/** The connection bonded to the conversation a hook fired in, or null. */
export function hookConnectionId(input, { env = process.env, home = os.homedir() } = {}) {
  let conversationId = null
  for (const field of ['conversation_id', 'conversationId']) {
    const fromInput = typeof input?.[field] === 'string' ? input[field].trim() : ''
    if (SAFE_ID.test(fromInput)) {
      conversationId = fromInput
      break
    }
  }
  if (!conversationId) {
    for (const name of [LOCAL_ID_OVERRIDE_ENV_VAR, ...CONVERSATION_ID_ENV_VARS]) {
      const value = typeof env?.[name] === 'string' ? env[name].trim() : ''
      if (SAFE_ID.test(value)) {
        conversationId = value
        break
      }
    }
  }
  if (!conversationId) {
    const fromSession = typeof input?.session_id === 'string' ? input.session_id.trim() : ''
    conversationId = SAFE_ID.test(fromSession) ? fromSession : null
  }
  if (!conversationId) return null

  for (const candidatePath of [
    bondPath(home, conversationId),
    path.join(home, '.devspec', 'remote-control', 'local', 'claude-code', `${conversationId}.json`),
  ]) {
    try {
      const connectionId = readPrivateJson(candidatePath)?.connection_id
      if (SAFE_ID.test(connectionId ?? '')) return connectionId
    } catch {
      /* try next */
    }
  }

  try {
    const fromState = ownConnectionId(conversationId, { home })
    if (SAFE_ID.test(fromState ?? '')) return fromState
  } catch {
    /* ignore */
  }
  return null
}

/** PostToolUse: a tool call finished, so this conversation's turn is alive. Silent always. */
export function touch(raw, { env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  let input = null
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return false
  }
  const connectionId = hookConnectionId(input, { env, home })
  if (!connectionId) return false
  return recordTurnActivity(connectionId, { dir: connectionsDir(home), now })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === 'touch') {
    let raw = ''
    try {
      raw = fs.readFileSync(0, 'utf8')
    } catch {
      /* no stdin: nothing to resolve */
    }
    try {
      touch(raw)
    } catch {
      /* a hook never blocks the agent */
    }
  }
  process.exit(0)
}
