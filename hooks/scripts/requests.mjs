/**
 * The requests this connection is carrying, and which one each turn and write
 * serves (item 56ba1b79, DevSpec design "the request chain").
 *
 * A request is something a person asked this agent for: a room command, or a
 * prompt its owner typed at this terminal. Work the agent does when something it
 * started wakes it — a background command, a subagent, a workflow, a monitor, a
 * scheduled wake or a loop — continues the request that started it. Two people's
 * work on one agent is never credited to each other, and a wake is the agent's
 * own initiative only when it positively continues nobody's request.
 *
 * DevSpec cannot tell these apart from the connection's state, which holds one
 * current request, so every DevSpec write names the request it serves
 * (request_ref, stamped by project-input.mjs) and the server keeps which
 * requests are open (report_request, opened and closed here with the
 * connection's capability). Whatever this cannot tell is left unstated, and
 * DevSpec records that it could not tell who asked (item 3279dab5), never a
 * guess.
 *
 * A turn starts from what woke it (current). Anything delivered INTO a running
 * turn — a second person's command, a prompt typed over it, another job's
 * notification — joins it (joined). While a turn carries requests that would
 * be recorded differently, the agent says which one its next writes serve
 * (serve).
 *
 * One append-only log per connection, `<connection>.requests.jsonl`, written by
 * the poller (commands) and the hooks (prompts, launches, wakes, Stop). Appended,
 * never rewritten: parallel tool calls finish together, and a read-modify-write
 * would drop one of them. It starts afresh once it has grown and nothing in it is
 * open.
 *
 * Imports only Node built-ins.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9_-]{1,128}$/

/** A status the host reports once a background job has ended. */
const ENDED_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error'])

/** The host clips a cron's prompt to this many characters in Stop's session_crons. */
const CRON_PROMPT_CLIP = 1000

/** The log starts afresh past this size, when nothing in it is open. */
const ROTATE_BYTES = 64 * 1024

/** The ref a turn that continues nobody's request carries. */
export const NO_REQUEST = 'none'

/**
 * A turn, or part of one, whose request is not known here (a command or a prompt
 * DevSpec did not open a request for, a wake nothing here recorded): its writes
 * name nothing, so DevSpec resolves who asked itself, never as an earlier request's.
 */
export const UNSTATED = 'unstated'

const DEFAULT_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

export function requestLogPath(connectionId, dir = DEFAULT_DIR) {
  return path.join(dir, `${connectionId}.requests.jsonl`)
}

