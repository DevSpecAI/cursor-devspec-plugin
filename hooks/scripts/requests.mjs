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
 *   joined: Set<string>,
 *   chosen: boolean,
 * }}
 */
export function reduceRequestLog(text) {
  const open = new Map()
  const started = new Set()
  const launches = new Map()
  const aliases = new Map()
  const schedules = []
  let current = null
  let joined = new Set()
  let chosen = false
  const launchOf = (key) => launches.get(key) ?? launches.get(aliases.get(key))
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
          open.set(event.id, {
            kind: event.kind,
            ...(event.message_id ? { message_id: event.message_id } : {}),
            ...(event.provenance_ref ? { provenance_ref: event.provenance_ref } : {}),
            ...(event.requested_by ? { requested_by: event.requested_by } : {}),
          })
        }
        break
      case 'close':
        open.delete(event.id)
        started.delete(event.id)
        joined.delete(event.id)
        if (current === event.id) current = null
        break
      case 'current':
        // A new turn: what it carries starts again from what woke it.
        current = event.ref === NO_REQUEST || UUID.test(event.ref ?? '') ? event.ref : null
        joined = new Set()
        chosen = false
        if (UUID.test(current ?? '')) started.add(current)
        break
      case 'joined':
        // Delivered into the running turn: the turn now carries it too.
        if (carriedRef(event.id) && event.id !== current) {
          joined.add(event.id)
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
          chosen = true
          if (UUID.test(current ?? '')) started.add(current)
        }
        break
      case 'answered': {
        // The agent posted its final answer to this room command
        // (post_session_message with complete_turn), so once its work is done
        // the command is finished. Until then it stays open (item 984ca8b4).
        const info = open.get(event.id)
        if (info) info.answered = true
        break
      }
      case 'launch':
        if (KEY.test(event.key ?? '') && carriedRef(event.request)) {
          launches.set(event.key, {
            key: event.key,
            request: event.request,
            also: uuids(event.also),
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
        break
      }
      case 'absent': {
        const launch = launchOf(event.key)
        if (launch) launch.absent += 1
        break
      }
      case 'schedule':
        if (typeof event.prompt === 'string' && event.prompt.trim() && carriedRef(event.request)) {
          schedules.push({
            prompt: event.prompt.trim(),
            request: event.request,
            also: uuids(event.also),
            id: KEY.test(event.id ?? '') ? event.id : null,
          })
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
  return { open, started, launches, schedules, current, joined, chosen }
}

export function readRequestState(connectionId, { dir = DEFAULT_DIR } = {}) {
  let text = ''
  try {
    text = fs.readFileSync(requestLogPath(connectionId, dir), 'utf8')
  } catch {
    /* no log yet: nothing open */
  }
  return reduceRequestLog(text)
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
  appendRequestEvent(
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
  return requestId
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
export function promptArrival({ fromAPerson, origin, text, midTurn = false, state, newId = randomUUID }) {
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
    events.push({ op: 'current', ref: ref === UNSTATED ? null : ref })
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
 * null when the write serves a typed terminal prompt, nobody's request, or an
 * unknown request.
 */
export function provenanceRefForWrite(state, agentId = null) {
  if (!state) return null
  const ref = requestRefForWrite(state, agentId)
  if (!ref || ref === NO_REQUEST) return null
  const info = state.open.get(ref)
  return typeof info?.provenance_ref === 'string' && UUID.test(info.provenance_ref) ? info.provenance_ref : null
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
 * Start the log afresh once it has grown and carries no open request. Launches
 * and schedules made for nobody's request are carried over while they may still
 * wake the agent, so their wakes stay positively nobody's.
 */
export function rotateRequestLog(connectionId, { dir = DEFAULT_DIR, minBytes = ROTATE_BYTES } = {}) {
  const file = requestLogPath(connectionId, dir)
  try {
    if (fs.statSync(file).size < minBytes) return false
    const state = reduceRequestLog(fs.readFileSync(file, 'utf8'))
    if (state.open.size > 0) return false
    fs.renameSync(file, `${file}.1`)
    for (const launch of new Set(state.launches.values())) {
      if (launch.request === NO_REQUEST && launch.notifies && !launch.notified) {
        appendRequestEvent(
          connectionId,
          { op: 'launch', key: launch.key, kind: launch.kind, notifies: true, request: NO_REQUEST, also: [] },
          { dir },
        )
      }
    }
    for (const schedule of state.schedules) {
      if (schedule.request === NO_REQUEST) {
        appendRequestEvent(
          connectionId,
          { op: 'schedule', prompt: schedule.prompt, id: schedule.id, request: NO_REQUEST, also: [] },
          { dir },
        )
      }
    }
    return true
  } catch {
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
