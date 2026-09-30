import { appendDiagnostic } from './local-diagnostics.mjs'

/** Never persist raw stderr, MCP bodies, SQL, tokens or content. */
export function classifyProgressFailure(error) {
  const message = typeof error?.message === 'string' ? error.message.slice(0, 8192) : ''
  let reason = 'unclassified_failure'
  if (/\bactivity_attempt_closed\b/.test(message)) reason = 'activity_attempt_closed'
  else if (/requires an exact open activity attempt/.test(message)) reason = 'missing_open_attempt'
  else if (/^command_turn_id is unknown/.test(message)) reason = 'unknown_command_turn'
  else if (/^Failed to write work trail:/.test(message)) reason = 'trail_write_failed'
  else if (error?.code === 'timeout') reason = 'timeout'
  else if (error?.code === 'owner_gone') reason = 'owner_gone'
  else if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error?.cause?.code)) reason = 'network_failure'
  else if (Number.isInteger(error?.status)) reason = 'http_failure'
  const detail = { reason }
  if (['auth_validation_unavailable', 'invalid_api_token', 'invalid_connection_capability'].includes(error?.serverCode)) detail.serverCode = error.serverCode
  if (typeof error?.retryable === 'boolean') detail.retryable = error.retryable
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) detail.httpStatus = error.status
  return detail
}

export function recordProgressFailure(connectionId, error, options = {}) {
  return appendDiagnostic({ connectionId }, { kind: 'progress_failure', phase: 'observed', source: 'progress_reporter', outcome: 'error', ...classifyProgressFailure(error) }, options)
}
