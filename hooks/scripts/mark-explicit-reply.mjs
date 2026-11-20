#!/usr/bin/env node
/**
 * PostToolUse / afterMCPExecution hook for Cursor (matcher / target: post_session_message).
 *
 * Records that the agent posted an explicit reply into the session this turn (writing the
 * `.explicit-reply` marker so Stop skips mirroring redundant narration), AND if the post
 * completed the turn (`complete_turn: true`), immediately clears the local `<connection_id>.turn`
 * marker so the poller stops asserting busy: true and Working dots clear without lag.
 *
 * A reply to DevSpec notices (notice-reply.mjs) is neither: it answers no command and
 * completes no turn, even when it passes complete_turn, so a command being worked still
 * needs its own answer and keeps showing Working until it gets one.
 *
 * On afterMCPExecution it also notes a DevSpec write whose result carries DevSpec's
 * `tell_person` mark on the turn (`handleTellPersonMark`), for the end-of-turn
 * backstop that tells the person when the model did not (notice-reply.mjs).
 * When Stop could not post that message, it left it for the agent's next turn; on
 * postToolUse this hook hands it over (`tellPersonNoteHook`).
 *
 * Run as `mark-explicit-reply.mjs <postToolUse|afterMCPExecution>`: the event decides
 * whether a left note may be handed over, since Cursor delivers a hook's
 * `additional_context` on postToolUse.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  resolveHookConversationId,
  loadState,
  explicitReplyMarkerPath,
  clearTurnMarker,
} from './mirror-turn.mjs'
import { appendRequestEvent, commandsAnsweredNow, readRequestState } from './requests.mjs'
import { isDevspecPostSessionTool } from './work-trail.mjs'
import {
  currentTurnNoticeIds,
  isNoticeReplyPost,
  leaveTellPersonNote,
  recordTellPerson,
  resultCarriesTellPerson,
  takeTellPersonNotes,
  TELL_PERSON_NOTE_SUFFIX,
  tellPersonNoteText,
} from './notice-reply.mjs'
import { isDevspecServer, namespacedVerb } from './project-context.mjs'
import { writePrivateText } from './private-state.mjs'
import { POST_TOOL_CONTEXT_SHARE } from './hook-context-budget.mjs'

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export function extractPostSessionArgs(data) {
  if (!data || typeof data !== 'object') return null
  const input = data.tool_input ?? data.toolInput ?? data.arguments ?? data.args ?? data
  if (typeof input === 'string') {
    try {
      return JSON.parse(input)
    } catch {
      return null
    }
  }
  if (typeof input === 'object' && input !== null) {
    if (input.arguments && typeof input.arguments === 'object') return input.arguments
    if (input.args && typeof input.args === 'object') return input.args
    return input
  }
  return null
}

/**
 * Did this post declare the turn finished? Only an explicit boolean true counts —
 * a missing or malformed field must never be read as completion, because clearing
 * the marker wrongly would show Idle while the agent is still working. Exported
 * for tests.
 */
export function declaresCompleteTurn(raw) {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
    const args = extractPostSessionArgs(data) || {}
    return args.complete_turn === true || args.completeTurn === true
  } catch {
    return false
  }
}

/**
 * Record that the turn's room commands were answered. Exported for tests;
 * `dir` defaults to where the request log lives.
 */
export function markCommandsAnswered(
  connectionId,
  { dir = path.join(os.homedir(), '.devspec', 'remote-control', 'connections') } = {},
) {
  try {
    const ids = commandsAnsweredNow(readRequestState(connectionId, { dir }))
    for (const id of ids) appendRequestEvent(connectionId, { op: 'answered', id }, { dir })
    return ids
  } catch {
    return [] // never fails the post: an unmarked command only stays open longer
  }
}

export async function handleExplicitReply(rawInput, env = process.env, { dir } = {}) {
  let data = {}
  try {
    data = typeof rawInput === 'string' ? JSON.parse(rawInput || '{}') : rawInput || {}
  } catch {
    data = {}
  }

  if (!isDevspecPostSessionTool(data)) return false

  const conversationId = resolveHookConversationId(typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput), env)
  const state = loadState(conversationId)
  const args = extractPostSessionArgs(data)

  const connectionId =
    (typeof args?.connection_id === 'string' && args.connection_id.trim()) ||
    state?.connection_id ||
    null

  if (!connectionId) return false

  // A notice reply is not the turn's reply (notice-reply.mjs). It names its notices,
  // or preToolUse gave it the turn's own because every wake of the turn was a notice.
  const connDir = dir ?? path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
  const turnNotices = args && args.system_notice_ids === undefined
    ? currentTurnNoticeIds(connectionId, { dir: connDir, connectionState: state })
    : null
  if (isNoticeReplyPost(args, { turnNotices })) return false

  try {
    const markerPath = explicitReplyMarkerPath(connectionId)
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, `${Date.now()}\n`, { mode: 0o600 })
  } catch {
    /* non-fatal */
  }

  // If the message completed the turn (or was marked complete), clear the .turn marker immediately
  // and mark the turn's room commands answered so Stop can close them once their work finishes.
  const isCompleteTurn = args?.complete_turn === true || args?.completeTurn === true
  if (isCompleteTurn) {
    clearTurnMarker(connectionId)
    markCommandsAnswered(connectionId, dir ? { dir } : {})
  }

  return true
}

