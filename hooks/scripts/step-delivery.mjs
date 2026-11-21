#!/usr/bin/env node
/**
 * Check jobs and notices DevSpec sends a Cursor agent while it is working reach it at
 * its next step: after the tool call that is running finishes, never in the middle of
 * one, with everything then waiting handed over together in one pause (DevSpec task
 * 8f940862, decision b8abe2bb). Before this, they reached it only once its turn ended.
 *
 * Maintainer notes: what Cursor does, as measured, and how the pieces fit.
 *
 * ## What Cursor does
 *
 * - Context a postToolUse hook adds (`additional_context`) reaches the model in the same
 *   turn, beside that tool's result, wrapped in `<system_reminder>`. Live check on
 *   cursor-agent 2026.11.05-86047df, 20 November 2026 (DevSpec task 8f940862): headless
 *   and in the terminal, with `--plugin-dir` and as an installed local plugin. The
 *   plugin's own postToolUse runs for a person with no hooks file of their own on CLI
 *   2026.10.22, 2026.11.05 and 2026.11.19 (task 659a015f), unlike its `stop` hook.
 * - Cursor holds a background command's output (the wake tail, devspec-wake-tail.mjs)
 *   until the agent is idle, so the wake file cannot reach a working agent.
 * - A helper agent's (subagent's) tool calls run the plugin's postToolUse too, and the
 *   helper receives what it adds. The call carries the helper's own `conversation_id`,
 *   with no parent id and no subagent flag (CLI 2026.11.05). Cursor's IDE release notes
 *   (3.22) say a helper's calls carry `parent_tool_call_id`; the probe did not see it,
 *   so it is honoured when present and never relied on. An installed plugin's
 *   `sessionStart` did not run in terminal sessions, so the parent conversation is the
 *   one the connection was made in (its state's `local_id`), never one a hook noted.
 *
 * ## How it works
 *
 * 1. The host follow (devspec-remote-wait.mjs `--follow`) reads each check job or
 *    notice batch from the inbox. When Cursor is in a turn of the connection's
 *    conversation (its transcript does not end in `turn_ended`, transcript-turn-end.mjs),
 *    it holds the batch here, as the wake events it would have written
 *    (`holdForNextStep`), instead of writing it to the wake file. Between turns it
 *    writes the wake file as before, so an idle agent is woken as before.
 * 2. After each tool call of that conversation, the postToolUse hook
 *    (`stepDeliveryHook`) takes everything held, drops any check job DevSpec has
 *    already settled (`checkJobStillOpen`), and hands the rest over as one note
 *    (hook-context-budget.mjs `writeNote`), with a pointer to it as the hook's context.
 *    Items that arrive while an earlier note is unread join it in a new note, so one
 *    read always has everything. The pointer comes back after every step until the
 *    agent is seen reading the note whole (`readThrough`); Cursor gives no sign that
 *    hook context arrived, and drops it whole when all the hooks on a step together
 *    pass its ceiling, so a printed pointer is not a delivery.
 * 3. When Cursor is between turns again, the follow offers through the wake file
 *    whatever is still held and whatever was handed over but not read whole
 *    (`releaseAtIdle`), dropping settled check jobs the same way, as the same kind of
 *    note the steps hand over, in one `held_for_step` wake line. The wake is sized in the
 *    one place that knows Cursor's limit on a background command's output
 *    (hook-context-budget.mjs `fitIntoWake`): when the note fits the wake it goes in it
 *    whole and is delivered; otherwise it is kept as a note file, and the wake points
 *    at it. Such a note is delivered only once the agent is seen reading it whole: until
 *    then its items stay here, every step points at it, and anything new that arrives
 *    joins it in the next wake. A note the idle wake already pointed at, with nothing
 *    new, is not woken for again, so an agent that does not read it is not woken in a
 *    loop. A stretch with no tool calls (the agent only thinking or writing) therefore
 *    still ends in the idle wake, and nothing the agent read is delivered again. Cursor
 *    does not run the plugin's `stop` hook for most people, so nothing here leans on it.
 * 4. When the connection ends (stopped at the terminal, ended in DevSpec, signed out,
 *    its Cursor gone), nothing can hand its items over any more: the follow has stopped
 *    and the hook serves only a live connection. So whatever ended it moves them out of
 *    the folder the hook looks in (`parkSteps`), and the next poller start for the same
 *    conversation takes them back as its own (`adoptParked`), to offer at its agent's
 *    next step or idle wake; a check job DevSpec has handed on meanwhile is then dropped
 *    as any settled one is. An end that could not do this itself (a process killed
 *    outright) is caught at the next poller start (`parkEndedSteps`). Either way no
 *    later tool call pays for starting the hook, and nothing is dropped unseen.

 * Each file (a held item, the handed-over record) is taken by renaming it to a name
 * only its taker knows, so the hook and the follow never both deliver one item; a
 * taker that died (a hook past Cursor's timeout) leaves its files to be put back
 * (`reclaimAbandoned`). How a check job is taken and ruled, and what a notice asks of
 * the agent, are DevSpec's rules: the note points at them by id and never restates them.
 */

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendWakeEvents } from './devspec-wake-file.mjs'
import {
  fitIntoWake,
  noteCommand,
  pointToNote,
  POST_TOOL_CONTEXT_SHARE,
  postToolUseOutput,
  readThrough,
  writeNote,
} from './hook-context-budget.mjs'
import { isDirectRun } from './is-direct-run.mjs'
import { noticeReplyInstruction, recordTurnWake, turnWakeFromEvents } from './notice-reply.mjs'
import { readOwnConnectionState } from './own-connection.mjs'
import { readPrivateJson, writePrivateJson } from './private-state.mjs'
import { firingConversation } from './project-context.mjs'
import { readLastTurnEnd } from './transcript-turn-end.mjs'
import { resolveAgentTranscriptPath } from './work-trail.mjs'

