/**
 * Replies to DevSpec notices (this plugin's item 5f8fe76a; the server half is item
 * 8885423d, and the Claude Code, Antigravity and Pi plugins made the same change as
 * items 8ad9f857, fdc96b30 and 6aad2b46).
 *
 * DevSpec sends notices about the agent's own work (a conflict with someone else's
 * work, a failed check, a review finding, the outcome of a pending edit) to its exact
 * connection, outside every command and turn. Telling the person about one in the
 * room is `post_session_message` with `connection_id` and `system_notice_ids`: the
 * server stores it as the agent's own message, labelled as a reply to those notices,
 * bound to no command or turn. It never opens, completes or closes a turn, so a
 * command being worked at the same time still gets its own answer. A plain post
 * instead is filed under whichever command the agent last answered, which is the bug
 * this fixes. The served rules are `semantics.notice_reply` in
 * devspec://product/remote-ingress-contract; nothing here restates more than the
 * mechanics a host needs.
 *
 * How the ids reach the post:
 * - Every notice the wake hands the model carries the exact call with its own id
 *   (`noticeReplyInstruction`), and the wake line carries the call for the whole
 *   batch, so the model copies ids from the text in front of it, never from memory.
 * - `<connection>.turn-wakes.json` records what woke the current turn: the notice ids
 *   delivered into it, and `otherWake` once anything else did (a command, a typed
 *   prompt, an automation run, an answered question, or a mid-turn prompt that is not
 *   a notice). The wait script records each batch it delivers; the prompt hook
 *   records what started the turn, from the wake lines in the prompt itself.
 * - When every wake of the turn was a notice and nothing else is open on the
 *   connection (`turnNoticeIds`), every post the model makes in it is about those
 *   notices, so preToolUse stamps their ids on a plain post itself. Anywhere else the
 *   plugin cannot tell which post is about the notice, stamps nothing, and the model
 *   passes the ids it was shown.
 * - A notice-only turn whose model posted no reply ends with one: Stop posts the
 *   turn's final message as a notice reply (`postNoticeTurnReply`).
 *
 * Imports only Node built-ins and sibling modules that do.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { NO_REQUEST, UNSTATED, readRequestState } from './requests.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const DEFAULT_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

export const NOTICE_REPLY_CONTRACT = 'semantics.notice_reply in devspec://product/remote-ingress-contract'

/** The wake reason a batch of notices carries (devspec-remote-wait.mjs). */
export const NOTICE_WAKE_REASON = 'exact_connection_system_notice'

/** Wake event types that are not notices: each one makes the turn more than a notice turn. */
const OTHER_WAKE_TYPES = new Set([
  'owner_message',
  'automation_dispatch',
  'automation_run',
  'question_answer',
  'question_dismissal',
])

function uniqueIds(values) {
  const seen = new Set()
  const ids = []
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !UUID.test(value)) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ids.push(key)
  }
  return ids
}

function idList(ids) {
  return uniqueIds(Array.isArray(ids) ? ids : [ids])
}

/** The exact call that replies to `ids`, as the model should make it. */
export function noticeReplyCall(ids, { connectionId = null } = {}) {
  const list = idList(ids)
  const connection = typeof connectionId === 'string' && UUID.test(connectionId)
    ? `connection_id: ${JSON.stringify(connectionId)}, `
    : ''
  return `post_session_message({ ${connection}message, system_notice_ids: ${JSON.stringify(list)} })`
}

/**
 * The model-facing line under each notice (and under a batch): the exact call with
 * the exact ids, and what a notice reply is and is not.
 */
