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
 *   passes the ids it was shown. Check jobs delivered into the turn are recorded
 *   beside the notices (`checkJobIds`) and change none of this.
 * - Stop never posts a reply for the model (item 140a7f68). Whether a notice is
 *   answered in the room is DevSpec's rule (`semantics.notice_audience`,
 *   `semantics.notice_reply`), and when one is called for the model posts it itself;
 *   what it leaves in the terminal at the end of a turn that owns no command is its
 *   working, not a reply. The one thing Stop posts for such a turn is its final
 *   message, as an ordinary message, after one of its writes carried DevSpec's
 *   `tell_person` mark and the model told nobody itself (`postTellPersonAtStop`).
 *
 * Which notices get a reply is DevSpec's label, never the plugin's guess (item
 * a868f41f; `semantics.notice_audience`). At system_notice_version 3 every notice
 * carries `audience`: `needs_person` or `for_the_record`. Only notices that need a
 * person are given a reply call or stamped on a plain post; the turn record keeps the
 * for-the-record ones apart (`forTheRecordIds`). They still make the turn one that
 * owns no command.
 *
 * Imports only Node built-ins and sibling modules that do.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { NO_REQUEST, UNSTATED, readRequestState } from './requests.mjs'
import { logRemoteControlStory } from './remote-control-story.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const DEFAULT_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

export const NOTICE_REPLY_CONTRACT = 'semantics.notice_reply in devspec://product/remote-ingress-contract'
export const NOTICE_AUDIENCE_CONTRACT = 'semantics.notice_audience in devspec://product/remote-ingress-contract'

/**
 * The line a notice labelled for the record ends with, in place of a notice reply:
 * what the label means for this host, and where the rules are.
 */
export const FOR_THE_RECORD_HANDLING =
  'DevSpec labelled this notice for the record: it gets no notice reply and nothing in the room, ' +
  'and any housekeeping it asks for on your own work is done quietly. ' +
  'If a write you make while handling it returns tell_person, tell your person: in a turn that only DevSpec notices or check jobs woke, ' +
  'put it in your final message, which the plugin posts to the room as your own message; in any other turn, in your next message to them. ' +
  `Rules: ${NOTICE_AUDIENCE_CONTRACT}.`

/** The wake line's `notice_reply` when every notice it handed over is for the record. */
export const FOR_THE_RECORD_WAKE =
  `No notice reply: every notice in this wake is for the record (${NOTICE_AUDIENCE_CONTRACT}).`

/** The wake reason a batch of notices carries (devspec-remote-wait.mjs). */
export const NOTICE_WAKE_REASON = 'exact_connection_system_notice'

/**
 * The wake reason a check job carries (devspec-remote-wait.mjs). A check job, like a
 * notice, is DevSpec asking about a change, not anyone's command: a turn that only
 * check jobs and notices woke owns no command, so its work is kept out of the room's
 * trail (`turnOwnsNoCommand`). It is not a notice, so nothing is posted as a notice
 * reply because of it.
 */
export const CHECK_JOB_WAKE_REASON = 'check_job'

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
    `When an unresolved choice, hold, rejection, or block still needs the person on ${subject} in your room after you act, post a notice reply: ${noticeReplyCall(list, { connectionId })}. ` +
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

/** A record's check job ids, as a field only when there are any. */
function checkJobIdsField(ids) {
  const list = uniqueIds(ids)
  return list.length > 0 ? { checkJobIds: list } : {}
}

/** A record's for-the-record notice ids, as a field only when there are any. */
function forTheRecordField(ids) {
  const list = uniqueIds(ids)
  return list.length > 0 ? { forTheRecordIds: list } : {}
}

/**
 * The current turn's record: `{ startedAt, noticeIds, forTheRecordIds?, checkJobIds?,
 * otherWake, noticeReplyAt?, tellPersonAt? }`, or null. `noticeIds` holds every notice
 * that woke the turn; `forTheRecordIds` the ones among them DevSpec labelled for the
 * record; `tellPersonAt` when a DevSpec write in the turn carried `tell_person`.
 */