/** Append one event. Returns false when it could not be written. */
export function appendRequestEvent(connectionId, event, { dir = DEFAULT_DIR, now = Date.now() } = {}) {
  if (!connectionId || !event?.op) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      requestLogPath(connectionId, dir),
      `${JSON.stringify({ ...event, at: new Date(now).toISOString() })}\n`,
      { mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

/** A ref a turn can carry: a request, nobody's, or not known. */
function carriedRef(ref) {
  return ref === NO_REQUEST || ref === UNSTATED || UUID.test(ref ?? '')
}

function uuids(value) {
  return Array.isArray(value) ? value.filter((id) => UUID.test(id ?? '')) : []
}

/**
 * The connection's requests as the log describes them. Pure over the log's text,
 * so tests run it directly.
 *
 * @returns {{
 *   open: Map<string, { kind: string, message_id?: string, provenance_ref?: string, requested_by?: string, answered?: boolean }>,
 *   started: Set<string>,
 *   launches: Map<string, { key: string, request: string, also: string[], kind: string, notifies: boolean, notified: boolean, absent: number }>,
 *   schedules: Array<{ prompt: string, request: string, also: string[], id: string|null }>,
 *   current: string|null,
 *   currentFromWake: boolean,
 *   currentBoundByWake: boolean,
 *   currentWakeNotifiedKeys: Set<string>,
 *   joined: Set<string>,
 *   chosen: boolean,
 *   seenTranscriptTurns: Map<string, string|null>,
 *   failedTranscriptTurns: Set<string>,
 * }}
 */
export function reduceRequestLog(text) {
  const open = new Map()
  const closed = new Set()
  const idleClosedInfo = new Map()
  const started = new Set()
  const launches = new Map()
  const aliases = new Map()
  const schedules = []
  const seenTranscriptTurns = new Map()
  const failedTranscriptTurns = new Set()
  let current = null
  let currentFromWake = false
  let currentBoundByWake = false
  let unconsumedWakeCount = 0
  let currentWakeNotifiedKeys = new Set()
  let currentWakePriorEndedKeys = new Set()
  let currentWakeLiveUnoutputKeys = new Set()
  let joined = new Set()
  let priorTurnJoined = new Set()
  let chosen = false
  const launchOf = (key) => launches.get(key) ?? launches.get(aliases.get(key))
  const hasActiveWorkFor = (requestId) => {
    if (!UUID.test(requestId ?? '')) return false
    for (const launch of launches.values()) {
      const namesIt = launch.request === requestId || (Array.isArray(launch.also) && launch.also.includes(requestId))
      if (namesIt && (launch.kind === 'monitor' || (launch.notifies !== false && !launch.notified))) {
        return true
      }
    }
    for (const sched of schedules) {
      if (sched.request === requestId || (Array.isArray(sched.also) && sched.also.includes(requestId))) {
        return true
      }
    }
    return false
  }
  const restoreIdleClosedRefs = (primary, also) => {
    for (const ref of [primary, ...(Array.isArray(also) ? also : [])]) {
      if (UUID.test(ref ?? '') && !open.has(ref) && idleClosedInfo.has(ref)) {
        open.set(ref, idleClosedInfo.get(ref))
        closed.delete(ref)
        idleClosedInfo.delete(ref)
      }
    }
  }
  for (const line of String(text || '').split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // a torn line is not an event
    }
    switch (event?.op) {
      case 'open':
        if (UUID.test(event.id ?? '')) {
          closed.delete(event.id)
          idleClosedInfo.delete(event.id)
          open.set(event.id, {
            kind: event.kind,
            ...(event.message_id ? { message_id: event.message_id } : {}),
            ...(event.provenance_ref ? { provenance_ref: event.provenance_ref } : {}),
            ...(event.requested_by ? { requested_by: event.requested_by } : {}),
          })
        }
        break
      case 'close':
        // Conditional idle close (`if_idle: true`): never close a request that gained a
        // pending background launch, monitor, or schedule, joined a live turn, or whose
        // foreground turn changed between the idle sweep's read and its append
        // (requirements 3ea2b201 / ce71a72b).
        if (event.if_idle === true) {
          const currentChanged =
            Object.prototype.hasOwnProperty.call(event, 'expected_current') && current !== event.expected_current
          const newlyJoined = joined.has(event.id) && event.allow_joined !== true
          if (hasActiveWorkFor(event.id) || currentChanged || newlyJoined) {
            break
          }
        }
        if (event.if_idle === true && UUID.test(event.id ?? '') && open.has(event.id)) {
          idleClosedInfo.set(event.id, open.get(event.id))
        } else if (UUID.test(event.id ?? '')) {
          idleClosedInfo.delete(event.id)
        }
        if (UUID.test(event.id ?? '')) closed.add(event.id)
        open.delete(event.id)
        started.delete(event.id)
        joined.delete(event.id)
        priorTurnJoined.delete(event.id)
        if (current === event.id) {
          current = null
          currentFromWake = false
          currentBoundByWake = false
          unconsumedWakeCount = 0
          currentWakeNotifiedKeys = new Set()
          currentWakePriorEndedKeys = new Set()
          currentWakeLiveUnoutputKeys = new Set()
        }
        break
      case 'current':
        // Compare-and-swap guard: when `expected_current` is specified and another
        // request (e.g. a different sender's live room command) became `current`
        // between the caller's last read and this append, do NOT replace it! Still
        // record a newly opened UUID ref in `started` so idle cleanup can close it
        // cleanly (decision ce71a72b).
        if (
          Object.prototype.hasOwnProperty.call(event, 'expected_current') &&
          current !== event.expected_current &&
          current !== event.ref &&
          current !== null
        ) {
          if (UUID.test(event.ref ?? '')) started.add(event.ref)
          break
        }
        // A new turn: what it carries starts again from what woke it. When
        // `preserve_live_joined` is set (establishing the foreground request for a
        // live terminal turn), drop ONLY stale joined ids explicitly listed in
        // `drop_joined_ids` (plus `priorTurnJoined` and `current`) so a room command
        // joining the same live turn even immediately before this event is written
        // NEVER disappears from `joined` (decision ce71a72b).
        current = event.ref === NO_REQUEST || UUID.test(event.ref ?? '') ? event.ref : null
        currentFromWake = Boolean(event.from_wake && current !== null)
        currentBoundByWake = Boolean(event.bound_by_wake && current !== null)
        // When the prompt hook recorded which non-typed wakes had ALREADY ended in the
        // transcript before this wake started (`prior_ended_wake_keys`), those earlier
        // ended wakes never consume this wake's attribution, and exactly 1 subsequent
        // ended wake (not in `prior_ended_wake_keys`) consumes it. Otherwise fall back
        // to counting non-sync wake arrivals (`from_wake: true` or unstated `{ ref: null }`
        // without `from_sync: true`) so consecutive wakes between sync passes preserve
        // the latest wake's known requester (decision ce71a72b).
        const hasPriorEndedKeys = Boolean(currentFromWake && Array.isArray(event.prior_ended_wake_keys))
        currentWakePriorEndedKeys = new Set(
          hasPriorEndedKeys ? event.prior_ended_wake_keys.filter((k) => typeof k === 'string' && k) : [],
        )
        currentWakeLiveUnoutputKeys = new Set(
          currentFromWake && Array.isArray(event.hook_live_unoutput_wake_keys)
            ? event.hook_live_unoutput_wake_keys.filter((k) => typeof k === 'string' && k)
            : [],
        )
        unconsumedWakeCount = hasPriorEndedKeys
          ? 1
          : currentFromWake || (current === null && event.from_sync !== true)
            ? unconsumedWakeCount + 1
            : 0
        currentWakeNotifiedKeys = new Set(
          currentFromWake && Array.isArray(event.wake_notified_keys)
            ? event.wake_notified_keys.filter((k) => typeof k === 'string' && k)
            : [],
        )
        if (event.preserve_live_joined === true) {
          const drop = new Set(Array.isArray(event.drop_joined_ids) ? event.drop_joined_ids : [])
          if (UUID.test(current ?? '')) drop.add(current)
          joined = new Set([...joined].filter((id) => !drop.has(id) && !priorTurnJoined.has(id)))
        } else if (Array.isArray(event.preserve_joined_ids)) {
          const keep = new Set(event.preserve_joined_ids.filter((id) => UUID.test(id ?? '') && id !== current))
          joined = new Set([...joined].filter((id) => keep.has(id)))
        } else {
          joined = new Set()
        }
        priorTurnJoined = new Set()
        chosen = false
        if (UUID.test(current ?? '')) started.add(current)
        break
      case 'joined':
        // Delivered into the running turn: the turn now carries it too.
        if (carriedRef(event.id) && event.id !== current) {
          restoreIdleClosedRefs(event.id, [])
          joined.add(event.id)
          priorTurnJoined.delete(event.id)
          chosen = false
          if (UUID.test(event.id)) started.add(event.id)
        }
        break
      case 'serve':
        // The agent named the request its writes now serve, until something else
        // reaches it. What the turn served until now stays carried, so the agent
        // can still switch back to it: naming one never locks the turn (item
        // 984ca8b4).
        if (carriedRef(event.ref)) {
          const next = event.ref === UNSTATED ? null : event.ref
          const previous = current ?? UNSTATED
          if (previous !== (next ?? UNSTATED)) joined.add(previous)
          joined.delete(next ?? UNSTATED)
          current = next
          currentFromWake = false
          currentBoundByWake = false
          unconsumedWakeCount = 0
          currentWakeNotifiedKeys = new Set()
          currentWakePriorEndedKeys = new Set()
          currentWakeLiveUnoutputKeys = new Set()
          chosen = true
          if (UUID.test(current ?? '')) started.add(current)
        }
        break
      case 'answered': {
        // The agent posted its final answer to this room command
        // (post_session_message with complete_turn). DevSpec closes the command's
        // delivery immediately, so it must no longer serve as the foreground turn's
        // current request (item da03801e). It stays in `open` until closed so any
        // background subagent it launched keeps naming its request_ref while its
        // work runs on (item 984ca8b4).
        const info = open.get(event.id)
        if (info) info.answered = true
        if (current === event.id) {
          current = null
          currentFromWake = false
          currentBoundByWake = false
          unconsumedWakeCount = 0
          currentWakeNotifiedKeys = new Set()
          currentWakePriorEndedKeys = new Set()
          currentWakeLiveUnoutputKeys = new Set()
          // Any other requests already in `joined` belonged to this answered turn,
          // so a subsequent turn after `turn_ended` knows not to inherit them while
          // still preserving any fresh join that arrives after `current` became null.
          for (const jid of joined) {
            if (jid !== event.id) priorTurnJoined.add(jid)
          }
        }
        joined.delete(event.id)
        priorTurnJoined.delete(event.id)
        break
      }
      case 'transcript_turn':
        if (typeof event.key === 'string' && event.key) {
          const boundRef = event.ref === NO_REQUEST || UUID.test(event.ref ?? '') ? event.ref : null
          seenTranscriptTurns.set(event.key, boundRef)
          failedTranscriptTurns.delete(event.key)
          if (event.mark_started === true && UUID.test(boundRef ?? '')) {
            started.add(boundRef)
          }
          // Once a transcript turn binds the wake-restored current request, mark
          // it bound by that wake so a subsequent unrelated wake clears it
          // (even for an unanswered room command) instead of inheriting it.
          if (!event.historical && current !== null && boundRef === current) {
            if (currentFromWake) currentBoundByWake = true
            currentFromWake = false
            unconsumedWakeCount = 0
            currentWakeNotifiedKeys = new Set()
            currentWakePriorEndedKeys = new Set()
            currentWakeLiveUnoutputKeys = new Set()
          } else if (event.consumes_ended_wake === true && unconsumedWakeCount > 0) {
            unconsumedWakeCount -= 1
          }
        }
        break
      case 'typed_turn_failed':
        if (typeof event.key === 'string' && event.key && !seenTranscriptTurns.has(event.key)) {
          failedTranscriptTurns.add(event.key)
        }
        break
      case 'launch':
        if (KEY.test(event.key ?? '') && carriedRef(event.request)) {
          const also = uuids(event.also)
          restoreIdleClosedRefs(event.request, also)
          launches.set(event.key, {
            key: event.key,
            request: event.request,
            also,
            kind: String(event.kind || 'unknown'),
            notifies: event.notifies !== false,
            notified: false,
            absent: 0,
          })
          if (KEY.test(event.alias ?? '')) aliases.set(event.alias, event.key)
        }
        break
      case 'notified': {
        const launch = launchOf(event.key)
        if (launch) launch.notified = true
        if (currentFromWake && !event.historical && KEY.test(event.key ?? '')) {
          currentWakeNotifiedKeys.add(event.key)
        }
        break
      }
      case 'absent': {
        const launch = launchOf(event.key)
        if (launch) launch.absent += 1
        break
      }
      case 'schedule':
        if (typeof event.prompt === 'string' && event.prompt.trim() && carriedRef(event.request)) {
          const also = uuids(event.also)
          restoreIdleClosedRefs(event.request, also)
          const trimmedPrompt = event.prompt.trim()
          const schedId = KEY.test(event.id ?? '') ? event.id : null
          const alreadyListed = schedules.some(
            (s) =>
              s.prompt === trimmedPrompt &&
              s.request === event.request &&
              s.id === schedId &&
              s.also.length === also.length &&
              s.also.every((x, i) => x === also[i]),
          )
          if (!alreadyListed) {
            schedules.push({
              prompt: trimmedPrompt,
              request: event.request,
              also,
              id: schedId,
            })
          }
        }
        break
      default:
        break
    }
  }
  // An alias (the launching tool call's id) finds the same launch as its job id.
  for (const [alias, key] of aliases) {
    if (!launches.has(alias) && launches.has(key)) launches.set(alias, launches.get(key))
  }
  return { open, closed, started, launches, schedules, current, currentFromWake, currentBoundByWake, unconsumedWakeCount, currentWakeNotifiedKeys, currentWakePriorEndedKeys, currentWakeLiveUnoutputKeys, joined, priorTurnJoined, chosen, seenTranscriptTurns, failedTranscriptTurns }
}

/**
 * Extract all `{ op: 'rotated', archive_name?, archive_bytes, archive_ino, archive_dev }`
 * watermarks written into the active request log by `rotateRequestLog`. Returns a map
 * keyed by archive file basename (legacy watermarks without `archive_name` default to
 * `${connectionId}.requests.jsonl.1`) plus an inode map keyed by `${dev}:${ino}`, keeping
 * the latest watermark recorded for each archive.
 */
function archiveWatermarks(text, connectionId) {
  const defaultName = `${connectionId}.requests.jsonl.1`
  const byName = new Map()
  const byIno = new Map()
  const rawLines = []
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"rotated"')) continue
    try {
      const event = JSON.parse(line)
      if (
        event?.op === 'rotated' &&
        typeof event.archive_bytes === 'number' &&
        Number.isFinite(event.archive_bytes) &&
        event.archive_bytes >= 0
      ) {
        const archiveName =
          typeof event.archive_name === 'string' && event.archive_name ? event.archive_name : defaultName
        const wm = {
          archive_name: archiveName,
          archive_bytes: event.archive_bytes,
          archive_ino: typeof event.archive_ino === 'number' ? event.archive_ino : null,
          archive_dev: typeof event.archive_dev === 'number' ? event.archive_dev : null,
        }
        byName.set(archiveName, wm)
        if (wm.archive_ino !== null) {
          byIno.set(`${wm.archive_dev ?? ''}:${wm.archive_ino}`, wm)
        }
        rawLines.push(wm)
      }
    } catch {
      /* ignore torn line */
    }
  }
  return { byName, byIno, latest: [...byName.values()] }
}

