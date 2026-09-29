#!/usr/bin/env node
/**
 * Node-measured per-tool timings on live Cursor remote answer turns (item f719e846).
 *
 * Complements connect-phase-timing.mjs (cold launch). Emits lean Remote-control story
 * breadcrumbs with kind=turn_tool so Axiom can reconstruct one answer's tool timeline.
 *
 * Never log tokens, message bodies, tool arguments, or model streams.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_NAME } from './agent-identity.mjs'
import {
  deriveLogIngestUrl,
  durationMs,
  shipConnectPhaseToAxiom,
  STORY_MSG,
} from './connect-phase-timing.mjs'
import { hasActiveTurnMarker, loadState, resolveHookConversationId } from './mirror-turn.mjs'
import { logRemoteControlStory } from './remote-control-story.mjs'
import { isDevspecPostSessionTool } from './work-trail.mjs'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

export const TURN_TOOL_KIND = 'turn_tool'
export const TURN_TOOL_SOURCE = 'cursor_plugin'

const BEFORE_MODES = new Set([
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
])

const AFTER_MODES = new Set([
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'afterMCPExecution',
])

/**
 * @param {string} connectionId
 * @returns {string}
 */
export function turnToolPendingPath(connectionId) {
  return path.join(CONNECTIONS_DIR, `${connectionId}.turn-tool-pending.json`)
}

/**
 * @param {string} connectionId
 * @returns {Record<string, { startedAt: number, tool: string, channel: string }>}
 */
export function readPendingStarts(connectionId) {
  if (!connectionId) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(turnToolPendingPath(connectionId), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * @param {string} connectionId
 * @param {Record<string, { startedAt: number, tool: string, channel: string }>} pending
 */
export function writePendingStarts(connectionId, pending) {
  if (!connectionId) return
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true })
  fs.writeFileSync(turnToolPendingPath(connectionId), JSON.stringify(pending), { mode: 0o600 })
}

/**
 * Stable key for pairing before/after hooks for one invocation.
 * @param {Record<string, unknown>} data
 * @param {string} channel
 * @param {string} tool
 * @returns {string}
 */
export function pendingKey(data, channel, tool) {
  const id =
    data?.tool_call_id ||
    data?.toolCallId ||
    data?.call_id ||
    data?.callId ||
    data?.invocation_id ||
    data?.id ||
    null
  if (typeof id === 'string' && id.trim()) return `${channel}:${id.trim()}`
  // Shell often has no call id — pair on normalized command fingerprint.
  return `${channel}:${tool}`
}

/**
 * @param {string} mode
 * @param {Record<string, unknown>} data
 * @returns {{ channel: string, tool: string } | null}
 */
export function resolveToolIdentity(mode, data) {
  if (!data || typeof data !== 'object') return null

  if (mode === 'beforeShellExecution' || mode === 'afterShellExecution') {
    const cmd = String(data.command || '').trim() || 'shell'
    const short = cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd
    return { channel: 'shell', tool: short }
  }

  if (mode === 'beforeMCPExecution' || mode === 'afterMCPExecution') {
    const tool = String(data.tool_name || data.toolName || 'mcp').trim() || 'mcp'
    return { channel: 'mcp', tool }
  }

  if (
    mode === 'preToolUse' ||
    mode === 'postToolUse' ||
    mode === 'postToolUseFailure'
  ) {
    const tool = String(data.tool_name || data.toolName || 'tool').trim() || 'tool'
    return { channel: 'tool', tool }
  }

  return null
}

/**
 * Prefer Cursor-reported duration when present; else elapsed from pending start.
 * @param {Record<string, unknown>} data
 * @param {number | null | undefined} startedAt
 * @param {number} [endedAt]
 * @returns {number}
 */
export function resolveDurationMs(data, startedAt, endedAt = Date.now()) {
  if (typeof data?.duration === 'number' && Number.isFinite(data.duration)) {
    return Math.max(0, Math.round(data.duration))
  }
  if (typeof data?.duration_ms === 'number' && Number.isFinite(data.duration_ms)) {
    return Math.max(0, Math.round(data.duration_ms))
  }
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
    return durationMs(startedAt, endedAt)
  }
  return 0
}

/**
 * @param {{
 *   tool: string,
 *   channel: string,
 *   outcome?: string,
 *   duration_ms: number,
 *   connectionId?: string | null,
 *   sessionId?: string | null,
 *   turn_id?: string | null,
 *   launch_id?: string | null,
 *   local_id?: string | null,
 *   agent?: string | null,
 *   reason?: string | null,
 * }} fields
 */
