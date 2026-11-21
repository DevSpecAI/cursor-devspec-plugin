#!/usr/bin/env node
/**
 * Automatic project recall for a command sent to this agent from a DevSpec room
 * (DevSpec task 0dec37d4, decision 3ea02bd2).
 *
 * On each command, DevSpec picks the project's records that bear on it (its
 * requirements, standing documents, decisions and conventions, plans and rejections,
 * and past shipped work) and formats them as one block. The plugin hands that block
 * over as DevSpec wrote it and remembers which record versions it has shown; nothing
 * here knows what a lane or a kind of record is, so a kind DevSpec adds later needs no
 * plugin release.
 *
 * How a room command gets its recall
 * ----------------------------------
 * A room command reaches Cursor as a background command's output (the host wake
 * follow writes it, devspec-wake-tail.mjs prints it), never as a prompt, so no prompt
 * hook runs for it. So the poller asks `poll_connection` to attach the turn's recall
 * to a response that delivers a command or an automation run (`turn_recall_version`),
 * and sends the record versions this conversation has already been shown
 * (`seen_recall_versions`): a record shown once is not shown again in the same
 * conversation until it is edited (a new version is a new key). The recall is kept
 * with the command in the inbox, and the wake that hands the command over carries it
 * (devspec-remote-wait.mjs), so the agent receives both together. DevSpec recalls
 * nothing for a check job, a notice or an idle poll, so they carry none.
 *
 * Nothing is cut, the command least of all, and no recall is dropped unsaid. The
 * plugin's one wake sizer (`fitIntoWake`, hook-context-budget.mjs) holds the whole
 * wake to Cursor's rules on one command's output (`fitsShellOutput`: past 20,000
 * characters Cursor keeps the first and last 10,000, and past 40,000 bytes it shows a
 * file path instead). The recall goes into the wake itself only while the whole wake,
 * command and recall together, still fits. Otherwise it is kept whole as a note in
 * ~/.devspec/notes/ (`writeNote`, in parts that each reach the model whole) and the
 * wake carries only a short pointer to it, when the whole wake with that pointer still
 * fits. When not even that fits, the whole wake, the command and its recall together,
 * is kept whole in one sealed note of its own, and the wake carries only a short line
 * saying so and how to read it (`recallWakeOut`, `wakeWithin`); the same holds for any
 * wake too long to show whole, with or without recall. The agent sees that line before
 * it does anything, and each wake points at its own note, so nothing displaces
 * anything. The reader that prints the wake file hands Cursor whole wakes only, as many
 * as fit one output together (`wakesForOneOutput`, devspec-wake-tail.mjs).
 *
 * What counts as shown (`settleRecallHandover`): a recall that went inline, once its
 * wake has been written; a recall in a note (its own, or the whole wake's), only once
 * the agent has read every part of that note whole, by the same proof every other note
 * of the plugin is counted read with (`readThrough`, hook-context-budget.mjs). The
 * plugin's postToolUse hook runs this file with `post-tool` while a note is waiting
 * (`noteRecallReads`); it only observes. Until then its records stay unshown, so the
 * next command's recall can offer them again. A command whose wake never went out
 * leaves nothing remembered either. A compaction forgets what was shown before it (the
 * preCompact hook runs this file with `compact`), because the summary that replaces
 * the conversation may not keep it.
 *
 * Never in the way. DevSpec runs the recall within the time budget every plugin's
 * recall shares (DevSpecV2 packages/core/src/recall/budget.ts: the server gives up
 * after 4.4 seconds, before a plugin's 4.8-second wait ends) and past it delivers the
 * command with no recall. The poller's own deadline on a held poll leaves far more
 * room than that (`POLL_HTTP_GRACE_MS` in devspec-remote-poll.mjs). A DevSpec server
 * that does not know `turn_recall_version` ignores it, and commands arrive as before.
 * Anything that goes wrong here (an unreadable or unwritable seen store, a malformed
 * recall, a note that cannot be written) costs the recall or repeats a card, never the
 * command.
 *
 * Maintainer notes: compaction runs the plugin's own preCompact hook
 * -------------------------------------------------------------------
 * Unlike `beforeSubmitPrompt` and `stop` (below), Cursor runs a plugin's own
 * `preCompact` hook with no hooks file of the person's own. Measured on CLI
 * 2026.11.19-f005e9d, 21 November 2026 (DevSpec task 0dec37d4): a throwaway plugin
 * whose hooks log their input, a temporary HOME holding only `.config/cursor`, no
 * DevSpec plugin, no `~/.cursor/hooks.json` and no project `.cursor/hooks.json`, an
 * interactive session, one answered prompt, then `/summarize`. The plugin's
 * `preCompact` ran both with `--plugin-dir` and installed as a local plugin
 * (`~/.cursor/plugins/local/`), with `conversation_id` (the chat's id, the same as
 * `session_id`), `trigger: "manual"` and the transcript path in its input, and
 * Cursor's summary row then appeared in the transcript; its `beforeSubmitPrompt` and
 * `stop` did not run. The 2026.11.19 bundle runs `preCompact`
 * whenever Cursor's server asks for it during a compaction, outside the local
 * hooks-file gate; only `/summarize` was measured, not a compaction Cursor starts by
 * itself. So the preCompact hook is what forgets the shown records; if a later Cursor
 * stops running it, records shown before a compaction stay hidden until they change,
 * and the poller would need to notice Cursor's summary row in the transcript instead
 * (transcript-turn-end.mjs already recognises it).
 *
 * Maintainer notes: typed prompts get no recall yet
 * -------------------------------------------------
 * A prompt typed at the terminal would get its recall from Cursor's before-prompt hook
 * (`beforeSubmitPrompt`, whose `additional_context` Cursor attaches to the prompt), as
 * the other DevSpec plugins do from their prompt hooks. Cursor's command-line agent
 * does not run a plugin's own `beforeSubmitPrompt` unless the person also has a hooks
 * file of their own that declares it (`~/.cursor/hooks.json`, or the project's
 * `.cursor/hooks.json`), and runs none in a headless (`-p`) run. Measured with a
 * throwaway plugin on CLI 2026.11.05 (DevSpec task 0dec37d4) and with this plugin on
 * CLI 2026.10.22, 2026.11.05 and 2026.11.19 (task 659a015f). When the hook does run,
 * its context reaches the model. Cursor tracks the gap as a known bug:
 *
 *  - https://forum.cursor.com/t/cursor-cli-does-not-run-enterprise-or-team-beforesubmitprompt-hooks/173219
 *  - https://forum.cursor.com/t/cursor-cli-2026-11-05-macos-user-level-cursor-hooks-json-is-never-loaded-project-level-cursor-hooks-json-works/177989
 *
 * Decided on 20 November 2026 (task 0dec37d4): recall on typed prompts waits for
 * Cursor's own fix, and the plugin builds no stand-in for it (such as recall at the
 * turn's first tool call) and never adds an entry to the person's hooks files. Once
 * Cursor runs a plugin's own `beforeSubmitPrompt` with no hooks file of the person's
 * own, in the terminal and headless, add the recall there: ask DevSpec's turn recall
 * for the prompt with `seenRecallKeys`, hand the block over within the hook's share of
 * Cursor's ceiling on hook context (`fitHookContext`), and `rememberShown` what went
 * out.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fitIntoWake, fitsShellOutput, readThrough, wakeWithin } from './hook-context-budget.mjs'
import { wakeLines } from './devspec-wake-file.mjs'
import { isDirectRun } from './is-direct-run.mjs'
import { readPrivateJson, writePrivateText } from './private-state.mjs'
import { firingConversation } from './project-context.mjs'

/** The `turn_recall_version` this plugin negotiates on `poll_connection`. */
export const TURN_RECALL_VERSION = 1