/** The inbox batches that reach a working agent at its next step: check jobs and notices. */
export const STEP_BATCH_TYPES = Object.freeze(['check_job_dispatches', 'canonical_system_notices'])

/** Where DevSpec says how a check job is taken and ruled. Pointed at, never restated. */
export const CHECK_JOB_RULES =
  'semantics.check_job.helpers and semantics.check_job.busy in devspec://product/remote-ingress-contract'

/** Where DevSpec says what a notice asks of the agent and whether and how to answer it. */
export const NOTICE_RULES =
  'semantics.notice_audience and semantics.notice_reply in devspec://product/remote-ingress-contract'

const RECORD_VERSION = 1
const HANDED = 'handed.json'
const MANIFEST = 'manifest.json'
const CONNECTION_FOLDER = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(steps|parked)$/i
const WAITING = /^w-\d{15}-[0-9a-f]{12}\.json$/
const TAKEN = /^(.+\.json)\.taken-(\d+)-[0-9a-f]{8}$/

/** One check job's lookup on DevSpec: 5 seconds, so a slow server costs a step little. */
const CHECK_JOB_LOOKUP_MS = 5_000

/**
 * A transcript read that catches Cursor mid-write is tried again this many times, this
 * far apart: Cursor writes a row in one go, far faster than this (transcript-turn-end.mjs).
 */
const TURN_READ_ATTEMPTS = 3
const TURN_READ_GAP_MS = 25

export function isStepBatch(batch) {
  return STEP_BATCH_TYPES.includes(batch?.type)
}

export function connectionsDirFor(home = os.homedir(), env = process.env) {
  const override = typeof env?.DEVSPEC_REMOTE_CONNECTIONS_DIR === 'string' ? env.DEVSPEC_REMOTE_CONNECTIONS_DIR.trim() : ''
  return override || path.join(home, '.devspec', 'remote-control', 'connections')
}

/** The folder holding what waits for one connection's next step. */
export function stepsDir(connectionId, dir) {
  return path.join(dir, `${connectionId}.steps`)
}

