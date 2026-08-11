#!/usr/bin/env node
/**
 * Shared mid-turn trail growth from Cursor agent-transcript JSONL.
 *
 * Used when Cursor CLI does not fire mid-turn hooks (Agents --resume path).
 * IDE hooks (trail-turn.mjs) remain the primary path when they fire; this module
 * is the durable CLI-safe feed and is also safe if both run (hash + throttle).
 */

import fs from 'node:fs'
import { mcpToolsCall } from './mcp-call.mjs'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  advanceTrailState,
  readTrailState,
  resolveAgentTranscriptPath,
  writeTrailState,
} from './work-trail.mjs'

/**
 * @param {{
 *   connectionId: string
 *   mcpUrl: string
 *   token: string
 *   localId?: string | null
 *   transcriptPath?: string | null
 *   agentName?: string
 *   timeoutMs?: number
 *   now?: number
 * }} opts
 * @returns {Promise<{
 *   ok: boolean
 *   skipped?: boolean
 *   reason?: string
 *   trail?: string
 *   transcriptPath?: string | null
 * }>}
 */
export async function postTrailFromTranscript(opts) {
  const connectionId = String(opts?.connectionId || '').trim()
  const mcpUrl = String(opts?.mcpUrl || '').trim()
  const token = String(opts?.token || '').trim()
  const agentName = opts?.agentName || AGENT_NAME
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const now = opts?.now ?? Date.now()

  if (!connectionId || !mcpUrl || !token) {
    return { ok: false, skipped: true, reason: 'missing_args' }
  }

  const transcriptPath =
    (typeof opts.transcriptPath === 'string' && opts.transcriptPath.trim()
      ? opts.transcriptPath.trim()
      : null) ||
    (opts.localId ? resolveAgentTranscriptPath(opts.localId) : null)

  if (!transcriptPath) {
    return { ok: false, skipped: true, reason: 'no_transcript', transcriptPath: null }
  }

  let transcriptText = ''
  try {
    transcriptText = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return { ok: false, skipped: true, reason: 'transcript_unreadable', transcriptPath }
  }
  if (!transcriptText.trim()) {
    return { ok: false, skipped: true, reason: 'transcript_empty', transcriptPath }
  }

  const prev = readTrailState(connectionId)
  const advanced = advanceTrailState({
    prev,
    part: null,
    mode: 'transcript',
    transcriptText,
    now,
  })
  if (!advanced) {
    return { ok: false, skipped: true, reason: 'no_advance', transcriptPath }
  }
  if (!String(advanced.trail || '').trim()) {
    return { ok: false, skipped: true, reason: 'empty_trail', transcriptPath }
  }

  // Persist only when we have real trail body — do not wipe a Working… seed
  // with an empty serialize of a transcript that has no assistant tool_use yet.
  writeTrailState(connectionId, {
    ...(prev || {}),
    cumulative: advanced.nextState.cumulative,
    lastPostedHash: advanced.nextState.lastPostedHash,
    lastPostedAt: advanced.nextState.lastPostedAt,
    updatedAt: advanced.nextState.updatedAt,
    transcriptPath,
    source: 'transcript',
  })

  if (!advanced.shouldPost) {
    return { ok: false, skipped: true, reason: 'throttle', transcriptPath, trail: advanced.trail }
  }

  await mcpToolsCall({
    mcpUrl,
    token,
    name: 'post_session_message',
    arguments: {
      connection_id: connectionId,
      message: advanced.trail,
      agent_name: agentName,
      turn_kind: 'agent',
      phase: 'trail',
    },
    timeoutMs,
  })

  return { ok: true, trail: advanced.trail, transcriptPath }
}
