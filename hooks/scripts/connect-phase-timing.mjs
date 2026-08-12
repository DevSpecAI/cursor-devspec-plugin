/**
 * Node-measured connect / cold-launch phase timings (item 383de0cd).
 *
 * Emits lean Remote-control story breadcrumbs with duration_ms + launch_id so
 * Axiom can reconstruct a single launch timeline. Local stderr `story ` lines
 * stay aligned with remote-control-story.mjs; Axiom ingest uses public
 * POST /api/log (same path as the web clientLogger) derived from the MCP URL.
 *
 * Never log tokens, message bodies, or model streams.
 */

import { randomUUID } from 'node:crypto'
import { logRemoteControlStory } from './remote-control-story.mjs'

/** Launcher + connect phases measured in Node for cold-launch timelines. */
export const CONNECT_PHASE_NAMES = [
  'create_chat',
  'expand_stamp',
  'skip_stamp',
  'write_stamp',
  'agent_spawn',
  'agent_resume',
  'resolve_local_id',
  'resolve_local',
  'project_resolve',
  'register_connection',
  'attach_connection',
  'write_state',
  'ensure_poller',
  'wait_armed',
]

export const STORY_MSG = 'Remote-control story'

/**
 * @param {number} startedAtMs
 * @param {number} [endedAtMs]
 * @returns {number}
 */
export function durationMs(startedAtMs, endedAtMs = Date.now()) {
  const start = Number(startedAtMs)
  const end = Number(endedAtMs)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round(end - start))
}

/** @returns {string} */
export function newLaunchId() {
  return randomUUID()
}

/**
 * Prefer explicit arg, then env (launcher stamps DEVSPEC_LAUNCH_ID on the agent).
 * @param {string | null | undefined} explicit
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveLaunchId(explicit, env = process.env) {
  const fromArg = typeof explicit === 'string' ? explicit.trim() : ''
  if (fromArg) return fromArg
  const fromEnv =
    typeof env.DEVSPEC_LAUNCH_ID === 'string' ? env.DEVSPEC_LAUNCH_ID.trim() : ''
  return fromEnv || null
}

/**
 * Derive the browser log ingest URL from an MCP endpoint.
 * @param {string | null | undefined} mcpUrl
 * @returns {string | null}
 */
export function deriveLogIngestUrl(mcpUrl) {
  const raw = typeof mcpUrl === 'string' ? mcpUrl.trim() : ''
  if (!raw) return null
  try {
    const u = new URL(raw)
    // …/api/mcp → …/api/log
    if (u.pathname.endsWith('/api/mcp') || u.pathname.endsWith('/api/mcp/')) {
      u.pathname = u.pathname.replace(/\/api\/mcp\/?$/, '/api/log')
      u.search = ''
      u.hash = ''
      return u.toString()
    }
    // Bare origin or other path: append /api/log under origin.
    u.pathname = '/api/log'
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

/**
 * @param {{
 *   phase: string,
 *   outcome?: string,
 *   duration_ms: number,
 *   launch_id?: string | null,
 *   connectionId?: string | null,
 *   sessionId?: string | null,
 *   local_id?: string | null,
 *   agent?: string | null,
 *   reason?: string | null,
 *   extra?: Record<string, unknown>,
 * }} fields
 */
export function buildConnectPhasePayload(fields) {
  const {
    phase,
    outcome = 'ok',
    duration_ms,
    launch_id,
    connectionId,
    sessionId,
    local_id,
    agent,
    reason,
    extra,
  } = fields

  return {
    phase,
    outcome,
    duration_ms: Math.max(0, Math.round(Number(duration_ms) || 0)),
    kind: 'connect_phase',
    source: 'cursor_plugin',
    ...(launch_id ? { launch_id } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(local_id ? { local_id } : {}),
    ...(agent ? { agent } : {}),
    ...(reason != null && reason !== '' ? { reason } : {}),
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
}

/**
 * Best-effort Axiom ship via public /api/log (nests undeclared keys under data.client).
 * @param {string | null | undefined} logUrl
 * @param {Record<string, unknown>} payload
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function shipConnectPhaseToAxiom(logUrl, payload, opts = {}) {
  const url = typeof logUrl === 'string' ? logUrl.trim() : ''
  if (!url) return { ok: false, error: 'no_log_url' }
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch' }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'devspec-cursor-plugin/connect-phase-timing',
      },
      body: JSON.stringify({
        logs: [
          {
            level: 'info',
            msg: STORY_MSG,
            data: payload,
          },
        ],
      }),
    })
    if (!res.ok) {
      return { ok: false, status: res.status, error: `http_${res.status}` }
    }
    return { ok: true, status: res.status }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Local story line + optional Axiom ingest.
 * @param {{
 *   phase: string,
 *   outcome?: string,
 *   duration_ms: number,
 *   launch_id?: string | null,
 *   connectionId?: string | null,
 *   sessionId?: string | null,
 *   local_id?: string | null,
 *   agent?: string | null,
 *   reason?: string | null,
 *   mcpUrl?: string | null,
 *   logUrl?: string | null,
 *   extra?: Record<string, unknown>,
 *   fetchImpl?: typeof fetch,
 *   ship?: boolean,
 * }} fields
 */
export async function emitConnectPhase(fields) {
  const payload = buildConnectPhasePayload(fields)
  const {
    phase,
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
    phase,
    outcome,
    reason: reason ?? null,
    connectionId: connectionId ?? null,
    sessionId: sessionId ?? null,
    agent: agent ?? 'Cursor',
    tool: 'connect_phase_timing',
    data: {
      duration_ms: payload.duration_ms,
      kind: payload.kind,
      source: payload.source,
      ...(payload.launch_id ? { launch_id: payload.launch_id } : {}),
      ...(payload.local_id ? { local_id: payload.local_id } : {}),
      ...(fields.extra && typeof fields.extra === 'object' ? fields.extra : {}),
    },
  })

  if (!ship) return { local: true, axiom: { ok: false, error: 'ship_disabled' } }

  const ingest =
    (typeof logUrl === 'string' && logUrl.trim()) || deriveLogIngestUrl(mcpUrl)
  const axiom = await shipConnectPhaseToAxiom(ingest, payload, { fetchImpl })
  return { local: true, axiom }
}

/**
 * Time an async or sync function and emit a connect phase.
 * @template T
 * @param {string} phase
 * @param {() => T | Promise<T>} fn
 * @param {Omit<Parameters<typeof emitConnectPhase>[0], 'phase' | 'duration_ms' | 'outcome'> & { outcomeOk?: string, outcomeFail?: string }} ctx
 * @returns {Promise<T>}
 */
export async function timeConnectPhase(phase, fn, ctx = {}) {
  const started = Date.now()
  try {
    const result = await fn()
    await emitConnectPhase({
      ...ctx,
      phase,
      outcome: ctx.outcomeOk || 'ok',
      duration_ms: durationMs(started),
    })
    return result
  } catch (err) {
    await emitConnectPhase({
      ...ctx,
      phase,
      outcome: ctx.outcomeFail || 'error',
      duration_ms: durationMs(started),
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    })
    throw err
  }
}