export function noticeReplyInstruction(ids, { connectionId = null } = {}) {
  const list = idList(ids)
  const subject = list.length === 1 ? 'this notice' : `these ${list.length} notices`
  return (
    `To tell the person about ${subject} in your room, post a notice reply: ${noticeReplyCall(list, { connectionId })}. ` +
    'It is your own message, shown as a reply to the notice and never as an answer to a command: ' +
    'it opens, completes and closes no turn, complete_turn has no effect on it, and a command you are working on still needs its own answer. ' +
    (list.length > 1 ? 'One reply can answer all of these notices; name only the notices it answers. ' : '') +
    "If DevSpec refuses it, the result gives DevSpec's reason; when you are attached to no room, tell the person here in the terminal instead. " +
    `Rules: ${NOTICE_REPLY_CONTRACT}.`
  )
}

/**
 * Shape only, never meaning. A Cursor chat whose tool list was loaded before DevSpec
 * took `system_notice_ids` has no type for it and can hand the array over as a
 * string ('["<id>"]', '<id>', '<id>, <id>'). Those become the array the server takes,
 * with an exact repeat sent once (the server refuses repeated ids). Anything that is
 * not wholly notice ids comes back unchanged, so the server's own refusal, with its
 * reason, reaches the model.
 */
export function normalizeNoticeIds(value) {
  let parts = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('[')) {
      try {
        parts = JSON.parse(text)
      } catch {
        parts = text.replace(/^\[|\]$/g, '').split(/[\s,]+/).map((part) => part.replace(/^["']+|["']+$/g, ''))
      }
    } else {
      parts = text.split(/[\s,]+/)
    }
  }
  if (!Array.isArray(parts)) return value
  const trimmed = parts.map((part) => (typeof part === 'string' ? part.trim() : part)).filter((part) => part !== '')
  if (trimmed.length === 0 || !trimmed.every((id) => typeof id === 'string' && UUID.test(id))) return value
  const seen = new Set()
  return trimmed.filter((id) => {
    const key = id.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The arguments of a post the model aimed at something other than the turn's notices. */
const ADDRESSED_ELSEWHERE = [
  'command_turn_id',
  'command_message_id',
  'attempt_id',
  'reply_to_message_id',
  'needs_input',
  'work_trail',
  'trail_events',
  'assistant_source_id',
  'ingest_version',
  'expected_session_id',
  'expected_attached_at',
  'expected_attachment_id',
  'interaction_event_version',
  'interaction_event_id',
  'interaction_response_id',
  'interaction_claim_token',
  'question_dismissal_event_version',
  'question_dismissal_event_id',
  'question_dismissal_question_id',
  'question_dismissal_claim_token',
]

const present = (value) => value !== undefined && value !== null && value !== ''

/**
 * Whether a `post_session_message` the model wrote without `system_notice_ids` can
 * take the turn's notices: an ordinary message, aimed at no command, message,
 * question or terminal turn of its own.
 */
export function postCanTakeTurnNotices(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (args.system_notice_ids !== undefined) return false
  if (args.command_turn_unbound === true || args.local_turn === true) return false
  if (args.phase !== undefined && args.phase !== 'answer') return false
  if (args.turn_kind !== undefined && args.turn_kind !== 'agent') return false
  return ADDRESSED_ELSEWHERE.every((key) => !present(args[key]))
}

/** Whether a `post_session_message` call is a reply to DevSpec notices. */
export function isNoticeReplyPost(args, { turnNotices = null } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (args.system_notice_ids !== undefined) return true
  return Boolean(turnNotices) && postCanTakeTurnNotices(args)
}

/**
 * A `post_session_message` as it goes to DevSpec when it is a notice reply, or null
 * when it is not one. `turnNotices` are the turn's notices when the plugin knows them
 * (`currentTurnNoticeIds`).
 *
 * - The model's ids, as an array whatever shape the tool list gave them.
 * - Otherwise, on a plain post in a notice-only turn, the turn's notices.
 * - The connection: the reply lands in the room the connection is attached to now,
 *   so it is needed even when the model named a room.
 * - `local_turn` / `command_turn_unbound` set to false when the model set them: the
 *   rules for a turn typed at the terminal say to pass them on every post, and the
 *   server refuses them on a notice reply, which is outside every turn. Set rather
 *   than left out because Cursor merges a hook's input into the call.
 */
export function prepareNoticeReply(args, { connectionId = null, turnNotices = null } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  let ids
  if (args.system_notice_ids !== undefined) ids = normalizeNoticeIds(args.system_notice_ids)
  else if (turnNotices && postCanTakeTurnNotices(args)) ids = [...turnNotices]
  else return null
  const next = { ...args, system_notice_ids: ids }
  if (connectionId && !present(next.connection_id)) next.connection_id = connectionId
  for (const key of ['local_turn', 'command_turn_unbound']) {
    if (next[key] === true) next[key] = false
  }
  return next
}

// ── What woke the turn ─────────────────────────────────────────────────────────

export function turnWakesPath(connectionId, dir = DEFAULT_DIR) {
  return path.join(dir, `${connectionId}.turn-wakes.json`)
}

/** The current turn's record: `{ startedAt, noticeIds, otherWake, noticeReplyAt? }`, or null. */
export function readTurnWakes(connectionId, { dir = DEFAULT_DIR } = {}) {
  if (!connectionId) return null
  try {
    const record = readPrivateJson(turnWakesPath(connectionId, dir))
    if (!record || typeof record !== 'object' || typeof record.startedAt !== 'number') return null
    return {
      startedAt: record.startedAt,
      noticeIds: uniqueIds(record.noticeIds),
      otherWake: record.otherWake === true,
      ...(typeof record.noticeReplyAt === 'number' ? { noticeReplyAt: record.noticeReplyAt } : {}),
    }
  } catch {
    return null
  }
}

function writeTurnWakes(connectionId, record, dir) {
  try {
    writePrivateJson(turnWakesPath(connectionId, dir), record)
    return record
  } catch {
    return null // an unrecorded wake only means the model passes the ids itself
  }
}

/** Fold a wake into a record: notice ids accumulate, `otherWake` sticks. */
export function mergeTurnWake(record, wake) {
  const base = record ?? { startedAt: Date.now(), noticeIds: [], otherWake: false }
  if (!wake) return base
  return {
    ...base,
    noticeIds: uniqueIds([...(base.noticeIds ?? []), ...(wake.noticeIds ?? [])]),
    otherWake: base.otherWake === true || wake.otherWake === true,
  }
}

/**
 * Record a wake delivered into the turn. `newTurn` starts the record again from this
 * wake (the prompt that started a turn); otherwise it is folded into what is there.
 */
export function recordTurnWake(connectionId, wake, { dir = DEFAULT_DIR, newTurn = false, now = Date.now() } = {}) {
  if (!connectionId || !wake) return null
  const existing = newTurn ? null : readTurnWakes(connectionId, { dir })
  const base = existing ?? { startedAt: now, noticeIds: [], otherWake: false }
  return writeTurnWakes(connectionId, mergeTurnWake(base, wake), dir)
}

/** The turn is over: forget what woke it. */
export function clearTurnWakes(connectionId, { dir = DEFAULT_DIR } = {}) {
  if (!connectionId) return
  try {
    fs.rmSync(turnWakesPath(connectionId, dir), { force: true })
  } catch {
    /* ignore */
  }
}

/** Note that a reply to the turn's notices went out, so Stop does not post a second. */
export function recordNoticeReply(connectionId, { dir = DEFAULT_DIR, now = Date.now() } = {}) {
  const record = readTurnWakes(connectionId, { dir })
  if (!record) return false
  return Boolean(writeTurnWakes(connectionId, { ...record, noticeReplyAt: now }, dir))
}

/**
 * What a list of wake events (devspec-remote-wait.mjs) brings into a turn: its notice
 * ids, or `otherWake` when anything in it is not a notice. Advisory lines (room
 * context, unread counts) and a connection's end bring nothing. Null when nothing in
 * it is a wake.
 */
export function turnWakeFromEvents(events) {
  const noticeIds = []
  let otherWake = false
  let seen = false
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'system_notice') {
      seen = true
      if (typeof event.notice_id === 'string') noticeIds.push(event.notice_id)
    } else if (event.type === 'wake') {
      seen = true
      if (event.reason === NOTICE_WAKE_REASON) {
        if (Array.isArray(event.system_notice_ids)) noticeIds.push(...event.system_notice_ids)
      } else {
        otherWake = true
      }
    } else if (OTHER_WAKE_TYPES.has(event.type)) {
      seen = true
      otherWake = true
    }
  }
  if (otherWake) return { otherWake: true }
  const ids = uniqueIds(noticeIds)
  if (ids.length > 0) return { noticeIds: ids }
  return seen ? { otherWake: true } : null
}

/**
 * The same, read from the text of a prompt: the wake lines Cursor shows the model,
 * one JSON object per line, possibly inside a notification wrapper or cut short by
 * a preview. A line that does not parse is read by its leading fields, which the
 * wait script writes first.
 */
export function turnWakeFromText(text) {
  const events = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('"type"')) continue
    const start = line.indexOf('{')
    if (start >= 0) {
      try {
        events.push(JSON.parse(line.slice(start)))
        continue
      } catch {
        /* read it by its leading fields below */
      }
    }
    const type = /"type"\s*:\s*"([a-z_]+)"/.exec(line)?.[1]
    if (type === 'system_notice') {
      const id = /"notice_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(line)?.[1]
      events.push({ type, notice_id: id })
    } else if (type === 'wake') {
      const reason = /"reason"\s*:\s*"([a-z_]+)"/.exec(line)?.[1]
      const listed = /"system_notice_ids"\s*:\s*\[([^\]]*)\]/.exec(line)?.[1] ?? ''
      events.push({ type, reason, system_notice_ids: listed.match(UUID_IN_TEXT) ?? [] })
    } else if (OTHER_WAKE_TYPES.has(type)) {
      events.push({ type })
    }
  }
  return turnWakeFromEvents(events)
}