/**
 * Find any leftover `.requests.jsonl.rotating-*` staged files in `dir` for
 * `connectionId`, sorted oldest-first. Returns `{ files, error }` so callers
 * fail closed if `dir` itself cannot be listed.
 */
function stagedRequestLogFiles(connectionId, dir) {
  const prefix = `${connectionId}.requests.jsonl.rotating-`
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { files: [], error: null }
    return { files: [], error }
  }
  const matched = []
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const fullPath = path.join(dir, name)
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(fullPath).mtimeMs
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return { files: [], error }
    }
    matched.push({ fullPath, name, mtimeMs })
  }
  matched.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  return { files: matched.map((m) => m.fullPath), error: null }
}

/**
 * Find every retained archive file for `connectionId` in `dir`: both the primary
 * `.requests.jsonl.1` archive and any `.requests.jsonl.archive-*` archives created by
 * subsequent rotations (which NEVER overwrite or unlink earlier archives so an already-open
 * writer fd on any prior archive remains visible — requirement 3ea2b201 / decision ce71a72b).
 */
function archiveRequestLogFiles(connectionId, dir) {
  const legacyName = `${connectionId}.requests.jsonl.1`
  const archivePrefix = `${connectionId}.requests.jsonl.archive-`
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { files: [], error: null }
    return { files: [], error }
  }
  const matched = []
  for (const name of entries) {
    if (name !== legacyName && !name.startsWith(archivePrefix)) continue
    const fullPath = path.join(dir, name)
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(fullPath).mtimeMs
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return { files: [], error }
    }
    matched.push({ fullPath, name, mtimeMs })
  }
  matched.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  return { files: matched.map((m) => m.fullPath), error: null }
}

/**
 * Combined change stamp covering the active request log AND every retained archive
 * (`.requests.jsonl.1` and `.requests.jsonl.archive-*`) and staged rotation file
 * (`.requests.jsonl.rotating-*`) that `readRequestState` reads. Returns `null` on any
 * non-ENOENT stat/readdir error so callers never skip reconciliation on a transient
 * filesystem error (req 3ea2b201).
 */
export function requestLogChangeStamp(connectionId, { dir = DEFAULT_DIR } = {}) {
  if (!connectionId) return ''
  const file = requestLogPath(connectionId, dir)
  const parts = []
  const statTag = (label, target) => {
    try {
      const st = fs.statSync(target)
      parts.push(`${label}=${st.ino}:${st.size}:${st.mtimeMs}`)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      return false
    }
  }
  if (!statTag('active', file)) return null
  const archives = archiveRequestLogFiles(connectionId, dir)
  if (archives.error) return null
  for (const archiveFile of archives.files) {
    if (!statTag(`archive:${path.basename(archiveFile)}`, archiveFile)) return null
  }
  const staged = stagedRequestLogFiles(connectionId, dir)
  if (staged.error) return null
  for (const stagedFile of staged.files) {
    if (!statTag(`staged:${path.basename(stagedFile)}`, stagedFile)) return null
  }
  return parts.join('|')
}

export function readRequestState(connectionId, { dir = DEFAULT_DIR } = {}) {
  const file = requestLogPath(connectionId, dir)
  let text = ''
  let readError = null
  const stagedTexts = []
  const staged = stagedRequestLogFiles(connectionId, dir)
  if (staged.error) {
    readError = staged.error
  } else {
    for (const stagedFile of staged.files) {
      try {
        stagedTexts.push(fs.readFileSync(stagedFile, 'utf8'))
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          readError = error
          break
        }
      }
    }
  }
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') readError ??= error
  }
  // If a writer that already had ANY rotated log's fd open appended after
  // `rotateRequestLog`'s final read (even across multiple subsequent rotations),
  // that retained archive (`.requests.jsonl.1` or `.requests.jsonl.archive-*`) will
  // have grown past its recorded watermark `archive_bytes` (or lack a watermark).
  // Replay every such archive ahead of the active log so NO late `launch`, `schedule`,
  // `open`, or `typed_turn_failed` is ever missed (requirement 3ea2b201 / decision ce71a72b).
  const archiveTexts = []
  if (!readError) {
    const archives = archiveRequestLogFiles(connectionId, dir)
    if (archives.error) {
      readError = archives.error
    } else if (archives.files.length > 0) {
      const watermarks = archiveWatermarks(text, connectionId)
      for (const archiveFile of archives.files) {
        try {
          const archStat = fs.statSync(archiveFile)
          const base = path.basename(archiveFile)
          const byInoWm =
            watermarks.byIno.get(`${archStat.dev ?? ''}:${archStat.ino}`) ??
            watermarks.byIno.get(`:${archStat.ino}`) ??
            null
          const byNameWm = watermarks.byName.get(base) ?? null
          const wm =
            byInoWm ??
            (byNameWm &&
            (byNameWm.archive_ino == null ||
              (archStat.ino === byNameWm.archive_ino &&
                (byNameWm.archive_dev == null || archStat.dev === byNameWm.archive_dev)))
              ? byNameWm
              : null)
          if (!wm) {
            archiveTexts.push(fs.readFileSync(archiveFile, 'utf8'))
          } else if (archStat.size > wm.archive_bytes) {
            const tailReplay = carryForwardTailLines(fs.readFileSync(archiveFile), wm.archive_bytes)
            if (tailReplay) archiveTexts.push(tailReplay)
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            readError = error
            break
          }
        }
      }
    }
  }
  const combined = [...stagedTexts, ...archiveTexts, ...(text ? [text] : [])].join('\n')
  const state = reduceRequestLog(combined)
  return readError ? { ...state, readError } : state
}