/** Where an ended connection's items wait for the next connection of its conversation. */
export function parkedDir(connectionId, dir) {
  return path.join(dir, `${connectionId}.parked`)
}

const keyHash = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 12)

/**
 * Whether Cursor is in a turn of `conversationId`: `in_turn` while its transcript does
 * not end in a turn end, `between` when it does or there is no transcript to read (as
 * before this existed), `unknown` when the final line could not be read just now.
 */
export function cursorTurnState(conversationId, { home = os.homedir() } = {}) {
  if (typeof conversationId !== 'string' || !conversationId) return 'unknown'
  const transcript = resolveAgentTranscriptPath(conversationId, { home })
  if (!transcript) return 'between'
  const { read, end } = readLastTurnEnd(transcript)
  if (!read) return 'unknown'
  return end ? 'between' : 'in_turn'
}

/** `cursorTurnState`, read again when a read catches Cursor mid-write. */
export async function readTurnState(conversationId, { home = os.homedir() } = {}) {
  let state = 'unknown'
  for (let attempt = 0; attempt < TURN_READ_ATTEMPTS; attempt += 1) {
    state = cursorTurnState(conversationId, { home })
    if (state !== 'unknown') return state
    await new Promise((resolve) => setTimeout(resolve, TURN_READ_GAP_MS))
  }
  return state
}

/** One held batch: the wake events the follow built for it, and what it is. */
export function stepItem(batch, events, { now = Date.now() } = {}) {
  const list = Array.isArray(events) ? events : []
  if (batch?.type === 'check_job_dispatches') {
    const job = batch.messages?.[0]
    return {
      version: RECORD_VERSION,
      key: batch.acceptance_key ?? `check_job:${job?.check_job_id}`,
      kind: 'check_job',
      check_job_id: job?.check_job_id ?? null,
      held_at: new Date(now).toISOString(),
      events: list,
    }
  }
  return {
    version: RECORD_VERSION,
    key: batch?.acceptance_key ?? `notices:${list.map((event) => event?.notice_id).filter(Boolean).join(',')}`,
    kind: 'notices',
    notice_ids: list.filter((event) => event?.type === 'system_notice').map((event) => event.notice_id),
    held_at: new Date(now).toISOString(),
    events: list,
  }
}

function validItem(item) {
  return item?.version === RECORD_VERSION && typeof item.key === 'string' &&
    (item.kind === 'check_job' || item.kind === 'notices') && Array.isArray(item.events)
}

function validRecord(record) {
  return record?.version === RECORD_VERSION && typeof record.note === 'string' &&
    Array.isArray(record.items) && record.items.every(validItem)
}