/**
 * Record what a prompt brought into the turn (mirror-turn.mjs, beforeSubmitPrompt).
 *
 * - A person's prompt is never a notice.
 * - A prompt that starts a turn and carries wake lines starts the record from them.
 * - One that starts a turn with no wake lines (Cursor's notification may only point
 *   at the wake file) leaves the record the wait script wrote on delivery.
 * - Anything delivered into a running turn is folded in, and a mid-turn prompt that
 *   is not a notice makes the turn more than a notice turn.
 */
export function recordPromptWake(connectionId, { fromAPerson = false, text = '', midTurn = false, dir = DEFAULT_DIR } = {}) {
  if (!connectionId) return null
  const wake = fromAPerson ? { otherWake: true } : turnWakeFromText(text)
  if (midTurn) return recordTurnWake(connectionId, wake ?? { otherWake: true }, { dir })
  if (wake) return recordTurnWake(connectionId, wake, { dir, newTurn: true })
  return readTurnWakes(connectionId, { dir })
}

/**
 * The notices this turn is about, when that is certain; otherwise null.
 *
 * Certain means: the record holds at least one notice and no other wake; no turn typed
 * at the terminal is open (`connectionState.local_turn`); and the request log has no
 * command, typed prompt or automation run current or joined. A prompt that is not a
 * request joins as "not known" (UNSTATED); the record accounts for those, since every
 * one that is not a notice sets `otherWake`. A stale record or request only ever
 * makes this null, never the other way round.
 */