/**
 * The seen store's bounds: the host delivery contract every DevSpec plugin keeps
 * (DevSpecV2 apps/web/scripts/eval/recall-plugin-bench/host-delivery-contract.ts,
 * task 7c87f509).
 * - `maxKeys`: DevSpec takes at most 512 seen keys with one request
 *   (`RECALL_LIMITS.seenKeysPerRequest`) and skips the recall when sent more, so the
 *   whole store can always go with every poll.
 * - `maxKeyChars`: the longest key DevSpec accepts (`RECALL_LIMITS.seenKeyChars`). One
 *   longer would make the whole poll invalid, command included, so it is never kept.
 * - `maxBytes` and `ttlMs`: one conversation's file stays small, and a conversation
 *   left untouched for 30 days has its file removed when another conversation's file
 *   is first written. A recall note never read in 30 days is let go the same way: its
 *   records simply stay unshown.
 */
export const SEEN_STORE = Object.freeze({
  maxKeys: 512,
  maxKeyChars: 120,
  maxBytes: 32_768,
  ttlMs: 30 * 24 * 60 * 60 * 1_000,
})

const STORE_VERSION = 1

/** Where the seen stores live: one private file per conversation. */
export function recallDir(home = os.homedir()) {
  return path.join(home, '.devspec', 'recall', 'cursor')
}

