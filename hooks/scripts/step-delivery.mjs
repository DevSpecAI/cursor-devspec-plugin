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
 * - Cursor holds a background command's output (the wake tail, devspec-wake-tail.mjs,
 *   whose lines notify the agent of new wakes) until the agent is idle, so the wake
 *   file cannot reach a working agent.
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
 *    already settled (`checkJobStillOpen`), and hands the rest over as one sealed note
 *    (hook-context-budget.mjs `writeNote`), with a pointer to it as the hook's context.
 *    Items that arrive while an earlier note is unread join it in a new note, so one
 *    read always has everything. The pointer comes back after every step until the
 *    agent is seen reading the note whole (`readThrough`), the one sign that it reached
 *    the model: Cursor gives none that hook context, or a background command's output,
 *    arrived. An item leaves this queue then, and only then.
 * 3. When Cursor is between turns again, the follow writes one short wake line
 *    (`held_for_step`) pointing at the same kind of note, holding everything still held
 *    and everything handed over but not read whole (`releaseAtIdle`), with settled check
 *    jobs dropped the same way. The items stay here until that note is read whole, and
 *    every step points at it meanwhile. A note the idle wake already pointed at, with
 *    nothing new, is not woken for again, so an agent that does not read it is not woken
 *    in a loop; anything new joins it, and the next idle wake points at the joined note.
 *    A stretch with no tool calls (the agent only thinking or writing) therefore still
 *    ends in the idle wake. Cursor does not run the plugin's `stop` hook for most
 *    people, so nothing here leans on it.
 * 4. When the connection ends (stopped at the terminal, ended in DevSpec, signed out,
 *    its Cursor gone), whatever ended it discards the connection's local copies and
 *    logs which notices and check jobs they were (`discardSteps`); one that could not
 *    (a process killed outright) is caught at the next poller start
 *    (`discardEndedSteps`). That loses nothing: this queue is only a delivery buffer.
 *    DevSpec keeps every notice and every check job: a notice belongs to the connection
 *    DevSpec addressed it to, and stays on the record and in the project's Review where
 *    the person sees it (semantics.notice_audience in
 *    devspec://product/remote-ingress-contract); a check job is DevSpec's to hand on
 *    once that connection ends (semantics.check_job.busy). So nothing is carried over to
 *    a later connection, and no later tool call pays for starting the hook.
 *
 * Each file (a held item, the handed-over record) is taken by renaming it to a name only
 * its taker knows, so the hook and the follow never both deliver one item, and the
 * cleanup never deletes an item a live process has taken; a taker that died (a hook past
 * Cursor's timeout) leaves its files to be put back (`reclaimAbandoned`).
 *
 * One lock per connection is taken by both writers, the step hook and the idle wake, and
 * by every write that marks the connection ended, with its cleanup (`endConnectionSteps`:
 * the poller's `disableLocalState` for every end it sees, remote-control-state.mjs's
 * `disableConnectionState` for a stop at the terminal; those are the only two writes of
 * `enabled: false`). A writer takes it after it has asked DevSpec about check jobs, and
 * holds it from its check that the connection is still live, through writing the note
 * and the record, until the hook's pointer has been written out or the wake appended. So
 * whichever comes second sees what the other did: a writer after the end writes nothing
 * and discards what it held; an end after a writer marks the connection ended once the
 * pointer or wake is out, and discards the record the writer wrote. A wake appended just
 * before an end is never printed: the wake reader skips a `held_for_step` line whose
 * connection has ended (`withoutEndedConnectionWakes`, devspec-wake-tail.mjs). The wait
 * takes the same lock to hand on, or keep, the rest of a delivery a one-shot run left
 * frozen in the connection's state (devspec-remote-wait.mjs), and hands it on only while
 * the connection is live; the reader skips a recall's own wake for an ended connection
 * the same way.
 *
 * What this cannot see: an end DevSpec has decided that the plugin has not heard yet (the
 * poller learns it on its next poll). Until then the connection is live here, and a
 * pointer or wake can still go out for it. What that leaves for a notice is DevSpec's to
 * own: semantics.notice_audience in devspec://product/remote-ingress-contract.
 *
 * How a check job is taken and ruled, and what a notice asks of the agent, are DevSpec's
 * rules: the note points at them by id and never restates them.
 */

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendWakeEvents, splitWakes, wakeLines } from './devspec-wake-file.mjs'
import {
  fitHookContext,
  fitsShellOutput,
  noteCommand,
  pointToNote,
  POST_TOOL_CONTEXT_SHARE,
  postToolUseOutput,
  readThrough,
  shellDiagnosticPointer,
  writeFallbackDiagnosticNote,
  writeNote,
} from './hook-context-budget.mjs'
import { isDirectRun } from './is-direct-run.mjs'
import { noticeReplyInstruction, recordTurnWake, turnWakeFromEvents } from './notice-reply.mjs'
import { readOwnConnectionState } from './own-connection.mjs'
import { readPrivateJson, readPrivateJsonResult, STATE_UNREADABLE, writePrivateJson } from './private-state.mjs'
import { firingConversation } from './project-context.mjs'
import { readLastTurnEnd, STABLE_READ_ATTEMPTS, STABLE_READ_GAP_MS } from './transcript-turn-end.mjs'
import { resolveAgentTranscriptPath } from './work-trail.mjs'
import { answerCursorAtExit } from './hook-answer.mjs'
import {
  clearWakeListenerNeeded,
  extractRoomCommandsFromWake,
  formatStructuredRefusalsFallback,
  isWakeListenerActive,
  startRoomCommands,
  structuredRefusalFromError,
  wakeListenerReminder,
  wakeNeededPath,
} from './command-start.mjs'
import { commandsHandedOver } from './turn-commands.mjs'

/** The inbox batches that reach a working agent at its next step: canonical room messages, check jobs, and notices. */
export const STEP_BATCH_TYPES = Object.freeze(['owner_messages', 'check_job_dispatches', 'canonical_system_notices'])

/** Where DevSpec says how a check job is taken and ruled. Pointed at, never restated. */
export const CHECK_JOB_RULES =
  'semantics.check_job.helpers and semantics.check_job.busy in devspec://product/remote-ingress-contract'

/** Where DevSpec says what a notice asks of the agent and whether and how to answer it. */
export const NOTICE_RULES =
  'semantics.notice_audience and semantics.notice_reply in devspec://product/remote-ingress-contract'

const RECORD_VERSION = 1
const HANDED = 'handed.json'
const STEPS_FOLDER = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.steps$/i
const WAITING = /^w-\d{15}-[0-9a-f]{12}\.json$/
const RETRY_OVERFLOW = /^retry-\d+-[0-9a-f]{8}\.json$/
const WAKE_NOTE = /^wake-note-([0-9a-f]{16})\.json$/
const TAKEN_WAKE_NOTE = /^wake-note-([0-9a-f]{16})\.json\.taken-(\d+)-[0-9a-f]{8}$/
const WAKE_INLINE_HOLD = 'wake-inline-hold.json'
const TAKEN = /^(.+\.json)\.taken-(\d+)-[0-9a-f]{8}$/
const unpersistedRetryOverflow = new Map()

/**
 * Record an active unstarted-inline-command cursor barrier for `wakePositionPath` so
 * completing a later `wake_in_note` via `stepDeliveryHook` can NEVER advance the wake
 * cursor past an earlier unstarted inline command on the same wake file (req 3ea2b201).
 */
export function setWakeInlineHold(connectionId, { wakePositionPath, holdOffset }, { dir = connectionsDirFor() } = {}) {
  if (!connectionId || typeof wakePositionPath !== 'string' || typeof holdOffset !== 'number') return false
  const steps = stepsDir(connectionId, dir)
  fs.mkdirSync(steps, { recursive: true, mode: 0o700 })
  const target = path.join(steps, WAKE_INLINE_HOLD)
  const current = readPrivateJson(target)
  const holds = current && typeof current.holds === 'object' && !Array.isArray(current.holds) ? { ...current.holds } : {}
  holds[wakePositionPath] = holdOffset
  writePrivateJson(target, { version: RECORD_VERSION, holds, at: new Date().toISOString() })
  return true
}

/** Clear the unstarted-inline-command cursor barrier once all inline commands are started. */
export function clearWakeInlineHold(connectionId, { wakePositionPath }, { dir = connectionsDirFor() } = {}) {
  if (!connectionId || typeof wakePositionPath !== 'string') return false
  const steps = stepsDir(connectionId, dir)
  const target = path.join(steps, WAKE_INLINE_HOLD)
  const current = readPrivateJson(target)
  if (!current || typeof current.holds !== 'object' || !(wakePositionPath in current.holds)) return false
  const holds = { ...current.holds }
  delete holds[wakePositionPath]
  if (Object.keys(holds).length === 0) {
    try { fs.rmSync(target, { force: true }) } catch { /* ignore */ }
  } else {
    writePrivateJson(target, { version: RECORD_VERSION, holds, at: new Date().toISOString() })
  }
  return true
}

function readWakeInlineHoldOffset(steps, wakePositionPath) {
  const data = readPrivateJson(path.join(steps, WAKE_INLINE_HOLD))
  const offset = data?.holds?.[wakePositionPath]
  return typeof offset === 'number' ? offset : null
}

/** Whether a deferred `wake_in_note` has already been read whole and picked up. */
export function isWakeNoteCompleted(connectionId, noteId, { dir = connectionsDirFor() } = {}) {
  if (!connectionId || !/^[0-9a-f]{16}$/.test(String(noteId ?? ''))) return false
  const entry = readPrivateJson(path.join(stepsDir(connectionId, dir), `wake-note-${noteId}.json`))
  return entry?.note === noteId && entry?.completed === true
}

/** Remove completed wake-note markers whose byte span has already been passed by `offset`. */
export function cleanupCompletedWakeNotesBefore(connectionId, { wakePositionPath, offset }, { dir = connectionsDirFor() } = {}) {
  if (!connectionId || typeof wakePositionPath !== 'string' || typeof offset !== 'number') return
  const steps = stepsDir(connectionId, dir)
  for (const file of pendingWakeNoteFiles(steps)) {
    const entry = readPrivateJson(file)
    if (
      entry?.completed === true &&
      entry.wake_position_path === wakePositionPath &&
      typeof entry.wake_through === 'number' &&
      entry.wake_through <= offset
    ) {
      try { fs.rmSync(file, { force: true }) } catch { /* ignore */ }
    }
  }
}

/**
 * Record a `wake_in_note` carrying canonical room command(s) as awaiting full agent read
 * before calling `report_pickup` or advancing the wake reader cursor (requirement 3ea2b201).
 * Stored inside `<connectionId>.steps/` so the existing `postToolUse` glob wakes
 * `stepDeliveryHook` automatically once the agent runs `cat ~/.devspec/notes/<noteId>.md`.
 */
export function registerPendingWakeNote(
  connectionId,
  {
    noteId,
    commands = [],
    messages = [],
    sessionId = null,
    wakeFile = null,
    wakePositionPath = null,
    wakePositionVersion = 1,
    wakeStart = null,
    wakeThrough = null,
  },
  { dir = connectionsDirFor() } = {},
) {
  if (!connectionId || !/^[0-9a-f]{16}$/.test(String(noteId ?? '')) || !Array.isArray(commands) || commands.length === 0) {
    return null
  }
  const steps = stepsDir(connectionId, dir)
  fs.mkdirSync(steps, { recursive: true, mode: 0o700 })
  const target = path.join(steps, `wake-note-${noteId}.json`)
  const existing = readPrivateJson(target)
  if (existing && existing.note === noteId) {
    const nextStart =
      typeof wakeStart === 'number'
        ? typeof existing.wake_start === 'number'
          ? Math.min(existing.wake_start, wakeStart)
          : wakeStart
        : existing.wake_start ?? null
    const nextThrough =
      typeof wakeThrough === 'number'
        ? Math.max(existing.wake_through ?? 0, wakeThrough)
        : existing.wake_through ?? null
    if (
      wakePositionPath &&
      (nextThrough !== existing.wake_through || nextStart !== existing.wake_start || existing.wake_position_path !== wakePositionPath)
    ) {
      writePrivateJson(target, {
        ...existing,
        wake_file: wakeFile ?? existing.wake_file ?? null,
        wake_position_path: wakePositionPath,
        wake_position_version: wakePositionVersion,
        wake_start: nextStart,
        wake_through: nextThrough,
      })
    }
    return target
  }
  writePrivateJson(target, {
    version: RECORD_VERSION,
    note: noteId,
    parts: [],
    commands,
    messages,
    session_id: sessionId,
    wake_file: wakeFile,
    wake_position_path: wakePositionPath,
    wake_position_version: wakePositionVersion,
    wake_start: typeof wakeStart === 'number' ? wakeStart : null,
    wake_through: typeof wakeThrough === 'number' ? wakeThrough : null,
    completed: false,
    at: new Date().toISOString(),
  })
  return target
}

/**
 * Advance each wake reader cursor ONLY up to the highest contiguous completed wake-note
 * offset that has no earlier incomplete wake-note before it (requirement 3ea2b201).
 * Out-of-order completed notes remain marked `completed: true` until every earlier note
 * on the same wake file is also read and picked up; once the cursor passes them, their
 * marker files are deleted.
 */
function advanceCompletedWakeNotePositions(steps) {
  const files = pendingWakeNoteFiles(steps)
  const takenFiles = takenWakeNoteFiles(steps)
  if (files.length === 0) return
  const byPosPath = new Map()
  let unknownIncompletePresent = false
  for (const file of files) {
    const entry = readPrivateJson(file)
    if (!entry || typeof entry.wake_position_path !== 'string') {
      unknownIncompletePresent = true
      continue
    }
    if (!byPosPath.has(entry.wake_position_path)) byPosPath.set(entry.wake_position_path, [])
    byPosPath.get(entry.wake_position_path).push({ file, entry, taken: false })
  }
  // Include in-flight wake-note markers currently renamed to `.taken-...` by a concurrent
  // hook awaiting pickup so a later note completing out of order can NEVER advance the wake
  // cursor past an earlier in-flight note (requirement 3ea2b201).
  const takenIncompleteMinByPos = new Map()
  for (const takenFile of takenFiles) {
    const entry = readPrivateJson(takenFile)
    if (!entry || typeof entry.wake_position_path !== 'string') {
      unknownIncompletePresent = true
      continue
    }
    const start = typeof entry.wake_start === 'number' ? entry.wake_start : 0
    const prevMin = takenIncompleteMinByPos.get(entry.wake_position_path)
    if (prevMin === undefined || start < prevMin) {
      takenIncompleteMinByPos.set(entry.wake_position_path, start)
    }
  }
  for (const [posPath, group] of byPosPath) {
    let minIncompleteStart = unknownIncompletePresent ? 0 : Number.POSITIVE_INFINITY
    const takenMin = takenIncompleteMinByPos.get(posPath)
    if (typeof takenMin === 'number' && takenMin < minIncompleteStart) {
      minIncompleteStart = takenMin
    }
    const inlineHoldOffset = readWakeInlineHoldOffset(steps, posPath)
    if (typeof inlineHoldOffset === 'number' && inlineHoldOffset < minIncompleteStart) {
      minIncompleteStart = inlineHoldOffset
    }
    for (const { entry } of group) {
      if (entry.completed !== true) {
        const start = typeof entry.wake_start === 'number' ? entry.wake_start : 0
        if (start < minIncompleteStart) minIncompleteStart = start
      }
    }
    const cur = readPrivateJson(posPath)
    const prevOffset = typeof cur?.offset === 'number' ? cur.offset : 0
    let nextOffset = prevOffset
    let wakeFile = cur?.file ?? null
    let posVersion = cur?.version ?? 1
    for (const { entry } of group) {
      if (entry.completed === true && typeof entry.wake_through === 'number' && entry.wake_through <= minIncompleteStart) {
        if (entry.wake_through > nextOffset) {
          nextOffset = entry.wake_through
          wakeFile = entry.wake_file ?? wakeFile
          posVersion = entry.wake_position_version ?? posVersion
        }
      }
    }
    let advancedOk = nextOffset === prevOffset
    if (nextOffset > prevOffset) {
      try {
        writePrivateJson(posPath, {
          version: posVersion,
          file: wakeFile,
          offset: nextOffset,
          at: new Date().toISOString(),
        })
        advancedOk = true
      } catch {
        advancedOk = false
      }
    }
    if (advancedOk) {
      for (const { file, entry } of group) {
        if (entry.completed === true && typeof entry.wake_through === 'number' && entry.wake_through <= nextOffset) {
          try {
            fs.rmSync(file, { force: true })
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}

function pendingWakeNoteFiles(steps) {
  try {
    return fs
      .readdirSync(steps)
      .filter((name) => WAKE_NOTE.test(name))
      .sort()
      .map((name) => path.join(steps, name))
  } catch {
    return []
  }
}

function takenWakeNoteFiles(steps) {
  try {
    return fs
      .readdirSync(steps)
      .filter((name) => TAKEN_WAKE_NOTE.test(name))
      .sort()
      .map((name) => path.join(steps, name))
  } catch {
    return []
  }
}

/**
 * One check job's lookup on DevSpec: the budget the plugin's other postToolUse hook that
 * waits on DevSpec already keeps (commit-reports.mjs: 5 seconds a request, 15 seconds
 * for the hook in hooks.json). The lookups for every job run at once, so this hook keeps
 * the same 15 seconds in hooks.json.
 */
const CHECK_JOB_LOOKUP_MS = 5_000

export function isStepBatch(batch) {
  if (!batch || typeof batch !== 'object') return false
  if (batch.type === 'owner_messages') return batch?.ingress?.canonical === true
  return STEP_BATCH_TYPES.includes(batch.type)
}

export function connectionsDirFor(home = os.homedir(), env = process.env) {
  const override = typeof env?.DEVSPEC_REMOTE_CONNECTIONS_DIR === 'string' ? env.DEVSPEC_REMOTE_CONNECTIONS_DIR.trim() : ''
  return override || path.join(home, '.devspec', 'remote-control', 'connections')
}

/** The folder holding what waits for one connection's next step. */
export function stepsDir(connectionId, dir) {
  return path.join(dir, `${connectionId}.steps`)
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

/**
 * `cursorTurnState`, read again when a read catches Cursor mid-write, as often and as
 * far apart as transcript-turn-end.mjs reads it (`STABLE_READ_ATTEMPTS`, `STABLE_READ_GAP_MS`).
 */
export async function readTurnState(conversationId, { home = os.homedir() } = {}) {
  let state = 'unknown'
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    state = cursorTurnState(conversationId, { home })
    if (state !== 'unknown') return state
    await new Promise((resolve) => setTimeout(resolve, STABLE_READ_GAP_MS))
  }
  return state
}

/** One held batch: the wake events the follow built for it, and what it is. */
export function stepItem(batch, events, { now = Date.now() } = {}) {
  const list = Array.isArray(events) ? events : []
  if (batch?.type === 'owner_messages') {
    const messages = Array.isArray(batch.messages) ? batch.messages : []
    const commands = commandsHandedOver(messages)
    return {
      version: RECORD_VERSION,
      key:
        batch.acceptance_key ??
        `owner_messages:${commands.map((c) => c.messageId).join(',') || list.length}`,
      kind: 'owner_messages',
      session_id: batch.session_id ?? null,
      commands,
      messages,
      held_at: new Date(now).toISOString(),
      events: list,
    }
  }
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
    (item.kind === 'owner_messages' || item.kind === 'check_job' || item.kind === 'notices') &&
    Array.isArray(item.events)
}

function validRecord(record) {
  return record?.version === RECORD_VERSION && typeof record.note === 'string' &&
    Array.isArray(record.items) && record.items.every(validItem)
}

function hasUnreadNote(record) {
  if (!record) return false
  if (record.note_read === true) return false
  if (record.note_read === false) return true
  return record.pickup_pending !== true && record.inner_note_pending !== true
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

/**
 * How long a process waiting for a connection's steps lock sleeps between looks. The
 * holder keeps it only for local file work (writing a note, a record and one wake line,
 * or printing a hook's pointer), and the plugin's state writes retry the same way
 * (private-state.mjs retries a rename every 20 ms).
 */
const LOCK_RETRY_MS = 20

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lockPath(connectionId, dir) {
  return path.join(dir, `${connectionId}.steps.lock`)
}

/**
 * Take the connection's steps lock, waiting while a live process holds it, and return
 * the function that releases it. The lock is a file holding the taker's process id,
 * made by hard-linking a file already written, so it never exists half-written; one
 * whose holder has gone is cleared. It sits beside the steps folder, not in it, so the
 * hook's guard (hooks.json) never sees it.
 */
function acquireStepsLock(connectionId, dir) {
  const target = lockPath(connectionId, dir)
  const mine = `${target}.${process.pid}-${randomBytes(4).toString('hex')}`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 })
  try {
    for (;;) {
      try {
        fs.linkSync(mine, target)
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      let holder = null
      try {
        holder = Number(fs.readFileSync(target, 'utf8'))
      } catch {
        continue // released just now
      }
      if (Number.isSafeInteger(holder) && holder > 0 && !pidAlive(holder)) {
        fs.rmSync(target, { force: true })
        continue
      }
      sleepSync(LOCK_RETRY_MS)
    }
  } finally {
    fs.rmSync(mine, { force: true })
  }
  return () => fs.rmSync(target, { force: true })
}

/** Run `work` (synchronous) holding the connection's steps lock; returns what it returns. */
export function withStepsLock(connectionId, dir, work) {
  const release = acquireStepsLock(connectionId, dir)
  try {
    return work()
  } finally {
    release()
  }
}

/** The same, for `work` that must finish something asynchronous (a flushed write) before the lock goes. */
export async function withStepsLockAsync(connectionId, dir, work) {
  const release = acquireStepsLock(connectionId, dir)
  try {
    return await work()
  } finally {
    release()
  }
}

/**
 * Mark the connection ended (`markEnded`, the caller's own write of its state file)
 * holding its steps lock, then discard what it held, still holding it. Every write that
 * ends a connection goes through here, so a writer holding the lock finishes what it
 * hands over while the connection is live, or sees it ended and hands nothing over:
 * never a pointer or wake after the end. Returns the ids discarded, as `discardSteps`.
 */
export function endConnectionSteps(connectionId, { dir, markEnded }) {
  return withStepsLock(connectionId, dir, () => {
    markEnded()
    return discardLocked(connectionId, dir)
  })
}

/** Put back what a process that has gone took and never finished with. */
export function reclaimAbandoned(steps) {
  for (const name of list(steps)) {
    const match = TAKEN.exec(name)
    if (!match || pidAlive(Number(match[2]))) continue
    const takenPath = path.join(steps, name)
    const originalPath = path.join(steps, match[1])
    if (match[1] === HANDED && fs.existsSync(originalPath)) {
      try {
        fs.renameSync(takenPath, path.join(steps, `retry-${Date.now()}-${randomBytes(4).toString('hex')}.json`))
        continue
      } catch {
        /* leave in place for next reclaim */
        continue
      }
    }
    giveBack({ file: takenPath, original: originalPath })
  }
}

function waitingFiles(steps) {
  return list(steps).filter((name) => WAITING.test(name)).sort().map((name) => path.join(steps, name))
}

function retryOverflowFiles(steps) {
  return list(steps).filter((name) => RETRY_OVERFLOW.test(name)).sort().map((name) => path.join(steps, name))
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
  const roomMessages = items.reduce(
    (sum, item) =>
      sum + (item.kind === 'owner_messages' ? item.events.filter((e) => e?.type === 'owner_message').length || 1 : 0),
    0,
  )
  const checks = items.filter((item) => item.kind === 'check_job').length
  const notices = items.reduce((sum, item) => sum + (item.kind === 'notices' ? item.events.filter((e) => e?.type === 'system_notice').length : 0), 0)
  return [
    roomMessages ? plural(roomMessages, 'room message', 'room messages') : null,
    checks ? plural(checks, 'check job', 'check jobs') : null,
    notices ? plural(notices, 'notice', 'notices') : null,
  ]
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
  if (items.some((item) => item.kind === 'owner_messages')) {
    lines.push(
      '',
      'Answer each canonical room message (type: owner_message) before ending your turn via post_session_message({ connection_id, message, complete_turn: true }) (when attached). Preserve its authority, project_scope, and sender_response_style.',
    )
  }
  if (items.some((item) => item.kind === 'check_job')) {
    lines.push('', `How a check job is taken and ruled is DevSpec's rule: ${CHECK_JOB_RULES} (claim_check_job repeats the first as \`helpers\`).`)
  }
  const notices = items.flatMap((item) => (item.kind === 'notices' ? item.events.filter((event) => event?.type === 'system_notice') : []))
  if (notices.length > 0) {
    lines.push('', `What a notice asks of you, and whether and how you answer it, is DevSpec's rule too: ${NOTICE_RULES}.`)
  }
  for (const item of items) {
    if (item.kind === 'owner_messages') {
      const msgIds = item.events
        .filter((event) => event?.type === 'owner_message')
        .map((event) => event.message?.message_id)
        .filter(Boolean)
      lines.push('', `## Room message${msgIds.length > 1 ? 's' : ''}${msgIds.length ? ` (${msgIds.join(', ')})` : ''}`)
      for (const event of item.events) {
        lines.push(JSON.stringify(event))
      }
      continue
    }
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
 * The idle wake's one line: a pointer to the note that holds everything waiting, the
 * same kind of note the steps hand over. `holds` names the wake types inside, which are
 * what the wake tail's notification watches for (devspec-wake-file.mjs
 * `REMOTE_WAKE_NOTIFY_PATTERN`), so Cursor wakes the agent for it.
 */
function idlePointer(note, items, connectionId) {
  return {
    type: 'held_for_step',
    holds: [
      ...new Set(
        items.map((item) =>
          item.kind === 'owner_messages'
            ? 'owner_message'
            : item.kind === 'check_job'
              ? 'check_job'
              : 'system_notice',
        ),
      ),
    ],
    connection_id: connectionId,
    note: note.id,
    read_with: note.command,
    instruction:
      `${stepWhat(items)} is waiting for you whole in a file. Read it now: \`${note.command}\`, and every further part ` +
      'it names, then deal with all of it as it says. Until you have read it whole it comes back after each step.',
  }
}

/**
 * The postToolUse hook: the pointer to everything DevSpec sent the agent while it was
 * working, or null when nothing waits. Only the conversation the connection was made in
 * gets it, never a helper agent's tool call. Returns the hook's stdout.
 */
export async function stepDeliveryHook(
  input,
  {
    env = process.env,
    home = os.homedir(),
    dir = null,
    isOpen = itemStillOpen,
    share = POST_TOOL_CONTEXT_SHARE,
    emit = () => {},
    startCommands = startRoomCommands,
    listenerActive = isWakeListenerActive,
  } = {},
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
  const neededFile = wakeNeededPath(connectionId, connDir)
  const hasSteps = fs.existsSync(steps)
  const hasWakeNeeded = fs.existsSync(neededFile)
  if (!hasSteps && !hasWakeNeeded) return null

  const toolCmd = String(input?.tool_input?.command ?? '')
  const startingListener =
    toolCmd.includes('devspec-wake-tail.mjs') && !/\bdevspec-wake-tail\.mjs\b[^;\n]*\bread\b/.test(toolCmd)
  let needsListenerReminder = false
  if (hasWakeNeeded) {
    if (listenerActive(connectionId, { dir: connDir })) {
      clearWakeListenerNeeded(connectionId, connDir)
    } else if (!startingListener) {
      needsListenerReminder = true
    }
  }

  if (!hasSteps) {
    if (!needsListenerReminder) return null
    const reminder = fitHookContext(wakeListenerReminder(connectionId, { dir: connDir }), {
      share,
      what: 'A DevSpec wake-listener setup notice',
      home,
    })
    if (!reminder) return null
    const output = JSON.stringify(postToolUseOutput(reminder))
    await emit(output)
    return output
  }
  reclaimAbandoned(steps)

  // What came back of the note already handed over, in this tool call.
  const takenRecord = take(path.join(steps, HANDED))
  let record = null
  let readChanged = false
  const partitionOwnerItems = (items) => {
    const immediateOwnerItems = []
    const unreadableItems = []
    const unreadableRefusals = []
    for (const item of items) {
      if (item.kind !== 'owner_messages') continue
      const hasInnerWakeNote =
        Array.isArray(item.events) &&
        item.events.some(
          (event) =>
            event?.type === 'wake_in_note' &&
            Array.isArray(event.carries) &&
            event.carries.includes('owner_message'),
        )
      if (!hasInnerWakeNote) {
        immediateOwnerItems.push(item)
        continue
      }
      // The outer step note contained a `wake_in_note` pointer for an oversized
      // room command whose body lives in an inner note. Do NOT trigger report_pickup
      // or drop pending tracking yet: register each inner note via registerPendingWakeNote
      // so pickup runs ONLY once the agent finishes reading the inner note whole (3ea2b201).
      const extracted = extractRoomCommandsFromWake(wakeLines(item.events), { home })
      for (const deferred of extracted.deferredNoteCommands) {
        registerPendingWakeNote(
          connectionId,
          {
            noteId: deferred.noteId,
            commands: deferred.commands,
            messages: deferred.messages,
            sessionId: deferred.sessionId ?? item.session_id ?? null,
          },
          { dir: connDir },
        )
      }
      if (extracted.unreadableNotes.length > 0) {
        const innerOnlyEvents = item.events.filter(
          (event) =>
            event?.type === 'wake_in_note' &&
            Array.isArray(event.carries) &&
            event.carries.includes('owner_message'),
        )
        unreadableItems.push({
          ...item,
          events: innerOnlyEvents,
          commands: [],
          messages: [],
        })
        for (const unreadable of extracted.unreadableNotes) {
          unreadableRefusals.push({
            command_message_id: null,
            command_turn_id: null,
            refusal: unreadable,
          })
        }
      }
      if (extracted.inlineCommands.length > 0) {
        immediateOwnerItems.push({
          ...item,
          commands: extracted.inlineCommands,
          messages: extracted.inlineMessages,
        })
      }
    }
    return { immediateOwnerItems, unreadableItems, unreadableRefusals }
  }

  let completedOwnerItems = []
  let keptForPickupRetry = null
  let unreadableInnerNoteRefusals = []
  let unreadableInnerNoteItems = []
  let unreadNoteRecord = null
  if (takenRecord) {
    const kept = readPrivateJson(takenRecord.file)
    if (validRecord(kept)) {
      const hadPendingInner = kept.inner_note_pending === true
      const hadPendingPickup = kept.pickup_pending === true
      if (hadPendingInner) {
        const innerSource = Array.isArray(kept.inner_note_items) ? kept.inner_note_items : kept.items
        const { immediateOwnerItems, unreadableItems, unreadableRefusals } = partitionOwnerItems(innerSource)
        unreadableInnerNoteRefusals.push(...unreadableRefusals)
        unreadableInnerNoteItems.push(...unreadableItems)
        if (immediateOwnerItems.length > 0) {
          completedOwnerItems.push(...immediateOwnerItems)
        }
        readChanged = true
      }
      if (hadPendingPickup) {
        const pickupSource = Array.isArray(kept.pickup_items)
          ? kept.pickup_items
          : kept.items.filter((item) => item.kind === 'owner_messages')
        completedOwnerItems.push(...pickupSource)
        readChanged = true
      }
      if (hasUnreadNote(kept)) {
        const { record: next, done } = readThrough(kept, input, { home })
        if (done) {
          readChanged = true
          const { immediateOwnerItems, unreadableItems, unreadableRefusals } = partitionOwnerItems(kept.items)
          completedOwnerItems.push(...immediateOwnerItems)
          unreadableInnerNoteRefusals.push(...unreadableRefusals)
          unreadableInnerNoteItems.push(...unreadableItems)
        } else {
          if (next.parts.length !== (kept.parts?.length ?? 0)) readChanged = true
          unreadNoteRecord = {
            version: kept.version,
            note: kept.note,
            parts: next.parts,
            items: kept.items,
            at: kept.at,
            note_read: false,
          }
        }
      }
      keptForPickupRetry = { ...kept, note_read: !unreadNoteRecord }
      if (unreadNoteRecord) {
        record = {
          ...unreadNoteRecord,
          ...(unreadableInnerNoteItems.length > 0
            ? {
                inner_note_pending: true,
                inner_note_items: unreadableInnerNoteItems,
                pickup_refusals: unreadableInnerNoteRefusals,
              }
            : {}),
        }
      } else if (unreadableInnerNoteItems.length > 0) {
        record = {
          ...kept,
          note_read: true,
          items: unreadableInnerNoteItems,
          inner_note_pending: true,
          inner_note_items: unreadableInnerNoteItems,
          pickup_pending: false,
          pickup_items: [],
          pickup_refusals: unreadableInnerNoteRefusals,
        }
      } else {
        record = null
      }
    } else {
      giveBack(takenRecord)
      return null
    }
  }

  // Also drain any retry overflow preserved when a parallel hook wrote a fresh HANDED
  // right before a transient write failure on an earlier hook, or when reclaimAbandoned
  // moved a dead hook's taken HANDED record alongside a newer HANDED (requirement 3ea2b201).
  const takenOverflows = retryOverflowFiles(steps).map(take).filter(Boolean)
  const memoryOverflows = unpersistedRetryOverflow.get(steps) ?? []
  if (memoryOverflows.length > 0) unpersistedRetryOverflow.delete(steps)
  const reclaimedUnreadItems = []
  const consumeOverflowEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return
    const innerList = Array.isArray(entry.inner_note_items) ? entry.inner_note_items : []
    if (innerList.length > 0) {
      const { immediateOwnerItems, unreadableItems, unreadableRefusals } = partitionOwnerItems(innerList)
      unreadableInnerNoteRefusals.push(...unreadableRefusals)
      unreadableInnerNoteItems.push(...unreadableItems)
      if (immediateOwnerItems.length > 0) completedOwnerItems.push(...immediateOwnerItems)
      readChanged = true
    }
    const pickupList = Array.isArray(entry.pickup_items)
      ? entry.pickup_items
      : validRecord(entry) && entry.pickup_pending === true
        ? entry.items.filter((i) => i.kind === 'owner_messages')
        : []
    if (pickupList.length > 0) {
      completedOwnerItems.push(...pickupList)
      readChanged = true
    }
    if (Array.isArray(entry.unread_items) && entry.unread_items.length > 0) {
      reclaimedUnreadItems.push(...entry.unread_items)
      readChanged = true
    } else if (validRecord(entry) && hasUnreadNote(entry)) {
      // An abandoned unread note MUST NEVER be passed to startCommands on an unrelated
      // tool step: only if THIS tool call actually finished reading that exact note whole
      // may its items proceed to pickup; otherwise re-offer them in the unread note
      // (requirement 3ea2b201).
      const { done } = readThrough(entry, input, { home })
      if (done) {
        const { immediateOwnerItems, unreadableItems, unreadableRefusals } = partitionOwnerItems(entry.items)
        completedOwnerItems.push(...immediateOwnerItems)
        unreadableInnerNoteRefusals.push(...unreadableRefusals)
        unreadableInnerNoteItems.push(...unreadableItems)
        if (!keptForPickupRetry && (immediateOwnerItems.length > 0 || unreadableItems.length > 0)) {
          keptForPickupRetry = { ...entry, note_read: true }
        }
      } else {
        reclaimedUnreadItems.push(...entry.items)
      }
      readChanged = true
    }
    if (!keptForPickupRetry && (innerList.length > 0 || pickupList.length > 0)) {
      keptForPickupRetry = {
        version: RECORD_VERSION,
        note: typeof entry.note === 'string' ? entry.note : '0'.repeat(16),
        parts: [],
        items: [...innerList, ...pickupList],
        at: new Date().toISOString(),
        note_read: true,
      }
    }
  }
  const consumedOverflows = []
  for (const ov of takenOverflows) {
    const parsed = readPrivateJson(ov.file)
    if (!parsed || typeof parsed !== 'object') {
      giveBack(ov)
      process.stderr.write(
        `step-delivery: retry overflow file ${path.basename(ov.original)} could not be read; leaving queued for next retry\n`,
      )
      continue
    }
    consumedOverflows.push(ov)
    consumeOverflowEntry(parsed)
  }
  for (const ov of memoryOverflows) {
    consumeOverflowEntry(ov)
  }
  if (unreadableInnerNoteItems.length > 0) {
    if (record && hasUnreadNote(record)) {
      record = {
        ...record,
        inner_note_pending: true,
        inner_note_items: unreadableInnerNoteItems,
        pickup_refusals: unreadableInnerNoteRefusals,
      }
    } else {
      const base = record ?? keptForPickupRetry ?? {
        version: RECORD_VERSION,
        note: '0'.repeat(16),
        parts: [],
        at: new Date().toISOString(),
      }
      record = {
        ...base,
        note_read: true,
        items: unreadableInnerNoteItems,
        inner_note_pending: true,
        inner_note_items: unreadableInnerNoteItems,
        pickup_pending: false,
        pickup_items: [],
        pickup_refusals: unreadableInnerNoteRefusals,
      }
    }
    readChanged = true
  }

  // Also track any oversized `wake_in_note` command pointers handed over via wake-tail
  // or one-shot wait: trigger `report_pickup` and advance the wake reader offset ONLY once
  // the agent has actually read the sealed note whole (`readThrough`, req 3ea2b201).
  const takenWakeNotes = pendingWakeNoteFiles(steps).map(take).filter(Boolean)
  const completedWakeNotes = []
  for (const each of takenWakeNotes) {
    const entry = readPrivateJson(each.file)
    if (!entry || typeof entry.note !== 'string' || !Array.isArray(entry.commands)) {
      drop(each)
      continue
    }
    if (entry.completed === true) {
      // Already picked up; waiting only for an earlier wake-note on the same page before cursor advance.
      giveBack(each)
      continue
    }
    if (entry.pickup_pending === true) {
      completedWakeNotes.push({ taken: each, entry })
      continue
    }
    const { record: next, done } = readThrough({ note: entry.note, parts: Array.isArray(entry.parts) ? entry.parts : [] }, input, { home })
    if (done) {
      completedWakeNotes.push({ taken: each, entry: { ...entry, parts: next.parts } })
    } else if (next.parts.length !== (entry.parts?.length ?? 0)) {
      try {
        writePrivateJson(each.original, { ...entry, parts: next.parts })
        drop(each)
      } catch {
        giveBack(each)
      }
    } else {
      giveBack(each)
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

  // The agent just finished reading a step note or wake_in_note holding room message(s) (or a previous
  // pickup refused and is retrying): combine all owner items into ONE single startCommands
  // call (no per-item loop, req c900f599). If report_pickup refuses, keep the record as
  // `pickup_pending` so the next step retries instead of dropping it (req 3ea2b201) and
  // preserve/surface the full structured refusal details (req 4e32d1a5).
  let pickupRefusals = unreadableInnerNoteRefusals.length > 0 ? unreadableInnerNoteRefusals : null
  let loggedRefusalsToStderr = false
  if (completedOwnerItems.length > 0 || completedWakeNotes.length > 0) {
    const combinedMessages = [
      ...completedOwnerItems.flatMap((item) =>
        Array.isArray(item.messages) && item.messages.length > 0
          ? item.messages
          : item.events.filter((e) => e?.type === 'owner_message' && e.message).map((e) => e.message),
      ),
      ...completedWakeNotes.flatMap(({ entry }) => (Array.isArray(entry.messages) ? entry.messages : [])),
    ]
    const combinedCommands = [
      ...completedOwnerItems.flatMap((item) =>
        Array.isArray(item.commands) && item.commands.length > 0
          ? item.commands
          : commandsHandedOver(
              Array.isArray(item.messages) && item.messages.length > 0
                ? item.messages
                : item.events.filter((e) => e?.type === 'owner_message' && e.message).map((e) => e.message),
            ),
      ),
      ...completedWakeNotes.flatMap(({ entry }) => (Array.isArray(entry.commands) ? entry.commands : [])),
    ]
    const firstSessionId =
      completedOwnerItems.find((item) => typeof item.session_id === 'string' && item.session_id)?.session_id ??
      completedWakeNotes.find(({ entry }) => typeof entry.session_id === 'string' && entry.session_id)?.entry.session_id ??
      state.session_id ??
      null
    if (combinedCommands.length > 0) {
      let pickupResult = null
      try {
        pickupResult = await startCommands({
          connectionId,
          commands: combinedCommands,
          batch: { type: 'owner_messages', session_id: firstSessionId, messages: combinedMessages },
          sessionId: firstSessionId,
          dir: connDir,
          home,
          state,
        })
      } catch (error) {
        pickupResult = {
          ok: false,
          outcome: 'refused',
          refusals: [structuredRefusalFromError(error)],
        }
      }
      if (Array.isArray(pickupResult?.refusals) && pickupResult.refusals.length > 0) {
        pickupRefusals = [...unreadableInnerNoteRefusals, ...pickupResult.refusals]
        process.stderr.write(
          `step-delivery: report_pickup refused for ${connectionId}; retaining pending pickup for retry: ${JSON.stringify(pickupRefusals)}\n`,
        )
        loggedRefusalsToStderr = true
        if (completedOwnerItems.length > 0 && keptForPickupRetry) {
          const base = record ?? keptForPickupRetry
          const keepUnread = hasUnreadNote(base)
          record = {
            ...base,
            note_read: !keepUnread,
            items: keepUnread ? base.items : [...unreadableInnerNoteItems, ...completedOwnerItems],
            inner_note_pending: unreadableInnerNoteItems.length > 0,
            inner_note_items: unreadableInnerNoteItems,
            pickup_pending: true,
            pickup_items: completedOwnerItems,
            pickup_refusals: pickupRefusals,
          }
          readChanged = true
        }
        for (const { taken: noteTaken, entry } of completedWakeNotes) {
          try {
            writePrivateJson(noteTaken.original, {
              ...entry,
              pickup_pending: true,
              pickup_refusals: pickupRefusals,
            })
            drop(noteTaken)
          } catch {
            giveBack(noteTaken)
          }
        }
      } else {
        if (Array.isArray(pickupResult?.nothingOpen) && pickupResult.nothingOpen.length > 0) {
          process.stderr.write(
            `step-delivery: report_pickup returned nothing_open for ${connectionId}: ${JSON.stringify(pickupResult.nothingOpen)}\n`,
          )
        }
        const unstartedIds = new Set(
          (Array.isArray(pickupResult?.unstarted) ? pickupResult.unstarted : [])
            .map((cmd) => cmd?.messageId)
            .filter(Boolean),
        )
        if (unstartedIds.size > 0 && completedOwnerItems.length > 0 && keptForPickupRetry) {
          const remainingOwnerItems = completedOwnerItems.filter((item) => {
            const cmds =
              Array.isArray(item.commands) && item.commands.length > 0
                ? item.commands
                : commandsHandedOver(
                    Array.isArray(item.messages) && item.messages.length > 0
                      ? item.messages
                      : item.events.filter((e) => e?.type === 'owner_message' && e.message).map((e) => e.message),
                  )
            return cmds.some((cmd) => unstartedIds.has(cmd?.messageId))
          })
          if (remainingOwnerItems.length > 0) {
            const base = record ?? keptForPickupRetry
            const keepUnread = hasUnreadNote(base)
            record = {
              ...base,
              note_read: !keepUnread,
              items: keepUnread ? base.items : [...unreadableInnerNoteItems, ...remainingOwnerItems],
              inner_note_pending: unreadableInnerNoteItems.length > 0,
              inner_note_items: unreadableInnerNoteItems,
              pickup_pending: true,
              pickup_items: remainingOwnerItems,
              ...(pickupRefusals ? { pickup_refusals: pickupRefusals } : {}),
            }
            readChanged = true
          }
        }
        let hasPositionTrackedCompleted = false
        for (const { taken: noteTaken, entry } of completedWakeNotes) {
          const noteHasUnstarted =
            unstartedIds.size > 0 &&
            Array.isArray(entry.commands) &&
            entry.commands.some((cmd) => unstartedIds.has(cmd?.messageId))
          if (noteHasUnstarted) {
            try {
              writePrivateJson(noteTaken.original, {
                ...entry,
                pickup_pending: true,
              })
              drop(noteTaken)
            } catch {
              giveBack(noteTaken)
            }
          } else if (typeof entry.wake_position_path === 'string' && typeof entry.wake_through === 'number') {
            hasPositionTrackedCompleted = true
            try {
              writePrivateJson(noteTaken.original, {
                ...entry,
                completed: true,
                pickup_pending: false,
                pickup_refusals: null,
              })
              drop(noteTaken)
            } catch {
              giveBack(noteTaken)
            }
          } else {
            drop(noteTaken)
          }
        }
        if (hasPositionTrackedCompleted) {
          withStepsLock(connectionId, connDir, () => advanceCompletedWakeNotePositions(steps))
        }
      }
    } else {
      for (const { taken: noteTaken } of completedWakeNotes) drop(noteTaken)
    }
  }
  if (Array.isArray(pickupRefusals) && pickupRefusals.length > 0 && !loggedRefusalsToStderr) {
    process.stderr.write(
      `step-delivery: room-command note/pickup refusals for ${connectionId}; retaining pending retry: ${JSON.stringify(pickupRefusals)}\n`,
    )
    loggedRefusalsToStderr = true
  }

  // From the check that the connection is still live until the pointer has been written
  // out, under the connection's steps lock, which every write that ends the connection
  // takes too (`endConnectionSteps`). The hold is a note, a record and one short line.
  return withStepsLockAsync(connectionId, connDir, async () => {
    // The connection ended while this hook held its items, so the end left them to it:
    // nothing is handed over for a connection that has ended. Everything goes back, and
    // is discarded as the end would have done.
    if (readOwnConnectionState(firingConversation(input), { home })?.connection_id !== connectionId) {
      for (const each of checked) {
        if (each.open) giveBack(each.taken)
        else drop(each.taken)
      }
      // A note read whole in this very call was delivered: not given back to be discarded.
      if (takenRecord && record) giveBack(takenRecord)
      else if (takenRecord) drop(takenRecord)
      logDiscarded('stepDeliveryHook', connectionId, discardLocked(connectionId, connDir))
      return null
    }
    const formatPickupRefusals = (existingContext, priorNoteError = null) => {
      if (!pickupRefusals) return existingContext
      const refusalNotice =
        `DevSpec report_pickup was refused and will be retried on the next step; structured refusal details: ${JSON.stringify(pickupRefusals)}`
      const buildFallback = (budget, noteError) => {
        const fallbackBaseDirs = [
          null,
          ...(connDir ? [path.join(connDir, 'diagnostic-notes')] : []),
          path.join(steps, 'diagnostic-notes'),
        ]
        let savedFallback = null
        for (const baseDir of fallbackBaseDirs) {
          try {
            savedFallback = writeFallbackDiagnosticNote(refusalNotice, { baseDir })
            if (savedFallback) break
          } catch {
            savedFallback = null
          }
        }
        if (!savedFallback && !loggedRefusalsToStderr && Array.isArray(pickupRefusals) && pickupRefusals.length > 0) {
          process.stderr.write(
            `step-delivery: room-command note/pickup refusals for ${connectionId}; retaining pending retry: ${JSON.stringify(pickupRefusals)}\n`,
          )
          loggedRefusalsToStderr = true
        }
        const formatted = formatStructuredRefusalsFallback(pickupRefusals, {
          prefix: 'DevSpec report_pickup refused (note write failed; will retry next step): ',
          maxChars: budget,
          noteError,
          savedNote: savedFallback,
          recovery:
            'All diagnostic note stores (~/.devspec/notes, TMPDIR, connections, steps) were unwritable; unabridged refusal JSON was written to hook stderr. Inspect hook stderr for complete text and fix write permissions on ~/.devspec/notes.',
        })
        if (formatted) return formatted.trimEnd()
        if (savedFallback) {
          const ptr = shellDiagnosticPointer('step-delivery', savedFallback.command).trimEnd()
          if (ptr.length <= budget) return ptr
        }
        // When ALL note stores rejected writes AND the refusal payload exceeds `budget`,
        // NEVER drop the entire agent-facing diagnostic silently: emit an explicit,
        // budget-fitted omission + recovery notice stating the limit, actual size,
        // omitted count, and where the unabridged JSON was written (requirements 3c5147a7 / 91d7b47c).
        const omittedKeys = [
          ...new Set(
            pickupRefusals.flatMap((entry) => {
              const inner = entry?.refusal && typeof entry.refusal === 'object' ? entry.refusal : entry
              return inner && typeof inner === 'object' ? Object.keys(inner) : []
            }),
          ),
        ]
        const codes = pickupRefusals
          .map((entry) => entry?.refusal?.code ?? entry?.code ?? null)
          .filter((code) => typeof code === 'string' && code)
        const readRefs = pickupRefusals
          .map((entry) => entry?.refusal?.read ?? entry?.read ?? null)
          .filter((ref) => typeof ref === 'string' && ref)
        const why = noteError instanceof Error ? noteError.message : String(noteError ?? 'all diagnostic note stores unwritable')
        const omissionCandidates = [
          JSON.stringify({
            refused: 'report_pickup',
            note_write_failed: true,
            note_write_error: why,
            omitted_due_to_hook_limit: true,
            total_count: pickupRefusals.length,
            returned_count: 0,
            omitted_count: pickupRefusals.length,
            limit_chars: budget,
            actual_chars: refusalNotice.length,
            ...(codes.length > 0 ? { codes } : {}),
            ...(readRefs.length > 0 ? { read_refs: readRefs } : {}),
            ...(omittedKeys.length > 0 ? { omitted_keys: omittedKeys } : {}),
            recovery:
              'All diagnostic note stores (~/.devspec/notes, TMPDIR, connections, steps) were unwritable so oversized refusal details could not be saved; unabridged JSON was written to hook stderr. Fix write permissions on ~/.devspec/notes.',
          }),
          JSON.stringify({
            refused: 'report_pickup',
            note_write_failed: true,
            omitted_due_to_hook_limit: true,
            omitted_count: pickupRefusals.length,
            limit_chars: budget,
            actual_chars: refusalNotice.length,
            ...(codes.length > 0 ? { codes } : {}),
            recovery: 'Unabridged refusal JSON is in hook stderr; fix ~/.devspec/notes or TMPDIR permissions.',
          }),
          `DevSpec report_pickup refused (${pickupRefusals.length} omitted: ${refusalNotice.length}>${budget} chars, note stores unwritable); unabridged JSON in hook stderr; fix ~/.devspec/notes permissions.`,
        ]
        for (const candidate of omissionCandidates) {
          if (candidate.length <= budget) return candidate
        }
        return null
      }
      if (!existingContext) {
        if (priorNoteError) {
          return buildFallback(share, priorNoteError)
        }
        try {
          return fitHookContext(refusalNotice, {
            share,
            what: 'DevSpec room-command pickup refusal details',
            home,
          })
        } catch (noteError) {
          return buildFallback(share, noteError)
        }
      }
      const remainingShare = share - existingContext.length - 2
      let fittedInlineOrPointer = null
      let inlineNoteError = priorNoteError
      if (remainingShare > 0 && !priorNoteError) {
        try {
          fittedInlineOrPointer = fitHookContext(refusalNotice, {
            share: remainingShare,
            what: 'DevSpec room-command pickup refusal details',
            home,
          })
        } catch (noteError) {
          inlineNoteError = noteError
        }
      }
      if (fittedInlineOrPointer && existingContext.length + 2 + fittedInlineOrPointer.length <= share) {
        return `${existingContext}\n\n${fittedInlineOrPointer}`
      }
      // Never drop the structured pickup refusal when a concurrent delivery note
      // fills the hook share: combine both into one sealed note, or if note writing
      // fails, surface a budget-fitted structured refusal fallback inline (req 4e32d1a5 / 3c5147a7).
      let combined = null
      let combinedNoteError = inlineNoteError
      if (!priorNoteError) {
        try {
          combined = fitHookContext(`${existingContext}\n\n${refusalNotice}`, {
            share,
            what: 'DevSpec pending delivery and room-command pickup refusal details',
            home,
          })
        } catch (noteError) {
          combinedNoteError = noteError
        }
      }
      if (combined) return combined
      const fbWithContext = remainingShare > 0 ? buildFallback(remainingShare, combinedNoteError) : null
      if (fbWithContext && existingContext.length + 2 + fbWithContext.length <= share) {
        return `${existingContext}\n\n${fbWithContext}`
      }
      const fbFull = buildFallback(share, combinedNoteError)
      return fbFull ?? existingContext
    }

    // Merge any concurrent HANDED record written by a parallel postToolUse hook while
    // this hook awaited `isOpen` or `startCommands`, so a refusal/retry write NEVER
    // overwrites a freshly handed-over unread note (requirement 3ea2b201).
    const dedupeStepItems = (list) => {
      const seen = new Set()
      const out = []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const key = typeof item.key === 'string' && item.key ? item.key : null
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        out.push(item)
      }
      return out
    }
    let mergedConcurrent = false
    try {
      const concurrentRes = readPrivateJsonResult(path.join(steps, HANDED))
      if (concurrentRes.status === STATE_UNREADABLE || (concurrentRes.value !== null && !validRecord(concurrentRes.value))) {
        throw new Error(`concurrent ${HANDED} could not be read; refusing to overwrite`)
      }
      const concurrent = concurrentRes.value
      if (validRecord(concurrent)) {
        const cUnread = hasUnreadNote(concurrent)
        const rUnread = hasUnreadNote(record)
        const cInner = concurrent.inner_note_pending ? (Array.isArray(concurrent.inner_note_items) ? concurrent.inner_note_items : concurrent.items) : []
        const rInner = record?.inner_note_pending ? (Array.isArray(record.inner_note_items) ? record.inner_note_items : []) : []
        const mergedInner = [...cInner, ...rInner]
        const cPickup = concurrent.pickup_pending ? (Array.isArray(concurrent.pickup_items) ? concurrent.pickup_items : concurrent.items.filter((i) => i.kind === 'owner_messages')) : []
        const rPickup = record?.pickup_pending ? (Array.isArray(record.pickup_items) ? record.pickup_items : []) : []
        const mergedPickup = [...cPickup, ...rPickup]
        const mergedRefusals = [
          ...(Array.isArray(concurrent.pickup_refusals) ? concurrent.pickup_refusals : []),
          ...(Array.isArray(record?.pickup_refusals) ? record.pickup_refusals : []),
        ]
        const pendingMeta = {
          ...(mergedInner.length > 0 ? { inner_note_pending: true, inner_note_items: mergedInner } : { inner_note_pending: false, inner_note_items: [] }),
          ...(mergedPickup.length > 0 ? { pickup_pending: true, pickup_items: mergedPickup } : { pickup_pending: false, pickup_items: [] }),
          ...(mergedRefusals.length > 0 ? { pickup_refusals: mergedRefusals } : {}),
        }
        if (adding.length > 0 || reclaimedUnreadItems.length > 0 || (cUnread && rUnread)) {
          const unreadItems = dedupeStepItems([
            ...reclaimedUnreadItems,
            ...(cUnread ? concurrent.items : []),
            ...(rUnread ? record.items : []),
            ...adding.map((each) => each.item),
          ])
          const note = writeNote(stepNoteText(unreadItems, { connectionId }), { home })
          record = {
            version: RECORD_VERSION,
            note: note.id,
            parts: [],
            items: unreadItems,
            at: new Date().toISOString(),
            note_read: false,
            ...pendingMeta,
          }
        } else if (cUnread) {
          record = {
            version: concurrent.version,
            note: concurrent.note,
            parts: Array.isArray(concurrent.parts) ? concurrent.parts : [],
            items: concurrent.items,
            at: concurrent.at,
            note_read: false,
            ...pendingMeta,
          }
        } else if (rUnread) {
          record = {
            version: record.version,
            note: record.note,
            parts: Array.isArray(record.parts) ? record.parts : [],
            items: record.items,
            at: record.at,
            note_read: false,
            ...pendingMeta,
          }
        } else if (mergedInner.length > 0 || mergedPickup.length > 0) {
          record = {
            ...(record ?? concurrent),
            note_read: true,
            items: [...mergedInner, ...mergedPickup],
            ...pendingMeta,
          }
        } else {
          record = null
        }
        mergedConcurrent = true
      } else if (adding.length > 0 || reclaimedUnreadItems.length > 0) {
        const keepPendingMeta = record
          ? {
              ...(record.inner_note_pending ? { inner_note_pending: true, inner_note_items: record.inner_note_items ?? [] } : {}),
              ...(record.pickup_pending ? { pickup_pending: true, pickup_items: record.pickup_items ?? [] } : {}),
              ...(Array.isArray(record.pickup_refusals) && record.pickup_refusals.length > 0 ? { pickup_refusals: record.pickup_refusals } : {}),
            }
          : {}
        const items = dedupeStepItems([
          ...reclaimedUnreadItems,
          ...(hasUnreadNote(record) ? record.items : []),
          ...adding.map((each) => each.item),
        ])
        const note = writeNote(stepNoteText(items, { connectionId }), { home })
        record = {
          version: RECORD_VERSION,
          note: note.id,
          parts: [],
          items,
          at: new Date().toISOString(),
          note_read: false,
          ...keepPendingMeta,
        }
      }
      if (record && (adding.length > 0 || reclaimedUnreadItems.length > 0 || readChanged || mergedConcurrent)) {
        writePrivateJson(path.join(steps, HANDED), record)
      }
    } catch (deliveryWriteError) {
      // Not handed over, so not taken: everything goes back for the next step.
      for (const each of adding) giveBack(each.taken)
      for (const ov of consumedOverflows) giveBack(ov)
      if (memoryOverflows.length > 0) {
        const existingMem = unpersistedRetryOverflow.get(steps) ?? []
        unpersistedRetryOverflow.set(steps, [...existingMem, ...memoryOverflows])
      }
      if (takenRecord) {
        if (!fs.existsSync(takenRecord.original)) {
          giveBack(takenRecord)
        } else {
          // A parallel hook already wrote a fresh HANDED note while this hook awaited
          // pickup: NEVER discard our pending retry record via giveBack() (req 3ea2b201).
          const overflowPayload = {
            version: RECORD_VERSION,
            note: record?.note ?? '0'.repeat(16),
            ...(hasUnreadNote(record) ? { unread_items: record.items } : {}),
            inner_note_items:
              Array.isArray(record?.inner_note_items) && record.inner_note_items.length > 0
                ? record.inner_note_items
                : unreadableInnerNoteItems,
            pickup_items:
              Array.isArray(record?.pickup_items) && record.pickup_items.length > 0
                ? record.pickup_items
                : completedOwnerItems,
            pickup_refusals: pickupRefusals ?? [],
            at: new Date().toISOString(),
          }
          const overflowFile = path.join(steps, `retry-${Date.now()}-${randomBytes(4).toString('hex')}.json`)
          let preservedOnDisk = false
          try {
            writePrivateJson(overflowFile, overflowPayload)
            preservedOnDisk = true
          } catch {
            try {
              fs.renameSync(takenRecord.file, overflowFile)
              preservedOnDisk = true
            } catch {
              preservedOnDisk = false
            }
          }
          if (preservedOnDisk) {
            drop(takenRecord)
          } else {
            // `steps` itself rejected writes/renames transiently: retain in-memory overflow
            // AND keep takenRecord.file on disk (do NOT unlink it).
            const existingMem = unpersistedRetryOverflow.get(steps) ?? []
            unpersistedRetryOverflow.set(steps, [...existingMem, overflowPayload])
          }
        }
      }
      for (const each of checked.filter((one) => !one.open)) drop(each.taken)
      // Even when saving a concurrent delivery note fails, NEVER swallow structured
      // pickup refusal details from this step — emit the budget-fitted refusal fallback
      // as agent-facing additional_context (requirements 4e32d1a5 / 3c5147a7 / 91d7b47c).
      if (pickupRefusals) {
        const refusalContext = formatPickupRefusals(null, deliveryWriteError)
        const refusalOutput = refusalContext ? JSON.stringify(postToolUseOutput(refusalContext)) : null
        if (refusalOutput) {
          await emit(refusalOutput)
          return refusalOutput
        }
      }
      return null
    }
    for (const each of checked) drop(each.taken)
    for (const ov of consumedOverflows) drop(ov)
    if (takenRecord) {
      if (record && adding.length === 0 && reclaimedUnreadItems.length === 0 && !readChanged && !mergedConcurrent) giveBack(takenRecord)
      else drop(takenRecord)
    }
    if (adding.length > 0) {
      recordTurnWake(connectionId, turnWakeFromEvents(adding.flatMap((each) => each.item.events)), { dir: connDir })
    }
    let context =
      hasUnreadNote(record)
        ? pointToNote({ id: record.note, command: noteCommand(record.note) }, { share, what: stepWhat(record.items), also: STEP_ALSO })
        : null
    context = formatPickupRefusals(context)
    if (needsListenerReminder) {
      const rawReminder = wakeListenerReminder(connectionId, { dir: connDir })
      if (!context) {
        try {
          context = fitHookContext(rawReminder, {
            share,
            what: 'A DevSpec wake-listener setup notice',
            home,
          })
        } catch {
          context = rawReminder.length <= share ? rawReminder : null
        }
      } else if (context.length + 2 + rawReminder.length <= share) {
        context = `${context}\n\n${rawReminder}`
      }
    }
    const output = context ? JSON.stringify(postToolUseOutput(context)) : null
    // Written out, and the write finished, before the lock goes, so no end comes between
    // the check and the agent's pointer.
    if (output) await emit(output)
    return output
  })
}

function overflowHasUnread(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (Array.isArray(entry.unread_items) && entry.unread_items.length > 0) return true
  return validRecord(entry) && hasUnreadNote(entry)
}

/**
 * Between turns, point the agent through the wake file at everything still held and
 * everything handed over but not read whole, in one note, the same kind the steps hand
 * over; a check job DevSpec has settled is dropped. The items stay here as the
 * handed-over record until the note is read whole. A note already woken for, with
 * nothing new, waits for the agent's steps instead of waking it again. Does nothing
 * while Cursor is in a turn. Returns what it did, or null.
 */
export async function releaseAtIdle(
  connectionId,
  { dir, state, wakeFile, home = os.homedir(), isOpen = itemStillOpen, append = appendWakeEvents, turnState = null } = {},
) {
  const steps = stepsDir(connectionId, dir)
  if (!fs.existsSync(steps)) return null
  reclaimAbandoned(steps)
  const handedPath = path.join(steps, HANDED)
  const hasUnreadOverflow =
    retryOverflowFiles(steps).some((file) => overflowHasUnread(readPrivateJson(file))) ||
    (unpersistedRetryOverflow.get(steps) ?? []).some(overflowHasUnread)
  if (waitingFiles(steps).length === 0 && !hasUnreadOverflow) {
    // Nothing new, and nothing handed over, or a note already woken / awaiting pickup retry only.
    const handed = fs.existsSync(handedPath) ? readPrivateJson(handedPath) : null
    if (
      !handed ||
      handed.woken === true ||
      (!hasUnreadNote(handed) && (handed.pickup_pending === true || handed.inner_note_pending === true))
    ) {
      return null
    }
  }
  const now = turnState ?? (await readTurnState(state?.local_id, { home }))
  if (now !== 'between') return null

  const takenRecord = take(handedPath)
  let record = null
  if (takenRecord) {
    const keptRes = readPrivateJsonResult(takenRecord.file)
    if (keptRes.status === STATE_UNREADABLE) {
      // Transient read error on HANDED at sweep start: restore it untouched and fail closed
      // so this sweep NEVER proceeds on waiting items alone and later merges the unchecked
      // older HANDED check job as a concurrent record (requirement 3ea2b201).
      giveBack(takenRecord)
      process.stderr.write(
        `step-delivery: ${HANDED} could not be read during idle sweep for ${connectionId}; leaving queued for retry\n`,
      )
      return null
    }
    record = validRecord(keptRes.value) ? keptRes.value : null
    if (!record) giveBack(takenRecord)
  }
  const takenOverflows = retryOverflowFiles(steps).map(take).filter(Boolean)
  const memoryOverflows = unpersistedRetryOverflow.get(steps) ?? []
  if (memoryOverflows.length > 0) unpersistedRetryOverflow.delete(steps)
  const overflowUnreadItems = []
  const overflowInnerItems = []
  const overflowPickupItems = []
  const overflowRefusals = []
  const collectOverflow = (entry) => {
    if (!entry || typeof entry !== 'object') return
    if (Array.isArray(entry.unread_items) && entry.unread_items.length > 0) {
      overflowUnreadItems.push(...entry.unread_items)
    } else if (validRecord(entry) && hasUnreadNote(entry)) {
      overflowUnreadItems.push(...entry.items)
    }
    if (Array.isArray(entry.inner_note_items) && entry.inner_note_items.length > 0) {
      overflowInnerItems.push(...entry.inner_note_items)
    } else if (validRecord(entry) && entry.inner_note_pending === true) {
      overflowInnerItems.push(...entry.items)
    }
    if (Array.isArray(entry.pickup_items) && entry.pickup_items.length > 0) {
      overflowPickupItems.push(...entry.pickup_items)
    } else if (validRecord(entry) && entry.pickup_pending === true) {
      overflowPickupItems.push(...entry.items.filter((i) => i.kind === 'owner_messages'))
    }
    if (Array.isArray(entry.pickup_refusals) && entry.pickup_refusals.length > 0) {
      overflowRefusals.push(...entry.pickup_refusals)
    }
  }
  const consumedOverflows = []
  const skippedUnreadableOverflows = []
  for (const ov of takenOverflows) {
    const parsed = readPrivateJson(ov.file)
    if (!parsed || typeof parsed !== 'object') {
      // Transient read error: NEVER delete an unreadable retry overflow file; restore it
      // to disk and report that it remained queued for retry (requirement 3ea2b201).
      giveBack(ov)
      skippedUnreadableOverflows.push(path.basename(ov.original))
      process.stderr.write(
        `step-delivery: retry overflow file ${path.basename(ov.original)} could not be read during idle sweep; leaving queued for retry\n`,
      )
      continue
    }
    consumedOverflows.push(ov)
    collectOverflow(parsed)
  }
  for (const ov of memoryOverflows) collectOverflow(ov)

  const taken = waitingFiles(steps).map(take).filter(Boolean)
  const validTaken = []
  const fresh = []
  for (const each of taken) {
    const item = readPrivateJson(each.file)
    if (validItem(item)) {
      fresh.push(item)
      validTaken.push(each)
    } else {
      giveBack(each)
      process.stderr.write(
        `step-delivery: waiting file ${path.basename(each.original)} could not be read during idle sweep; leaving queued for retry\n`,
      )
    }
  }
  if (record?.woken === true && fresh.length === 0 && overflowUnreadItems.length === 0) {
    for (const each of validTaken) giveBack(each)
    for (const ov of consumedOverflows) giveBack(ov)
    if (memoryOverflows.length > 0) {
      const existingMem = unpersistedRetryOverflow.get(steps) ?? []
      unpersistedRetryOverflow.set(steps, [...existingMem, ...memoryOverflows])
    }
    giveBack(takenRecord)
    return null
  }
  // Preserve any refused pickup retry / pending inner wake-note retry on HANDED (and any
  // retry overflow) when handing over fresh unread items at idle so a refused command is
  // NEVER dropped from the retry queue (requirement 3ea2b201).
  const recordInner =
    record?.inner_note_pending === true
      ? Array.isArray(record.inner_note_items)
        ? record.inner_note_items
        : record.items
      : []
  const recordPickup =
    record?.pickup_pending === true
      ? Array.isArray(record.pickup_items)
        ? record.pickup_items
        : record.items.filter((i) => i.kind === 'owner_messages')
      : []
  const recordRefusals = Array.isArray(record?.pickup_refusals) ? record.pickup_refusals : []
  const combinedInner = [...overflowInnerItems, ...recordInner]
  const combinedPickup = [...overflowPickupItems, ...recordPickup]
  const combinedRefusals = [...overflowRefusals, ...recordRefusals]
  const pendingRetryMeta = {
    ...(combinedInner.length > 0 ? { inner_note_pending: true, inner_note_items: combinedInner } : {}),
    ...(combinedPickup.length > 0 ? { pickup_pending: true, pickup_items: combinedPickup } : {}),
    ...(combinedRefusals.length > 0 ? { pickup_refusals: combinedRefusals } : {}),
  }
  const hasPendingRetry = Boolean(pendingRetryMeta.pickup_pending || pendingRetryMeta.inner_note_pending)
  const unreadPrior = hasUnreadNote(record) ? record.items : []
  const seenKeys = new Set()
  const items = []
  for (const item of [...overflowUnreadItems, ...unreadPrior, ...fresh]) {
    const key = typeof item?.key === 'string' && item.key ? item.key : null
    if (key && seenKeys.has(key)) continue
    if (key) seenKeys.add(key)
    items.push(item)
  }
  const open = []
  const dropped = []
  const checkedOpenKeys = new Set()
  const checkedSettledKeys = new Set()
  for (const item of items) {
    if (await isOpen(item, { connectionId, state })) {
      open.push(item)
      if (typeof item?.key === 'string' && item.key) checkedOpenKeys.add(item.key)
    } else {
      dropped.push(item.key)
      if (typeof item?.key === 'string' && item.key) checkedSettledKeys.add(item.key)
    }
  }
  const finish = () => {
    for (const each of validTaken) drop(each)
    for (const ov of consumedOverflows) drop(ov)
    if (takenRecord && record) drop(takenRecord)
  }
  const preserveTakenRecord = () => {
    if (!takenRecord || !record) return
    if (!fs.existsSync(takenRecord.original)) {
      giveBack(takenRecord)
      return
    }
    // Never delete `takenRecord` via `giveBack()` when a concurrent `HANDED` exists at
    // `handedPath` (for example after restoring `previousConcurrent` on wake-append error):
    // move `takenRecord` into a `retry-*.json` overflow file (or in-memory overflow if
    // `steps` rejects writes) so older unread commands are NEVER lost (requirement 3ea2b201).
    const overflowFile = path.join(steps, `retry-${Date.now()}-${randomBytes(4).toString('hex')}.json`)
    let preservedOnDisk = false
    try {
      fs.renameSync(takenRecord.file, overflowFile)
      preservedOnDisk = true
    } catch {
      try {
        writePrivateJson(overflowFile, record)
        preservedOnDisk = true
        drop(takenRecord)
      } catch {
        preservedOnDisk = false
      }
    }
    if (!preservedOnDisk) {
      const existingMem = unpersistedRetryOverflow.get(steps) ?? []
      unpersistedRetryOverflow.set(steps, [...existingMem, record])
    }
  }
  // From the check that the connection is still live to appending the wake, under the
  // connection's steps lock, which every write that ends the connection takes too
  // (`endConnectionSteps`). If a concurrent `HANDED` record appears holding any `check_job`
  // that this sweep has not yet verified via `isOpen`, release the lock and verify it first
  // (bounded passes) so an unchecked check job is NEVER marked handed off or woken (3ea2b201).
  for (let pass = 0; pass < 3; pass += 1) {
    const stepOutcome = withStepsLock(connectionId, dir, () => {
      // An end that landed during the lookups left these items to this hold: they are
      // discarded and named as the end would have, and no record or wake is written.
      if (connectionEnded(dir, connectionId)) {
        for (const each of validTaken) giveBack(each)
        for (const ov of consumedOverflows) giveBack(ov)
        if (takenRecord && record) giveBack(takenRecord)
        logDiscarded('releaseAtIdle', connectionId, discardLocked(connectionId, dir))
        return { done: true, result: { pointed: [], dropped, note: null, discarded: true } }
      }
      // Merge any concurrent HANDED record written by a parallel postToolUse hook while
      // `releaseAtIdle` awaited `isOpen`, so the idle handoff NEVER overwrites or drops
      // a newer command handed over concurrently (requirement 3ea2b201). If a concurrent
      // HANDED file exists on disk but fails to read transiently, FAIL CLOSED: restore all
      // taken items (preserving takenRecord into retry-*.json) and throw instead of treating
      // it as absent and overwriting it!
      const concurrentRes = readPrivateJsonResult(handedPath)
      if (concurrentRes.status === STATE_UNREADABLE || (concurrentRes.value !== null && !validRecord(concurrentRes.value))) {
        for (const each of validTaken) giveBack(each)
        for (const ov of consumedOverflows) giveBack(ov)
        if (memoryOverflows.length > 0) {
          const existingMem = unpersistedRetryOverflow.get(steps) ?? []
          unpersistedRetryOverflow.set(steps, [...existingMem, ...memoryOverflows])
        }
        preserveTakenRecord()
        process.stderr.write(
          `step-delivery: concurrent ${HANDED} could not be read during idle handoff for ${connectionId}; refusing to overwrite\n`,
        )
        throw new Error(`concurrent ${HANDED} unreadable during idle handoff; refusing to overwrite`)
      }
      const concurrent = concurrentRes.value
      const hasConcurrent = validRecord(concurrent)
      const concurrentUnread = hasConcurrent && hasUnreadNote(concurrent) ? concurrent.items : []
      const uncheckedConcurrentChecks = concurrentUnread.filter(
        (item) =>
          item?.kind === 'check_job' &&
          typeof item.key === 'string' &&
          !checkedOpenKeys.has(item.key) &&
          !checkedSettledKeys.has(item.key),
      )
      if (uncheckedConcurrentChecks.length > 0) {
        if (pass < 2) {
          return { done: false, needCheck: uncheckedConcurrentChecks }
        }
        // Still seeing new unchecked concurrent check jobs on the final pass: roll back
        // without touching `HANDED` or waking unchecked items; next idle tick retries.
        for (const each of validTaken) giveBack(each)
        for (const ov of consumedOverflows) giveBack(ov)
        if (memoryOverflows.length > 0) {
          const existingMem = unpersistedRetryOverflow.get(steps) ?? []
          unpersistedRetryOverflow.set(steps, [...existingMem, ...memoryOverflows])
        }
        preserveTakenRecord()
        return { done: true, result: null }
      }
      const openConcurrentUnread = concurrentUnread.filter(
        (item) => !(typeof item?.key === 'string' && checkedSettledKeys.has(item.key)),
      )
      const mergedOpen = []
      const mergedKeys = new Set()
      for (const item of [...open, ...openConcurrentUnread]) {
        const key = typeof item?.key === 'string' && item.key ? item.key : null
        if (key && mergedKeys.has(key)) continue
        if (key) mergedKeys.add(key)
        mergedOpen.push(item)
      }
      const cInner =
        hasConcurrent && concurrent.inner_note_pending === true
          ? Array.isArray(concurrent.inner_note_items)
            ? concurrent.inner_note_items
            : concurrent.items
          : []
      const rInner = Array.isArray(pendingRetryMeta.inner_note_items) ? pendingRetryMeta.inner_note_items : []
      const mergedInner = [...cInner, ...rInner]
      const cPickup =
        hasConcurrent && concurrent.pickup_pending === true
          ? Array.isArray(concurrent.pickup_items)
            ? concurrent.pickup_items
            : concurrent.items.filter((i) => i.kind === 'owner_messages')
          : []
      const rPickup = Array.isArray(pendingRetryMeta.pickup_items) ? pendingRetryMeta.pickup_items : []
      const mergedPickup = [...cPickup, ...rPickup]
      const mergedRefusals = [
        ...(hasConcurrent && Array.isArray(concurrent.pickup_refusals) ? concurrent.pickup_refusals : []),
        ...(Array.isArray(pendingRetryMeta.pickup_refusals) ? pendingRetryMeta.pickup_refusals : []),
      ]
      const mergedPendingMeta = {
        ...(mergedInner.length > 0 ? { inner_note_pending: true, inner_note_items: mergedInner } : {}),
        ...(mergedPickup.length > 0 ? { pickup_pending: true, pickup_items: mergedPickup } : {}),
        ...(mergedRefusals.length > 0 ? { pickup_refusals: mergedRefusals } : {}),
      }

      if (mergedOpen.length === 0) {
        for (const each of validTaken) drop(each)
        if (hasConcurrent && hasPendingRetry) {
          try {
            writePrivateJson(handedPath, { ...concurrent, ...mergedPendingMeta })
            for (const ov of consumedOverflows) drop(ov)
            if (takenRecord && record) drop(takenRecord)
          } catch {
            for (const ov of consumedOverflows) giveBack(ov)
            if (memoryOverflows.length > 0) {
              const existingMem = unpersistedRetryOverflow.get(steps) ?? []
              unpersistedRetryOverflow.set(steps, [...existingMem, ...memoryOverflows])
            }
            preserveTakenRecord()
          }
        } else {
          if (hasConcurrent && openConcurrentUnread.length === 0 && concurrentUnread.length > 0) {
            // All concurrent unread items were verified settled; remove stale HANDED if no pending retries remain.
            if (!mergedPendingMeta.pickup_pending && !mergedPendingMeta.inner_note_pending) {
              try { fs.rmSync(handedPath, { force: true }) } catch { /* ignore */ }
            }
          }
          for (const ov of consumedOverflows) {
            if (hasPendingRetry) giveBack(ov)
            else drop(ov)
          }
          if (hasPendingRetry && memoryOverflows.length > 0) {
            const existingMem = unpersistedRetryOverflow.get(steps) ?? []
            unpersistedRetryOverflow.set(steps, [...existingMem, ...memoryOverflows])
          }
          if (takenRecord && record) {
            if (hasPendingRetry) preserveTakenRecord()
            else drop(takenRecord)
          }
        }
        return {
          done: true,
          result: {
            pointed: [],
            dropped,
            note: null,
            ...(skippedUnreadableOverflows.length > 0 ? { skipped_unreadable_overflows: skippedUnreadableOverflows } : {}),
          },
        }
      }
      let note = null
      let wroteHanded = false
      const previousConcurrent = hasConcurrent ? concurrent : null
      try {
        note = writeNote(stepNoteText(mergedOpen, { connectionId }), { home })
        const wake = [idlePointer(note, mergedOpen, connectionId)]
        // The pointer is a few hundred characters whatever the note holds; checked against
        // Cursor's rules on one output all the same, in the one place they are kept.
        if (!fitsShellOutput(wakeLines(wake))) throw new Error(`the pointer to note ${note.id} does not fit one output`)
        writePrivateJson(handedPath, {
          version: RECORD_VERSION,
          note: note.id,
          parts: record?.note === note.id ? record.parts ?? [] : [],
          items: mergedOpen,
          at: new Date().toISOString(),
          note_read: false,
          woken: true,
          ...mergedPendingMeta,
        })
        wroteHanded = true
        append(wakeFile, wake)
      } catch (error) {
        if (wroteHanded) {
          if (previousConcurrent) {
            try { writePrivateJson(handedPath, previousConcurrent) } catch { /* ignore */ }
          } else {
            fs.rmSync(handedPath, { force: true })
          }
        }
        for (const each of validTaken) giveBack(each)
        for (const ov of consumedOverflows) giveBack(ov)
        if (memoryOverflows.length > 0) {
          const existingMem = unpersistedRetryOverflow.get(steps) ?? []
          unpersistedRetryOverflow.set(steps, [...existingMem, ...memoryOverflows])
        }
        preserveTakenRecord()
        throw error
      }
      finish()
      recordTurnWake(connectionId, turnWakeFromEvents(mergedOpen.flatMap((item) => item.events)), { dir })
      return {
        done: true,
        result: {
          pointed: mergedOpen.map((item) => item.key),
          dropped,
          note: note.id,
          ...(skippedUnreadableOverflows.length > 0 ? { skipped_unreadable_overflows: skippedUnreadableOverflows } : {}),
        },
      }
    })
    if (stepOutcome.done) return stepOutcome.result
    for (const item of stepOutcome.needCheck) {
      if (await isOpen(item, { connectionId, state })) {
        checkedOpenKeys.add(item.key)
      } else {
        checkedSettledKeys.add(item.key)
        dropped.push(item.key)
      }
    }
  }
  return null
}

/**
 * Whether the connection has ended, read afresh from its state file: disabled, or the
 * file gone. A file that cannot be read just now (being rewritten) is not an end.
 */
function connectionEnded(dir, connectionId) {
  const { state, missing } = readStateOf(dir, connectionId)
  return missing || state?.enabled === false
}

/**
 * The wakes, among those the reader prints, that point the agent at something for one
 * connection, by its `connection_id`: a `held_for_step` line, and a command's recall in a
 * wake of its own (turn-recall.mjs: a `turn_recall` naming its command in `for`, which a
 * one-shot wait may have left frozen in the connection's state for the next printer).
 */
const CONNECTION_WAKE_TYPES = Object.freeze(['held_for_step', 'turn_recall'])
const namesConnection = (event) =>
  typeof event?.connection_id === 'string' &&
  (event.type === 'held_for_step' || (event.type === 'turn_recall' && typeof event.for === 'string'))

/**
 * The last line of defence, at print time (devspec-wake-tail.mjs: the reader, and the
 * tail's notifications): `output`, whole wakes about to be printed or notified, without
 * any wake for a connection that has ended (a `held_for_step` line, or a recall's own
 * wake: `namesConnection`). A writer holding the
 * steps lock never appends one after the end, but one appended just before it may not
 * have been printed yet; it is skipped and named on stderr, never printed. Other wakes,
 * and output that is not whole wakes as the wake writer wrote them, are printed as they
 * are.
 */
export function withoutEndedConnectionWakes(output, { dir = connectionsDirFor(), write = (line) => process.stderr.write(line) } = {}) {
  if (typeof output !== 'string' || !CONNECTION_WAKE_TYPES.some((type) => output.includes(`"${type}"`))) return output
  const { wakes } = splitWakes(output, { settled: true })
  if (wakes.join('') !== output) return output
  return wakes
    .filter((wake) => {
      for (const line of wake.split('\n')) {
        let event = null
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (namesConnection(event) && connectionEnded(dir, event.connection_id)) {
          write(
            `devspec-wake-tail: skipped a ${event.type} wake for connection ${event.connection_id}, which has ended ` +
              `(${event.type === 'held_for_step' ? `note ${event.note}` : `recall for ${event.for}`}); never printed. DevSpec keeps what it pointed at.\n`,
          )
          return false
        }
      }
      return true
    })
    .join('')
}

function readStateOf(dir, connectionId) {
  try {
    return { state: JSON.parse(fs.readFileSync(path.join(dir, `${connectionId}.json`), 'utf8')), missing: false }
  } catch (error) {
    return { state: null, missing: error?.code === 'ENOENT' }
  }
}

/**
 * The connection has ended, so nothing will hand its items over: discard its local
 * copies, waiting or in a note not read whole, and say which they were. This loses
 * nothing (see the header, 4.): the queue is only a delivery buffer, and DevSpec keeps
 * each notice and check job. An item a live hook has taken stays where it is, and so
 * does the folder: that hook puts it back when it finishes, sees the connection has
 * ended, and discards it then. Returns the notice and check job ids discarded and
 * whether the folder is still there, or null when there was no folder.
 */
export function discardSteps(connectionId, { dir } = {}) {
  if (!fs.existsSync(stepsDir(connectionId, dir))) return null
  return withStepsLock(connectionId, dir, () => discardLocked(connectionId, dir))
}

/** `discardSteps`, for a caller already holding the connection's steps lock. */
function discardLocked(connectionId, dir) {
  const steps = stepsDir(connectionId, dir)
  if (!fs.existsSync(steps)) return null
  reclaimAbandoned(steps)
  const items = []
  const takenRecord = take(path.join(steps, HANDED))
  if (takenRecord) {
    const record = readPrivateJson(takenRecord.file)
    if (validRecord(record)) items.push(...record.items)
    drop(takenRecord)
  }
  unpersistedRetryOverflow.delete(steps)
  for (const file of retryOverflowFiles(steps)) {
    const taken = take(file)
    if (taken) drop(taken)
  }
  for (const file of waitingFiles(steps)) {
    const taken = take(file)
    if (!taken) continue
    const item = readPrivateJson(taken.file)
    if (validItem(item)) items.push(item)
    drop(taken)
  }
  try {
    fs.rmdirSync(steps)
  } catch {
    /* not empty: a live hook holds an item, and discards it when it finishes */
  }
  return {
    notices: items.flatMap((item) => (item.kind === 'notices' ? item.notice_ids ?? [] : [])),
    check_jobs: items.filter((item) => item.kind === 'check_job').map((item) => item.check_job_id),
    left: fs.existsSync(steps),
  }
}

/** Say on stderr which notices and check jobs a connection's end discarded, if any. */
export function logDiscarded(who, connectionId, discarded, write = (line) => process.stderr.write(line)) {
  if (!discarded || discarded.notices.length + discarded.check_jobs.length === 0) return
  write(
    `${who}: connection ${connectionId} ended; discarded its local copies of notices [${discarded.notices.join(', ')}] ` +
      `and check jobs [${discarded.check_jobs.join(', ')}] held for its agent's next step. DevSpec keeps them.\n`,
  )
}

/**
 * At a poller's start: discard what every connection in `dir` that is no longer live
 * (its state disabled or gone) still held, however it ended. Catches an end that could
 * not discard them itself (a process killed outright). Returns each connection's
 * discarded ids.
 */
export function discardEndedSteps({ dir } = {}) {
  const discarded = []
  for (const name of list(dir)) {
    const match = STEPS_FOLDER.exec(name)
    if (!match) continue
    const { state, missing } = readStateOf(dir, match[1])
    // A state file being rewritten right now is not an ended connection.
    if (!state && !missing) continue
    if (state?.enabled === true) continue
    const each = discardSteps(match[1], { dir })
    if (each) discarded.push({ connection_id: match[1], ...each })
  }
  return discarded
}

if (isDirectRun(import.meta.url)) {
  if (process.argv[2] === 'post-tool') {
    answerCursorAtExit()
    let input = null
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
    } catch {
      input = null
    }
    try {
      // Printed from inside the hook, while it holds the connection's steps lock, which
      // it releases only once the write has finished.
      await stepDeliveryHook(input, { emit: (output) => new Promise((resolve) => process.stdout.write(output, () => resolve())) })
    } catch {
      /* what waits stays where it is, for the next step or the idle wake */
    }
  }
  process.exit(0)
}
