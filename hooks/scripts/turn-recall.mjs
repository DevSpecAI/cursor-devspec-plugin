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
 * What counts as shown: only a recall that went into a wake, and only once that wake
 * has been written (`recallShownIn`, `rememberShown`). A command whose wake never went
 * out leaves nothing remembered, so its cards come back with the next command. A
 * compaction forgets what was shown before it (the preCompact hook runs this file with
 * `compact`), because the summary that replaces the conversation may not keep it.
 *
 * Nothing is cut. The recall goes into the wake itself only while the whole wake still
 * reaches the model whole under Cursor's rules on one command's output
 * (`fitsShellOutput`, hook-context-budget.mjs: past 20,000 characters Cursor keeps the
 * first and last 10,000, and past 40,000 bytes it shows a file path instead). Otherwise
 * it is kept whole as a note in ~/.devspec/notes/ (`writeNote`, in parts that each
 * reach the model whole) and the wake says how to read it.
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

import { fitsShellOutput, writeNote } from './hook-context-budget.mjs'
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
 *   is first written.
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

/** What the wake says when the recall is in a note: a fixed sentence and a fixed-length command. */
export function recallPointer(note) {
  return (
    "DevSpec's recall for the command above (project records that bear on it) is waiting for you whole in a file, " +
    "because with it this wake would be longer than Cursor shows from one command's output. " +
    `Read it before you act on the command: \`${note.command}\`, and every further part it names.`
  )
}

/**
 * `events`, one wake's events in the order they are written, with the batch's recall
 * after its last command: inline when the whole wake, written as the wake file and
 * stdout write it (`wakeLines`), still reaches the model whole (`fitsShellOutput`);
 * otherwise as a pointer to a note that keeps it whole (`writeNote`). `events`
 * unchanged when there is no recall, no command to follow, or a note that cannot be
 * written: the command goes without it rather than with part of it.
 */
export function withTurnRecall(events, recall, { home = os.homedir(), sessionId = null } = {}) {
  const deliverable = deliverableRecall(recall)
  if (!deliverable || !Array.isArray(events)) return events
  const at = events.findLastIndex((event) => COMMAND_EVENTS.has(event?.type)) + 1
  if (at === 0) return events
  const place = (event) => [...events.slice(0, at), event, ...events.slice(at)]
  const base = { type: 'turn_recall', session_id: sessionId, executable: false }
  const inline = place({ ...base, note: RECALL_INLINE_NOTE, block: deliverable.formatted_block })
  if (fitsShellOutput(wakeLines(inline))) return inline
  let note
  try {
    note = writeNote(deliverable.formatted_block, { home })
  } catch {
    return events
  }
  return place({ ...base, note: recallPointer(note), read: note.command, parts: note.parts })
}

/** The record versions a written wake showed: the batch's recall keys, when the wake carried its recall. */
export function recallShownIn(events, batch) {
  if (!Array.isArray(events) || !events.some((event) => event?.type === 'turn_recall')) return []
  return deliverableRecall(batch?.turn_recall)?.seen_keys ?? []
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