export function buildTurnToolPayload(fields) {
  const {
    tool,
    channel,
    outcome = 'ok',
    duration_ms,
    connectionId,
    sessionId,
    turn_id,
    launch_id,
    local_id,
    agent,
    reason,
  } = fields

  return {
    phase: `tool:${channel}:${tool}`.slice(0, 200),
    tool,
    channel,
    outcome,
    duration_ms: Math.max(0, Math.round(Number(duration_ms) || 0)),
    kind: TURN_TOOL_KIND,
    source: TURN_TOOL_SOURCE,
    ...(connectionId ? { connectionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turn_id ? { turn_id } : {}),
    ...(launch_id ? { launch_id } : {}),
    ...(local_id ? { local_id } : {}),
    ...(agent ? { agent } : {}),
    ...(reason != null && reason !== '' ? { reason: String(reason).slice(0, 200) } : {}),
  }
}

/**
 * @param {{
 *   tool: string,
 *   channel: string,
 *   outcome?: string,
 *   duration_ms: number,
 *   connectionId?: string | null,
 *   sessionId?: string | null,
 *   turn_id?: string | null,
 *   launch_id?: string | null,
 *   local_id?: string | null,
 *   agent?: string | null,
 *   reason?: string | null,
 *   mcpUrl?: string | null,
 *   logUrl?: string | null,
 *   fetchImpl?: typeof fetch,
 *   ship?: boolean,
 * }} fields
 */
export async function emitTurnToolTiming(fields) {
  const payload = buildTurnToolPayload(fields)
  const {
    tool,
    channel,
    outcome = 'ok',
    connectionId,
    sessionId,
    agent,
    reason,
    mcpUrl,
    logUrl,
    fetchImpl,
    ship = true,
  } = fields

  logRemoteControlStory({
    phase: payload.phase,
    outcome,
    reason: reason ?? null,
    connectionId: connectionId ?? null,
    sessionId: sessionId ?? null,
    agent: agent ?? 'Cursor',
    tool: 'turn_tool_timing',
    data: {
      duration_ms: payload.duration_ms,
      kind: payload.kind,
      source: payload.source,
      tool,
      channel,
      ...(payload.turn_id ? { turn_id: payload.turn_id } : {}),
      ...(payload.launch_id ? { launch_id: payload.launch_id } : {}),
      ...(payload.local_id ? { local_id: payload.local_id } : {}),
    },
  })

  if (!ship) return { local: true, axiom: { ok: false, error: 'ship_disabled' } }

  const ingest =
    (typeof logUrl === 'string' && logUrl.trim()) || deriveLogIngestUrl(mcpUrl)
  const axiom = await shipConnectPhaseToAxiom(ingest, payload, { fetchImpl })
  return { local: true, axiom }
}

/**
 * @param {string} mode
 * @param {Record<string, unknown>} data
 * @param {{
 *   connectionId: string,
 *   sessionId?: string | null,
 *   turn_id?: string | null,
 *   launch_id?: string | null,
 *   local_id?: string | null,
 *   mcpUrl?: string | null,
 *   agent?: string | null,
 *   ship?: boolean,
 *   fetchImpl?: typeof fetch,
 *   now?: number,
 * }} ctx
 */
export async function handleTurnToolHook(mode, data, ctx) {
  if (isDevspecPostSessionTool(data)) return { skipped: 'post_session' }

  const identity = resolveToolIdentity(mode, data)
  if (!identity) return { skipped: 'unknown_mode' }

  const { connectionId } = ctx
  if (!connectionId) return { skipped: 'no_connection' }

  const key = pendingKey(data, identity.channel, identity.tool)
  const now = typeof ctx.now === 'number' ? ctx.now : Date.now()

  if (BEFORE_MODES.has(mode)) {
    const pending = readPendingStarts(connectionId)
    pending[key] = {
      startedAt: now,
      tool: identity.tool,
      channel: identity.channel,
    }
    // Bound growth — keep newest 64 starts.
    const keys = Object.keys(pending)
    if (keys.length > 64) {
      for (const k of keys.slice(0, keys.length - 64)) delete pending[k]
    }
    writePendingStarts(connectionId, pending)
    return { recorded: true, key }
  }

  if (!AFTER_MODES.has(mode)) return { skipped: 'not_after' }

  const pending = readPendingStarts(connectionId)
  const start = pending[key] || null
  if (start) {
    delete pending[key]
    writePendingStarts(connectionId, pending)
  }

  const outcome =
    mode === 'postToolUseFailure'
      ? 'error'
      : typeof data?.error === 'string' && data.error
        ? 'error'
        : 'ok'

  const reason =
    mode === 'postToolUseFailure'
      ? String(data.error_message || data.errorMessage || data.failure_type || 'failed')
      : null

  return emitTurnToolTiming({
    tool: identity.tool,
    channel: identity.channel,
    outcome,
    duration_ms: resolveDurationMs(data, start?.startedAt ?? null, now),
    connectionId,
    sessionId: ctx.sessionId ?? null,
    turn_id: ctx.turn_id ?? null,
    launch_id: ctx.launch_id ?? null,
    local_id: ctx.local_id ?? null,
    agent: ctx.agent ?? AGENT_NAME,
    reason,
    mcpUrl: ctx.mcpUrl ?? null,
    ship: ctx.ship !== false,
    fetchImpl: ctx.fetchImpl,
  })
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

async function main() {
  const mode = String(process.argv[2] || '')
  if (!BEFORE_MODES.has(mode) && !AFTER_MODES.has(mode)) process.exit(0)

  const raw = readStdin()
  let data = {}
  try {
    data = JSON.parse(raw || '{}')
  } catch {
    data = {}
  }

  const conversationId = resolveHookConversationId(raw, process.env)
  const fromHook =
    typeof data.conversation_id === 'string' && data.conversation_id.trim()
      ? data.conversation_id.trim()
      : null
  const bondId = conversationId || fromHook
  const state = loadState(bondId)
  if (!state?.enabled || !state.connection_id || !state.session_id) process.exit(0)
  if (!hasActiveTurnMarker(state.connection_id)) process.exit(0)

  try {
    await handleTurnToolHook(mode, data, {
      connectionId: state.connection_id,
      sessionId: state.session_id,
      turn_id: state.current_command_turn_id || state.turn_id || null,
      launch_id: state.launch_id || process.env.DEVSPEC_LAUNCH_ID || null,
      local_id: bondId,
      mcpUrl: state.mcp_url || null,
      agent: AGENT_NAME,
    })
  } catch (err) {
    process.stderr.write(
      `[devspec-remote] turn-tool-timing failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
  process.exit(0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()

export { STORY_MSG }