/** Whether a hook event is a call to one of DevSpec's own tools. */
function isDevspecToolEvent(data) {
  if (data?.mcp_server_name !== undefined) return isDevspecServer(data.mcp_server_name)
  return Boolean(namespacedVerb(data?.tool_name ?? data?.toolName))
}

/**
 * Note on the turn that a DevSpec write's result carried DevSpec's `tell_person` mark
 * (`resultCarriesTellPerson`). Cursor hands the result to afterMCPExecution as
 * `result_json`; an event without one changes nothing. Exported for tests; `dir`
 * defaults to where the turn record lives.
 */
export function handleTellPersonMark(rawInput, env = process.env, { dir } = {}) {
  let data = {}
  try {
    data = typeof rawInput === 'string' ? JSON.parse(rawInput || '{}') : rawInput || {}
  } catch {
    return false
  }
  if (!data || typeof data !== 'object' || !isDevspecToolEvent(data)) return false
  if (!resultCarriesTellPerson(data.result_json ?? data.resultJson)) return false
  const conversationId = resolveHookConversationId(typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput), env)
  const connectionId = loadState(conversationId)?.connection_id
  if (!connectionId) return false
  const connDir = dir ?? path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
  return recordTellPerson(connectionId, { dir: connDir })
}

/**
 * The hook output handing the agent a message Stop could not post (notice-reply.mjs,
 * `leaveTellPersonNote`), or null when none was left. Only the conversation that holds
 * the connection gets it, never a subagent's tool call. Past this hook's share of
 * Cursor's limit on hook context (hook-context-budget.mjs), the whole note goes to a
 * private file and the agent is told where, so nothing in it is cut or dropped. Exported for tests; `dir` defaults to where the
 * connection's files live.
 */
export function tellPersonNoteHook(rawInput, env = process.env, { dir } = {}) {
  let data = {}
  try {
    data = typeof rawInput === 'string' ? JSON.parse(rawInput || '{}') : rawInput || {}
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || data.agent_id) return null
  const connDir = dir ?? path.join(os.homedir(), '.devspec', 'remote-control', 'connections')
  // This runs after every tool call: one directory read settles that nothing is waiting.
  if (!anyTellPersonNote(connDir)) return null
  const conversationId = resolveHookConversationId(typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput), env)
  const connectionId = loadState(conversationId)?.connection_id
  if (!connectionId) return null
  const notes = takeTellPersonNotes(connectionId, { dir: connDir })
  let text = tellPersonNoteText(notes)
  if (!text) return null
  if (text.length > POST_TOOL_CONTEXT_SHARE) {
    const file = path.join(connDir, `${connectionId}.tell-person-note.md`)
    try {
      writePrivateText(file, `${text}\n`)
    } catch (error) {
      // Not handed over, so not taken: put every note back for the next tool call.
      for (const note of notes) leaveTellPersonNote(connectionId, { text: note.text, refusal: note.refusal ?? null, dir: connDir, now: note.at })
      throw error
    }
    text =
      'From the DevSpec plugin: a message your person has not heard is waiting for you, longer than Cursor hands a hook\'s note to you at once. ' +
      `Read it whole, with the file-reading tool, at ${JSON.stringify(file)}, and do what it says.`
  }
  return JSON.stringify({
    additional_context: text,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
  })
}

/** Whether any connection has a note waiting (`leaveTellPersonNote`). */
function anyTellPersonNote(connDir) {
  try {
    return fs.readdirSync(connDir).some((name) => name.endsWith(TELL_PERSON_NOTE_SUFFIX))
  } catch {
    return false
  }
}

const MODE = process.argv[2] ?? null

async function main() {
  const raw = readStdin()
  let output = null
  try {
    handleTellPersonMark(raw)
  } catch {
    /* non-fatal: an unnoted mark only leaves telling the person to the model */
  }
  try {
    await handleExplicitReply(raw)
  } catch {
    /* non-fatal */
  }
  if (MODE === 'postToolUse') {
    try {
      output = tellPersonNoteHook(raw)
    } catch {
      /* the note stays where it was left, for the next tool call */
    }
  }
  if (output) process.stdout.write(output)
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