/**
 * Open a request on DevSpec and record it. `call(args)` performs report_request
 * with the connection capability and returns the parsed result. A command already
 * open here (or, on DevSpec, under another id) is the request it already is.
 *
 * @returns {Promise<string|null>} the request id, or null when DevSpec refused it
 */
export async function openRequest({
  connectionId,
  kind,
  provenanceRef = null,
  messageId = null,
  call,
  dir = DEFAULT_DIR,
  id = randomUUID(),
}) {
  if (!connectionId || (kind !== 'command' && kind !== 'typed_prompt')) return null
  if (kind === 'command') {
    if (!UUID.test(provenanceRef ?? '')) return null
    for (const [existing, info] of readRequestState(connectionId, { dir }).open) {
      if (info.provenance_ref === provenanceRef) return existing
    }
  }
  let result
  try {
    result = await call({
      connection_id: connectionId,
      action: 'open',
      request_id: id,
      kind,
      ...(kind === 'command' ? { provenance_ref: provenanceRef } : {}),
    })
  } catch {
    return null
  }
  const requestId = UUID.test(result?.request_id ?? '') ? result.request_id : null
  if (!requestId || result.status !== 'open') return null
  const persisted = appendRequestEvent(
    connectionId,
    {
      op: 'open',
      id: requestId,
      kind,
      ...(kind === 'command' ? { provenance_ref: provenanceRef } : {}),
      ...(UUID.test(messageId ?? '') ? { message_id: messageId } : {}),
      ...(UUID.test(result.requested_by_user_id ?? '') ? { requested_by: result.requested_by_user_id } : {}),
    },
    { dir },
  )
  return persisted ? requestId : null
}

/**
 * Close a request whose work is finished. Recorded closed here only once DevSpec
 * says so, or says it has no such request: a close that failed is tried again at
 * the next Stop, so DevSpec never carries a finished request it was not told of.
 */
export async function closeRequest({
  connectionId,
  requestId,
  reason = 'host_finished',
  call,
  dir = DEFAULT_DIR,
}) {
  if (!connectionId || !UUID.test(requestId ?? '')) return false
  let closed = false
  try {
    const result = await call({ connection_id: connectionId, action: 'close', request_id: requestId, reason })
    closed = result?.status === 'closed'
  } catch (error) {
    closed = /unknown request/i.test(String(error?.message ?? error))
  }
  return closed ? appendRequestEvent(connectionId, { op: 'close', id: requestId }, { dir }) : false
}

export function setCurrentRequest(connectionId, ref, { dir = DEFAULT_DIR } = {}) {
  if (ref === UNSTATED) return appendRequestEvent(connectionId, { op: 'current', ref: null }, { dir })
  if (ref !== NO_REQUEST && !UUID.test(ref ?? '')) return false
  return appendRequestEvent(connectionId, { op: 'current', ref }, { dir })
}

function tag(text, name) {
  const match = String(text || '').match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))
  return match ? match[1] : null
}

/** The DevSpec command message ids a listener wake carries, oldest first. */
function ownerMessageIds(text) {
  const ids = []
  for (const line of String(text || '').split('\n')) {
    const start = line.indexOf('{')
    if (start < 0 || !line.includes('owner_message')) continue
    try {
      const event = JSON.parse(line.slice(start))
      const msgId = event?.message_id ?? event?.message?.message_id ?? event?.message?.id
      if (event?.type === 'owner_message' && UUID.test(msgId ?? '')) ids.push(msgId)
    } catch {
      const match = line.match(/"message_id":"([0-9a-f-]{36})"/i)
      if (match && UUID.test(match[1])) ids.push(match[1])
    }
  }
  return ids
}

/** The open requests of the DevSpec commands a wake carries, oldest first. */
export function commandRequestsInWake(text, state) {
  const refs = []
  if (!state?.open) return refs
  for (const messageId of ownerMessageIds(text)) {
    for (const [id, info] of state.open) {
      if (info.message_id === messageId && !refs.includes(id)) refs.push(id)
    }
  }
  return refs
}

/**
 * What a recorded launch or schedule carries when it wakes the agent: its request
 * while still open, nobody's when it was positively launched for nobody's, and
 * otherwise not known (its request finished, or was never known). Never nobody's
 * by default.
 */
function carriedBy(entry, state) {
  return {
    ref: state.open.has(entry.request) || entry.request === NO_REQUEST ? entry.request : UNSTATED,
    also: (entry.also ?? []).filter((id) => state.open.has(id) && id !== entry.request),
  }
}

/**
 * Which request a prompt continues, from its origin and text. A prompt a person
 * submitted is handled by the caller (a new typed request).
 *
 * @returns {{ ref: string, also: string[] }} ref is a request id, NO_REQUEST or UNSTATED
 */
export function requestForWake({ origin, text, state }) {
  const kind = typeof origin === 'string' ? origin : origin?.kind
  if (kind === 'task-notification') {
    for (const key of [tag(text, 'task-id'), tag(text, 'tool-use-id')]) {
      const launch = key ? state.launches.get(key) : null
      if (launch) return carriedBy(launch, state)
    }
    const commands = commandRequestsInWake(text, state)
    if (commands.length > 0) return { ref: commands.at(-1), also: commands.slice(0, -1) }
    // A command not opened here: DevSpec resolves it from the turn.
    if (ownerMessageIds(text).length > 0) return { ref: UNSTATED, also: [] }
    // An automation run DevSpec dispatched is positively nobody's request: DevSpec
    // credits the run while it is running, never a command that happens to be live.
    if (/"type"\s*:\s*"automation_(?:run|dispatch)"/.test(String(text || ''))) return { ref: NO_REQUEST, also: [] }
    return { ref: UNSTATED, also: [] }
  }
  if (kind === 'scheduled-trigger') {
    const prompt = String(text || '').trim()
    const matched = [...state.schedules].reverse().filter((schedule) => schedule.prompt === prompt)
    if (matched.length === 0) return { ref: UNSTATED, also: [] }
    const first = carriedBy(matched[0], state)
    const also = new Set(first.also)
    for (const schedule of matched.slice(1)) {
      const other = carriedBy(schedule, state)
      for (const id of [other.ref, ...other.also]) {
        if (id !== first.ref && (UUID.test(id) || id === NO_REQUEST)) also.add(id)
      }
    }
    return { ref: first.ref, also: [...also] }
  }
  return { ref: UNSTATED, also: [] }
}

/** The job ids a wake's notification names, to mark their launches notified. */
export function notifiedKeys(text) {
  return [tag(text, 'task-id'), tag(text, 'tool-use-id')].filter((key) => key && KEY.test(key))
}