function list(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Take `file` for this process: renamed where no one else looks. Null when someone else has it. */
function take(file) {
  const taken = `${file}.taken-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    fs.renameSync(file, taken)
    return { file: taken, original: file }
  } catch {
    return null
  }
}

/** Put a taken file back where it was, unless something new is there now. */
function giveBack(taken) {
  try {
    if (fs.existsSync(taken.original)) fs.rmSync(taken.file, { force: true })
    else fs.renameSync(taken.file, taken.original)
  } catch {
    /* reclaimAbandoned puts it back once this process has gone */
  }
}

function drop(taken) {
  try {
    fs.rmSync(taken.file, { force: true })
  } catch {
    /* gone already */
  }
}

/** Put back what a process that has gone took and never finished with. */
export function reclaimAbandoned(steps) {
  for (const name of list(steps)) {
    const match = TAKEN.exec(name)
    if (!match || pidAlive(Number(match[2]))) continue
    giveBack({ file: path.join(steps, name), original: path.join(steps, match[1]) })
  }
}

function waitingFiles(steps) {
  return list(steps).filter((name) => WAITING.test(name)).sort().map((name) => path.join(steps, name))
}

/** A waiting item's file name: when it was held, then its key, so names sort in arrival order. */
function itemFileName(item) {
  const at = Date.parse(item.held_at)
  return `w-${String(Number.isFinite(at) ? at : 0).padStart(15, '0')}-${keyHash(item.key)}.json`
}

/** Whether `folder` already has `key`, waiting, being handed over, or in its handed-over note. */
function holds(folder, key) {
  const suffix = `-${keyHash(key)}.json`
  const handed = readPrivateJson(path.join(folder, HANDED))
  return list(folder).some((name) => name.startsWith('w-') && name.includes(suffix)) ||
    (validRecord(handed) && handed.items.some((each) => each.key === key))
}

/** Keep `item` waiting in `folder`, once. A failed write throws. */
function writeWaiting(folder, item) {
  if (holds(folder, item.key)) return false
  writePrivateJson(path.join(folder, itemFileName(item)), item)
  return true
}

/**
 * Hold a batch for the agent's next step (the follow, while Cursor is in a turn). The
 * same batch is held once, however often it is offered. A failed write throws, so the
 * follow writes the wake file instead and nothing is lost.
 */
export function holdForNextStep(connectionId, batch, events, { dir, now = Date.now() } = {}) {
  const item = stepItem(batch, events, { now })
  const held = writeWaiting(stepsDir(connectionId, dir), item)
  return { held: true, duplicate: !held }
}

/**
 * Whether DevSpec still has `checkJobId` waiting for this connection, asked right before
 * it is handed over (DevSpec items e6985316, 8f940862): a check held behind a step or a
 * turn may be settled or handed on meanwhile. `get_connection_dispatch` lists what still
 * waits; a job not in it is settled. A missing credential or a failed lookup counts as
 * open, so a real check is never lost.
 */
export async function checkJobStillOpen(
  checkJobId,
  { connectionId, state, call = null, resolveCredential = null, readCapability = null, timeoutMs = CHECK_JOB_LOOKUP_MS } = {},
) {
  if (typeof checkJobId !== 'string' || !checkJobId || !connectionId || !state) return true
  try {
    const credentialOf = resolveCredential ?? (await import('./resolve-mcp-auth.mjs')).connectionCredential
    const credential = await credentialOf(state)
    if (!credential?.ok || !credential.token || !credential.mcp_url) return true
    const capabilityOf = readCapability ?? (await import('./manage-plan-bridge.mjs')).readConnectionCapability
    const connectionCapability = capabilityOf(connectionId)
    const send = call ?? (await import('./mcp-call.mjs')).mcpToolsCall
    const result = await send({
      mcpUrl: credential.mcp_url,
      token: credential.token,
      ...(connectionCapability ? { connectionCapability } : {}),
      name: 'get_connection_dispatch',
      arguments: { connection_id: connectionId, dispatch_id: checkJobId },
      timeoutMs,
    })
    if (!Array.isArray(result?.dispatches)) return true
    return result.dispatches.some((dispatch) => (dispatch?.check_job_id ?? dispatch?.id) === checkJobId)
  } catch {
    return true
  }
}

/** Whether a held item is still to be handed over: a check job DevSpec still has waiting, or any notice. */
export function itemStillOpen(item, options = {}) {
  return item?.kind === 'check_job' ? checkJobStillOpen(item.check_job_id, options) : Promise.resolve(true)
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

function itemCounts(items) {
  const checks = items.filter((item) => item.kind === 'check_job').length
  const notices = items.reduce((sum, item) => sum + (item.kind === 'notices' ? item.events.filter((e) => e?.type === 'system_notice').length : 0), 0)
  return [checks ? plural(checks, 'check job', 'check jobs') : null, notices ? plural(notices, 'notice', 'notices') : null]
    .filter(Boolean)
    .join(' and ')
}

/**
 * The note a step hands over: everything waiting, as the idle wake would have carried
 * it, under one heading that says to deal with all of it in this pause and where
 * DevSpec's rules for it are.
 */
export function stepNoteText(items, { connectionId = null } = {}) {
  const lines = [
    `DevSpec sent you ${itemCounts(items) || 'nothing'} while you were working. Deal with all of them now, in this one pause, then carry on with what you were doing.`,
  ]
  if (items.some((item) => item.kind === 'check_job')) {
    lines.push('', `How a check job is taken and ruled is DevSpec's rule: ${CHECK_JOB_RULES} (claim_check_job repeats the first as \`helpers\`).`)
  }
  const notices = items.flatMap((item) => (item.kind === 'notices' ? item.events.filter((event) => event?.type === 'system_notice') : []))
  if (notices.length > 0) {
    lines.push('', `What a notice asks of you, and whether and how you answer it, is DevSpec's rule too: ${NOTICE_RULES}.`)
  }
  for (const item of items) {
    if (item.kind === 'check_job') {
      const event = item.events.find((each) => each?.type === 'check_job') ?? {}
      const job = event.check_job ?? {}
      lines.push(
        '',
        `## Check job ${item.check_job_id}`,
        event.instruction ?? '',
        `check_job_id: ${item.check_job_id}`,
        ...(job.delivery_connection_id ? [`Your connection id (its delivery_connection_id): ${job.delivery_connection_id}`] : []),
      )
      continue
    }
    for (const notice of item.events.filter((event) => event?.type === 'system_notice')) {
      lines.push('', `## Notice ${notice.notice_id}`, String(notice.content ?? ''))
    }
  }
  const needPerson = notices.filter((notice) => notice.audience !== 'for_the_record').map((notice) => notice.notice_id)
  if (needPerson.length > 1) lines.push('', noticeReplyInstruction(needPerson, { connectionId }))
  return lines.join('\n') + '\n'
}

