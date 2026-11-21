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
 *   owner can cause (`endConnection`). Not `/devspec-remote-stop` typed in this
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
 *
 * ## What it closes
 *
 * The Cursor process and the commands it started (item b7523464). Signalling Cursor
 * alone left a shell command it was running (a `sleep 240` in the live check) behind as
 * an orphan. So its descendants are listed BEFORE Cursor is signalled (once it exits
 * they are reparented and nothing ties them to it any more), Cursor gets SIGTERM, then
 * each of them does, and a detached reaper sends SIGKILL to any still running after
 * `COMMAND_STOP_GRACE_MS`. Only those processes: no name matching, and a pid is killed
 * late only while it is still the very process that was listed (its start time), so a
 * recycled pid is never touched. The process doing the closing, and the shells it runs
 * under, are spared: they end with it.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDirectRun } from './is-direct-run.mjs'

/** The server's word for an End a person made from DevSpec. */
export const PERSON_END_REASON = 'ui'

/**
 * Ceiling for one synchronous `ps` read of the local kernel process table on macOS /
 * non-Linux POSIX. A normal local `ps` invocation completes in ~5–20 ms; 2,000 ms
 * (~100x headroom) bounds a wedged `ps` subprocess so it cannot stall the listener's
 * shutdown path indefinitely inside `execFileSync`. Enforced in one place (`runPs`),
 * and any lookup that hits this bound is identified as a timeout (`ETIMEDOUT` /
 * `lookupTimedOut: true`) rather than treated as "no processes found".
 */
export const PS_LOOKUP_TIMEOUT_MS = 2_000

export function isLookupTimeout(error) {
  return Boolean(
    error &&
      (error.code === 'ETIMEDOUT' ||
        error.timedOut === true ||
        (error.killed === true && error.signal === 'SIGTERM') ||
        /ETIMEDOUT|timed out/i.test(String(error.message ?? ''))),
  )
}

