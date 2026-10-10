/**
 * Tell DevSpec which model Cursor is running, so the Agents page shows it even when
 * the agent is not in a session (item cc47378e).
 *
 * Cursor hands every hook the selected model (`model`, plus `model_id` and
 * `model_params` when it has them; https://cursor.com/docs/agent/hooks). The
 * prompt-submit and stop hooks write it to `<connection>.telemetry.json` beside the
 * connection's state, and the poller sends it as `agent_stats` on every
 * `poll_connection`. Mechanical: no model instruction is involved, and a connection
 * whose hooks never ran simply sends nothing.
 *
 * This plugin owns its copy (decision 1d06cdc6); the report shape is the server's
 * `agent_stats` v1, the same one Pi, Claude Code and OpenCode send.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/** The levels `agent_stats.thinkingLevel` accepts. Anything else is sent as null, or the server drops the whole report. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Cursor routes every model itself, so the route it reports under is Cursor. */
const PROVIDER = 'cursor'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function telemetryPath(connectionId, dir = CONNECTIONS_DIR) {
  return path.join(dir, `${connectionId}.telemetry.json`)
}

/**
 * The runtime report a hook's stdin describes, or null when it names no model.
 * `model_id` is preferred to the legacy `model` slug when both are present.
 */
export function runtimeReportFromHookInput(input, now = new Date()) {
  if (!input || typeof input !== 'object') return null
  const id = text(input.model_id) ?? text(input.model)
  if (!id) return null
  const params = Array.isArray(input.model_params) ? input.model_params : []
  const effort = params.find((p) => p && (p.id === 'effort' || p.id === 'thinking') && THINKING_LEVELS.has(text(p.value)))
  return {
    v: 1,
    model: { provider: PROVIDER, id },
    thinkingLevel: effort ? text(effort.value) : null,
    context: null,
    turn: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 },
    session: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 },
    at: now.toISOString(),
  }
}

/**
 * Write the report for this connection from a hook's raw stdin. Never throws: a
 * missing model or an unwritable file just means no report, and the hook carries on.
 */
export function recordRuntimeReport(connectionId, rawHookInput, { dir = CONNECTIONS_DIR, now = new Date() } = {}) {
  if (!UUID_RE.test(String(connectionId || ''))) return false
  try {
    const report = runtimeReportFromHookInput(JSON.parse(rawHookInput || '{}'), now)
    if (!report) return false
    fs.writeFileSync(telemetryPath(connectionId, dir), JSON.stringify(report), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** `{ agent_stats }` for a poll's arguments, or `{}` when this connection has no report yet. */
export function agentStatsArgs(connectionId, { dir = CONNECTIONS_DIR } = {}) {
  if (!UUID_RE.test(String(connectionId || ''))) return {}
  try {
    const report = JSON.parse(fs.readFileSync(telemetryPath(connectionId, dir), 'utf8'))
    return report?.v === 1 && text(report?.model?.id) ? { agent_stats: report } : {}
  } catch {
    return {}
  }
}