/** The pointer's subject: what is waiting, by count. */
function stepWhat(items) {
  return `What DevSpec sent you while you were working (${itemCounts(items)})`
}

const STEP_ALSO = 'Deal with all of it in one pause, then carry on with your task. It comes back after each step until you have read it whole.'

/**
 * The idle wake's one line: everything held, as the note the steps hand over, carried
 * whole (`content`) or pointed at (`read_with`) when that would not fit one wake.
 * `holds` names the wake types inside, which are what the wake tail's notification
 * watches for (devspec-wake-file.mjs `REMOTE_WAKE_NOTIFY_PATTERN`), so Cursor wakes the
 * agent for it.
 */
function idleWakeEvent(items, connectionId, fields) {
  return {
    type: 'held_for_step',
    holds: [...new Set(items.map((item) => (item.kind === 'check_job' ? 'check_job' : 'system_notice')))],
    connection_id: connectionId,
    ...fields,
  }
}

function idleInline(items, connectionId) {
  return (text) =>
    idleWakeEvent(items, connectionId, {
      instruction: `${stepWhat(items)} is in content below, whole. Deal with all of it as it says.`,
      content: text,
    })
}

function idlePointer(items, connectionId) {
  return (note) =>
    idleWakeEvent(items, connectionId, {
      note: note.id,
      read_with: note.command,
      instruction:
        `${stepWhat(items)} is waiting for you whole in a file, because all of it is longer than Cursor shows from one ` +
        `background command. Read it now: \`${note.command}\`, and every further part it names, then deal with all of it ` +
        'as it says. Until you have read it whole it comes back after each step.',
    })
}

/**
 * The postToolUse hook: the pointer to everything DevSpec sent the agent while it was
 * working, or null when nothing waits. Only the conversation the connection was made in
 * gets it, never a helper agent's tool call. Returns the hook's stdout.
 */
