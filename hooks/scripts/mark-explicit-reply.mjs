#!/usr/bin/env node
/**
 * PostToolUse / afterMCPExecution hook for Cursor (matcher / target: post_session_message).
 *
 * Records that the agent posted an explicit reply into the session this turn (writing the
 * `.explicit-reply` marker so Stop skips mirroring redundant narration), AND if the post
 * completed the turn (`complete_turn: true`), immediately clears the local `<connection_id>.turn`
 * marker so the poller stops asserting busy: true and Working dots clear without lag.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  resolveHookConversationId,
  loadState,
  explicitReplyMarkerPath,
  clearTurnMarker,
} from './mirror-turn.mjs'
import { isDevspecPostSessionTool } from './work-trail.mjs'

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

export async function handleExplicitReply(rawInput, env = process.env) {
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

  try {
    const markerPath = explicitReplyMarkerPath(connectionId)
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, `${Date.now()}\n`, { mode: 0o600 })
  } catch {
    /* non-fatal */
  }

  // If the message completed the turn (or was marked complete), clear the .turn marker immediately.
  const isCompleteTurn = args?.complete_turn === true || args?.completeTurn === true
  if (isCompleteTurn) {
    clearTurnMarker(connectionId)
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
