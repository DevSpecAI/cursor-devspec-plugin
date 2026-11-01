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
import { currentTurnNoticeIds, isNoticeReplyPost } from './notice-reply.mjs'

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

async function main() {
  const raw = readStdin()
  try {
    await handleExplicitReply(raw)
  } catch {
    /* non-fatal */
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
