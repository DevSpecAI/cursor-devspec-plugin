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
import {
  appendRequestEvent,
  closeRequest,
  commandsAnsweredNow,
  readRequestState,
  requestFinished,
  requestsWithWorkPending,
  rotateRequestLog,
} from './requests.mjs'
import { recordedSessionCrons, TYPED_SYNC_BACKGROUND_TIMEOUT_MS } from './typed-turn-sync.mjs'
import { connectionCredential } from './resolve-mcp-auth.mjs'
import { readConnectionCapability } from './manage-plan-bridge.mjs'
import { mcpToolsCall } from './mcp-call.mjs'
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
import { handOver, handOverPrefix, postToolUseOutput } from './hook-context-budget.mjs'
import { answerCursorAtExit } from './hook-answer.mjs'

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

  // If the message completed the turn (or was marked complete), clear the .turn marker immediately,
  // mark the turn's room commands answered, and close the turn's single primary answered command on
  // DevSpec when it has no pending background work (no dynamic multi-record loop; item da03801e).
  const isCompleteTurn = args?.complete_turn === true || args?.completeTurn === true
  if (isCompleteTurn) {
    clearTurnMarker(connectionId)
    const beforeState = readRequestState(connectionId, { dir: connDir })
    const primaryAnsweredId =
      beforeState.current && beforeState.open.get(beforeState.current)?.kind === 'command'
        ? beforeState.current
        : null
    markCommandsAnswered(connectionId, dir ? { dir } : {})
    if (primaryAnsweredId && state) {
      try {
        const reqState = readRequestState(connectionId, { dir: connDir })
        const sessionCrons = recordedSessionCrons(reqState)
        const pending = requestsWithWorkPending(reqState, { sessionCrons })
        if (requestFinished(reqState, primaryAnsweredId, pending)) {
          const credential = connectionCredential(state)
          const capability = state.connection_capability || readConnectionCapability(connectionId)
          if (credential.ok && capability) {
            await closeRequest({
              connectionId,
              requestId: primaryAnsweredId,
              dir: connDir,
              call: (reqArgs) =>
                mcpToolsCall({
                  mcpUrl: credential.mcp_url,
                  token: credential.token,
                  connectionCapability: capability,
                  name: 'report_request',
                  arguments: reqArgs,
                  timeoutMs: TYPED_SYNC_BACKGROUND_TIMEOUT_MS,
                }),
            })
            rotateRequestLog(connectionId, { dir: connDir })
          }
        }
      } catch {
        /* non-fatal: answered command is already cleared from current */
      }
    }
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
 * `leaveTellPersonNote`), or null when there is none. Only the conversation that holds
 * the connection gets it, never a subagent's tool call.
 *
 * The message is the person's, so it must reach the agent, and Cursor gives no sign
 * that a hook's note did (hook-context-budget.mjs). So it goes whole into a note file,
 * and a short pointer to it comes back after every step until the agent is seen
 * reading all of that delivery (`handOver`). A message left while an earlier one is still unread
 * joins it in one note. If the note cannot be written, the messages are put back for
 * the next step. Exported for tests; `dir` defaults to where the connection's files
 * live.
 */
export function tellPersonNoteHook(rawInput, env = process.env, { dir, home = os.homedir() } = {}) {
  let data = {}
  try {
    data = typeof rawInput === 'string' ? JSON.parse(rawInput || '{}') : rawInput || {}
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || data.agent_id) return null
  const connDir = dir ?? path.join(home, '.devspec', 'remote-control', 'connections')
  // This runs after every tool call: two directory reads settle that nothing is waiting.
  if (!anyTellPersonNote(connDir, home)) return null
  const conversationId = resolveHookConversationId(typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput), env)
  const connectionId = loadState(conversationId)?.connection_id
  if (!connectionId) return null
  const notes = takeTellPersonNotes(connectionId, { dir: connDir })
  let context
  try {
    // One delivery at a time: new messages join one still unread in a new delivery,
    // and only a whole read of the current delivery ends it (`handOver`).
    context = handOver(handOverPrefix('tell', connectionId), data, {
      add: tellPersonNoteText(notes),
      what: 'A message your person has not heard, handed back to you by the DevSpec plugin,',
      also: 'Do what it says.',
      home,
    })
  } catch (error) {
    // Not handed over, so not taken: every message goes back for the next step.
    for (const note of notes) leaveTellPersonNote(connectionId, { text: note.text, refusal: note.refusal ?? null, dir: connDir, now: note.at })
    throw error
  }
  return context === null ? null : JSON.stringify(postToolUseOutput(context))
}

/** Whether any connection has a message waiting (`leaveTellPersonNote`) or handed over and not yet read. */
function anyTellPersonNote(connDir, home) {
  const any = (dir, test) => {
    try {
      return fs.readdirSync(dir).some(test)
    } catch {
      return false
    }
  }
  return any(connDir, (name) => name.endsWith(TELL_PERSON_NOTE_SUFFIX)) ||
    any(path.join(home, '.devspec', 'notes', 'pending'), (name) => name.startsWith('tell-'))
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
if (isMain) {
  answerCursorAtExit()
  main()
}
