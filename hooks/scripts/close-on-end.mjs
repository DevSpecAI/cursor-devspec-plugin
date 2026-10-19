/**
 * Ending an agent from DevSpec closes its local Cursor session (item 2b840556,
 * parity with Claude Code item 973124bd and Antigravity item b725aa2d).
 *
 * The owner ends an agent on the Agents page or in a session (`end_reason: 'ui'`).
 * Until now that ended the connection and left the Cursor CLI / agent process running
 * in its terminal, so someone with many terminals open had to hunt for the right tab
 * and close it by hand. End closes the program straight away and even mid-task.
 *
 * ## Exactly when, and never otherwise
 *
 * - Only a person's End: the server's `end_reason` `'ui'`, which only the connection's
 *   owner can cause (`endConnection`). Not `/devspec.remote-stop` typed in this
 *   terminal (`local_stop`: the person is right here), not a detach, not a recoverable
 *   server end (a redeploy blip, an idle sweep, `owner_gone`).
 * - Only an end this process watched happen: the caller must have served the connection
 *   live first (`sawLive === true`). A conversation resumed after its connection was
 *   ended must not close the moment it starts.
 * - Only the Cursor process that owns the connection, proved by ancestry / recorded
 *   owner_pid (`ownedByProcess`). A conversation resumed in another window moved
 *   ownership there, and the old window stays open.
 * - Not on Windows (`platform === 'win32'`), where `process.kill` is `TerminateProcess`
 *   (hard kill without graceful shutdown).
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

/** The server's word for an End a person made from DevSpec. */
export const PERSON_END_REASON = 'ui'

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && e.code === 'EPERM')
  }
}

export function commandOf(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      return fs.readFileSync(`${procRoot}/${pid}/comm`, 'utf8').trim()
    }
    if (platform === 'win32') return null
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim()
  } catch {
    return null
  }
}

export function commandLineOf(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      return fs
        .readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ')
        .trim()
    }
    if (platform === 'win32') return ''
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim()
  } catch {
    return ''
  }
}

export function parentOf(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number.parseInt(after[1], 10) || null
    }
    if (platform === 'win32') return null
    return (
      Number.parseInt(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: 2000,
        }).trim(),
        10,
      ) || null
    )
  } catch {
    return null
  }
}

export function processStartTime(pid, { procRoot = '/proc', platform = process.platform } = {}) {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return after[19] || null
  } catch {
    return null
  }
}

export function looksLikeCursor(name, cmdline = '') {
  if (
    typeof name === 'string' &&
    /(^|\/)(cursor|cursor-agent|agent|claude)(\.exe)?$/i.test(name.trim())
  ) {
    return true
  }
  if (typeof cmdline === 'string' && cmdline.trim()) {
    const trimmed = cmdline.trim()
    if (
      /(^|[\s/\\])(cursor|cursor-agent|claude)(\.exe)?(\s|$)/i.test(trimmed) ||
      (/(?:^|[\s/\\])cursor-agent(?:[\s/\\]|$)/i.test(trimmed) && !/\bworker-server\b/i.test(trimmed))
    ) {
      return true
    }
  }
  return false
}

/**
 * The Cursor agent process a pid belongs to: the pid itself when it is Cursor, else
 * its nearest Cursor ancestor. Null when the ancestry holds no Cursor process or the
 * pid is not alive.
 */
export function cursorProcessOf(
  pid,
  {
    maxHops = 12,
    isAlive = pidAlive,
    nameOf = commandOf,
    cmdlineOf = commandLineOf,
    parentOfPid = parentOf,
  } = {},
) {
  const start = Number(pid)
  if (!Number.isInteger(start) || start <= 1 || !isAlive(start)) return null
  let cursor = start
  for (let hop = 0; hop <= maxHops && cursor && cursor > 1; hop++) {
    const name = nameOf(cursor)
    const cmdline = cmdlineOf(cursor)
    if (name === null && !cmdline) return hop === 0 ? start : null
    if (looksLikeCursor(name, cmdline)) return cursor
    const parent = parentOfPid(cursor)
    if (!parent || parent === cursor) return null
    cursor = parent
  }
  return null
}

/**
 * Resolve the live Cursor agent PID from an explicit owner pid / env or by walking
 * `startPid`'s ancestry.
 */