export function turnNoticeIds({ record, requestState = null, connectionState = null } = {}) {
  const ids = uniqueIds(record?.noticeIds)
  if (ids.length === 0 || record.otherWake === true) return null
  if (connectionState?.local_turn) return null
  if (requestState) {
    if (requestState.current === NO_REQUEST) return null
    if (requestState.current && requestState.open?.has?.(requestState.current)) return null
    for (const id of requestState.joined ?? []) {
      if (id !== UNSTATED) return null
    }
  }
  return ids
}

/** `turnNoticeIds` for a connection, read fresh. */
export function currentTurnNoticeIds(connectionId, { dir = DEFAULT_DIR, connectionState = null } = {}) {
  if (!connectionId) return null
  return turnNoticeIds({
    record: readTurnWakes(connectionId, { dir }),
    requestState: readRequestState(connectionId, { dir }),
    connectionState,
  })
}

// ── Stop: a notice-only turn ends with a notice reply ─────────────────────────

const TRANSCRIPT_TAIL_BYTES = 256 * 1024

function textOf(row) {
  const content = row?.message?.content ?? row?.content
  if (typeof content === 'string') return { text: content.trim(), tools: false }
  const parts = Array.isArray(content) ? content : []
  return {
    text: parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim(),
    tools: parts.some((part) => part && part.type === 'tool_use'),
  }
}

