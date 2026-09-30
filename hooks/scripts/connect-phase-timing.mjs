import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { activeDiagnostics, appendDiagnostic } from './local-diagnostics.mjs'

export const CONNECT_PHASE_NAMES = ['create_chat', 'expand_stamp', 'skip_stamp', 'write_stamp', 'agent_spawn', 'agent_resume', 'resolve_local_id', 'resolve_local', 'project_resolve', 'register_connection', 'attach_connection', 'write_state', 'ensure_poller', 'wait_armed']
export const durationMs = (start, end = Date.now()) => Number.isFinite(Number(start)) && Number.isFinite(Number(end)) ? Math.max(0, Math.round(Number(end) - Number(start))) : 0
export const newLaunchId = () => randomUUID()
export function resolveLaunchId(explicit, env = process.env) { return typeof explicit === 'string' && explicit.trim() ? explicit.trim() : typeof env.DEVSPEC_LAUNCH_ID === 'string' ? env.DEVSPEC_LAUNCH_ID.trim() || null : null }

/** No stderr timing stream or network transport. Legacy ship/logUrl options are
 * deliberately ignored: diagnostics require a locally enabled matching run.
 */
export async function emitConnectPhase(fields) {
  return { local: appendDiagnostic(fields, {
    kind: 'connect', phase: 'end', source: 'plugin_connect', operation: fields.phase,
    outcome: fields.outcome || 'ok', duration_ms: fields.duration_ms,
    invocationId: fields.invocationId, started_at: fields.started_at, ended_at: fields.ended_at || new Date().toISOString(),
  }, fields.diagnosticOptions) }
}
export async function timeConnectPhase(phase, fn, ctx = {}) {
  const run = activeDiagnostics(ctx, ctx.diagnosticOptions)
  if (!run) return fn()
  ctx = { ...ctx, diagnosticOptions: { ...ctx.diagnosticOptions, runId: run.meta.runId } }
  const invocationId = randomUUID(), started_at = new Date().toISOString(), started = performance.now()
  appendDiagnostic(ctx, { kind: 'connect', phase: 'start', source: 'plugin_connect', operation: phase, invocationId, started_at }, ctx.diagnosticOptions)
  try {
    const result = await fn()
    await emitConnectPhase({ ...ctx, phase, invocationId, started_at, duration_ms: performance.now() - started, outcome: ctx.outcomeOk || 'ok' })
    return result
  } catch (error) {
    await emitConnectPhase({ ...ctx, phase, invocationId, started_at, duration_ms: performance.now() - started, outcome: ctx.outcomeFail || 'error' })
    throw error
  }
}