export function resolveCursorPid(
  envOrOwnerPid = process.env,
  { startPid = process.pid, maxHops = 12, cursorOf = cursorProcessOf } = {},
) {
  if (typeof envOrOwnerPid === 'number' || typeof envOrOwnerPid === 'string') {
    const claimed = Number.parseInt(String(envOrOwnerPid), 10)
    if (Number.isInteger(claimed) && claimed > 1) {
      const resolved = cursorOf(claimed, { maxHops })
      if (resolved !== null) return resolved
    }
    return cursorOf(startPid, { maxHops })
  }
  const env = envOrOwnerPid && typeof envOrOwnerPid === 'object' ? envOrOwnerPid : {}
  const claimed = Number.parseInt(
    String(env.CURSOR_PID ?? env.DEVSPEC_OWNER_PID ?? env.CLAUDE_PID ?? ''),
    10,
  )
  if (Number.isInteger(claimed) && claimed > 1) {
    const resolved = cursorOf(claimed, { maxHops })
    if (resolved !== null) return resolved
  }
  return cursorOf(startPid, { maxHops })
}

/**
 * Does this Cursor process own this connection?
 */
export function ownedByProcess(
  state,
  myPid,
  {
    isAlive = pidAlive,
    cursorOf = cursorProcessOf,
    startTimeOf = processStartTime,
  } = {},
) {
  const owner = Number(state?.owner_pid)
  if (!Number.isInteger(owner) || owner <= 1 || !isAlive(owner)) return false
  const ownerCursor = cursorOf(owner)
  const mine = cursorOf(Number(myPid))
  if (ownerCursor === null || mine === null || ownerCursor !== mine) return false
  const recordedStart = state?.owner_started ?? null
  if (recordedStart !== null && recordedStart !== undefined) {
    const currentStart = startTimeOf(ownerCursor)
    if (currentStart !== null && String(recordedStart) !== String(currentStart)) {
      return false
    }
  }
  return true
}

export const ownedByCursorProcess = ownedByProcess

/**
 * Should this process close its Cursor session now? Pure: every input is passed in.
 *
 * @returns {{ close: boolean, reason: string, pid: number | null }}
 */
export function closeOnEndDecision(opts = {}) {
  const {
    state,
    sawLive,
    cursorPid,
    claudePid,
    ownerPid,
    platform = process.platform,
    owns = ownedByProcess,
  } = opts
  const targetPid = cursorPid ?? claudePid ?? ownerPid
  const missingProcessReason =
    Object.hasOwn(opts, 'claudePid') && !Object.hasOwn(opts, 'cursorPid')
      ? 'no_claude_process'
      : 'no_cursor_process'
  if (!state || state.end_reason !== PERSON_END_REASON) {
    return { close: false, reason: 'not_a_person_end', pid: null }
  }
  if (!sawLive) {
    return { close: false, reason: 'ended_before_this_process_served_it', pid: null }
  }
  if (platform === 'win32') {
    return { close: false, reason: 'unsupported_platform', pid: null }
  }
  if (!Number.isInteger(targetPid) || targetPid <= 1) {
    return { close: false, reason: missingProcessReason, pid: null }
  }
  if (!owns(state, targetPid)) {
    return { close: false, reason: 'not_the_owner', pid: null }
  }
  return { close: true, reason: 'person_ended_it', pid: targetPid }
}

/**
 * Close this process's Cursor session if the decision says so. The pid is resolved by
 * ancestry / verified owner at the moment of closing, never trusted from a file alone,
 * so a recycled pid can never be signalled.
 *
 * @returns {{ closed: boolean, reason: string, pid: number | null }}
 */
export function closeCursorOnEnd({
  state,
  sawLive,
  ownerPid = undefined,
  env = process.env,
  platform = process.platform,
  resolvePid = resolveCursorPid,
  owns = ownedByProcess,
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const cursorPid = platform === 'win32' ? null : resolvePid(ownerPid ?? env)
  const decision = closeOnEndDecision({ state, sawLive, cursorPid, platform, owns })
  if (!decision.close) return { closed: false, reason: decision.reason, pid: cursorPid }
  try {
    kill(cursorPid, 'SIGTERM')
    return { closed: true, reason: decision.reason, pid: cursorPid }
  } catch (e) {
    return {
      closed: false,
      reason: `signal_failed: ${e?.code || e?.message || e}`,
      pid: cursorPid,
    }
  }
}

export const closeClaudeCodeOnEnd = closeCursorOnEnd