/**
 * The request-log events for a prompt submitted into the host, and the id of
 * the typed request to open for it. `midTurn` is true when delivered into a
 * running turn so what it carries joins that turn rather than replacing what
 * the turn serves.
 */
export function promptArrival({
  fromAPerson,
  origin,
  text,
  midTurn = false,
  state,
  newId = randomUUID,
  priorEndedWakeKeys = undefined,
  hookLiveUnoutputWakeKeys = undefined,
}) {
  const events = []
  if (fromAPerson) {
    const id = newId()
    events.push(midTurn ? { op: 'joined', id } : { op: 'current', ref: id })
    return { events, typedId: id }
  }
  const { ref, also } = requestForWake({ origin, text, state })
  if (midTurn) {
    for (const id of [ref, ...also]) events.push({ op: 'joined', id })
  } else {
    const resolvedRef = ref === UNSTATED ? null : ref
    const priorKeys =
      resolvedRef !== null && Array.isArray(priorEndedWakeKeys)
        ? priorEndedWakeKeys.filter((k) => typeof k === 'string' && k)
        : null
    const liveUnoutputKeys =
      resolvedRef !== null && Array.isArray(hookLiveUnoutputWakeKeys)
        ? hookLiveUnoutputWakeKeys.filter((k) => typeof k === 'string' && k)
        : null
    events.push({
      op: 'current',
      ref: resolvedRef,
      ...(resolvedRef !== null ? { from_wake: true } : {}),
      ...(priorKeys !== null ? { prior_ended_wake_keys: priorKeys } : {}),
      ...(liveUnoutputKeys && liveUnoutputKeys.length > 0 ? { hook_live_unoutput_wake_keys: liveUnoutputKeys } : {}),
    })
    for (const id of also) events.push({ op: 'joined', id })
  }
  const kind = typeof origin === 'string' ? origin : origin?.kind
  if (kind === 'task-notification') {
    for (const key of notifiedKeys(text)) events.push({ op: 'notified', key })
  }
  return { events, typedId: null }
}

/**
 * Record the active request(s) in `<connectionId>.requests.jsonl` when a remote
 * inbox batch is delivered by `devspec-remote-wait.mjs`.
 */
export function recordDeliveredBatchRequests(connectionId, batch, { dir = DEFAULT_DIR, midTurn = false } = {}) {
  if (!connectionId || !batch || typeof batch !== 'object') return []
  const events = []
  const state = readRequestState(connectionId, { dir })
  const activeTurn = midTurn || (state.current !== null && (state.current === NO_REQUEST || state.open.has(state.current)))
  if (batch.type === 'owner_messages' || batch.type === 'canonical_commands') {
    const executeIds = Array.isArray(batch.execute_message_ids)
      ? batch.execute_message_ids
      : Array.isArray(batch.messages)
        ? batch.messages.map((m) => m?.message_id ?? m?.id).filter(Boolean)
        : []
    const refs = []
    for (const messageId of executeIds) {
      for (const [id, info] of state.open) {
        if (info.message_id === messageId && !refs.includes(id)) refs.push(id)
      }
    }
    if (refs.length > 0) {
      if (activeTurn) {
        for (const id of refs) events.push({ op: 'joined', id })
      } else {
        events.push({ op: 'current', ref: refs.at(-1) })
        for (const id of refs.slice(0, -1)) events.push({ op: 'joined', id })
      }
    } else if (executeIds.length > 0) {
      events.push(activeTurn ? { op: 'joined', id: UNSTATED } : { op: 'current', ref: null })
    }
  } else if (batch.type === 'automation_dispatches' || batch.type === 'automation_run') {
    events.push(activeTurn ? { op: 'joined', id: NO_REQUEST } : { op: 'current', ref: NO_REQUEST })
  }
  for (const event of events) {
    appendRequestEvent(connectionId, event, { dir })
  }
  return events
}

/**
 * The request a write made now serves: a subagent's is the request that launched
 * it, anything else the current one. Null when nothing is known, which leaves the
 * write unstamped for DevSpec to resolve itself.
 */
export function requestRefForWrite(state, agentId = null) {
  if (!state) return null
  if (agentId) {
    const launch = state.launches.get(agentId)
    if (launch) return state.open.has(launch.request) || launch.request === NO_REQUEST ? launch.request : null
  }
  if (state.current === NO_REQUEST) return NO_REQUEST
  return state.current && state.open.has(state.current) ? state.current : null
}

/**
 * The delivery `provenance_ref` of the room command a write made now serves, or
 * null when the write serves a typed terminal prompt, nobody's request, an
 * already-answered command (whose delivery DevSpec closed on final answer), or an
 * unknown request.
 */
export function provenanceRefForWrite(state, agentId = null) {
  if (!state) return null
  const ref = requestRefForWrite(state, agentId)
  if (!ref || ref === NO_REQUEST) return null
  const info = state.open.get(ref)
  if (!info || info.answered) return null
  return typeof info.provenance_ref === 'string' && UUID.test(info.provenance_ref) ? info.provenance_ref : null
}

/**
 * Who a request is from, as a write would record it: a person, and whether they
 * asked at this terminal or in a room.
 */
function attributionOf(info) {
  return `${info.requested_by ?? 'unknown'}:${info.kind === 'typed_prompt' ? 'terminal' : 'room'}`
}

/**
 * What the current turn carries when it would not all be recorded the same way
 * (different people; one person here and in a room; nobody's request or one not
 * known beside somebody's), and the agent has not named which its writes serve.
 * Null when any write this turn makes has one answer. A subagent's write is
 * settled by its own launch.
 */
export function turnAmbiguity(state, agentId = null) {
  if (!state || state.chosen || state.joined.size === 0) return null
  if (agentId && state.launches.has(agentId)) return null
  return undecided(carriedEntries(state))
}

/** Everything the current turn carries, the request it serves first. */
function carriedEntries(state) {
  const entries = []
  const add = (ref, current) => {
    if (entries.some((entry) => entry.id === (ref ?? UNSTATED))) return
    if (ref === NO_REQUEST) entries.push({ id: NO_REQUEST, kind: 'none', current, attribution: 'nobody' })
    else if (ref === UNSTATED || ref === null) entries.push({ id: UNSTATED, kind: 'unstated', current, attribution: 'unknown' })
    else if (state.open.has(ref)) entries.push(openEntry(ref, state.open.get(ref), current))
  }
  add(state.current, true)
  for (const id of state.joined) add(id, false)
  return entries
}

function openEntry(id, info, current) {
  return {
    id,
    kind: info.kind,
    ...(info.message_id ? { message_id: info.message_id } : {}),
    current,
    attribution: attributionOf(info),
  }
}

/** The entries, when they would not all be recorded the same way; otherwise null. */
function undecided(entries) {
  if (new Set(entries.map((entry) => entry.attribution)).size < 2) return null
  return entries.map(({ attribution: _attribution, ...entry }) => entry)
}

/**
 * What the agent may name with `serve`: everything the turn carries, even after
 * it has named one, and every room command it has started on and not yet given
 * its final answer to (item 984ca8b4). Null when every choice would be recorded
 * the same way.
 */
export function selectableRequests(state) {
  const entries = carriedEntries(state)
  for (const [id, info] of state.open) {
    if (info.kind !== 'command' || info.answered || !state.started.has(id)) continue
    if (!entries.some((entry) => entry.id === id)) entries.push(openEntry(id, info, false))
  }
  return undecided(entries)
}

/**
 * The room commands a final answer posted now finishes: those the turn carries.
 * `complete_turn` ends the turn for every command in it.
 */