export async function stepDeliveryHook(
  input,
  { env = process.env, home = os.homedir(), dir = null, isOpen = itemStillOpen, share = POST_TOOL_CONTEXT_SHARE } = {},
) {
  if (!input || typeof input !== 'object') return null
  // A helper agent's call: its conversation id is its own, so the lookup below finds no
  // connection for it; Cursor also documents parent_tool_call_id on it.
  if (typeof input.parent_tool_call_id === 'string' && input.parent_tool_call_id.trim()) return null
  const state = readOwnConnectionState(firingConversation(input), { home })
  if (!state) return null
  const connectionId = state.connection_id
  const connDir = dir ?? connectionsDirFor(home, env)
  const steps = stepsDir(connectionId, connDir)
  if (!fs.existsSync(steps)) return null
  reclaimAbandoned(steps)

  // What came back of the note already handed over, in this tool call.
  const takenRecord = take(path.join(steps, HANDED))
  let record = null
  let readChanged = false
  if (takenRecord) {
    const kept = readPrivateJson(takenRecord.file)
    if (validRecord(kept)) {
      const { record: next, done } = readThrough(kept, input, { home })
      record = done ? null : { ...kept, parts: next.parts }
      readChanged = done || next.parts.length !== (kept.parts?.length ?? 0)
    } else {
      giveBack(takenRecord)
      return null
    }
  }

  // Everything newly waiting; a check job DevSpec has settled meanwhile is dropped.
  const taken = waitingFiles(steps).map(take).filter(Boolean)
  const fresh = []
  for (const each of taken) {
    const item = readPrivateJson(each.file)
    if (validItem(item)) fresh.push({ taken: each, item })
    else giveBack(each)
  }
  const checked = await Promise.all(
    fresh.map(async (each) => ({ ...each, open: await isOpen(each.item, { connectionId, state }) })),
  )
  const adding = checked.filter((each) => each.open)

  // The connection ended while this hook held its items: nothing it hands over now
  // could be seen read. Everything goes back, read or settled excepted, and is parked
  // for the conversation's next connection, as the end itself would have done.
  if (readOwnConnectionState(firingConversation(input), { home })?.connection_id !== connectionId) {
    for (const each of checked) {
      if (each.open) giveBack(each.taken)
      else drop(each.taken)
    }
    if (takenRecord && record) giveBack(takenRecord)
    else if (takenRecord) drop(takenRecord)
    parkSteps(connectionId, { dir: connDir, localId: state.local_id ?? null })
    return null
  }

  try {
    if (adding.length > 0) {
      const items = [...(record?.items ?? []), ...adding.map((each) => each.item)]
      const note = writeNote(stepNoteText(items, { connectionId }), { home })
      record = { version: RECORD_VERSION, note: note.id, parts: [], items, at: new Date().toISOString() }
    }
    if (record && (adding.length > 0 || readChanged)) writePrivateJson(path.join(steps, HANDED), record)
  } catch {
    // Not handed over, so not taken: everything goes back for the next step.
    for (const each of adding) giveBack(each.taken)
    if (takenRecord) giveBack(takenRecord)
    for (const each of checked.filter((one) => !one.open)) drop(each.taken)
    return null
  }
  for (const each of checked) drop(each.taken)
  if (takenRecord) {
    if (record && adding.length === 0 && !readChanged) giveBack(takenRecord)
    else drop(takenRecord)
  }
  if (adding.length > 0) {
    recordTurnWake(connectionId, turnWakeFromEvents(adding.flatMap((each) => each.item.events)), { dir: connDir })
  }
  if (!record) return null
  const context = pointToNote({ id: record.note, command: noteCommand(record.note) }, { share, what: stepWhat(record.items), also: STEP_ALSO })
  return context ? JSON.stringify(postToolUseOutput(context)) : null
}

/**
 * Between turns, offer through the wake file everything still held and everything
 * handed over but not read whole, so Cursor wakes the agent with it; a check job DevSpec
 * has settled is dropped. It goes as the note the steps hand over, fitted to one
 * background output (`fitIntoWake`): carried whole in the wake when it fits, and then
 * delivered; otherwise kept as a note file the wake points at, and kept here as the
 * handed-over record until the agent reads it whole. A note
 * already woken for, with nothing new, waits for the agent's steps instead of waking it
 * again. Does nothing while Cursor is in a turn. Returns what it did, or null.
 */