/** The conversation a connection's recall belongs to: its Cursor chat, or the connection itself when the chat is not known. */
export function recallConversation(state, connectionId) {
  const local = typeof state?.local_id === 'string' ? state.local_id.trim() : ''
  if (local) return local
  return typeof connectionId === 'string' && connectionId ? `connection:${connectionId}` : null
}

/** One conversation's seen store, named by a digest of its id so no id can reach outside the folder. */
export function seenStoreFile(conversation, home = os.homedir()) {
  const stem = createHash('sha256').update(String(conversation), 'utf8').digest('hex').slice(0, 32)
  return path.join(recallDir(home), `${stem}.json`)
}

/** The keys in `list` that DevSpec can take back: strings within its length, without whitespace, each once. */
function validKeys(list) {
  if (!Array.isArray(list)) return []
  const keys = list.filter(
    (key) => typeof key === 'string' && key.length > 0 && key.length <= SEEN_STORE.maxKeyChars && !/\s/.test(key),
  )
  return [...new Set(keys)]
}

/**
 * The record versions this conversation has been shown, oldest first. Anything
 * unreadable reads as nothing shown: that only repeats a card.
 */
export function seenRecallKeys(conversation, { home = os.homedir() } = {}) {
  if (!conversation) return []
  const kept = readPrivateJson(seenStoreFile(conversation, home))
  if (kept?.version !== STORE_VERSION || kept.conversation !== conversation) return []
  return validKeys(kept.keys).slice(-SEEN_STORE.maxKeys)
}

/** `keys` as the store's text, the oldest dropped first until it is within its bounds. */
function storeText(conversation, keys, now) {
  let kept = keys.slice(-SEEN_STORE.maxKeys)
  const text = () => `${JSON.stringify({ version: STORE_VERSION, conversation, keys: kept, updated_at: now })}\n`
  while (kept.length > 0 && Buffer.byteLength(text()) > SEEN_STORE.maxBytes) kept = kept.slice(1)
  return text()
}

/** Remove seen stores untouched for `SEEN_STORE.ttlMs`. */
function sweepExpired(home, now) {
  let names
  try {
    names = fs.readdirSync(recallDir(home))
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(recallDir(home), name)
    try {
      const stat = fs.lstatSync(file)
      if (stat.isFile() && now - stat.mtimeMs > SEEN_STORE.ttlMs) fs.rmSync(file, { force: true })
    } catch {
      // removed or replaced meanwhile
    }
  }
}

/**
 * Remember that `keys` were shown in this conversation, newest last. Returns whether
 * the store was written; a failure only means a card may be shown again.
 */
export function rememberShown(conversation, keys, { home = os.homedir(), now = Date.now() } = {}) {
  const shown = validKeys(keys)
  if (!conversation || shown.length === 0) return false
  try {
    const file = seenStoreFile(conversation, home)
    if (!fs.existsSync(file)) sweepExpired(home, now)
    const earlier = seenRecallKeys(conversation, { home }).filter((key) => !shown.includes(key))
    writePrivateText(file, storeText(conversation, [...earlier, ...shown], now))
    return true
  } catch {
    return false
  }
}

/** Forget what this conversation was shown (a compaction). */
export function forgetShown(conversation, { home = os.homedir() } = {}) {
  if (!conversation) return
  try {
    fs.rmSync(seenStoreFile(conversation, home), { force: true })
  } catch {
    // nothing to forget
  }
}

/**
 * What the poller adds to `poll_connection` for this conversation: the recall it
 * negotiates, and the versions already shown (left out when there are none).
 */
export function recallPollArguments(conversation, { home = os.homedir() } = {}) {
  const seen = seenRecallKeys(conversation, { home })
  return { turn_recall_version: TURN_RECALL_VERSION, ...(seen.length > 0 ? { seen_recall_versions: seen } : {}) }
}

/**
 * The part of a `turn_recall` (DevSpec's, or as kept in the inbox) worth handing
 * over: DevSpec's block, exactly as written, and the keys of the records in it. Null
 * when there is nothing to show (no cards, a recall that timed out, an unknown version).
 */
