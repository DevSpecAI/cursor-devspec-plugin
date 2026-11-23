/**
 * The room commands this plugin starts, named to DevSpec at both ends of a turn.
 *
 * DevSpec starts a delivered room command only when the host names it, and a
 * turn-finished report that names nothing ends only the attempt being worked on, never
 * a command still waiting (what each form does is in the descriptions of
 * `report_pickup` and `report_complete`). So:
 *
 * - **Every command the plugin hands the agent is started by name**, as it is handed
 *   over, whether or not a turn is already running: `report_pickup` with the
 *   command's `command_turn_id` and `command_message_id` (`pickupArguments`).
 * - **Nothing else is reported as a pickup.** A check job, an automation run or a
 *   DevSpec notice starts no command, and a pickup that names no command can start
 *   one that is waiting. While the agent works a check job or a run, the poller
 *   reports busy (`semantics.check_job.busy` in
 *   `devspec://product/remote-ingress-contract`); what busy does is the
 *   `heartbeat_connection` description's to say.
 * - **The end of a turn names what it finishes** (`completionArguments`): the
 *   commands that started the turn, the terminal turn the owner typed, or, when it
 *   had neither, `command_turn_unbound`.
 * - **One end names nothing, on purpose** (`attemptEndArguments`): a turn that ended
 *   in an error the poller cannot tie to a command beyond doubt
 *   (transcript-turn-end.mjs). It must not say which command finished, yet the working
 *   attempt must not be left to lapse. `report_complete` with only `connection_id`
 *   ends the newest attempt being worked on, closes only that attempt's own command,
 *   never a delivered command that has not been picked up, and changes nothing when
 *   nothing is being worked on (its description at DevSpecV2 59acf1bfe; PR #1391,
 *   migration 1680, item f908710b).
 *
 * Which commands a turn's end names: the ones that started it. The poller records
 * them here when its delivery starts a turn, in `<connection>.turn-commands.json`,
 * and each process that reports a turn's end (the Stop hook, the wait's reply
 * re-arm, the poller's backstop) reads it and removes it with the turn marker. A
 * command handed over while a turn is already running is started by name but not
 * recorded: Cursor can hand it to the model after that turn has ended, and a turn's
 * end that named it would finish it before the model had seen it. Its own answer
 * finishes it.
 *
 * Imports only Node built-ins and `private-state.mjs`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One command as both reports name it, or null unless both ids are UUIDs. */
function commandIdentity(turnId, messageId) {
  return UUID.test(turnId ?? '') && UUID.test(messageId ?? '') ? { turnId, messageId } : null
}

/** Each command once, by message, in the order given. */
function unique(commands) {
  const seen = new Set()
  const out = []
  for (const command of Array.isArray(commands) ? commands : []) {
    const identity = commandIdentity(command?.turnId, command?.messageId)
    if (!identity || seen.has(identity.messageId)) continue
    seen.add(identity.messageId)
    out.push(identity)
  }
  return out
}

export function turnCommandsPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.turn-commands.json`)
}

/**
 * The commands a canonical delivery hands over, in the order delivered: each
 * command's `delivery.turn_id` and `message_id`. A command missing either is left
 * out, because it cannot be named.
 */
export function commandsHandedOver(commands) {
  return unique(
    (Array.isArray(commands) ? commands : []).map((command) => ({
      turnId: command?.delivery?.turn_id,
      messageId: command?.message_id,
    })),
  )
}

/**
 * Record the commands that started the turn now beginning, replacing any earlier
 * turn's: that turn's end has already been reported. Returns false when nothing was
 * written.
 */
export function recordTurnCommands(connectionId, commands, { dir }) {
  const named = unique(commands)
  if (!connectionId || named.length === 0) return false
  try {
    writePrivateJson(turnCommandsPath(connectionId, dir), {
      version: 1,
      commands: named.map((command) => ({ turn_id: command.turnId, message_id: command.messageId })),
    })
    return true
  } catch {
    return false
  }
}

/** The commands that started the current turn, oldest first; none when unreadable. */
export function readTurnCommands(connectionId, { dir }) {
  if (!connectionId) return []
  let stored = null
  try {
    stored = readPrivateJson(turnCommandsPath(connectionId, dir))
  } catch {
    return []
  }
  const commands = Array.isArray(stored?.commands) ? stored.commands : []
  return unique(commands.map((entry) => ({ turnId: entry?.turn_id, messageId: entry?.message_id })))
}

export function clearTurnCommands(connectionId, { dir }) {
  if (!connectionId) return
  try {
    fs.rmSync(turnCommandsPath(connectionId, dir), { force: true })
  } catch {
    /* a stale record only names commands that are already finished */
  }
}

/** `report_pickup`'s arguments for starting exactly this command. */
export function pickupArguments(connectionId, command) {
  return {
    connection_id: connectionId,
    command_turn_id: command.turnId,
    command_message_id: command.messageId,
  }
}

/**
 * `report_complete`'s arguments for each thing a turn finishes, one identity per
 * call: every command that started it, by its turn and message, and the terminal
 * turn the owner typed. A turn that had neither says it is unbound. Never empty, so a
 * caller cannot fall back to a report that names nothing.
 */
/**
 * `report_complete`'s arguments for ending the working attempt without saying which
 * command finished (see the header): the connection and the reason, and no identity.
 */
export function attemptEndArguments({ connectionId, reason }) {
  return { connection_id: connectionId, ...(reason ? { reason } : {}) }
}

export function completionArguments({ connectionId, commands = [], localAttemptId = null, reason }) {
  const withReason = (identity) => ({ connection_id: connectionId, ...identity, ...(reason ? { reason } : {}) })
  const calls = unique(commands).map((command) =>
    withReason({ command_turn_id: command.turnId, command_message_id: command.messageId }),
  )
  if (UUID.test(localAttemptId ?? '')) calls.push(withReason({ attempt_id: localAttemptId }))
  if (calls.length === 0) calls.push(withReason({ command_turn_unbound: true }))
  return calls
}