export function commandsAnsweredNow(state) {
  return [state.current, ...state.joined]
    .filter((id) => state.open.get(id)?.kind === 'command' && !state.open.get(id)?.answered)
}

/**
 * Whether an open request is finished at a Stop: it has reached the agent, has no
 * work still running or still to wake the agent, and, for a room command, has its
 * final answer.
 */
export function requestFinished(state, id, pending) {
  const info = state.open.get(id)
  if (!info || !state.started.has(id) || pending.has(id)) return false
  return info.kind !== 'command' || info.answered === true
}

/**
 * The request a job launched now belongs to: the launching subagent's when a
 * subagent launched it, else the current one, with any other requests an
 * undecided turn was carrying.
 */
export function requestForLaunch(state, agentId = null) {
  const ref = requestRefForWrite(state, agentId) ?? UNSTATED
  const also = (turnAmbiguity(state, agentId) ?? [])
    .map((entry) => entry.id)
    .filter((id) => UUID.test(id) && id !== ref)
  return { request: ref, also }
}

/** Whether a cron the host lists (Stop's session_crons) is this schedule. */
function cronIsSchedule(cron, schedule) {
  if (schedule.id && cron?.id === schedule.id) return true
  const listed = typeof cron?.prompt === 'string' ? cron.prompt.trim() : ''
  if (!listed) return false
  if (listed === schedule.prompt) return true
  const kept = listed.replace(/(…|\.\.\.)$/, '')
  return listed.length >= CRON_PROMPT_CLIP - 3 && schedule.prompt.startsWith(kept)
}

/**
 * The open requests that still have work running or a wake still to come, at a
 * Stop.
 */
export function requestsWithWorkPending(state, { backgroundTasks = null, sessionCrons = null } = {}) {
  const pending = new Set()
  const listed = new Map()
  for (const task of Array.isArray(backgroundTasks) ? backgroundTasks : []) {
    if (task && typeof task.id === 'string') listed.set(task.id, String(task.status || '').toLowerCase())
  }
  const hold = (entry) => {
    for (const id of [entry.request, ...(entry.also ?? [])]) if (state.open.has(id)) pending.add(id)
  }
  for (const launch of new Set(state.launches.values())) {
    const status = listed.get(launch.key)
    if (status !== undefined && !ENDED_STATUSES.has(status)) hold(launch)
    else if (launch.notifies && !launch.notified && !(status === undefined && Array.isArray(backgroundTasks) && launch.absent >= 1)) hold(launch)
  }
  const crons = Array.isArray(sessionCrons) ? sessionCrons : []
  for (const schedule of state.schedules) {
    if (crons.some((cron) => cronIsSchedule(cron, schedule))) hold(schedule)
  }
  return pending
}

/** Launches still awaited that the host's list (Stop's background_tasks) leaves off. */
export function absentLaunches(state, backgroundTasks) {
  if (!Array.isArray(backgroundTasks)) return []
  const listed = new Set(backgroundTasks.map((task) => task?.id).filter((id) => typeof id === 'string'))
  return [...new Set(state.launches.values())]
    .filter((launch) => launch.notifies && !launch.notified && state.open.has(launch.request) && !listed.has(launch.key))
    .map((launch) => launch.key)
}

/**
 * The request bookkeeping at a turn's end, done once by whichever of the stop hook and
 * the poller reports that turn end (transcript-turn-end.mjs): close each open request
 * that is finished (requestFinished), note launches the host's list leaves off, and
 * start the log afresh when it may. `backgroundTasks` and `sessionCrons` are the host's
 * lists from the stop hook's input, null where there are none (the poller has none).
 * `holdCurrent` keeps the current request open while an answer to it is still on its
 * way. `call(args)` performs report_request with the connection capability. Returns
 * `{ closed, failed }`: the ids closed, and those whose close did not reach DevSpec
 * (they stay open here, so the next turn end tries them again).
 */
export async function finishTurnRequests({
  connectionId,
  call,
  dir = DEFAULT_DIR,
  backgroundTasks = null,
  sessionCrons = null,
  holdCurrent = false,
}) {
  if (!connectionId || typeof call !== 'function') return { closed: [], failed: [] }
  const requests = readRequestState(connectionId, { dir })
  const closed = []
  const failed = []
  if (requests.open.size > 0) {
    const pending = requestsWithWorkPending(requests, { backgroundTasks, sessionCrons })
    const awaitingAnswer = holdCurrent ? requests.current : null
    const finished = [...requests.open.keys()].filter(
      (id) => requestFinished(requests, id, pending) && id !== awaitingAnswer,
    )
    const results = await Promise.all(
      finished.map((requestId) => closeRequest({ connectionId, requestId, call, dir })),
    )
    finished.forEach((id, index) => {
      if (results[index]) closed.push(id)
      else failed.push(id)
    })
  }
  for (const key of absentLaunches(requests, backgroundTasks)) {
    appendRequestEvent(connectionId, { op: 'absent', key }, { dir })
  }
  rotateRequestLog(connectionId, { dir })
  return { closed, failed }
}

/**
 * Build lines to carry forward any tail appended to a rotated log past `knownBytes`,
 * including `open` restoration lines for any `if_idle`-closed request re-opened by
 * a late `launch`, `schedule`, or `joined` in that tail.
 */
function carryForwardTailLines(fullBuf, knownBytes) {
  if (fullBuf.length <= knownBytes) return ''
  const fullText = fullBuf.toString('utf8')
  const extraText = fullBuf.subarray(knownBytes).toString('utf8')
  const fullState = reduceRequestLog(fullText)
  const extraState = reduceRequestLog(extraText)
  const restoredLines = []
  for (const [id, info] of fullState.open) {
    if (!extraState.open.has(id)) {
      restoredLines.push(
        `${JSON.stringify({
          op: 'open',
          id,
          kind: info.kind,
          ...(info.message_id ? { message_id: info.message_id } : {}),
          ...(info.provenance_ref ? { provenance_ref: info.provenance_ref } : {}),
          ...(info.requested_by ? { requested_by: info.requested_by } : {}),
          at: new Date().toISOString(),
        })}\n`,
      )
    }
  }
  const normalizedExtra = extraText.endsWith('\n') ? extraText : `${extraText}\n`
  return `${restoredLines.join('')}${normalizedExtra}`
}

/**
 * Start the log afresh once it has grown and carries no open request. Launches
 * and schedules made for nobody's request are carried over while they may still
 * wake the agent, so their wakes stay positively nobody's.
 */
