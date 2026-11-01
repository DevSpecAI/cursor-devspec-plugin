#!/usr/bin/env node
/** Default-off local Cursor hook timings. Never upload, print command contents or
 * store raw errors. Unpaired completion durations remain unknown, not zero.
 */
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { activeDiagnostics, appendDiagnostic, safeToolName, updateDiagnosticPending } from './local-diagnostics.mjs'
import { loadState, resolveHookConversationId } from './mirror-turn.mjs'
import { isDevspecPostSessionTool } from './work-trail.mjs'

const BEFORE = new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution'])
const AFTER = new Set(['postToolUse', 'postToolUseFailure', 'afterShellExecution', 'afterMCPExecution'])
export function pendingKey(data, channel, tool) {
  const id = data?.tool_call_id || data?.toolCallId || data?.call_id || data?.callId || data?.invocation_id || data?.id
  const material = typeof id === 'string' ? id : channel === 'shell' ? String(data?.command || '') : tool
  return `${channel}:${createHash('sha256').update(material).digest('hex')}`
}
export function resolveToolIdentity(mode, data) {
  if (!data || typeof data !== 'object') return null
  if (mode === 'beforeShellExecution' || mode === 'afterShellExecution') return { channel: 'shell', tool: 'shell' }
  if (mode === 'beforeMCPExecution' || mode === 'afterMCPExecution') return { channel: 'mcp', tool: safeToolName(data.tool_name || data.toolName) }
  if (['preToolUse', 'postToolUse', 'postToolUseFailure'].includes(mode)) return { channel: 'tool', tool: safeToolName(data.tool_name || data.toolName) }
  return null
}
export function resolveDurationMs(data, startedAt, endedAt = Date.now()) {
  const reported = data?.duration_ms ?? data?.duration
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return Math.round(reported)
  return Number.isFinite(startedAt) && endedAt >= startedAt ? Math.round(endedAt - startedAt) : undefined
}
export async function emitTurnToolTiming(fields) {
  return { local: appendDiagnostic(fields, {
    kind: 'tool', phase: 'end', source: 'cursor_hook', channel: fields.channel, tool: fields.tool,
    invocationId: fields.invocationId, started_at: fields.started_at, ended_at: fields.ended_at || new Date().toISOString(),
    duration_ms: fields.duration_ms, outcome: fields.outcome || 'ok', turn_id: fields.turn_id,
  }, fields.diagnosticOptions) }
}
export async function handleTurnToolHook(mode, data, ctx) {
  if (isDevspecPostSessionTool(data)) return { skipped: 'post_session' }
  const run = activeDiagnostics(ctx, ctx.diagnosticOptions)
  if (!run) return { skipped: 'disabled' }
  const identity = resolveToolIdentity(mode, data)
  if (!identity) return { skipped: 'unknown_mode' }
  const now = ctx.now ?? Date.now(), key = pendingKey(data, identity.channel, identity.tool)
  if (BEFORE.has(mode)) {
    const entry = { startedAt: now, invocationId: randomUUID() }
    updateDiagnosticPending(run, key, entry)
    const recorded = appendDiagnostic(ctx, { kind: 'tool', phase: 'start', source: 'cursor_hook', ...identity, invocationId: entry.invocationId, started_at: new Date(now).toISOString(), turn_id: ctx.turn_id }, ctx.diagnosticOptions)
    return { recorded }
  }
  if (!AFTER.has(mode)) return { skipped: 'not_after' }
  const start = updateDiagnosticPending(run, key, null)
  return emitTurnToolTiming({ ...ctx, ...identity, invocationId: start?.invocationId || randomUUID(),
    ...(start ? { started_at: new Date(start.startedAt).toISOString() } : {}), ended_at: new Date(now).toISOString(),
    duration_ms: resolveDurationMs(data, start?.startedAt, now),
    outcome: mode === 'postToolUseFailure' || data.error ? 'error' : 'ok',
  })
}
async function main() {
  const mode = String(process.argv[2] || '')
  if (!BEFORE.has(mode) && !AFTER.has(mode)) return
  let raw = '', data = {}
  try { raw = fs.readFileSync(0, 'utf8'); data = JSON.parse(raw || '{}') } catch { return }
  const localId = resolveHookConversationId(raw, process.env) || data.conversation_id
  // Off by default: do not load bond state, create pending files or contact servers.
  if (!activeDiagnostics({ local_id: localId })) return
  const state = loadState(localId)
  if (!state?.enabled || !state.connection_id) return
  await handleTurnToolHook(mode, data, { connectionId: state.connection_id, local_id: localId, turn_id: state.current_command_turn_id || state.turn_id })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => process.exit(0))
}