export function deliverableRecall(payload) {
  if (!payload || typeof payload !== 'object' || payload.version !== TURN_RECALL_VERSION) return null
  const block = payload.formatted_block
  if (typeof block !== 'string' || block.trim().length === 0) return null
  const named = validKeys(payload.seen_keys)
  const keys = named.length > 0
    ? named
    : validKeys((Array.isArray(payload.cards) ? payload.cards : []).map((card) => card?.seenKey ?? card?.dedupe_key))
  return { version: TURN_RECALL_VERSION, formatted_block: block, seen_keys: keys }
}

/** The events a recall is about: it follows the last of them in a wake. */
const COMMAND_EVENTS = new Set(['owner_message', 'automation_dispatch'])

/** What the wake says beside a recall it carries. */
export const RECALL_INLINE_NOTE = 'Project records DevSpec recalled for the command above, as DevSpec wrote them.'

/**
 * What the wake says when the recall is in a note: as short as it can be and still
 * say what the file is and what to do, so it fits beside as long a command as possible.
 */
export const RECALL_POINTER_NOTE = 'DevSpec recall for the command above: run `read`, and each part it names, before acting.'

/**
 * `events`, one wake's events in the order they are written, with the batch's recall
 * after its last command, sized with the whole wake by the plugin's one wake sizer
 * (`fitIntoWake`, hook-context-budget.mjs): inline when the whole wake with it still
 * reaches the model whole; otherwise a short pointer to a note that keeps it whole,
 * when the whole wake with the pointer still does. Otherwise the recall goes inline
 * all the same, and the whole wake, command and recall together, goes out in one note
 * (`recallWakeOut`). `events` unchanged when there is no recall or no command to follow.
 */
export function withTurnRecall(events, recall, { home = os.homedir() } = {}) {
  const deliverable = deliverableRecall(recall)
  if (!deliverable || !Array.isArray(events)) return events
  const at = events.findLastIndex((event) => COMMAND_EVENTS.has(event?.type)) + 1
  if (at === 0) return events
  const inline = (block) => ({ type: 'turn_recall', note: RECALL_INLINE_NOTE, block })
  const placed = fitIntoWake(events, {
    at,
    text: deliverable.formatted_block,
    inline,
    pointer: (note) => ({ type: 'turn_recall', read: note.command, note: RECALL_POINTER_NOTE }),
    home,
  })
  return placed.route === 'none' ? [...events.slice(0, at), inline(deliverable.formatted_block), ...events.slice(at)] : placed.events
}

/**
 * One wake as it goes out (`wakeWithin`, hook-context-budget.mjs): as it is when it
 * fits Cursor's rules on one output, otherwise kept whole in one sealed note with a
 * short line in its place. Returns `{ events, note, full }`: what goes out, the note
 * when there is one, and the wake it stands for. When that note cannot be written, a
 * recall never makes the command longer than it was: the command goes without it.
 */
export function recallWakeOut(events, { home = os.homedir() } = {}) {
  const out = wakeWithin(events, { home })
  if (out.note || fitsShellOutput(wakeLines(out.events))) return { ...out, full: events }
  const bare = events.filter((event) => event?.type !== 'turn_recall')
  return { events: bare, note: null, full: bare }
}

/** The note a wake points its recall to, or null when the recall went inline or not at all. */
function recallNoteOf(events) {
  const event = Array.isArray(events) ? events.find((each) => each?.type === 'turn_recall') : null
  return /^cat ~\/\.devspec\/notes\/([0-9a-f]{16})\.md$/.exec(String(event?.read ?? ''))?.[1] ?? null
}

/** Where recall notes wait to be read: one record per conversation and note. */
function pendingDir(home) {
  return path.join(recallDir(home), 'pending')
}

function conversationDigest(conversation) {
  return createHash('sha256').update(String(conversation), 'utf8').digest('hex').slice(0, 32)
}

function pendingFile(conversation, note, home) {
  return path.join(pendingDir(home), `${conversationDigest(conversation)}-${note}.json`)
}