export function rotateRequestLog(connectionId, { dir = DEFAULT_DIR, minBytes = ROTATE_BYTES, onError = null } = {}) {
  const file = requestLogPath(connectionId, dir)
  try {
    let fileStat
    try {
      fileStat = fs.statSync(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') onError?.(error)
      return false
    }
    if (fileStat.size < minBytes) return false
    // Snapshot EVERY retained archive's size BEFORE calling `readRequestState` so the
    // carried-forward watermark NEVER advances past bytes appended after `readRequestState`
    // checked the old archive: any append landing during or after `readRequestState` is
    // strictly beyond `oldStat.size`, causing the post-rotation re-stat to report `false`
    // and leaving those new bytes unread past the watermark for the next read (req 3ea2b201).
    const priorArchives = archiveRequestLogFiles(connectionId, dir)
    if (priorArchives.error) {
      onError?.(priorArchives.error)
      return false
    }
    const priorArchiveStats = new Map()
    for (const oldArch of priorArchives.files) {
      try {
        priorArchiveStats.set(oldArch, fs.statSync(oldArch))
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          onError?.(error)
          return false
        }
      }
    }
    const effectiveState = readRequestState(connectionId, { dir })
    if (effectiveState.readError) {
      onError?.(effectiveState.readError)
      return false
    }
    if (effectiveState.open.size > 0 || effectiveState.failedTranscriptTurns.size > 0) return false
    // Never rotate while a `.pending-opens.json` recovery file exists or while any
    // unnotified launch/monitor/schedule for a request awaiting recovery sits in the log
    // (or in a late-appended archive tail) (decision ce71a72b / requirement 3ea2b201).
    if (fs.existsSync(path.join(dir, `${connectionId}.pending-opens.json`))) return false
    for (const launch of new Set(effectiveState.launches.values())) {
      if (
        launch.request !== NO_REQUEST &&
        (launch.kind === 'monitor' || (launch.notifies !== false && !launch.notified))
      ) {
        return false
      }
    }
    for (const schedule of effectiveState.schedules) {
      if (schedule.request !== NO_REQUEST) return false
    }
    const priorStaged = stagedRequestLogFiles(connectionId, dir)
    if (priorStaged.error) {
      onError?.(priorStaged.error)
      return false
    }
    const priorStagedSizes = new Map()
    for (const oldStaged of priorStaged.files) {
      try {
        priorStagedSizes.set(oldStaged, fs.statSync(oldStaged).size)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          onError?.(error)
          return false
        }
      }
    }
    const preBuf = fs.readFileSync(file)
    const preText = preBuf.toString('utf8')
    const preState = reduceRequestLog(preText)
    if (preState.open.size > 0 || preState.failedTranscriptTurns.size > 0) return false
    const carriedWatermarks = archiveWatermarks(preText, connectionId).latest
    // Atomically claim the active log into a unique staging file BEFORE archiving it,
    // then re-read the claimed file to catch ANY concurrent `launch`, `schedule`,
    // `typed_turn_failed`, or `open` appended between our read and our rename. NEVER
    // overwrite or unlink an existing archive (`.requests.jsonl.1` or prior
    // `.requests.jsonl.archive-*`): if `.1` already exists, place the new archive at a
    // unique `.archive-*` path and carry forward every prior archive's watermark
    // advanced to the exact size already verified clean by `effectiveState` so a
    // writer holding an already-open fd to ANY earlier archive remains visible across
    // arbitrary subsequent rotations without resurrecting already-closed work
    // (requirements 3ea2b201 / ce71a72b).
    const staged = `${file}.rotating-${process.pid}-${randomUUID().slice(0, 8)}`
    fs.renameSync(file, staged)
    try {
      const stagedStat = fs.statSync(staged)
      const stagedBuf = fs.readFileSync(staged)
      const hasExtraTail = stagedBuf.length > preBuf.length
      const primaryArchive = `${file}.1`
      const archiveFile = fs.existsSync(primaryArchive)
        ? `${file}.archive-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`
        : primaryArchive
      const archiveName = path.basename(archiveFile)
      const initialLines = []
      const emittedArchiveNames = new Set()
      for (const [oldArch, oldStat] of priorArchiveStats) {
        const oldName = path.basename(oldArch)
        emittedArchiveNames.add(oldName)
        initialLines.push(
          `${JSON.stringify({
            op: 'rotated',
            archive_name: oldName,
            archive_bytes: oldStat.size,
            archive_ino: oldStat.ino,
            archive_dev: oldStat.dev,
            at: new Date().toISOString(),
          })}\n`,
        )
      }
      for (const priorWm of carriedWatermarks) {
        if (emittedArchiveNames.has(priorWm.archive_name)) continue
        initialLines.push(
          `${JSON.stringify({
            op: 'rotated',
            archive_name: priorWm.archive_name,
            archive_bytes: priorWm.archive_bytes,
            archive_ino: priorWm.archive_ino,
            archive_dev: priorWm.archive_dev,
            at: new Date().toISOString(),
          })}\n`,
        )
      }
      initialLines.push(
        `${JSON.stringify({
          op: 'rotated',
          archive_name: archiveName,
          archive_bytes: stagedBuf.length,
          archive_ino: stagedStat.ino,
          archive_dev: stagedStat.dev,
          at: new Date().toISOString(),
        })}\n`,
      )
      if (hasExtraTail) {
        initialLines.push(carryForwardTailLines(stagedBuf, preBuf.length))
      }
      for (const launch of new Set(effectiveState.launches.values())) {
        if (launch.request === NO_REQUEST && launch.notifies && !launch.notified) {
          initialLines.push(
            `${JSON.stringify({
              op: 'launch',
              key: launch.key,
              kind: launch.kind,
              notifies: true,
              request: NO_REQUEST,
              also: [],
              at: new Date().toISOString(),
            })}\n`,
          )
        }
      }
      for (const schedule of effectiveState.schedules) {
        if (schedule.request === NO_REQUEST) {
          initialLines.push(
            `${JSON.stringify({
              op: 'schedule',
              prompt: schedule.prompt,
              id: schedule.id,
              request: NO_REQUEST,
              also: [],
              at: new Date().toISOString(),
            })}\n`,
          )
        }
      }
      fs.appendFileSync(file, initialLines.join(''), { mode: 0o600 })
      // Guard against a concurrent rotator creating `${file}.1` between our `existsSync`
      // check and rename: never overwrite an existing `.1` archive.
      let finalArchiveFile = archiveFile
      if (finalArchiveFile === primaryArchive && fs.existsSync(primaryArchive)) {
        finalArchiveFile = `${file}.archive-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`
      }
      fs.renameSync(staged, finalArchiveFile)
      if (finalArchiveFile !== archiveFile) {
        fs.appendFileSync(
          file,
          `${JSON.stringify({
            op: 'rotated',
            archive_name: path.basename(finalArchiveFile),
            archive_bytes: stagedBuf.length,
            archive_ino: stagedStat.ino,
            archive_dev: stagedStat.dev,
            at: new Date().toISOString(),
          })}\n`,
          { mode: 0o600 },
        )
      }
      // NEVER delete older `.rotating-*` or prior archive files: a writer may still
      // hold an open fd to one of them and append a `launch` or `typed_turn_failed` at
      // any time. Verify none of them grew or became unreadable during this rotation
      // (requirements 3ea2b201 / ce71a72b).
      let priorGrew = false
      for (const [oldStaged, beforeSize] of priorStagedSizes) {
        const afterStat = fs.statSync(oldStaged)
        if (afterStat.size > beforeSize) priorGrew = true
      }
      for (const [oldArch, oldStat] of priorArchiveStats) {
        const afterStat = fs.statSync(oldArch)
        if (afterStat.size > oldStat.size) priorGrew = true
      }
      // Re-stat the newly archived inode immediately after moving it into place: if a
      // writer with an already-open fd appended after `readFileSync(staged)`, carry those
      // bytes + restored open refs into the active log right away and advance its
      // watermark (requirements 3ea2b201 / ce71a72b).
      const postArchStat = fs.statSync(finalArchiveFile)
      if (postArchStat.size > stagedBuf.length) {
        const postArchBuf = fs.readFileSync(finalArchiveFile)
        const lateCarry = carryForwardTailLines(postArchBuf, stagedBuf.length)
        const updatedWatermark = `${JSON.stringify({
          op: 'rotated',
          archive_name: path.basename(finalArchiveFile),
          archive_bytes: postArchBuf.length,
          archive_ino: postArchStat.ino,
          archive_dev: postArchStat.dev,
          at: new Date().toISOString(),
        })}\n`
        fs.appendFileSync(file, `${lateCarry}${updatedWatermark}`, { mode: 0o600 })
        return false
      }
      return !hasExtraTail && !priorGrew
    } catch (error) {
      onError?.(error)
      try {
        if (!fs.existsSync(file) && fs.existsSync(staged)) {
          fs.renameSync(staged, file)
        }
      } catch {
        /* ignore rollback failure; `readRequestState` still reads `.rotating-*` */
      }
      return false
    }
  } catch (error) {
    onError?.(error)
    return false
  }
}