/**
 * The turn's final message from Cursor's agent transcript, or null. Rows are
 * `{"role":"user"|"assistant","message":{"content":[…]}}` with a
 * `{"type":"turn_ended",…}` line at each turn's end. The final message is the last
 * assistant row of the turn, when it is words and not a tool call; nothing from an
 * earlier turn ever counts.
 */
export function lastAssistantText(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  let tail
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      tail = buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = tail.split('\n')
  let endedSeen = false
  for (let i = lines.length - 1; i >= 0; i--) {
    let row
    try {
      row = JSON.parse(lines[i])
    } catch {
      continue // blank, or the partial first line of the tail
    }
    if (row?.type === 'turn_ended') {
      if (endedSeen) return null // an earlier turn's end: this turn said nothing
      endedSeen = true
      continue
    }
    const role = row?.role ?? row?.message?.role
    if (role === 'user') return null
    if (role !== 'assistant') continue
    const { text, tools } = textOf(row)
    return text && !tools ? text : null
  }
  return null
}

/** Text a hook payload carries as the assistant's last message, when Cursor sends one. */
function hookAssistantText(data) {
  for (const key of ['last_assistant_message', 'assistant_message', 'response']) {
    if (typeof data?.[key] === 'string' && data[key].trim()) return data[key]
  }
  return null
}

/**
 * Stop: when the turn was woken only by notices and the model posted no reply to
 * them, post its final message as a notice reply. Bound to no command turn, so no
 * trail, no complete_turn and no local-turn flags. Nothing for a turn that errored or
 * was stopped (its last words are not an answer), or for a connection in no room:
 * the person already sees the final message in the terminal.
 *
 * @returns {Promise<string[]|null>} the notice ids replied to, or null
 */
export async function postNoticeTurnReply({
  raw,
  connectionId,
  sessionId,
  connectionState = null,
  agentName,
  post,
  dir = DEFAULT_DIR,
  prepare = (text) => String(text ?? '').trim() || null,
} = {}) {
  if (!connectionId || !sessionId || typeof post !== 'function') return null
  const record = readTurnWakes(connectionId, { dir })
  if (!record || record.noticeReplyAt) return null
  const ids = turnNoticeIds({ record, requestState: readRequestState(connectionId, { dir }), connectionState })
  if (!ids) return null
  let data = {}
  try {
    data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  } catch {
    data = {}
  }
  if (data.status !== undefined && data.status !== 'completed') return null
  const text = prepare(hookAssistantText(data) ?? lastAssistantText(data.transcript_path))
  if (!text) return null
  await post({
    connection_id: connectionId,
    ...(agentName ? { agent_name: agentName } : {}),
    message: text,
    system_notice_ids: ids,
  })
  recordNoticeReply(connectionId, { dir })
  return ids
}