export async function releaseAtIdle(
  connectionId,
  { dir, state, wakeFile, home = os.homedir(), isOpen = itemStillOpen, append = appendWakeEvents, turnState = null } = {},
) {
  const steps = stepsDir(connectionId, dir)
  if (!fs.existsSync(steps)) return null
  reclaimAbandoned(steps)
  const handedPath = path.join(steps, HANDED)
  if (waitingFiles(steps).length === 0) {
    // Nothing new, and nothing handed over, or a note the idle wake already pointed at.
    if (!fs.existsSync(handedPath) || readPrivateJson(handedPath)?.woken === true) return null
  }
  const now = turnState ?? (await readTurnState(state?.local_id, { home }))
  if (now !== 'between') return null

  const takenRecord = take(handedPath)
  const kept = takenRecord ? readPrivateJson(takenRecord.file) : null
  const record = validRecord(kept) ? kept : null
  if (takenRecord && !record) giveBack(takenRecord)
  const taken = waitingFiles(steps).map(take).filter(Boolean)
  const fresh = []
  for (const each of taken) {
    const item = readPrivateJson(each.file)
    if (validItem(item)) fresh.push(item)
  }
  if (record?.woken === true && fresh.length === 0) {
    for (const each of taken) giveBack(each)
    giveBack(takenRecord)
    return null
  }
  const items = [...(record?.items ?? []), ...fresh]
  const open = []
  const dropped = []
  for (const item of items) {
    if (await isOpen(item, { connectionId, state })) open.push(item)
    else dropped.push(item.key)
  }
  const finish = () => {
    for (const each of taken) drop(each)
    if (takenRecord && record) drop(takenRecord)
  }
  if (open.length === 0) {
    finish()
    return { released: [], pointed: [], dropped, note: null }
  }
  const events = open.flatMap((item) => item.events)
  let wake = null
  try {
    wake = fitIntoWake([], {
      text: stepNoteText(open, { connectionId }),
      inline: idleInline(open, connectionId),
      pointer: idlePointer(open, connectionId),
      home,
    })
    // Neither fitted, or the note could not be written: everything stays for the next try.
    if (wake.route === 'none') throw new Error('the idle wake could not be fitted to one output')
    if (wake.note) {
      writePrivateJson(handedPath, {
        version: RECORD_VERSION,
        note: wake.note.id,
        parts: record?.note === wake.note.id ? record.parts ?? [] : [],
        items: open,
        at: new Date().toISOString(),
        woken: true,
      })
    }
    append(wakeFile, wake.events)
  } catch (error) {
    if (wake?.note) fs.rmSync(handedPath, { force: true })
    for (const each of taken) giveBack(each)
    if (takenRecord && record) giveBack(takenRecord)
    throw error
  }
  finish()
  recordTurnWake(connectionId, turnWakeFromEvents(events), { dir })
  const keys = open.map((item) => item.key)
  return { released: wake.note ? [] : keys, pointed: wake.note ? keys : [], dropped, note: wake.note?.id ?? null }
}

function readStateOf(dir, connectionId) {
  try {
    return { state: JSON.parse(fs.readFileSync(path.join(dir, `${connectionId}.json`), 'utf8')), missing: false }
  } catch (error) {
    return { state: null, missing: error?.code === 'ENOENT' }
  }
}

/**
 * The connection has ended (stopped at the terminal, ended in DevSpec, signed out, its
 * Cursor gone), so nothing can hand its items over any more: the follow stops with it
 * and the hook serves only a live connection. Its items, waiting or in a note not read
 * whole, move to its parked folder, outside the folder the hook's guard looks in, where
 * the next poller start for the same conversation (`localId`, else the state's) takes
 * them back (`adoptParked`). An item a live hook has taken stays where it is, and so
 * does the folder: that hook parks what it puts back when it finishes. Returns what it
 * did, or null when there was no folder.
 */