/**
 * The background job, wait or loop a finished tool call set up, for the request
 * log. Null when the call left nothing running.
 */
export function launchForRequest(toolName, toolInput, toolResponse, toolUseId = null) {
  const res = toolResponse && typeof toolResponse === 'object' ? toolResponse : null
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const id = (value) => (typeof value === 'string' && KEY.test(value) ? value : null)
  const alias = id(toolUseId)
  if (!res) return null
  switch (String(toolName || '')) {
    case 'Bash':
    case 'Shell': {
      if (isDevSpecListener(input)) return null
      const key = id(res.backgroundTaskId ?? res.shell_id ?? res.taskId)
      return key ? { key, alias, kind: 'shell', notifies: res.backgroundEndsWithFinalResponse !== true } : null
    }
    case 'Agent':
    case 'Task': {
      if (res.status === 'async_launched' && id(res.agentId)) return { key: res.agentId, alias, kind: 'subagent', notifies: true }
      if (res.status === 'remote_launched' && id(res.taskId)) return { key: res.taskId, alias, kind: 'subagent', notifies: true }
      return null
    }
    case 'Workflow': {
      const key = id(res.taskId)
      return key ? { key, alias, kind: 'workflow', notifies: true } : null
    }
    case 'Monitor': {
      // The DevSpec listener carries every request and belongs to none: its wakes
      // are commands, each its own request.
      if (isDevSpecListener(input)) return null
      const key = id(res.taskId)
      return key ? { key, alias, kind: 'monitor', notifies: false } : null
    }
    case 'ScheduleWakeup': {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      return prompt && !res.stopped ? { schedule: true, prompt, id: null } : null
    }
    case 'CronCreate': {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      return prompt ? { schedule: true, prompt, id: id(res.id) } : null
    }
    default:
      return null
  }
}

/** Whether a tool call arms the DevSpec listener or wake-tail itself. */
export function isDevSpecListener(toolInput) {
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : ''
  return cmd.includes('devspec-remote-wait.mjs') || cmd.includes('devspec-wake-tail.mjs')
}

/**
 * Whether a tool call is about to start work that will outlive it: a background
 * command or subagent, a workflow, a monitor, a scheduled wake-up or a cron.
 */
export function startsBackgroundWork(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  switch (String(toolName || '')) {
    case 'Bash':
    case 'Shell':
      if (isDevSpecListener(input)) return false
      return input.run_in_background === true || input.block_until_ms === 0
    case 'Agent':
    case 'Task':
      return input.run_in_background === true
    case 'Monitor':
      return !isDevSpecListener(input)
    case 'Workflow':
    case 'ScheduleWakeup':
    case 'CronCreate':
      return true
    default:
      return false
  }
}

export const REQUESTS_SCRIPT = fileURLToPath(import.meta.url)

/** The command the agent runs to name the request its writes serve. */
export function serveCommand(connectionId) {
  return `node ${JSON.stringify(REQUESTS_SCRIPT)} serve --connection-id ${connectionId}`
}

/**
 * The choices the agent is offered for an undecided turn. "Nobody's request" is
 * offered only when no other person's request is open here: DevSpec refuses it
 * while a teammate's is (migration 1272), because a nobody's change is judged by
 * the owner's role.
 */
export function servableCarried(state, carried) {
  if (!carried?.some((entry) => entry.kind === 'none')) return carried
  const owners = new Set(
    [...state.open.values()].filter((info) => info.kind === 'typed_prompt').map((info) => info.requested_by),
  )
  const teammateOpen = [...state.open.values()].some(
    (info) => info.kind === 'command' && !owners.has(info.requested_by),
  )
  if (!teammateOpen) return carried
  const choices = carried.filter((entry) => entry.kind !== 'none')
  if (!choices.some((entry) => entry.kind === 'unstated')) {
    choices.push({ id: UNSTATED, kind: 'unstated', current: false })
  }
  return choices
}

/** How a carried request is named to the agent, and the serve flag that picks it. */
export function describeCarried(entry) {
  if (entry.kind === 'none') return '- nobody\'s request (your own initiative): --none'
  if (entry.kind === 'unstated') {
    return '- none of these, or you cannot tell (DevSpec records that it could not tell who asked; the served contract\'s requester_rule says how that change is judged): --unstated'
  }
  if (entry.kind === 'typed_prompt') return '- the prompt your owner typed at this terminal: --terminal'
  return `- the room command with message_id ${entry.message_id ?? '(unknown)'}: --message-id ${entry.message_id ?? '<id>'}`
}

/** The refusal text for a write or launch made while the turn is undecided. */
export function undecidedTurnMessage(connectionId, carried, what = 'this change') {
  return [
    `This turn carries more than one request, and they would be recorded differently (different people, or the same person here and in a room). DevSpec records who asked for ${what}.`,
    'Say which request it serves, then make the call again. Run:',
    `  ${serveCommand(connectionId)} <one of>`,
    ...carried.map(describeCarried),
    'What you do next follows that request until another reaches you. Name each request before its work when you switch.',
  ].join('\n')
}

/**
 * `serve --connection-id <id> (--message-id <id> | --terminal | --none | --unstated)`:
 * the agent says which request the writes it makes next serve: one its turn
 * carries, or a room command it has started on and not yet answered
 * (selectableRequests). It can name another later; a choice never locks the
 * turn. Prints what it recorded, as one JSON line.
 */
export function serveMain(argv, { dir = DEFAULT_DIR } = {}) {
  const value = (flag) => {
    const at = argv.indexOf(flag)
    return at >= 0 && typeof argv[at + 1] === 'string' ? argv[at + 1] : null
  }
  const connectionId = value('--connection-id')
  if (!UUID.test(connectionId ?? '')) return { ok: false, error: 'serve needs --connection-id <your connection id>' }
  const messageId = value('--message-id')
  const flags = {
    terminal: argv.includes('--terminal'),
    none: argv.includes('--none'),
    unstated: argv.includes('--unstated'),
  }
  if ([Boolean(messageId), flags.terminal, flags.none, flags.unstated].filter(Boolean).length !== 1) {
    return { ok: false, error: 'serve needs exactly one of --message-id <id>, --terminal, --none or --unstated' }
  }
  const state = readRequestState(connectionId, { dir })
  const carried = servableCarried(state, selectableRequests(state))
  if (!carried) {
    return { ok: false, error: 'Nothing to choose: this turn carries one request, and your writes already name it.' }
  }
  const entry = [...carried].reverse().find((candidate) =>
    messageId
      ? candidate.message_id === messageId
      : flags.terminal
        ? candidate.kind === 'typed_prompt'
        : flags.none
          ? candidate.kind === 'none'
          : candidate.kind === 'unstated',
  )
  if (!entry) {
    return {
      ok: false,
      error: `That is not one of the requests this turn carries. Choose one of:\n${carried.map(describeCarried).join('\n')}`,
    }
  }
  if (!appendRequestEvent(connectionId, { op: 'serve', ref: entry.id }, { dir })) {
    return { ok: false, error: 'could not record it' }
  }
  return { ok: true, serving: describeCarried(entry).replace(/^- /, '').replace(/: --.*$/, '') }
}

let isMain = false
try {
  isMain =
    Boolean(process.argv[1]) &&
    fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  /* imported */
}
if (isMain && process.argv[2] === 'serve') {
  const result = serveMain(process.argv.slice(3))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}