export function readTurnWakes(connectionId, { dir = DEFAULT_DIR } = {}) {
  if (!connectionId) return null
  try {
    const record = readPrivateJson(turnWakesPath(connectionId, dir))
    if (!record || typeof record !== 'object' || typeof record.startedAt !== 'number') return null
    return {
      startedAt: record.startedAt,
      noticeIds: uniqueIds(record.noticeIds),
      ...forTheRecordField(record.forTheRecordIds),
      ...checkJobIdsField(record.checkJobIds),
      otherWake: record.otherWake === true,
      ...(typeof record.noticeReplyAt === 'number' ? { noticeReplyAt: record.noticeReplyAt } : {}),
      ...(typeof record.tellPersonAt === 'number' ? { tellPersonAt: record.tellPersonAt } : {}),
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

/** Fold a wake into a record: notice, label and check job ids accumulate, `otherWake` sticks. */
export function mergeTurnWake(record, wake) {
  const base = record ?? { startedAt: Date.now(), noticeIds: [], otherWake: false }
  if (!wake) return base
  return {
    ...base,
    noticeIds: uniqueIds([...(base.noticeIds ?? []), ...(wake.noticeIds ?? [])]),
    ...forTheRecordField([...(base.forTheRecordIds ?? []), ...(wake.forTheRecordIds ?? [])]),
    ...checkJobIdsField([...(base.checkJobIds ?? []), ...(wake.checkJobIds ?? [])]),
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

/** Note that the model replied to the turn's notices itself, so Stop posts nothing for it. */
export function recordNoticeReply(connectionId, { dir = DEFAULT_DIR, now = Date.now() } = {}) {
  const record = readTurnWakes(connectionId, { dir })
  if (!record) return false
  return Boolean(writeTurnWakes(connectionId, { ...record, noticeReplyAt: now }, dir))
}

/**
 * Note that a DevSpec write in the turn carried `tell_person` (`resultCarriesTellPerson`).
 * Only a turn something woke has a record, and only a turn that owns no command acts on
 * it (`postTellPersonAtStop`); anywhere else telling the person is the turn's own answer.
 */
export function recordTellPerson(connectionId, { dir = DEFAULT_DIR, now = Date.now() } = {}) {
  const record = readTurnWakes(connectionId, { dir })
  if (!record) return false
  if (record.tellPersonAt) return true
  return Boolean(writeTurnWakes(connectionId, { ...record, tellPersonAt: now }, dir))
}

/**
 * Whether a DevSpec tool result carries DevSpec's `tell_person` mark: the write changed
 * a record its requester does not own, or marked a task blocked, and the person the
 * agent works for must hear about it (`semantics.notice_audience.telling_anyway`).
 * DevSpec appends the mark to an applied write's result as its own text block,
 * `{"tell_person":{…}}`. Only that shape counts, so a record whose text merely mentions
 * the word never does. `result` is the result Cursor hands afterMCPExecution
 * (`result_json`), as text or as the parsed object.
 */
export function resultCarriesTellPerson(result) {
  let envelope = result
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope)
    } catch {
      return false
    }
  }
  if (!envelope || typeof envelope !== 'object' || envelope.isError === true) return false
  const blocks = Array.isArray(envelope.content) ? envelope.content : []
  return blocks.some((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.includes('"tell_person"')) return false
    try {
      const mark = JSON.parse(block.text)?.tell_person
      return Boolean(mark) && typeof mark === 'object' && !Array.isArray(mark) && typeof mark.why === 'string'
    } catch {
      return false
    }
  })
}

/**
 * What a list of wake events (devspec-remote-wait.mjs) brings into a turn: its notice
 * ids (and which of them DevSpec labelled for the record), or `otherWake` when
 * anything in it is not a notice. Advisory lines (room context, unread counts) and a
 * connection's end bring nothing. Null when nothing in it is a wake.
 */
export function turnWakeFromEvents(events) {
  const noticeIds = []
  const forTheRecordIds = []
  const checkJobIds = []
  let otherWake = false
  let seen = false
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'system_notice') {
      seen = true
      if (typeof event.notice_id === 'string') {
        noticeIds.push(event.notice_id)
        if (event.audience === 'for_the_record') forTheRecordIds.push(event.notice_id)
      }
    } else if (event.type === 'check_job') {
      seen = true
      if (typeof event.check_job_id === 'string') checkJobIds.push(event.check_job_id)
    } else if (event.type === 'wake') {
      seen = true
      if (event.reason === NOTICE_WAKE_REASON) {
        if (Array.isArray(event.system_notice_ids)) noticeIds.push(...event.system_notice_ids)
        if (Array.isArray(event.for_the_record_notice_ids)) forTheRecordIds.push(...event.for_the_record_notice_ids)
      } else if (event.reason === CHECK_JOB_WAKE_REASON) {
        if (typeof event.check_job_id === 'string') checkJobIds.push(event.check_job_id)
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
  const jobs = checkJobIdsField(checkJobIds)
  // A label counts only for a notice this wake actually delivered.
  const labels = forTheRecordField(uniqueIds(forTheRecordIds).filter((id) => ids.includes(id)))
  if (ids.length > 0 || jobs.checkJobIds) return { ...(ids.length > 0 ? { noticeIds: ids, ...labels } : {}), ...jobs }
  // A wake that names nothing it can be told apart by is treated as a command's.
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
    const checkJobId = /"check_job_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(line)?.[1]
    if (type === 'system_notice') {
      const id = /"notice_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(line)?.[1]
      const audience = /"audience"\s*:\s*"([a-z_]+)"/.exec(line)?.[1]
      events.push({ type, notice_id: id, ...(audience ? { audience } : {}) })
    } else if (type === 'check_job') {
      events.push({ type, check_job_id: checkJobId })
    } else if (type === 'wake') {
      const reason = /"reason"\s*:\s*"([a-z_]+)"/.exec(line)?.[1]
      const listed = /"system_notice_ids"\s*:\s*\[([^\]]*)\]/.exec(line)?.[1] ?? ''
      const quiet = /"for_the_record_notice_ids"\s*:\s*\[([^\]]*)\]/.exec(line)?.[1] ?? ''
      events.push({
        type,
        reason,
        system_notice_ids: listed.match(UUID_IN_TEXT) ?? [],
        for_the_record_notice_ids: quiet.match(UUID_IN_TEXT) ?? [],
        check_job_id: checkJobId,
      })
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
  if (wake) return recordTurnWake(connectionId, withKnownLabels(wake, readTurnWakes(connectionId, { dir })), { dir, newTurn: true })
  return readTurnWakes(connectionId, { dir })
}

/**
 * A prompt cut short can lose a notice's label. A label is a fact about its notice
 * id, so one the wait script recorded on delivery is kept for the same notice when
 * the prompt starts the record again; it never labels a notice the prompt lacks.
 */
function withKnownLabels(wake, known) {
  const ids = uniqueIds(wake?.noticeIds)
  const knownQuiet = uniqueIds(known?.forTheRecordIds).filter((id) => ids.includes(id))
  if (knownQuiet.length === 0) return wake
  return { ...wake, ...forTheRecordField([...(wake.forTheRecordIds ?? []), ...knownQuiet]) }
}

/**
 * The notices this turn is about that need a person, when that is certain; otherwise
 * null.
 *
 * Certain means: the record holds at least one notice and no other wake; no turn typed
 * at the terminal is open (`connectionState.local_turn`); and the request log has no
 * command, typed prompt or automation run current or joined. A prompt that is not a
 * request joins as "not known" (UNSTATED); the record accounts for those, since every
 * one that is not a notice sets `otherWake`. A stale record or request only ever
 * makes this null, never the other way round.
 *
 * Notices DevSpec labelled for the record are left out: a reply naming them is never
 * one, so a plain post is never stamped with them. A turn that only they woke has none,
 * and so null.
 */
export function turnNoticeIds({ record, requestState = null, connectionState = null } = {}) {
  const quiet = new Set(uniqueIds(record?.forTheRecordIds))
  const ids = uniqueIds(record?.noticeIds).filter((id) => !quiet.has(id))
  if (ids.length === 0 || record.otherWake === true) return null
  return nothingElseOpen(requestState, connectionState) ? ids : null
}

/** No typed turn and no request open on the connection beside the turn's own wakes. */
function nothingElseOpen(requestState, connectionState) {
  if (connectionState?.local_turn) return false
  if (requestState) {
    if (requestState.current === NO_REQUEST) return false
    if (requestState.current && requestState.open?.has?.(requestState.current)) return false
    for (const id of requestState.joined ?? []) {
      if (id !== UNSTATED) return false
    }
  }
  return true
}

/**
 * Whether the turn owns no command: only DevSpec notices and check jobs woke it, and
 * nothing else is open on the connection. Its work is then never posted as a trail,
 * which DevSpec would file under someone's command. The same guards as
 * `turnNoticeIds`, so a stale record or request only ever makes this false.
 */
export function turnOwnsNoCommand({ record, requestState = null, connectionState = null } = {}) {
  if (!record || record.otherWake === true) return false
  if (uniqueIds(record.noticeIds).length === 0 && uniqueIds(record.checkJobIds).length === 0) return false
  return nothingElseOpen(requestState, connectionState)
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

/** `turnOwnsNoCommand` for a connection, read fresh. */
export function currentTurnOwnsNoCommand(connectionId, { dir = DEFAULT_DIR, connectionState = null } = {}) {
  if (!connectionId) return false
  return turnOwnsNoCommand({
    record: readTurnWakes(connectionId, { dir }),
    requestState: readRequestState(connectionId, { dir }),
    connectionState,
  })
}

// ── Stop: a write marked tell_person, which the model told nobody about ───────

// How much of the transcript's end is read for the turn's final message. Cursor writes
// a turn's rows last, so they sit at the end; this bound only stops a huge transcript
// being read whole at the end of every turn that needs it.
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
 * The post that tells the person: DevSpec's append-only speech lane
 * (`assistant_source_id` with `ingest_version: 2`, sent with the connection's own
 * capability). It lands in the room the connection is attached to now, as the agent's
 * ordinary message, whether or not a turn is open there; DevSpec refuses it only when
 * the connection is in no room.
 *
 * Neither of the other shapes reaches the room from a turn that owns no command
 * (item 140a7f68):
 * - an ordinary connection post joins the turn DevSpec has open for the connection,
 *   and a wake of notices or check jobs opens none, so it is refused;
 * - a notice reply (`system_notice_ids`) is refused when every notice it names is for
 *   the record, is recorded as quiet housekeeping with no message when they were all
 *   settled (`semantics.notice_reply.only_when_needed`), and a check job has no notice
 *   to name.
 * The Pi plugin posts the same call for the same case.
 */
export function tellPersonPost({ connectionId, text, agentName = null, sourceId = randomUUID() } = {}) {
  return {
    connection_id: connectionId,
    ingest_version: 2,
    assistant_source_id: sourceId,
    message: text,
    phase: 'answer',
    complete_turn: false,
    ...(agentName ? { agent_name: agentName } : {}),
  }
}

/** DevSpec's receipt for a post, from the parsed result or its first text block. */
function postReceipt(result) {
  if (result && typeof result === 'object' && typeof result.raw === 'string') {
    try {
      return JSON.parse(result.raw.split('\n')[0])
    } catch {
      return null
    }
  }
  return result && typeof result === 'object' ? result : null
}

/**
 * Why a post did not store the message, kept as DevSpec gave it rather than flattened
 * into a sentence: `{ message, details }`, where `details` is DevSpec's own structured
 * answer (a refusal's receipt, the not-stored delivery, an HTTP failure's status and
 * code) when there is one. Null when the receipt says the message was stored.
 */
export function postRefusal({ result = undefined, error = undefined } = {}) {
  if (error !== undefined) {
    const message = (error instanceof Error ? error.message : String(error ?? '')).trim() || null
    if (error && typeof error === 'object' && error.details !== undefined) return { message, details: error.details ?? null }
    const http = {}
    for (const key of ['status', 'serverCode', 'retryable', 'code']) {
      if (error && typeof error === 'object' && error[key] !== undefined && error[key] !== null) http[key] = error[key]
    }
    return { message, details: Object.keys(http).length > 0 ? http : null }
  }
  const receipt = postReceipt(result)
  const status = receipt?.delivery?.status
  if (status === 'stored' || status === 'idempotently_stored') return null
  return { message: null, details: receipt ?? null }
}

/** The refusal recorded when the post is never sent: the connection holds no capability here. */
export const NO_CAPABILITY_REFUSAL = Object.freeze({
  message:
    'This computer holds no capability for the connection, which DevSpec needs to post your message outside a turn. Reconnecting remote control gives it one.',
  details: { reason: 'no_connection_capability' },
})

// ── A message the plugin could not post, left for the agent's next turn ───────

export const TELL_PERSON_NOTE_SUFFIX = '.tell-person-pending.json'

export function tellPersonNotePath(connectionId, dir = DEFAULT_DIR) {
  return path.join(dir, `${connectionId}${TELL_PERSON_NOTE_SUFFIX}`)
}

function validNote(note) {
  return Boolean(note) && typeof note === 'object' && typeof note.text === 'string' && note.text.trim() !== ''
}

/**
 * Keep a final message the plugin could not post, with DevSpec's refusal as it gave it
 * (`postRefusal`), until the agent's next turn (`takeTellPersonNotes`). Notes add up;
 * none replaces another.
 */
export function leaveTellPersonNote(connectionId, { text, refusal = null, dir = DEFAULT_DIR, now = Date.now() } = {}) {
  if (!connectionId || typeof text !== 'string' || !text.trim()) return false
  const file = tellPersonNotePath(connectionId, dir)
  const existing = readPrivateJson(file)
  const notes = Array.isArray(existing?.notes) ? existing.notes.filter(validNote) : []
  try {
    writePrivateJson(file, { notes: [...notes, { at: now, refusal, text }] })
    return true
  } catch {
    return false
  }
}

/** The notes left for this connection, removed as they are handed over. */
export function takeTellPersonNotes(connectionId, { dir = DEFAULT_DIR } = {}) {
  if (!connectionId) return []
  const file = tellPersonNotePath(connectionId, dir)
  const record = readPrivateJson(file)
  const notes = Array.isArray(record?.notes) ? record.notes.filter(validNote) : []
  if (notes.length === 0) return []
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* handed over anyway: a note seen twice is better than one never seen */
  }
  return notes
}

/** What the agent is told at its next turn about notes it was left. */
export function tellPersonNoteText(notes) {
  const list = (Array.isArray(notes) ? notes : []).filter(validNote)
  if (list.length === 0) return null
  const each = list.map((note, i) => [
    `${list.length > 1 ? `${i + 1}. ` : ''}Why it was not posted, as DevSpec answered (data):`,
    JSON.stringify(note.refusal ?? { message: null, details: null }, null, 2),
    'Your final message was:',
    '<final-message>',
    note.text,
    '</final-message>',
  ].join('\n'))
  return [
    'From the DevSpec plugin: in a turn that only DevSpec notices or check jobs woke, a DevSpec write you made carried tell_person ' +
      `(${TELLING_ANYWAY_CONTRACT}) and you did not tell your person yourself. ` +
      'The plugin tried to post your final message to the room for you and could not, so your person has not heard it.',
    'Tell them in plain words in your next message to them, or here in the terminal when you are attached to no room.',
    ...each,
  ].join('\n\n')
}

export const TELLING_ANYWAY_CONTRACT = 'semantics.notice_audience.telling_anyway in devspec://product/remote-ingress-contract'

/**
 * Stop, for a turn that owns no command (`turnOwnsNoCommand`: only DevSpec notices and
 * check jobs woke it). Nothing from such a turn reaches the room on the plugin's word:
 * whether a notice is answered there is DevSpec's rule (`semantics.notice_audience`,
 * `semantics.notice_reply` in devspec://product/remote-ingress-contract), and when one
 * is called for the model posts it itself (item 140a7f68).
 *
 * The one exception is DevSpec's `tell_person` mark on a write the turn made
 * (`semantics.notice_audience.telling_anyway`, which has a host that posts mechanically
 * post that run's answer). When the model posted nothing in the room itself (`told`,
 * or a notice reply it made), the turn's final message goes there as the agent's
 * ordinary message (`tellPersonPost`). Nothing for a turn that errored or was stopped
 * (its last words are not an answer), or for a connection in no room (the person
 * already sees the final message in the terminal).
 *
 * A message that could not be posted is never dropped: the failure is logged with
 * DevSpec's refusal as it gave it (`postRefusal`), and the message is left, with that
 * refusal, for the agent's next turn (`leaveTellPersonNote`), where it is told to tell
 * its person.
 *
 * `post(args, { connectionCapability })` makes the call; it is not made without the
 * connection's capability, which the post needs.
 *
 * @returns {Promise<'posted'|'left_for_next_turn'|null>} null when there was nothing to post
 */
export async function postTellPersonAtStop({
  raw,
  connectionId,
  sessionId,
  connectionState = null,
  connectionCapability = null,
  agentName,
  told = false,
  post,
  dir = DEFAULT_DIR,
  prepare = (text) => String(text ?? '').trim() || null,
  log = logRemoteControlStory,
  now = Date.now(),
} = {}) {
  if (!connectionId || !sessionId || told || typeof post !== 'function') return null
  const record = readTurnWakes(connectionId, { dir })
  if (!record?.tellPersonAt || record.noticeReplyAt) return null
  if (!turnOwnsNoCommand({ record, requestState: readRequestState(connectionId, { dir }), connectionState })) return null
  let data = {}
  try {
    data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  } catch {
    data = {}
  }
  if (data.status !== undefined && data.status !== 'completed') return null
  const text = prepare(hookAssistantText(data) ?? lastAssistantText(data.transcript_path))
  if (!text) return null
  let refusal
  if (!connectionCapability) {
    refusal = NO_CAPABILITY_REFUSAL
  } else {
    try {
      refusal = postRefusal({ result: await post(tellPersonPost({ connectionId, text, agentName }), { connectionCapability }) })
    } catch (error) {
      refusal = postRefusal({ error })
    }
  }
  if (!refusal) return 'posted'
  // DevSpec's refusal as it gave it, never the message: story lines carry no message bodies.
  log({
    phase: 'mirror_post',
    outcome: 'failed',
    reason: 'tell_person_not_posted',
    connectionId,
    sessionId,
    agent: agentName,
    tool: 'post_session_message',
    data: { refusal },
  })
  leaveTellPersonNote(connectionId, { text, refusal, dir, now })
  return 'left_for_next_turn'
}
