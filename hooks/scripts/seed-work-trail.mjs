#!/usr/bin/env node
/**
 * Shared phase=trail "Working…" seed for attached remote-control turns.
 *
 * Used by:
 *   - mirror-turn.mjs user_prompt (IDE / CLI typed prompt)
 *   - devspec-remote-poll.mjs deliverOwnerMessages (DevSpec phone/web wake)
 *
 * Remote wakes never fire Cursor's user_prompt hook, so the poller must seed
 * here or the live Working bubble never opens.
 */

import { mcpToolsCall } from './mcp-call.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  TRAIL_SEED_TEXT,
  advanceTrailState,
  readTrailState,
  writeTrailState,
} from './work-trail.mjs'

/**
 * @param {{
 *   connectionId: string
 *   mcpUrl: string
 *   token: string
 *   agentName?: string
 *   timeoutMs?: number
 * }} opts
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string }>}
 */
export async function seedWorkTrailForConnection(opts) {
  const connectionId = String(opts?.connectionId || '').trim()
  const mcpUrl = String(opts?.mcpUrl || '').trim()
  const token = String(opts?.token || '').trim()
  const agentName = opts?.agentName || AGENT_NAME
  const timeoutMs = opts?.timeoutMs ?? 15_000

  if (!connectionId || !mcpUrl || !token) {
    return { ok: false, skipped: true, reason: 'missing_args' }
  }

  const prev = readTrailState(connectionId)
  const advanced = advanceTrailState({
    prev,
    part: TRAIL_SEED_TEXT,
    mode: 'seed',
  })
  if (!advanced) {
    return { ok: false, skipped: true, reason: 'already_growing' }
  }
  if (!advanced.shouldPost) {
    return { ok: false, skipped: true, reason: 'throttle' }
  }

  writeTrailState(connectionId, {
    ...(prev || {}),
    cumulative: advanced.nextState.cumulative,
    lastPostedHash: advanced.nextState.lastPostedHash,
    lastPostedAt: advanced.nextState.lastPostedAt,
    updatedAt: advanced.nextState.updatedAt,
  })

  await mcpToolsCall({
    mcpUrl,
    token,
    name: 'post_session_message',
    arguments: {
      connection_id: connectionId,
      message: TRAIL_SEED_TEXT,
      agent_name: agentName,
      turn_kind: 'agent',
      phase: 'trail',
    },
    timeoutMs,
  })

  return { ok: true }
}