export function parkSteps(connectionId, { dir, localId = null } = {}) {
  const steps = stepsDir(connectionId, dir)
  if (!fs.existsSync(steps)) return null
  reclaimAbandoned(steps)
  const parked = parkedDir(connectionId, dir)
  if (waitingFiles(steps).length > 0 || fs.existsSync(path.join(steps, HANDED))) {
    // Whose they are goes first, so a poller starting meanwhile knows the conversation.
    const manifestPath = path.join(parked, MANIFEST)
    const conversation = localId ?? readPrivateJson(manifestPath)?.local_id ?? readStateOf(dir, connectionId).state?.local_id ?? null
    writePrivateJson(manifestPath, {
      version: RECORD_VERSION,
      connection_id: connectionId,
      local_id: typeof conversation === 'string' && conversation ? conversation : null,
      parked_at: new Date().toISOString(),
    })
  }
  const moved = []
  const move = (taken, items) => {
    try {
      for (const item of items) writeWaiting(parked, item)
    } catch {
      giveBack(taken)
      return
    }
    drop(taken)
    moved.push(...items.map((item) => item.key))
  }
  const takenRecord = take(path.join(steps, HANDED))
  if (takenRecord) {
    const record = readPrivateJson(takenRecord.file)
    if (validRecord(record)) move(takenRecord, record.items)
    else giveBack(takenRecord)
  }
  for (const file of waitingFiles(steps)) {
    const taken = take(file)
    if (!taken) continue
    const item = readPrivateJson(taken.file)
    if (validItem(item)) move(taken, [item])
    else giveBack(taken)
  }
  try {
    fs.rmdirSync(steps)
  } catch {
    /* not empty: a live hook holds an item, and parks it when it finishes */
  }
  return { parked: moved, left: fs.existsSync(steps) }
}

/**
 * At a poller's start: park the items of every connection in `dir` that is no longer
 * live (its state disabled or gone), however it ended. Catches an end that could not
 * park them itself (a process killed outright, a write that failed).
 */
export function parkEndedSteps({ dir } = {}) {
  const parked = []
  for (const name of list(dir)) {
    const match = CONNECTION_FOLDER.exec(name)
    if (!match || match[2] !== 'steps') continue
    const { state, missing } = readStateOf(dir, match[1])
    // A state file being rewritten right now is not an ended connection.
    if (!state && !missing) continue
    if (state?.enabled === true) continue
    if (parkSteps(match[1], { dir })) parked.push(match[1])
  }
  return parked
}

/**
 * At a poller's start: what earlier connections of the same conversation parked becomes
 * this connection's, waiting for its agent's next step or idle wake. A check job among
 * them that DevSpec has handed on is dropped when it is offered, as any settled one is.
 * Returns the keys taken back.
 */
export function adoptParked(connectionId, { dir, localId } = {}) {
  if (typeof localId !== 'string' || !localId) return []
  const steps = stepsDir(connectionId, dir)
  const adopted = []
  for (const name of list(dir)) {
    const match = CONNECTION_FOLDER.exec(name)
    if (!match || match[2] !== 'parked') continue
    const parked = path.join(dir, name)
    if (readPrivateJson(path.join(parked, MANIFEST))?.local_id !== localId) continue
    reclaimAbandoned(parked)
    for (const file of waitingFiles(parked)) {
      const taken = take(file)
      if (!taken) continue
      const item = readPrivateJson(taken.file)
      try {
        if (validItem(item) && writeWaiting(steps, item)) adopted.push(item.key)
      } catch {
        giveBack(taken)
        continue
      }
      drop(taken)
    }
    if (waitingFiles(parked).length === 0) {
      fs.rmSync(path.join(parked, MANIFEST), { force: true })
      try {
        fs.rmdirSync(parked)
      } catch {
        /* something else arrived meanwhile: a later start takes it */
      }
    }
  }
  return adopted
}

if (isDirectRun(import.meta.url)) {
  if (process.argv[2] === 'post-tool') {
    let input = null
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
    } catch {
      input = null
    }
    try {
      const output = await stepDeliveryHook(input)
      if (output) process.stdout.write(output)
    } catch {
      /* what waits stays where it is, for the next step or the idle wake */
    }
  }
  process.exit(0)
}