function runPs(args, { timeoutMs = PS_LOOKUP_TIMEOUT_MS, execPs = execFileSync, lookup = 'ps' } = {}) {
  try {
    return execPs('ps', args, { encoding: 'utf8', timeout: timeoutMs })
  } catch (error) {
    if (isLookupTimeout(error)) {
      throw Object.assign(
        new Error(`ps ${lookup} lookup timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT', timedOut: true, timeoutMs, lookup, cause: error },
      )
    }
    throw error
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return Boolean(e && e.code === 'EPERM')
  }
}

export function commandOf(pid, { procRoot = '/proc', platform = process.platform, timeoutMs = PS_LOOKUP_TIMEOUT_MS, execPs = execFileSync } = {}) {
  try {
    if (platform === 'linux') {
      return fs.readFileSync(`${procRoot}/${pid}/comm`, 'utf8').trim()
    }
    if (platform === 'win32') return null
    return runPs(['-o', 'comm=', '-p', String(pid)], { timeoutMs, execPs, lookup: 'comm' }).trim()
  } catch {
    return null
  }
}

export function commandLineOf(pid, { procRoot = '/proc', platform = process.platform, timeoutMs = PS_LOOKUP_TIMEOUT_MS, execPs = execFileSync } = {}) {
  try {
    if (platform === 'linux') {
      return fs
        .readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ')
        .trim()
    }
    if (platform === 'win32') return ''
    return runPs(['-o', 'args=', '-p', String(pid)], { timeoutMs, execPs, lookup: 'args' }).trim()
  } catch {
    return ''
  }
}

export function parentOf(pid, { procRoot = '/proc', platform = process.platform, timeoutMs = PS_LOOKUP_TIMEOUT_MS, execPs = execFileSync } = {}) {
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number.parseInt(after[1], 10) || null
    }
    if (platform === 'win32') return null
    return (
      Number.parseInt(
        runPs(['-o', 'ppid=', '-p', String(pid)], { timeoutMs, execPs, lookup: 'ppid' }).trim(),
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
 * How long a command Cursor started gets to stop after SIGTERM before it is killed.
 *
 * SIGTERM asks a command to finish. A `sleep` or a shell exits at once; a program that
 * handles it (a dev server closing its port, a test runner stopping its workers, a
 * build flushing its cache) normally needs well under a couple of seconds. Five seconds
 * lets those finish cleanly, and anything still running after that is not going to
 * stop on request. It is no longer because the person pressed End expecting the work to
 * stop now; and it delays nothing, since a detached reaper waits it out, not the
 * process that closed Cursor.
 */
export const COMMAND_STOP_GRACE_MS = 5_000

/**
 * Every process's parent, `pid -> ppid`, read once. Empty where it cannot be read;
 * a `ps` lookup that hits `PS_LOOKUP_TIMEOUT_MS` throws an `ETIMEDOUT` error so a
 * timed-out lookup is never treated as "no processes running".
 */
export function processTable({ procRoot = '/proc', platform = process.platform, timeoutMs = PS_LOOKUP_TIMEOUT_MS, execPs = execFileSync } = {}) {
  const table = new Map()
  if (platform === 'win32') return table
  if (platform === 'linux') {
    let names = []
    try {
      names = fs.readdirSync(procRoot)
    } catch {
      return table
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue
      const ppid = parentOf(Number(name), { procRoot, platform })
      if (ppid !== null) table.set(Number(name), ppid)
    }
    return table
  }
  try {
    const out = runPs(['-A', '-o', 'pid=,ppid='], { timeoutMs, execPs, lookup: 'process_table' })
    for (const line of out.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map((n) => Number.parseInt(n, 10))
      if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid)
    }
  } catch (error) {
    if (isLookupTimeout(error)) throw error
    /* nothing listed: nothing is signalled */
  }
  return table
}

/** Every descendant of `rootPid` in `table`, nearest first. Never `rootPid` itself. */
export function descendantsOf(rootPid, table) {
  const children = new Map()
  for (const [pid, ppid] of table) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const found = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * What proves a pid is still the process it was when listed: its start time. Null when
 * it is gone or cannot be read; a zombie counts as gone (it has already exited). A `ps`
 * lookup that hits `PS_LOOKUP_TIMEOUT_MS` throws an `ETIMEDOUT` error rather than
 * returning null, so a timeout is never confused with a process that exited.
 */
export function processIdentity(pid, { procRoot = '/proc', platform = process.platform, timeoutMs = PS_LOOKUP_TIMEOUT_MS, execPs = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || platform === 'win32') return null
  if (platform === 'linux') {
    try {
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return after[0] === 'Z' || after[0] === 'X' ? null : after[19] || null
    } catch {
      return null
    }
  }
  try {
    const out = runPs(['-o', 'stat=,lstart=', '-p', String(pid)], { timeoutMs, execPs, lookup: 'process_identity' }).trim()
    return !out || out.startsWith('Z') ? null : out.replace(/^\S+\s+/, '')
  } catch (error) {
    if (isLookupTimeout(error)) throw Object.assign(error, { pid })
    return null
  }
}

/**
 * The commands a Cursor process started, each with the identity that proves it later:
 * its descendants, read now. Call it BEFORE signalling Cursor. Spared: `selfPid` (the
 * process doing the closing) and the shells between it and Cursor, which end with it.
 * Walking `selfPid`'s ancestors in the finite `table` snapshot needs no hop cap:
 * `!spared.has(pid)` prevents cycles, so the walk terminates in at most `table.size`
 * steps without ever cutting off a deep ancestor chain.
 */
export function commandsStartedBy(
  cursorPid,
  { selfPid = process.pid, table = processTable(), identityOf = processIdentity } = {},
) {
  if (!Number.isInteger(cursorPid) || cursorPid <= 1) return []
  const spared = new Set()
  for (
    let pid = selfPid;
    Number.isInteger(pid) && pid > 1 && pid !== cursorPid && !spared.has(pid);
    pid = table.get(pid)
  ) {
    spared.add(pid)
  }
  return descendantsOf(cursorPid, table)
    .filter((pid) => !spared.has(pid))
    .map((pid) => {
      try {
        return { pid, identity: identityOf(pid) }
      } catch (error) {
        return {
          pid,
          identity: null,
          ...(isLookupTimeout(error)
            ? { lookupTimedOut: true, lookupTimeoutMs: error.timeoutMs ?? PS_LOOKUP_TIMEOUT_MS }
            : {}),
          lookupError: String(error?.message || error),
        }
      }
    })
}

/**
 * Hand the commands to a detached reaper that SIGKILLs any still running after
 * `graceMs`. Detached (its own session, no terminal), so neither the closing process
 * exiting nor Cursor's terminal going away stops it. Returns the reaper's pid, or null
 * when there is nothing it could prove later.
 */
export function spawnCommandReaper(commands, { graceMs = COMMAND_STOP_GRACE_MS, spawnProcess = spawn } = {}) {
  const targets = commands.filter((command) => typeof command.identity === 'string' && command.identity)
  if (targets.length === 0) return null
  const child = spawnProcess(
    process.execPath,
    [fileURLToPath(import.meta.url), 'reap', JSON.stringify({ graceMs, targets })],
    { detached: true, stdio: 'ignore' },
  )
  child.on?.('error', () => {})
  child.unref?.()
  return child.pid ?? null
}

/**
 * The reaper: wait until every target has exited or `graceMs` has passed, then SIGKILL
 * the ones still running, each only while it is still the process that was listed.
 *
 * @returns {Promise<{ killed: number[] }>}
 */
export async function reapCommands(
  { graceMs = COMMAND_STOP_GRACE_MS, targets = [] } = {},
  {
    identityOf = processIdentity,
    kill = (pid, signal) => process.kill(pid, signal),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    pollMs = 100,
  } = {},
) {
  const deadline = now() + Math.max(0, Number(graceMs) || 0)
  const stillThere = (list) => list.filter((target) => identityOf(target.pid) === target.identity)
  let remaining = stillThere(targets)
  while (remaining.length > 0 && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())))
    remaining = stillThere(remaining)
  }
  const killed = []
  for (const target of remaining) {
    try {
      kill(target.pid, 'SIGKILL')
      killed.push(target.pid)
    } catch {
      /* gone meanwhile, or not ours to signal */
    }
  }
  return { killed }
}

/** A reaper plan from the command line, or null: only well-formed pids and identities. */
export function parseReapPlan(text) {
  let plan = null
  try {
    plan = JSON.parse(text)
  } catch {
    return null
  }
  const graceMs = typeof plan?.graceMs === 'number' ? plan.graceMs : Number.NaN
  if (!Number.isFinite(graceMs) || graceMs < 0 || !Array.isArray(plan?.targets)) return null
  const targets = plan.targets.filter((t) => Number.isInteger(t?.pid) && t.pid > 1 && typeof t.identity === 'string' && t.identity)
  return { graceMs, targets: targets.map((t) => ({ pid: t.pid, identity: t.identity })) }
}

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
 * Close this process's Cursor session if the decision says so, and stop the commands it
 * started. The pid is resolved by ancestry / verified owner at the moment of closing,
 * never trusted from a file alone, so a recycled pid can never be signalled.
 *
 * `commands` says what happened to them: `stopped` were sent SIGTERM, `failed` could not
 * be (with the reason), `reaper` is the pid of the process that SIGKILLs any still
 * running after `forceAfterMs` (null when none was needed or it could not start, with
 * `reaperError`). Nothing of theirs is touched when Cursor itself could not be signalled.
 *
 * @returns {{ closed: boolean, reason: string, pid: number | null, commands?: object }}
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
  listCommands = commandsStartedBy,
  reap = spawnCommandReaper,
  graceMs = COMMAND_STOP_GRACE_MS,
} = {}) {
  const cursorPid = platform === 'win32' ? null : resolvePid(ownerPid ?? env)
  const decision = closeOnEndDecision({ state, sawLive, cursorPid, platform, owns })
  if (!decision.close) return { closed: false, reason: decision.reason, pid: cursorPid }
  // Listed before Cursor is signalled: once it exits, they are reparented and nothing
  // ties them to it any more. A lookup that hits `PS_LOOKUP_TIMEOUT_MS` (or errors) is
  // surfaced on `commands` rather than treated as if there were no processes running.
  let commands = []
  let lookupTimedOut = false
  let lookupTimeoutMs = null
  let lookupError = null
  try {
    commands = listCommands(cursorPid)
  } catch (error) {
    commands = []
    lookupTimedOut = isLookupTimeout(error)
    if (lookupTimedOut) lookupTimeoutMs = error.timeoutMs ?? PS_LOOKUP_TIMEOUT_MS
    lookupError = String(error?.message || error)
  }
  for (const command of commands) {
    if (command?.lookupTimedOut) {
      lookupTimedOut = true
      lookupTimeoutMs = lookupTimeoutMs ?? command.lookupTimeoutMs ?? PS_LOOKUP_TIMEOUT_MS
    }
    if (command?.lookupError && !lookupError) {
      lookupError = command.lookupError
    }
  }
  try {
    kill(cursorPid, 'SIGTERM')
  } catch (e) {
    return {
      closed: false,
      reason: `signal_failed: ${e?.code || e?.message || e}`,
      pid: cursorPid,
    }
  }
  const stopped = []
  const failed = []
  for (const { pid } of commands) {
    try {
      kill(pid, 'SIGTERM')
      stopped.push(pid)
    } catch (e) {
      // ESRCH: it exited on its own between the listing and now, which is the goal.
      if (e?.code !== 'ESRCH') failed.push({ pid, reason: String(e?.code || e?.message || e) })
    }
  }
  let reaper = null
  let reaperError = null
  if (stopped.length > 0) {
    try {
      reaper = reap(commands.filter(({ pid }) => stopped.includes(pid)), { graceMs })
    } catch (e) {
      reaperError = String(e?.code || e?.message || e)
    }
  }
  return {
    closed: true,
    reason: decision.reason,
    pid: cursorPid,
    commands: {
      stopped,
      failed,
      reaper,
      forceAfterMs: graceMs,
      ...(reaperError ? { reaperError } : {}),
      ...(lookupTimedOut ? { lookupTimedOut: true, lookupTimeoutMs } : {}),
      ...(lookupError ? { lookupError } : {}),
    },
  }
}

export const closeClaudeCodeOnEnd = closeCursorOnEnd

// The reaper `spawnCommandReaper` starts: `node close-on-end.mjs reap '<plan json>'`.
if (process.argv[2] === 'reap' && isDirectRun(import.meta.url)) {
  const plan = parseReapPlan(process.argv[3])
  if (plan) reapCommands(plan).catch(() => {}).finally(() => process.exit(0))
}