/** This conversation's waiting recall notes, as `{ file, kept }`. */
function pendingRecords(conversation, home) {
  const prefix = `${conversationDigest(conversation)}-`
  let names
  try {
    names = fs.readdirSync(pendingDir(home)).filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
  } catch {
    return []
  }
  const records = []
  for (const name of names) {
    const file = path.join(pendingDir(home), name)
    const kept = readPrivateJson(file)
    if (kept?.version === STORE_VERSION && kept.conversation === conversation && typeof kept.note === 'string') {
      records.push({ file, kept })
    }
  }
  return records
}

/** Remove recall notes waiting longer than `SEEN_STORE.ttlMs`: their records stay unshown. */
function sweepPending(home, now) {
  let names
  try {
    names = fs.readdirSync(pendingDir(home))
  } catch {
    return
  }
  for (const name of names) {
    const file = path.join(pendingDir(home), name)
    try {
      const stat = fs.lstatSync(file)
      if (stat.isFile() && now - stat.mtimeMs > SEEN_STORE.ttlMs) fs.rmSync(file, { force: true })
    } catch {
      // removed or replaced meanwhile
    }
  }
}

/**
 * Settle what a written wake (`recallWakeOut`'s result) did with its batch's recall, in
 * `conversation`:
 * - inline in the wake: its records are shown now (`'shown'`);
 * - a pointer in the wake, or the whole wake in a note: they wait until the agent has
 *   read that note whole (`'awaiting_read'`; `noteRecallReads`). Each wake points at its
 *   own note, so nothing replaces anything.
 * Returns `'none'` when there was nothing to settle or it could not be recorded; that
 * only means the records may be offered again.
 */
export function settleRecallHandover(conversation, out, batch, { home = os.homedir(), now = Date.now() } = {}) {
  const keys = deliverableRecall(batch?.turn_recall)?.seen_keys ?? []
  const full = Array.isArray(out?.full) ? out.full : []
  if (!conversation || keys.length === 0 || !full.some((event) => event?.type === 'turn_recall')) return 'none'
  const note = out.note?.id ?? recallNoteOf(full)
  if (!note) return rememberShown(conversation, keys, { home, now }) ? 'shown' : 'none'
  try {
    sweepPending(home, now)
    const record = { version: STORE_VERSION, conversation, note, keys, parts: [], at: new Date(now).toISOString() }
    writePrivateText(pendingFile(conversation, note, home), `${JSON.stringify(record)}\n`)
    return 'awaiting_read'
  } catch {
    return 'none'
  }
}

/**
 * The postToolUse step (`post-tool`): for each recall note waiting in this tool call's
 * conversation, add any part this call handed the agent whole (`readThrough`, the
 * plugin's one proof that a note was read); once every part has come back whole, its
 * records are shown and the note stops waiting. A read in another conversation (a
 * helper agent's included) never counts. It only observes, and answers Cursor with
 * nothing. Returns the notes read through by this call.
 */
export function noteRecallReads(input, { home = os.homedir(), now = Date.now() } = {}) {
  const conversation = firingConversation(input)
  if (!conversation) return []
  const read = []
  for (const { file, kept } of pendingRecords(conversation, home)) {
    const { record, done } = readThrough({ note: kept.note, parts: kept.parts }, input, { home })
    try {
      if (done) {
        if (rememberShown(conversation, kept.keys, { home, now })) {
          fs.rmSync(file, { force: true })
          read.push(kept.note)
        }
      } else if (record.parts.length !== (Array.isArray(kept.parts) ? kept.parts.length : 0)) {
        writePrivateText(file, `${JSON.stringify({ ...kept, parts: record.parts })}\n`)
      }
    } catch {
      // the read is counted again at the next step that shows it
    }
  }
  return read
}

// preCompact: the summary that replaces the conversation may not keep the cards shown
// so far, so they may be shown again. Cursor reads nothing from this hook's output.
if (isDirectRun(import.meta.url) && process.argv[2] === 'compact') {
  try {
    forgetShown(firingConversation(JSON.parse(fs.readFileSync(0, 'utf8'))))
  } catch {
    // nothing to forget, or no conversation named
  }
  process.exit(0)
}

// postToolUse, while a recall note waits to be read: count what this tool call read.
// It only observes, and answers Cursor with nothing, so it takes no share of the
// context Cursor passes on after a step.
if (isDirectRun(import.meta.url) && process.argv[2] === 'post-tool') {
  try {
    noteRecallReads(JSON.parse(fs.readFileSync(0, 'utf8')))
  } catch {
    // an input it cannot read counts nothing
  }
  process.exit(0)
}
